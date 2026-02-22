import { type App, TFile, normalizePath } from "obsidian";
import * as Y from "yjs";
import type { VaultSync } from "./vaultSync";
import type { EditorBindingManager } from "./editorBinding";
import { ORIGIN_SEED } from "../types";
import { ORIGIN_RESTORE } from "./snapshotClient";

/**
 * Handles writeback from Y.Text -> disk with:
 *   - Remote-only writes (skip local yCollab/seed/disk-sync origins)
 *   - Lazy per-file Y.Text observers
 *   - Concurrency-limited write queue (prevents burst I/O on git pull)
 *   - Loop suppression via timed path suppression
 */

const DEBOUNCE_MS = 300;
const DEBOUNCE_BURST_MS = 1000;
const SUPPRESS_MS = 500;
const MAX_CONCURRENT_WRITES = 5;
const BURST_THRESHOLD = 20;

/** String origins that should NOT trigger a disk write. */
const LOCAL_STRING_ORIGINS = new Set([
	ORIGIN_SEED,
	"disk-sync",
	ORIGIN_RESTORE,
]);

/**
 * Determine whether a Yjs transaction origin is "local" (should NOT trigger
 * a disk write). Remote sync from y-partykit uses `null` as the origin —
 * that's the only case we want to write to disk.
 *
 * Local origins include:
 *   - String origins: "vault-crdt-seed", "disk-sync", "snapshot-restore"
 *   - Object origins: y-codemirror.next passes its YSyncConfig instance
 *     as the transaction origin (not a string). Any non-null object origin
 *     is a local editor transaction.
 */
function isLocalOrigin(origin: unknown): boolean {
	if (origin == null) return false; // null/undefined = remote sync
	if (typeof origin === "string") return LOCAL_STRING_ORIGINS.has(origin);
	// Non-null, non-string origin (e.g. y-codemirror's YSyncConfig object)
	// is always a local editor transaction.
	return true;
}

export class DiskMirror {
	private suppressedPaths = new Map<string, number>();

	/** Deduped write queue. Order doesn't matter — deduplication does. */
	private writeQueue = new Set<string>();
	/** Debounce timers per path. */
	private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
	/** True while the drain loop is running. */
	private draining = false;

	/** Per-file Y.Text observers. Only attached for open/active files. */
	private textObservers = new Map<
		string,
		{ ytext: import("yjs").Text; handler: (event: import("yjs").YTextEvent, txn: import("yjs").Transaction) => void }
	>();

	private mapObserverCleanups: (() => void)[] = [];

	private readonly debug: boolean;

	constructor(
		private app: App,
		private vaultSync: VaultSync,
		private editorBindings: EditorBindingManager,
		debug: boolean,
	) {
		this.debug = debug;
	}

	// -------------------------------------------------------------------
	// Map observers (structural: add/delete)
	// -------------------------------------------------------------------

	startMapObservers(): void {
		const pathObserver = (event: import("yjs").YMapEvent<string>) => {
			event.changes.keys.forEach((change, path) => {
				if (change.action === "add" || change.action === "update") {
					if (!isLocalOrigin(event.transaction.origin)) {
						this.log(`map: remote path added "${path}"`);
						this.observeText(path);
						this.scheduleWrite(path);
					}
				}
				if (change.action === "delete") {
					this.unobserveText(path);
					if (!isLocalOrigin(event.transaction.origin)) {
						void this.handleRemoteDelete(path);
					}
				}
			});
		};
		this.vaultSync.pathToId.observe(pathObserver);
		this.mapObserverCleanups.push(() =>
			this.vaultSync.pathToId.unobserve(pathObserver),
		);

		const metaObserver = (event: import("yjs").YMapEvent<import("../types").FileMeta>) => {
			event.changes.keys.forEach((change, fileId) => {
				if (change.action === "add" || change.action === "update") {
					const meta = this.vaultSync.meta.get(fileId);
					if (
						meta?.deleted &&
						!isLocalOrigin(event.transaction.origin)
					) {
						void this.handleRemoteDelete(meta.path);
					}
				}
			});
		};
		this.vaultSync.meta.observe(metaObserver);
		this.mapObserverCleanups.push(() =>
			this.vaultSync.meta.unobserve(metaObserver),
		);

		// ---------------------------------------------------------------
		// afterTransaction: catch remote content edits to CLOSED files.
		//
		// Per-file Y.Text observers only cover open files. When a remote
		// device edits a note that is closed locally, the Y.Text changes
		// in memory but nothing writes it to disk. This handler inspects
		// every non-local transaction for changed Y.Text instances,
		// reverse-maps them to paths, and schedules writes for any path
		// that doesn't already have a per-file observer (i.e. closed).
		// ---------------------------------------------------------------
		const afterTxnHandler = (txn: Y.Transaction) => {
			if (isLocalOrigin(txn.origin)) return;

			for (const [changedType] of txn.changed) {
				if (!(changedType instanceof Y.Text)) continue;

				// Reverse lookup: find the fileId that owns this Y.Text
				const fileId = this.findFileIdForText(changedType);
				if (!fileId) continue;

				// Map fileId → path via meta (pathToId is path→id, not id→path)
				const meta = this.vaultSync.meta.get(fileId);
				if (!meta || meta.deleted) continue;

				const path = meta.path;

				// Skip if this path already has a per-file text observer (open file)
				if (this.textObservers.has(path)) continue;

				this.log(`afterTxn: remote content change to closed file "${path}"`);
				this.scheduleWrite(path);
			}
		};
		this.vaultSync.ydoc.on("afterTransaction", afterTxnHandler);
		this.mapObserverCleanups.push(() =>
			this.vaultSync.ydoc.off("afterTransaction", afterTxnHandler),
		);

		this.log("Map observers started");
	}

	/**
	 * Reverse-lookup: given a Y.Text instance, find the fileId.
	 * Uses VaultSync's WeakMap for O(1) lookup, with O(n) fallback.
	 */
	private findFileIdForText(ytext: Y.Text): string | null {
		// Fast path: WeakMap lookup
		const cached = this.vaultSync.getFileIdForText(ytext);
		if (cached) return cached;

		// Slow fallback: scan idToText (should rarely happen)
		for (const [fileId, text] of this.vaultSync.idToText.entries()) {
			if (text === ytext) return fileId;
		}
		return null;
	}

	// -------------------------------------------------------------------
	// Per-file observers (lazy)
	// -------------------------------------------------------------------

	notifyFileOpened(path: string): void {
		this.observeText(path);
	}

	notifyFileClosed(path: string): void {
		// Flush any pending debounce for this path
		const timer = this.debounceTimers.get(path);
		if (timer) {
			clearTimeout(timer);
			this.debounceTimers.delete(path);
			// Push to queue immediately
			this.writeQueue.add(path);
			this.kickDrain();
		}
		this.unobserveText(path);
	}

	private observeText(path: string): void {
		if (this.textObservers.has(path)) return;

		const ytext = this.vaultSync.getTextForPath(path);
		if (!ytext) return;

		const handler = (_event: import("yjs").YTextEvent, txn: import("yjs").Transaction) => {
			if (isLocalOrigin(txn.origin)) return;
			this.log(`text observer: remote change to "${path}" (origin=${txn.origin})`);
			this.scheduleWrite(path);
		};

		ytext.observe(handler);
		this.textObservers.set(path, { ytext, handler });
		this.log(`observeText: watching "${path}" (remote-only)`);
	}

	private unobserveText(path: string): void {
		const obs = this.textObservers.get(path);
		if (obs) {
			obs.ytext.unobserve(obs.handler);
			this.textObservers.delete(path);
			this.log(`unobserveText: stopped watching "${path}"`);
		}
	}

	/** Set of currently observed paths (for external cleanup). */
	getObservedPaths(): Set<string> {
		return new Set(this.textObservers.keys());
	}

	// -------------------------------------------------------------------
	// Write scheduling (debounce + concurrency-limited queue)
	// -------------------------------------------------------------------

	scheduleWrite(path: string): void {
		// Clear existing debounce for this path
		const existing = this.debounceTimers.get(path);
		if (existing) clearTimeout(existing);

		// Use longer debounce when queue is deep (burst scenario)
		const delay = this.writeQueue.size >= BURST_THRESHOLD ? DEBOUNCE_BURST_MS : DEBOUNCE_MS;

		this.debounceTimers.set(
			path,
			setTimeout(() => {
				this.debounceTimers.delete(path);
				this.writeQueue.add(path);
				this.kickDrain();
			}, delay),
		);
	}

	/** Start the drain loop if not already running. */
	private kickDrain(): void {
		if (this.draining) return;
		void this.drain();
	}

	/**
	 * Drain the write queue with bounded concurrency.
	 * Processes up to MAX_CONCURRENT_WRITES in parallel, then loops.
	 */
	private async drain(): Promise<void> {
		this.draining = true;

		try {
			while (this.writeQueue.size > 0) {
				// If the queue is very deep, log a warning and pause briefly
				if (this.writeQueue.size > BURST_THRESHOLD) {
					this.log(`drain: ${this.writeQueue.size} writes queued (burst), cooling down 200ms`);
					await new Promise((r) => setTimeout(r, 200));
				}

				// Take up to MAX_CONCURRENT_WRITES from the queue
				const batch: string[] = [];
				for (const path of this.writeQueue) {
					batch.push(path);
					if (batch.length >= MAX_CONCURRENT_WRITES) break;
				}
				for (const path of batch) {
					this.writeQueue.delete(path);
				}

				// Execute writes in parallel
				await Promise.all(batch.map((path) => this.flushWrite(path)));
			}
		} finally {
			this.draining = false;
		}
	}

	// -------------------------------------------------------------------
	// Disk write
	// -------------------------------------------------------------------

	async flushWrite(path: string): Promise<void> {
		const ytext = this.vaultSync.getTextForPath(path);
		if (!ytext) {
			this.log(`flushWrite: no Y.Text for "${path}", skipping`);
			return;
		}

		const content = ytext.toString();
		const normalized = normalizePath(path);

		try {
			const existing = this.app.vault.getAbstractFileByPath(normalized);
			if (existing instanceof TFile) {
				const currentContent = await this.app.vault.read(existing);
				if (currentContent === content) {
					this.log(`flushWrite: "${path}" unchanged, skipping`);
					return;
				}

				this.suppress(path);
				await this.app.vault.modify(existing, content);
				this.log(`flushWrite: updated "${path}" (${content.length} chars)`);
			} else {
				this.suppress(path);
				const dir = normalized.substring(0, normalized.lastIndexOf("/"));
				if (dir) {
					const dirExists =
						this.app.vault.getAbstractFileByPath(normalizePath(dir));
					if (!dirExists) {
						await this.app.vault.createFolder(dir);
					}
				}
				await this.app.vault.create(normalized, content);
				this.log(
					`flushWrite: created "${path}" on disk (${content.length} chars)`,
				);
			}
		} catch (err) {
			console.error(`[vault-crdt-sync] flushWrite failed for "${path}":`, err);
		}
	}

	private async handleRemoteDelete(path: string): Promise<void> {
		const normalized = normalizePath(path);
		// Unbind editor before suppressed delete so the vault `delete` event
		// (which skips unbind due to suppression) doesn't leave a stale binding.
		this.editorBindings.unbindByPath(normalized);
		const file = this.app.vault.getAbstractFileByPath(normalized);
		if (file instanceof TFile) {
			try {
				this.suppress(path);
				await this.app.vault.delete(file);
				this.log(`handleRemoteDelete: deleted "${path}" from disk`);
			} catch (err) {
				console.error(
					`[vault-crdt-sync] handleRemoteDelete failed for "${path}":`,
					err,
				);
			}
		}
	}

	// -------------------------------------------------------------------
	// Suppression
	// -------------------------------------------------------------------

	isSuppressed(path: string): boolean {
		const until = this.suppressedPaths.get(path);
		if (!until) return false;
		if (Date.now() < until) return true;
		this.suppressedPaths.delete(path);
		return false;
	}

	private suppress(path: string): void {
		this.suppressedPaths.set(path, Date.now() + SUPPRESS_MS);
	}

	// -------------------------------------------------------------------
	// State
	// -------------------------------------------------------------------

	get activeObserverCount(): number {
		return this.textObservers.size;
	}

	get pendingWriteCount(): number {
		return this.writeQueue.size + this.debounceTimers.size;
	}

	// -------------------------------------------------------------------
	// Cleanup
	// -------------------------------------------------------------------

	destroy(): void {
		for (const cleanup of this.mapObserverCleanups) {
			cleanup();
		}
		this.mapObserverCleanups = [];

		for (const [, obs] of this.textObservers) {
			obs.ytext.unobserve(obs.handler);
		}
		this.textObservers.clear();

		for (const timer of this.debounceTimers.values()) {
			clearTimeout(timer);
		}
		this.debounceTimers.clear();

		this.writeQueue.clear();
		this.suppressedPaths.clear();
		this.log("DiskMirror destroyed");
	}

	private log(msg: string): void {
		if (this.debug) {
			console.log(`[vault-crdt-sync:disk] ${msg}`);
		}
	}
}
