import { MarkdownView, Modal, Notice, Plugin, TFile } from "obsidian";
import {
	DEFAULT_SETTINGS,
	VaultSyncSettingTab,
	generateVaultId,
	type VaultSyncSettings,
} from "./settings";
import { VaultSync, type ReconcileMode } from "./sync/vaultSync";
import { EditorBindingManager } from "./sync/editorBinding";
import { DiskMirror } from "./sync/diskMirror";
import { BlobSyncManager, type BlobQueueSnapshot } from "./sync/blobSync";
import { parseExcludePatterns } from "./sync/exclude";
import { isMarkdownSyncable, isBlobSyncable } from "./types";
import { applyDiffToYText } from "./sync/diff";
import {
	type DiskIndex,
	filterChangedFiles,
	updateIndex,
	moveIndexEntries,
	waitForStable,
} from "./sync/diskIndex";
import {
	type BlobHashCache,
	moveCachedHashes,
} from "./sync/blobHashCache";
import {
	requestDailySnapshot,
	requestSnapshotNow,
	listSnapshots as fetchSnapshotList,
	downloadSnapshot,
	diffSnapshot,
	restoreFromSnapshot,
	type SnapshotIndex,
	type SnapshotDiff,
} from "./sync/snapshotClient";

type SyncStatus = "disconnected" | "loading" | "syncing" | "connected" | "offline" | "error" | "unauthorized";

/** Minimum interval between reconcile runs (prevents rapid reconnect churn). */
const RECONCILE_COOLDOWN_MS = 10_000;

export default class VaultCrdtSyncPlugin extends Plugin {
	settings: VaultSyncSettings = DEFAULT_SETTINGS;

	private vaultSync: VaultSync | null = null;
	private editorBindings: EditorBindingManager | null = null;
	private diskMirror: DiskMirror | null = null;
	private blobSync: BlobSyncManager | null = null;
	private statusBarEl: HTMLElement | null = null;
	private statusInterval: ReturnType<typeof setInterval> | null = null;

	/**
	 * True after initial reconciliation is complete.
	 * Vault events are ignored before this.
	 */
	private reconciled = false;

	/** True while a reconciliation is running — prevents overlapping runs. */
	private reconcileInFlight = false;

	/** Set to true if a reconnect arrives while reconciliation is in-flight. */
	private reconcilePending = false;

	/**
	 * Files on disk that weren't imported during conservative reconciliation.
	 * Imported when the provider eventually syncs.
	 */
	private untrackedFiles: string[] = [];

	/**
	 * The connection generation at which we last reconciled.
	 * Used to detect reconnects that need re-reconciliation.
	 */
	private lastReconciledGeneration = 0;

	/** Visibility change handler reference for cleanup. */
	private visibilityHandler: (() => void) | null = null;

	/** Track the set of currently observed file paths for disk mirror cleanup. */
	private openFilePaths = new Set<string>();

	/** Parsed exclude patterns from settings. */
	private excludePatterns: string[] = [];

	/** Max file size in characters (derived from settings KB). */
	private maxFileSize = 0;

	/** Persisted disk index: {path -> {mtime, size}}. */
	private diskIndex: DiskIndex = {};

	/** Persisted blob hash cache: {path -> {mtime, size, hash}}. */
	private blobHashCache: BlobHashCache = {};

	/** Persisted blob queue snapshot for crash resilience. */
	private savedBlobQueue: BlobQueueSnapshot | null = null;

	/** Pending stability checks for newly created/dropped files. */
	private pendingStabilityChecks = new Set<string>();

	/** Last time a reconciliation completed (for cooldown). */
	private lastReconcileTime = 0;

	/** Timer for delayed reconcile after cooldown expires. */
	private reconcileCooldownTimer: ReturnType<typeof setTimeout> | null = null;

	async onload() {
		await this.loadSettings();

		if (!this.settings.vaultId) {
			this.settings.vaultId = generateVaultId();
			await this.saveSettings();
			this.log(`Generated vault ID: ${this.settings.vaultId}`);
		}

		if (!this.settings.deviceName) {
			this.settings.deviceName = `device-${Date.now().toString(36)}`;
			await this.saveSettings();
		}

		this.addSettingTab(new VaultSyncSettingTab(this.app, this));

		this.statusBarEl = this.addStatusBarItem();
		this.updateStatusBar("disconnected");

		if (!this.settings.host || !this.settings.token) {
			this.log("Host or token not configured — sync disabled");
			new Notice(
				"Vault CRDT sync: configure host and token in settings to enable sync.",
			);
			return;
		}

		// Parse exclude patterns and file size limit from settings
		this.excludePatterns = parseExcludePatterns(this.settings.excludePatterns);
		this.maxFileSize = this.settings.maxFileSizeKB * 1024;

		this.applyCursorVisibility();

		// Warn about insecure connections to non-localhost hosts
		if (this.settings.host) {
			try {
				const url = new URL(this.settings.host);
				const h = url.hostname;
				if (url.protocol === "http:" && h !== "localhost" && h !== "127.0.0.1" && h !== "[::1]") {
					this.log("WARNING: connecting over unencrypted HTTP to a remote host — token sent in plaintext");
					new Notice(
						"Vault CRDT sync: connecting over unencrypted HTTP. Your token will be sent in plaintext. Use https:// for production.",
						8000,
					);
				}
			} catch { /* invalid URL, will fail at connect */ }
		}

		void this.initSync();
	}

	private async initSync(): Promise<void> {
		try {
			// 1. Create VaultSync (Y.Doc + IndexedDB + provider in parallel)
			this.vaultSync = new VaultSync(this.settings);

			// 2. EditorBindingManager
			this.editorBindings = new EditorBindingManager(
				this.vaultSync,
				this.settings.debug,
			);

			// 3. Global CM6 extension
			this.registerEditorExtension(
				this.editorBindings.getBaseExtension(),
			);

			// 4. DiskMirror
			this.diskMirror = new DiskMirror(
				this.app,
				this.vaultSync,
				this.editorBindings,
				this.settings.debug,
			);
			this.diskMirror.startMapObservers();

			// 4b. BlobSyncManager (if attachment sync is enabled)
			if (this.settings.enableAttachmentSync) {
				this.blobSync = new BlobSyncManager(
					this.app,
					this.vaultSync,
					{
						host: this.settings.host,
						token: this.settings.token,
						vaultId: this.settings.vaultId,
						maxAttachmentSizeKB: this.settings.maxAttachmentSizeKB,
						attachmentConcurrency: this.settings.attachmentConcurrency,
						debug: this.settings.debug,
					},
					this.blobHashCache,
				);
				this.blobSync.startObservers();

				// Restore persisted queue from previous session
				if (this.savedBlobQueue) {
					this.blobSync.importQueue(this.savedBlobQueue);
					this.savedBlobQueue = null;
				}
			}

			// 5. Status tracking
			this.vaultSync.provider.on("status", () => this.refreshStatusBar());
			this.statusInterval = setInterval(() => {
				this.refreshStatusBar();
				// Periodically persist blob queue if transfers are active,
				// or clear persisted queue if transfers completed
				if (this.blobSync) {
					if (this.blobSync.pendingUploads > 0 || this.blobSync.pendingDownloads > 0) {
						void this.saveBlobQueue();
					} else {
						void this.clearSavedBlobQueue();
					}
				}
			}, 3000);
			this.register(() => {
				if (this.statusInterval) clearInterval(this.statusInterval);
			});

			// 6. Vault events (gated by this.reconciled)
			this.registerVaultEvents();

			// 7. Commands
			this.registerCommands();

			// 8. Rename batch callback → update editor bindings + disk mirror observers + disk index + blob hash cache
			this.vaultSync.onRenameBatchFlushed((renames) => {
				this.editorBindings?.updatePathsAfterRename(renames);

				// Move disk index entries
				moveIndexEntries(this.diskIndex, renames);

				// Move blob hash cache entries
				moveCachedHashes(this.blobHashCache, renames);

				// Move disk mirror observers and openFilePaths tracking
				// for any paths that were open before the rename.
				for (const [oldPath, newPath] of renames) {
					if (this.openFilePaths.has(oldPath)) {
						this.diskMirror?.notifyFileClosed(oldPath);
						this.openFilePaths.delete(oldPath);
						this.diskMirror?.notifyFileOpened(newPath);
						this.openFilePaths.add(newPath);
						this.log(`Rename batch: moved observer "${oldPath}" -> "${newPath}"`);
					}
				}
			});

			// 9. Reconnection: re-reconcile when provider re-syncs
			this.setupReconnectionHandler();

			// 10. Visibility change: force reconnect on foreground
			this.setupVisibilityHandler();

			// -----------------------------------------------------------
			// STARTUP SEQUENCE
			// -----------------------------------------------------------

			this.updateStatusBar("loading");
			this.log("Waiting for IndexedDB persistence...");
			const localLoaded = await this.vaultSync.waitForLocalPersistence();
			this.log(`IndexedDB: ${localLoaded ? "loaded" : "timed out"}`);

			// Schema version check — refuse to run if a newer plugin wrote this data
			const schemaError = this.vaultSync.checkSchemaVersion();
			if (schemaError) {
				console.error(`[vault-crdt-sync] ${schemaError}`);
				new Notice(`Vault CRDT sync: ${schemaError}`);
				this.updateStatusBar("error");
				return;
			}

			// Check for fatal auth error before waiting for provider
			if (this.vaultSync.fatalAuthError) {
				this.log("Fatal auth error during startup");
				this.updateStatusBar("unauthorized");
				new Notice("Vault CRDT sync: unauthorized — check your token in settings.");
				// Still reconcile with whatever we have locally
				const mode = this.vaultSync.getSafeReconcileMode();
				await this.runReconciliation(mode);
				this.bindAllOpenEditors();
				return;
			}

			this.updateStatusBar("syncing");
			this.log("Waiting for provider sync...");
			const providerSynced = await this.vaultSync.waitForProviderSync();
			this.log(`Provider: ${providerSynced ? "synced" : "timed out (offline)"}`);

			if (this.vaultSync.fatalAuthError) {
				this.updateStatusBar("unauthorized");
				new Notice("Vault CRDT sync: unauthorized — check your token in settings.");
				return;
			}

			const mode = this.vaultSync.getSafeReconcileMode();
			this.log(`Reconciliation mode: ${mode}`);

			await this.runReconciliation(mode);
			this.lastReconciledGeneration = this.vaultSync.connectionGeneration;

			this.bindAllOpenEditors();

			this.refreshStatusBar();
			this.log("Startup complete");

			// Trigger daily snapshot (noop if already taken today).
			// Fire-and-forget — don't block startup on snapshot creation.
			if (providerSynced) {
				void this.triggerDailySnapshot();
			}
		} catch (err) {
			console.error("[vault-crdt-sync] Failed to initialize sync:", err);
			new Notice(`Vault CRDT sync: failed to initialize — ${err}`);
			this.updateStatusBar("error");
		}
	}

	// -------------------------------------------------------------------
	// Reconnection
	// -------------------------------------------------------------------

	/**
	 * Listen for provider sync events after initial startup.
	 * When the provider syncs at a new generation (reconnect), trigger
	 * an authoritative re-reconciliation to catch any drift.
	 */
	private setupReconnectionHandler(): void {
		if (!this.vaultSync) return;

		this.vaultSync.onProviderSync((generation) => {
			// Skip the initial sync — that's handled by the startup sequence
			if (!this.reconciled) return;

			// Skip if we already reconciled at this generation
			if (generation <= this.lastReconciledGeneration) return;

			this.log(`Reconnect detected (gen ${generation}) — scheduling re-reconciliation`);

			if (this.reconcileInFlight) {
				this.reconcilePending = true;
				return;
			}

			void this.runReconnectReconciliation(generation);
		});
	}

	/**
	 * Lightweight authoritative reconcile after a reconnection.
	 * Fresh disk read to catch any drift during disconnect.
	 */
	private async runReconnectReconciliation(generation: number): Promise<void> {
		if (!this.vaultSync) return;

		this.log(`Running reconnect reconciliation (gen ${generation})`);

		// Also import any untracked files from a previous conservative run
		if (this.untrackedFiles.length > 0) {
			await this.importUntrackedFiles();
		}

		await this.runReconciliation("authoritative");
		this.lastReconciledGeneration = generation;
		this.bindAllOpenEditors();

		// If another reconnect arrived during this reconcile, run again
		if (this.reconcilePending) {
			this.reconcilePending = false;
			if (this.vaultSync.connectionGeneration > this.lastReconciledGeneration) {
				void this.runReconnectReconciliation(this.vaultSync.connectionGeneration);
			}
		}
	}

	/**
	 * On visibility change (foreground): if the provider is disconnected,
	 * force a reconnect. Handles Android backgrounding and desktop
	 * sleep/wake where sockets silently die.
	 */
	private setupVisibilityHandler(): void {
		this.visibilityHandler = () => {
			if (document.visibilityState !== "visible") return;
			if (!this.vaultSync) return;
			if (this.vaultSync.fatalAuthError) return;

			if (!this.vaultSync.connected) {
				this.log("App foregrounded — provider disconnected, forcing reconnect");
				this.vaultSync.provider.disconnect();
				this.vaultSync.provider.connect();
			}
		};

		document.addEventListener("visibilitychange", this.visibilityHandler);
		this.register(() => {
			if (this.visibilityHandler) {
				document.removeEventListener("visibilitychange", this.visibilityHandler);
			}
		});
	}

	// -------------------------------------------------------------------
	// Reconciliation
	// -------------------------------------------------------------------

	private async runReconciliation(mode: ReconcileMode): Promise<void> {
		if (!this.vaultSync || !this.diskMirror) return;
		if (this.reconcileInFlight) {
			this.reconcilePending = true;
			this.log("Reconciliation already in flight — queued");
			return;
		}

		// Cooldown: prevent rapid successive reconciliations (flaky Wi-Fi)
		const now = Date.now();
		const elapsed = now - this.lastReconcileTime;
		if (this.lastReconcileTime > 0 && elapsed < RECONCILE_COOLDOWN_MS) {
			const delay = RECONCILE_COOLDOWN_MS - elapsed;
			this.log(`Reconcile cooldown: ${delay}ms remaining, scheduling delayed run`);
			this.reconcilePending = true;
			if (!this.reconcileCooldownTimer) {
				this.reconcileCooldownTimer = setTimeout(() => {
					this.reconcileCooldownTimer = null;
					if (this.reconcilePending) {
						this.reconcilePending = false;
						const m = this.vaultSync?.getSafeReconcileMode() ?? mode;
						void this.runReconciliation(m);
					}
				}, delay);
			}
			return;
		}

		this.reconcileInFlight = true;

		try {
			const diskFiles = new Map<string, string>();
			const allMdFiles = this.app.vault.getMarkdownFiles();
			let excludedCount = 0;
			let oversizedCount = 0;
			let skippedByIndex = 0;

			// Filter by exclude patterns first
			const eligibleFiles: TFile[] = [];
			for (const file of allMdFiles) {
				if (!isMarkdownSyncable(file.path, this.excludePatterns)) {
					excludedCount++;
					continue;
				}
				eligibleFiles.push(file);
			}

			// Use disk index to only read changed files
			const { changed, unchanged, allStats } = await filterChangedFiles(
				this.app,
				eligibleFiles,
				this.diskIndex,
			);
			skippedByIndex = unchanged.length;

			// For unchanged files, we still need them in the diskFiles map
			// so reconcileVault knows they exist on disk (for the "disk-only
			// vs CRDT-only" comparison). But we use a sentinel instead of
			// actual content to avoid reading them.
			// We mark them with a special marker and handle them in reconcileVault
			// by checking CRDT existence only (no content comparison needed).
			for (const file of unchanged) {
				// File exists on disk and hasn't changed — just mark presence
				// Use empty string as placeholder; reconcileVault only needs
				// to know the path exists for the "disk-only" check.
				// Content comparison isn't needed because nothing changed.
				const existingText = this.vaultSync.getTextForPath(file.path);
				if (existingText) {
					// Both exist and disk unchanged → skip read entirely
					continue;
				}
				// Disk-only (not in CRDT) but unchanged → need to read for seeding
				try {
					const content = await this.app.vault.read(file);
					if (this.maxFileSize > 0 && content.length > this.maxFileSize) {
						oversizedCount++;
						continue;
					}
					diskFiles.set(file.path, content);
				} catch (err) {
					console.error(
						`[vault-crdt-sync] Failed to read "${file.path}":`,
						err,
					);
				}
			}

			// Read changed files
			for (const file of changed) {
				try {
					const content = await this.app.vault.read(file);
					if (this.maxFileSize > 0 && content.length > this.maxFileSize) {
						oversizedCount++;
						this.log(`reconcile: skipping "${file.path}" (${Math.round(content.length / 1024)} KB exceeds limit)`);
						continue;
					}
					diskFiles.set(file.path, content);
				} catch (err) {
					console.error(
						`[vault-crdt-sync] Failed to read "${file.path}" during reconciliation:`,
						err,
					);
				}
			}

			if (excludedCount > 0) {
				this.log(`reconcile: excluded ${excludedCount} files by pattern`);
			}
			if (oversizedCount > 0) {
				this.log(`reconcile: skipped ${oversizedCount} oversized files`);
				new Notice(`Vault CRDT sync: skipped ${oversizedCount} files exceeding ${this.settings.maxFileSizeKB} KB size limit.`);
			}
			if (skippedByIndex > 0) {
				this.log(`reconcile: ${skippedByIndex} files unchanged (stat match), ${changed.length} changed`);
			}

			this.log(
				`Reconciling [${mode}]: ${diskFiles.size} disk files (${changed.length} read) vs ` +
				`${this.vaultSync.pathToId.size} CRDT paths`,
			);

			const result = this.vaultSync.reconcileVault(
				diskFiles,
				mode,
				this.settings.deviceName,
			);

			for (const path of result.createdOnDisk) {
				await this.diskMirror.flushWrite(path);
			}

			this.untrackedFiles = result.untracked;
			this.reconciled = true;

			// Update disk index with fresh stats
			this.diskIndex = updateIndex(this.diskIndex, allStats);
			void this.saveDiskIndex();

			// Run integrity checks after reconciliation (orphan GC + duplicate detection)
			const integrity = this.vaultSync.runIntegrityChecks();
			if (integrity.duplicateIds > 0 || integrity.orphansCleaned > 0) {
				this.log(
					`Integrity: ${integrity.duplicateIds} duplicate IDs fixed, ` +
					`${integrity.orphansCleaned} orphans cleaned`,
				);
			}

			this.log(
				`Reconciliation [${mode}] complete: ` +
				`${result.seededToCrdt.length} seeded, ` +
				`${result.createdOnDisk.length} created on disk, ` +
				`${result.untracked.length} untracked, ` +
				`${result.skipped} tombstoned`,
			);

			// Blob reconciliation (if enabled)
			if (this.blobSync) {
				const blobResult = await this.blobSync.reconcile(
					mode,
					this.excludePatterns,
				);
				this.log(
					`Blob reconciliation [${mode}]: ` +
					`${blobResult.uploadQueued} uploads, ` +
					`${blobResult.downloadQueued} downloads, ` +
					`${blobResult.skipped} skipped`,
				);
			}
		} finally {
			this.reconcileInFlight = false;
			this.lastReconcileTime = Date.now();
		}
	}

	private async importUntrackedFiles(): Promise<void> {
		if (!this.vaultSync) return;

		const toImport = [...this.untrackedFiles];
		this.untrackedFiles = [];
		let imported = 0;

		for (const path of toImport) {
			if (this.vaultSync.getTextForPath(path)) {
				this.log(`importUntracked: "${path}" now in CRDT, skipping`);
				continue;
			}

			const file = this.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) continue;

			try {
				const content = await this.app.vault.read(file);
				this.vaultSync.ensureFile(path, content, this.settings.deviceName);
				imported++;
			} catch (err) {
				console.error(
					`[vault-crdt-sync] importUntracked failed for "${path}":`,
					err,
				);
			}
		}

		if (!this.vaultSync.isInitialized) {
			this.vaultSync.markInitialized();
		}

		this.refreshStatusBar();
		this.log(`Imported ${imported} previously untracked files`);

		if (imported > 0) {
			new Notice(`Vault CRDT sync: imported ${imported} files after server sync.`);
		}
	}

	// -------------------------------------------------------------------
	// Editor binding
	// -------------------------------------------------------------------

	private bindAllOpenEditors(): void {
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view instanceof MarkdownView) {
				this.editorBindings?.bind(leaf.view, this.settings.deviceName);
				if (leaf.view.file) {
					this.trackOpenFile(leaf.view.file.path);
				}
			}
		});
	}

	/**
	 * Track that a file is open. Notifies diskMirror to start observing.
	 * Also cleans up observers for files that are no longer open in any leaf.
	 */
	private trackOpenFile(path: string): void {
		// Notify disk mirror for the newly opened file
		if (!this.openFilePaths.has(path)) {
			this.diskMirror?.notifyFileOpened(path);
			this.openFilePaths.add(path);
		}

		// Scan all leaves to find which files are actually still open
		const currentlyOpen = new Set<string>();
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view instanceof MarkdownView && leaf.view.file) {
				currentlyOpen.add(leaf.view.file.path);
			}
		});

		// Close observers for files no longer open in any leaf
		for (const tracked of this.openFilePaths) {
			if (!currentlyOpen.has(tracked)) {
				this.diskMirror?.notifyFileClosed(tracked);
				this.openFilePaths.delete(tracked);
				this.log(`Closed observer for "${tracked}" (no longer open)`);
			}
		}
	}

	// -------------------------------------------------------------------
	// Vault event handlers
	// -------------------------------------------------------------------

	private registerVaultEvents(): void {
		// Layout change: clean up observers for closed files
		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				if (!this.reconciled) return;
				const currentlyOpen = new Set<string>();
				this.app.workspace.iterateAllLeaves((leaf) => {
					if (leaf.view instanceof MarkdownView && leaf.view.file) {
						currentlyOpen.add(leaf.view.file.path);
					}
				});
				for (const tracked of this.openFilePaths) {
					if (!currentlyOpen.has(tracked)) {
						this.diskMirror?.notifyFileClosed(tracked);
						this.openFilePaths.delete(tracked);
						this.log(`layout-change: closed observer for "${tracked}"`);
					}
				}
			}),
		);

		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				if (!this.reconciled || !leaf) return;
				const view = leaf.view;
				if (view instanceof MarkdownView) {
					this.editorBindings?.bind(view, this.settings.deviceName);
					if (view.file) {
						this.trackOpenFile(view.file.path);
					}
				}
			}),
		);

		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (!this.reconciled || !file) return;
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (view && view.file?.path === file.path) {
					this.editorBindings?.bind(view, this.settings.deviceName);
					this.trackOpenFile(file.path);
				}

				// Prefetch embedded attachments for the opened note
				if (file.path.endsWith(".md") && this.blobSync) {
					this.prefetchEmbeddedAttachments(file);
				}
			}),
		);

		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (!this.reconciled) return;
				if (!(file instanceof TFile)) return;

				if (isMarkdownSyncable(file.path, this.excludePatterns)) {
					if (this.diskMirror?.isSuppressed(file.path)) {
						this.log(`Suppressed modify event for "${file.path}"`);
						return;
					}
					void this.syncFileFromDisk(file);
				} else if (this.blobSync && isBlobSyncable(file.path, this.excludePatterns) && !this.blobSync.isSuppressed(file.path)) {
					this.blobSync.handleFileChange(file);
				}
			}),
		);

		// Rename: use batched queueRename for atomic folder renames.
		// Both markdown and blob files go through the same rename batch
		// since folder renames affect both types atomically.
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (!this.reconciled) return;
				if (!(file instanceof TFile)) return;
				// Rename is relevant if either the old or new path is syncable
				const newSyncable = isMarkdownSyncable(file.path, this.excludePatterns)
					|| isBlobSyncable(file.path, this.excludePatterns);
				const oldSyncable = isMarkdownSyncable(oldPath, this.excludePatterns)
					|| isBlobSyncable(oldPath, this.excludePatterns);
				if (!newSyncable && !oldSyncable) return;
				this.vaultSync?.queueRename(oldPath, file.path);
				this.log(`Rename queued: "${oldPath}" -> "${file.path}"`);
			}),
		);

		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (!this.reconciled) return;
				if (!(file instanceof TFile)) return;

				if (isMarkdownSyncable(file.path, this.excludePatterns)) {
					if (this.diskMirror?.isSuppressed(file.path)) {
						this.log(`Suppressed delete event for "${file.path}"`);
						return;
					}
					this.editorBindings?.unbindByPath(file.path);
					this.diskMirror?.notifyFileClosed(file.path);
					this.openFilePaths.delete(file.path);

					this.vaultSync?.handleDelete(
						file.path,
						this.settings.deviceName,
					);
					this.log(`Delete: "${file.path}"`);
				} else if (this.blobSync && isBlobSyncable(file.path, this.excludePatterns) && !this.blobSync.isSuppressed(file.path)) {
					this.blobSync.handleFileDelete(file.path, this.settings.deviceName);
					this.log(`Delete (blob): "${file.path}"`);
				}
			}),
		);

		this.registerEvent(
			this.app.vault.on("create", (file) => {
				if (!this.reconciled) return;
				if (!(file instanceof TFile)) return;

				if (isMarkdownSyncable(file.path, this.excludePatterns)) {
					if (this.diskMirror?.isSuppressed(file.path)) return;

					// Debounce rapid creates (like unzip or folder paste)
					if (this.pendingStabilityChecks.has(file.path)) return;
					this.pendingStabilityChecks.add(file.path);

					// Wait for file stability (OS writes to finish) before importing
					void waitForStable(this.app, file.path).then((stable) => {
						this.pendingStabilityChecks.delete(file.path);
						if (stable) {
							void this.syncFileFromDisk(file);
						} else {
							this.log(`Create: "${file.path}" unstable after timeout, skipping import`);
						}
					});
				} else if (this.blobSync && isBlobSyncable(file.path, this.excludePatterns) && !this.blobSync.isSuppressed(file.path)) {
					// For blob files, use the same stability check before uploading
					if (this.pendingStabilityChecks.has(file.path)) return;
					this.pendingStabilityChecks.add(file.path);

					void waitForStable(this.app, file.path).then((stable) => {
						this.pendingStabilityChecks.delete(file.path);
						if (stable) {
							this.blobSync?.handleFileChange(file);
						} else {
							this.log(`Create (blob): "${file.path}" unstable after timeout, skipping`);
						}
					});
				}
			}),
		);
	}

	// -------------------------------------------------------------------
	// Teardown + reinit (for reset commands)
	// -------------------------------------------------------------------

	/**
	 * Cleanly tear down all sync state: unbind editors, stop disk mirror,
	 * destroy provider + persistence + ydoc, reset all flags.
	 * After this, the plugin is in the same state as before initSync().
	 */
	private teardownSync(): void {
		this.log("teardownSync: tearing down all sync state");

		this.editorBindings?.unbindAll();
		this.diskMirror?.destroy();

		// Persist blob queue before destroying (crash resilience)
		if (this.blobSync) {
			const snapshot = this.blobSync.exportQueue();
			if (snapshot.uploads.length > 0 || snapshot.downloads.length > 0) {
				// Fire-and-forget — teardown can't be async
				void this.saveBlobQueue();
			}
		}
		this.blobSync?.destroy();

		if (this.statusInterval) {
			clearInterval(this.statusInterval);
			this.statusInterval = null;
		}
		if (this.reconcileCooldownTimer) {
			clearTimeout(this.reconcileCooldownTimer);
			this.reconcileCooldownTimer = null;
		}

		this.vaultSync?.destroy();

		this.vaultSync = null;
		this.editorBindings = null;
		this.diskMirror = null;
		this.blobSync = null;
		this.reconciled = false;
		this.reconcileInFlight = false;
		this.reconcilePending = false;
		this.untrackedFiles = [];
		this.lastReconciledGeneration = 0;
		this.openFilePaths.clear();

		this.updateStatusBar("disconnected");
	}

	// -------------------------------------------------------------------
	// Commands
	// -------------------------------------------------------------------

	private registerCommands(): void {
		this.addCommand({
			id: "vault-crdt-sync-reconnect",
			name: "Reconnect to sync server",
			callback: () => {
				if (this.vaultSync) {
					this.vaultSync.provider.disconnect();
					this.vaultSync.provider.connect();
					new Notice("Vault CRDT sync: reconnecting...");
				}
			},
		});

		this.addCommand({
			id: "vault-crdt-sync-force-reconcile",
			name: "Force reconcile vault with CRDT",
			callback: () => {
				if (!this.vaultSync) return;
				const mode = this.vaultSync.getSafeReconcileMode();
				void this.runReconciliation(mode).then(() => {
					this.bindAllOpenEditors();
				});
			},
		});

		this.addCommand({
			id: "vault-crdt-sync-debug-status",
			name: "Show sync debug info",
			callback: () => {
				const info = this.buildDebugInfo();
				new Notice(info, 10000);
				console.log("[vault-crdt-sync] Debug status:\n" + info);
			},
		});

		this.addCommand({
			id: "vault-crdt-sync-copy-debug",
			name: "Copy debug info to clipboard",
			callback: () => {
				const info = this.buildDebugInfo();
				navigator.clipboard.writeText(info).then(
					() => new Notice("Debug info copied to clipboard."),
					() => new Notice("Failed to copy to clipboard. Check console.", 5000),
				);
				console.log("[vault-crdt-sync] Debug info:\n" + info);
			},
		});

		this.addCommand({
			id: "vault-crdt-sync-import-untracked",
			name: "Import untracked files now",
			callback: () => {
				if (!this.vaultSync) {
					new Notice("Sync not initialized");
					return;
				}
				if (this.untrackedFiles.length === 0) {
					new Notice("No untracked files to import.");
					return;
				}
				const count = this.untrackedFiles.length;
				void this.importUntrackedFiles().then(() => {
					new Notice(`Imported ${count} untracked file(s).`);
				});
			},
		});

		this.addCommand({
			id: "vault-crdt-sync-reset-cache",
			name: "Reset local cache (re-sync from server)",
			callback: () => {
				if (!this.vaultSync) {
					new Notice("Sync not initialized");
					return;
				}

				const vaultId = this.settings.vaultId;
				new ConfirmModal(
					this.app,
					"Reset local cache",
					"This will clear the local IndexedDB cache and re-sync from the server. " +
					"Your disk files and server state are not affected. Continue?",
					async () => {
						this.log("Reset cache: starting");
						new Notice("Vault CRDT sync: clearing cache and re-syncing...");

						this.teardownSync();

						try {
							await VaultSync.deleteIdb(vaultId);
							this.log("Reset cache: IDB deleted");
						} catch (err) {
							console.error("[vault-crdt-sync] Failed to delete IDB:", err);
						}

						this.log("Reset cache: reinitializing");
						await this.initSync();
						new Notice("Vault CRDT sync: cache reset complete.");
					},
				).open();
			},
		});

		// --- Snapshot commands ---

		this.addCommand({
			id: "vault-crdt-sync-snapshot-now",
			name: "Take snapshot now",
			callback: async () => {
				if (!this.vaultSync) {
					new Notice("Sync not initialized");
					return;
				}
				if (!this.vaultSync.connected) {
					new Notice("Not connected to server — cannot create snapshot.");
					return;
				}

				new Notice("Creating snapshot...");
				try {
					const result = await requestSnapshotNow(
						this.settings,
						this.settings.deviceName,
					);
					if (result.status === "created" && result.index) {
						new Notice(
							`Snapshot created: ${result.index.markdownFileCount} notes, ` +
							`${result.index.blobFileCount} attachments ` +
							`(${Math.round(result.index.crdtSizeBytes / 1024)} KB)`,
						);
					} else if (result.status === "unavailable") {
						new Notice(`Snapshot unavailable: ${result.reason ?? "R2 not configured"}`);
					} else {
						new Notice("Snapshot created.");
					}
				} catch (err) {
					console.error("[vault-crdt-sync] Snapshot failed:", err);
					new Notice(`Snapshot failed: ${err}`);
				}
			},
		});

		this.addCommand({
			id: "vault-crdt-sync-snapshot-list",
			name: "Browse and restore snapshots",
			callback: async () => {
				if (!this.vaultSync) {
					new Notice("Sync not initialized");
					return;
				}
				if (!this.vaultSync.connected) {
					new Notice("Not connected to server — cannot browse snapshots.");
					return;
				}
				await this.showSnapshotList();
			},
		});

		// --- Reset commands ---

		this.addCommand({
			id: "vault-crdt-sync-nuclear-reset",
			name: "Nuclear reset (wipe CRDT, re-seed from disk)",
			callback: () => {
				if (!this.vaultSync) {
					new Notice("Sync not initialized");
					return;
				}

				const pathCount = this.vaultSync.pathToId.size;
				new ConfirmModal(
					this.app,
					"Nuclear reset",
					`This will wipe all CRDT state (${pathCount} files) on both this device and the server, ` +
					`clear the local cache, then re-seed everything from your current disk files. ` +
					`Other connected devices will also see the reset. This cannot be undone. Continue?`,
					async () => {
						this.log("Nuclear reset: starting");
						new Notice("Vault CRDT sync: nuclear reset in progress...");

						// Clear CRDT maps BEFORE teardown so the deletions propagate
						// to the server while the provider is still connected.
						const counts = this.vaultSync!.clearAllMaps();
						this.log(
							`Nuclear reset: cleared ${counts.pathCount} paths, ` +
							`${counts.idCount} texts, ${counts.metaCount} meta, ` +
							`${counts.blobCount} blob paths`,
						);

						// Give the provider a moment to sync the deletions to server
						await new Promise((r) => setTimeout(r, 500));

						const vaultId = this.settings.vaultId;
						this.teardownSync();

						try {
							await VaultSync.deleteIdb(vaultId);
							this.log("Nuclear reset: IDB deleted");
						} catch (err) {
							console.error("[vault-crdt-sync] Failed to delete IDB:", err);
						}

						this.log("Nuclear reset: reinitializing (will re-seed from disk)");
						await this.initSync();
						new Notice(
							`Vault CRDT sync: nuclear reset complete. ` +
							`Re-seeded ${this.vaultSync?.pathToId.size ?? 0} files from disk.`,
						);
					},
				).open();
			},
		});
	}

	// -------------------------------------------------------------------
	// Helpers
	// -------------------------------------------------------------------

	/**
	 * When a note opens, parse its embedded links (![[...]]) via Obsidian's
	 * metadata cache and prefetch any missing blob attachments from R2.
	 * This ensures images/PDFs render immediately rather than waiting for
	 * the next reconcile or CRDT observer to trigger the download.
	 */
	private prefetchEmbeddedAttachments(file: TFile): void {
		if (!this.blobSync) return;

		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache?.embeds) return;

		const pathsToFetch: string[] = [];

		for (const embed of cache.embeds) {
			// Resolve the link to an actual vault path.
			// getFirstLinkpathDest handles relative paths, aliases, etc.
			const resolved = this.app.metadataCache.getFirstLinkpathDest(
				embed.link,
				file.path,
			);

			if (resolved) {
				// File already exists on disk — skip
				continue;
			}

			// File doesn't exist on disk. Try to find it in the CRDT blob map.
			// The link could be just a filename (e.g. "image.png") or a path.
			// Check both the raw link text and common attachment patterns.
			const linkPath = (embed.link.split("#")[0] ?? "").split("|")[0] ?? ""; // strip anchors/aliases

			// Search pathToBlob for a matching path
			let blobPath: string | null = null;
			this.vaultSync?.pathToBlob.forEach((_ref, candidatePath) => {
				if (blobPath) return; // already found
				// Exact match
				if (candidatePath === linkPath) {
					blobPath = candidatePath;
					return;
				}
				// Filename-only match (Obsidian's default "shortest path" mode)
				const candidateFilename = candidatePath.split("/").pop();
				if (candidateFilename === linkPath) {
					blobPath = candidatePath;
				}
			});

			if (blobPath) {
				pathsToFetch.push(blobPath);
			}
		}

		if (pathsToFetch.length > 0) {
			const queued = this.blobSync.prioritizeDownloads(pathsToFetch);
			if (queued > 0) {
				this.log(`prefetch: queued ${queued} attachments for "${file.path}"`);
			}
		}
	}

	private async syncFileFromDisk(file: TFile): Promise<void> {
		if (!this.vaultSync) return;
		if (!isMarkdownSyncable(file.path, this.excludePatterns)) return;

		// Always skip files currently bound to an editor. When a file is
		// open, the editor → yCollab pipeline is the authoritative source
		// of truth. Reading from disk and diffing back into the Y.Text
		// is redundant and can cause cursor jumps during fast typing.
		if (this.editorBindings?.isBound(file.path)) {
			this.log(`syncFileFromDisk: skipping "${file.path}" (editor-bound)`);
			return;
		}

		// External edit policy gate: control whether disk changes to
		// *closed* files are imported into the CRDT.
		const policy = this.settings.externalEditPolicy;
		if (policy === "never") {
			this.log(`syncFileFromDisk: skipping "${file.path}" (external edit policy: never)`);
			return;
		}

		try {
			const content = await this.app.vault.read(file);

			// File size guard
			if (this.maxFileSize > 0 && content.length > this.maxFileSize) {
				this.log(`syncFileFromDisk: skipping "${file.path}" (${Math.round(content.length / 1024)} KB exceeds limit)`);
				return;
			}
			const existingText = this.vaultSync.getTextForPath(file.path);

			if (existingText) {
				const crdtContent = existingText.toString();
				if (crdtContent === content) return;

				// Apply a line-level diff to the Y.Text instead of delete-all + insert-all.
				// This preserves CRDT history, cursor positions, and awareness state.
				// Works for both editor-bound files (external edit merges into live editor)
				// and unbound files (background sync).
				this.log(
					`syncFileFromDisk: applying diff to "${file.path}" (${crdtContent.length} -> ${content.length} chars)`,
				);
				applyDiffToYText(existingText, crdtContent, content, "disk-sync");
			} else {
				this.vaultSync.ensureFile(
					file.path,
					content,
					this.settings.deviceName,
				);
			}

			// Update disk index for this file
			try {
				const stat = await this.app.vault.adapter.stat(file.path);
				if (stat) {
					this.diskIndex[file.path] = { mtime: stat.mtime, size: stat.size };
				}
			} catch { /* stat failed, index will be stale for this path */ }
		} catch (err) {
			console.error(
				`[vault-crdt-sync] syncFileFromDisk failed for "${file.path}":`,
				err,
			);
		}
	}

	/**
	 * Toggle remote cursor visibility via a CSS class on the document body.
	 * The actual cursor styles from y-codemirror.next are hidden when the
	 * class is absent; we add it when showRemoteCursors is true.
	 */
	applyCursorVisibility(): void {
		document.body.toggleClass(
			"vault-crdt-show-cursors",
			this.settings.showRemoteCursors,
		);
	}

	private refreshStatusBar(): void {
		if (!this.vaultSync) {
			this.updateStatusBar("disconnected");
			return;
		}

		if (this.vaultSync.fatalAuthError) {
			this.updateStatusBar("unauthorized");
			return;
		}

		if (!this.reconciled) {
			if (this.vaultSync.connected) {
				this.updateStatusBar("syncing");
			} else if (this.vaultSync.localReady) {
				this.updateStatusBar("loading");
			} else {
				this.updateStatusBar("disconnected");
			}
			return;
		}

		if (this.vaultSync.connected) {
			this.updateStatusBar("connected");
		} else if (this.vaultSync.localReady) {
			this.updateStatusBar("offline");
		} else {
			this.updateStatusBar("disconnected");
		}
	}

	private updateStatusBar(state: SyncStatus): void {
		if (!this.statusBarEl) return;
		const labels: Record<SyncStatus, string> = {
			disconnected: "CRDT: Disconnected",
			loading: "CRDT: Loading cache...",
			syncing: "CRDT: Syncing...",
			connected: "CRDT: Connected",
			offline: "CRDT: Offline",
			error: "CRDT: Error",
			unauthorized: "CRDT: Unauthorized",
		};
		let text = labels[state];

		// Append blob transfer progress if active
		const transfer = this.blobSync?.transferStatus;
		if (transfer) {
			text += ` (${transfer})`;
		}

		this.statusBarEl.setText(text);
	}

	onunload() {
		this.log("Unloading plugin");
		document.body.removeClass("vault-crdt-show-cursors");
		this.teardownSync();
	}

	async loadSettings() {
		const data = (await this.loadData()) as Record<string, unknown> | null;
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			data as Partial<VaultSyncSettings>,
		);
		// Load disk index from plugin data (stored under _diskIndex key)
		if (data && typeof data._diskIndex === "object" && data._diskIndex !== null) {
			this.diskIndex = data._diskIndex as DiskIndex;
		}
		// Load blob hash cache
		if (data && typeof data._blobHashCache === "object" && data._blobHashCache !== null) {
			this.blobHashCache = data._blobHashCache as BlobHashCache;
		}
		// Load persisted blob queue
		if (data && typeof data._blobQueue === "object" && data._blobQueue !== null) {
			this.savedBlobQueue = data._blobQueue as BlobQueueSnapshot;
		}
	}

	async saveSettings() {
		await this.saveData({
			...this.settings,
			_diskIndex: this.diskIndex,
			_blobHashCache: this.blobHashCache,
		});
	}

	private async saveDiskIndex(): Promise<void> {
		// Save just the disk index without re-saving all settings
		// (loadData includes _diskIndex, so we merge)
		const data = (await this.loadData()) as Record<string, unknown> | null;
		await this.saveData({
			...data,
			...this.settings,
			_diskIndex: this.diskIndex,
			_blobHashCache: this.blobHashCache,
		});
	}

	private async saveBlobQueue(): Promise<void> {
		if (!this.blobSync) return;
		const snapshot = this.blobSync.exportQueue();
		// Only write if there's actually something to persist
		if (snapshot.uploads.length === 0 && snapshot.downloads.length === 0) return;
		const data = (await this.loadData()) as Record<string, unknown> | null;
		await this.saveData({
			...data,
			...this.settings,
			_blobQueue: snapshot,
			_blobHashCache: this.blobHashCache,
		});
	}

	/**
	 * Clear the persisted blob queue once all transfers are done.
	 * Only writes if there was previously a saved queue.
	 */
	private async clearSavedBlobQueue(): Promise<void> {
		const data = (await this.loadData()) as Record<string, unknown> | null;
		if (!data || !data._blobQueue) return;
		delete data._blobQueue;
		await this.saveData({
			...data,
			...this.settings,
			_blobHashCache: this.blobHashCache,
		});
	}

	private buildDebugInfo(): string {
		if (!this.vaultSync) return "Sync not initialized";
		return [
			`Host: ${this.settings.host || "(not set)"}`,
			`Vault ID: ${this.settings.vaultId || "(not set)"}`,
			`Device: ${this.settings.deviceName || "(unnamed)"}`,
			`Connected: ${this.vaultSync.connected}`,
			`Local ready: ${this.vaultSync.localReady}`,
			`Provider synced: ${this.vaultSync.providerSynced}`,
			`Initialized (sentinel): ${this.vaultSync.isInitialized}`,
			`Reconcile mode: ${this.vaultSync.getSafeReconcileMode()}`,
			`Reconciled: ${this.reconciled}`,
			`Connection generation: ${this.vaultSync.connectionGeneration}`,
			`Last reconciled gen: ${this.lastReconciledGeneration}`,
			`Fatal auth error: ${this.vaultSync.fatalAuthError}`,
			`IndexedDB error: ${this.vaultSync.idbError}`,
			`CRDT paths: ${this.vaultSync.pathToId.size}`,
			`Blob paths: ${this.vaultSync.pathToBlob.size}`,
			`Untracked files: ${this.untrackedFiles.length}`,
			`Active disk observers: ${this.diskMirror?.activeObserverCount ?? 0}`,
			`External edit policy: ${this.settings.externalEditPolicy}`,
			`Attachment sync: ${this.settings.enableAttachmentSync ? "enabled" : "disabled"}`,
			...(this.blobSync ? [
				`Pending uploads: ${this.blobSync.pendingUploads}`,
				`Pending downloads: ${this.blobSync.pendingDownloads}`,
			] : []),
			`Open files: ${this.openFilePaths.size}`,
			`Remote cursors: ${this.settings.showRemoteCursors ? "shown" : "hidden"}`,
		].join("\n");
	}

	// -------------------------------------------------------------------
	// Snapshot helpers
	// -------------------------------------------------------------------

	/**
	 * Request the daily snapshot from the server.
	 * Called after provider syncs during startup.
	 * Silent noop if R2 isn't configured or snapshot already taken today.
	 */
	private async triggerDailySnapshot(): Promise<void> {
		try {
			const result = await requestDailySnapshot(this.settings, this.settings.deviceName);
			if (result.status === "created") {
				this.log(`Daily snapshot created: ${result.snapshotId}`);
			} else if (result.status === "noop") {
				this.log(`Daily snapshot: already taken today`);
			} else {
				this.log(`Daily snapshot: ${result.reason ?? "unavailable"}`);
			}
		} catch (err) {
			// Don't spam the user — snapshot failure is non-critical
			console.warn("[vault-crdt-sync] Daily snapshot failed:", err);
		}
	}

	/**
	 * Show a list of available snapshots and let the user pick one to diff/restore.
	 */
	private async showSnapshotList(): Promise<void> {
		new Notice("Loading snapshots...");

		try {
			const snapshots = await fetchSnapshotList(this.settings);

			if (snapshots.length === 0) {
				new Notice("No snapshots found. Take a snapshot first.");
				return;
			}

			new SnapshotListModal(this.app, snapshots, async (selected) => {
				await this.showSnapshotDiff(selected);
			}).open();
		} catch (err) {
			console.error("[vault-crdt-sync] Failed to list snapshots:", err);
			new Notice(`Failed to list snapshots: ${err}`);
		}
	}

	/**
	 * Download a snapshot, compute diff against current CRDT, and show the restore UI.
	 */
	private async showSnapshotDiff(snapshot: SnapshotIndex): Promise<void> {
		if (!this.vaultSync) return;

		new Notice("Downloading snapshot...");

		try {
			const snapshotDoc = await downloadSnapshot(this.settings, snapshot);
			const diff = diffSnapshot(snapshotDoc, this.vaultSync.ydoc);

			let destroyed = false;
			const cleanup = () => {
				if (!destroyed) {
					destroyed = true;
					snapshotDoc.destroy();
				}
			};

			new SnapshotDiffModal(
				this.app,
				snapshot,
				diff,
				async (markdownPaths, blobPaths) => {
					if (!this.vaultSync) return;

					// --- Pre-restore backup ---
					// Save current content of files we're about to overwrite
					// so the user can recover if the restore goes wrong.
					const backupDir = `.obsidian/plugins/vault-crdt-sync/restore-backups/${new Date().toISOString().replace(/[:.]/g, "-")}`;
					let backedUp = 0;
					for (const path of markdownPaths) {
						try {
							const file = this.app.vault.getAbstractFileByPath(path);
							if (file instanceof TFile) {
								const content = await this.app.vault.read(file);
								const backupPath = `${backupDir}/${path}`;
								// Ensure parent directories exist
								const parentDir = backupPath.substring(0, backupPath.lastIndexOf("/"));
								if (parentDir && !this.app.vault.getAbstractFileByPath(parentDir)) {
									await this.app.vault.createFolder(parentDir);
								}
								await this.app.vault.create(backupPath, content);
								backedUp++;
							}
						} catch (err) {
							// Non-fatal: file might not exist on disk (undelete case)
							this.log(`Backup skipped for "${path}": ${err}`);
						}
					}
					if (backedUp > 0) {
						this.log(`Pre-restore backup: ${backedUp} files saved to ${backupDir}`);
					}

					const result = restoreFromSnapshot(snapshotDoc, this.vaultSync.ydoc, {
						markdownPaths,
						blobPaths,
						device: this.settings.deviceName,
					});

					// Flush restored files to disk
					for (const path of markdownPaths) {
						await this.diskMirror?.flushWrite(path);
					}

					// Kick blob downloads for restored blob references
					if (blobPaths.length > 0 && this.blobSync) {
						const queued = this.blobSync.prioritizeDownloads(blobPaths);
						if (queued > 0) {
							this.log(`Restore: queued ${queued} blob downloads`);
						}
					}

					// Re-bind editors for restored files
					this.bindAllOpenEditors();

					const parts: string[] = [];
					if (result.markdownRestored > 0) parts.push(`${result.markdownRestored} files restored`);
					if (result.markdownUndeleted > 0) parts.push(`${result.markdownUndeleted} files undeleted`);
					if (result.blobsRestored > 0) parts.push(`${result.blobsRestored} attachments restored`);
					if (backedUp > 0) parts.push(`backup in ${backupDir}`);

					const msg = parts.length > 0
						? `Restore complete: ${parts.join(", ")}.`
						: "No changes were applied.";
					new Notice(msg, 8000);
					this.log(`Restore from snapshot ${snapshot.snapshotId}: ${msg}`);

					cleanup();
				},
				cleanup,
			).open();
		} catch (err) {
			console.error("[vault-crdt-sync] Snapshot diff failed:", err);
			new Notice(`Failed to load snapshot: ${err}`);
		}
	}

	private log(msg: string): void {
		if (this.settings.debug) {
			console.log(`[vault-crdt-sync] ${msg}`);
		}
	}
}

/**
 * Simple confirmation modal with a message and confirm/cancel buttons.
 */
class ConfirmModal extends Modal {
	private title: string;
	private message: string;
	private onConfirm: () => void | Promise<void>;

	constructor(
		app: import("obsidian").App,
		title: string,
		message: string,
		onConfirm: () => void | Promise<void>,
	) {
		super(app);
		this.title = title;
		this.message = message;
		this.onConfirm = onConfirm;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h3", { text: this.title });
		contentEl.createEl("p", { text: this.message });

		const buttonRow = contentEl.createDiv({ cls: "modal-button-container" });

		buttonRow
			.createEl("button", { text: "Cancel" })
			.addEventListener("click", () => this.close());

		const confirmBtn = buttonRow.createEl("button", {
			text: "Confirm",
			cls: "mod-warning",
		});
		confirmBtn.addEventListener("click", () => {
			this.close();
			void this.onConfirm();
		});
	}

	onClose() {
		this.contentEl.empty();
	}
}

/**
 * Modal that lists available snapshots and lets the user pick one.
 */
class SnapshotListModal extends Modal {
	constructor(
		app: import("obsidian").App,
		private snapshots: SnapshotIndex[],
		private onSelect: (snapshot: SnapshotIndex) => void | Promise<void>,
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h3", { text: "Available snapshots" });
		contentEl.createEl("p", {
			text: `${this.snapshots.length} snapshot(s) found. Select one to see a diff and restore files.`,
			cls: "setting-item-description",
		});

		const list = contentEl.createDiv({ cls: "snapshot-list" });

		for (const snap of this.snapshots) {
			const item = list.createDiv({ cls: "snapshot-list-item" });
			item.style.padding = "8px 0";
			item.style.borderBottom = "1px solid var(--background-modifier-border)";
			item.style.cursor = "pointer";

			const date = new Date(snap.createdAt);
			const dateStr = date.toLocaleDateString(undefined, {
				year: "numeric",
				month: "short",
				day: "numeric",
				hour: "2-digit",
				minute: "2-digit",
			});

			const title = item.createEl("div");
			title.createEl("strong", { text: dateStr });
			if (snap.triggeredBy) {
				title.createEl("span", {
					text: ` (${snap.triggeredBy})`,
					cls: "setting-item-description",
				});
			}

			item.createEl("div", {
				text: `${snap.markdownFileCount} notes, ${snap.blobFileCount} attachments ` +
					`(${Math.round(snap.crdtSizeBytes / 1024)} KB)`,
				cls: "setting-item-description",
			});

			item.addEventListener("click", () => {
				this.close();
				void this.onSelect(snap);
			});

			// Hover effect
			item.addEventListener("mouseenter", () => {
				item.style.backgroundColor = "var(--background-modifier-hover)";
			});
			item.addEventListener("mouseleave", () => {
				item.style.backgroundColor = "";
			});
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}

/**
 * Modal that shows a diff between a snapshot and the current CRDT state.
 * Lets the user select files to restore.
 */
class SnapshotDiffModal extends Modal {
	private selectedMd = new Set<string>();
	private selectedBlobs = new Set<string>();
	/** Set to true when restore is initiated — prevents cleanup from running twice. */
	private didRestore = false;

	constructor(
		app: import("obsidian").App,
		private snapshot: SnapshotIndex,
		private diff: SnapshotDiff,
		private onRestore: (markdownPaths: string[], blobPaths: string[]) => void | Promise<void>,
		private cleanup: () => void,
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		const date = new Date(this.snapshot.createdAt);
		const dateStr = date.toLocaleDateString(undefined, {
			year: "numeric",
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		});
		contentEl.createEl("h3", { text: `Snapshot: ${dateStr}` });

		const { diff } = this;
		const totalChanges = diff.deletedSinceSnapshot.length +
			diff.contentChanged.length +
			diff.blobsDeletedSinceSnapshot.length +
			diff.blobsChanged.length;

		if (totalChanges === 0 && diff.createdSinceSnapshot.length === 0) {
			contentEl.createEl("p", { text: "No differences found between the snapshot and current state." });
			return;
		}

		contentEl.createEl("p", {
			text: "Select files to restore from the snapshot. " +
				"Created-since-snapshot files are shown for reference but cannot be \"restored\" (they didn't exist yet).",
			cls: "setting-item-description",
		});

		// --- Deleted since snapshot (can restore = undelete) ---
		if (diff.deletedSinceSnapshot.length > 0) {
			this.renderSection(
				contentEl,
				"Deleted since snapshot (can undelete)",
				diff.deletedSinceSnapshot.map((d) => d.path),
				this.selectedMd,
			);
		}

		// --- Content changed (can restore to snapshot version) ---
		if (diff.contentChanged.length > 0) {
			this.renderSection(
				contentEl,
				"Content changed since snapshot",
				diff.contentChanged.map((d) => d.path),
				this.selectedMd,
			);
		}

		// --- Created since snapshot (informational only) ---
		if (diff.createdSinceSnapshot.length > 0) {
			const section = contentEl.createDiv();
			section.createEl("h4", { text: `Created since snapshot (${diff.createdSinceSnapshot.length})` });
			const listEl = section.createEl("ul");
			for (const path of diff.createdSinceSnapshot) {
				listEl.createEl("li", { text: path, cls: "setting-item-description" });
			}
		}

		// --- Blob changes ---
		if (diff.blobsDeletedSinceSnapshot.length > 0) {
			this.renderSection(
				contentEl,
				"Attachments deleted since snapshot",
				diff.blobsDeletedSinceSnapshot.map((d) => d.path),
				this.selectedBlobs,
			);
		}

		if (diff.blobsChanged.length > 0) {
			this.renderSection(
				contentEl,
				"Attachments changed since snapshot",
				diff.blobsChanged.map((d) => d.path),
				this.selectedBlobs,
			);
		}

		// --- Unchanged summary ---
		if (diff.unchanged.length > 0) {
			contentEl.createEl("p", {
				text: `${diff.unchanged.length} file(s) unchanged.`,
				cls: "setting-item-description",
			});
		}

		// --- Restore button ---
		const buttonRow = contentEl.createDiv({ cls: "modal-button-container" });
		buttonRow.style.marginTop = "16px";

		buttonRow
			.createEl("button", { text: "Cancel" })
			.addEventListener("click", () => this.close());

		const restoreBtn = buttonRow.createEl("button", {
			text: "Restore selected",
			cls: "mod-cta",
		});
		restoreBtn.addEventListener("click", () => {
			const mdPaths = Array.from(this.selectedMd);
			const blobPaths = Array.from(this.selectedBlobs);

			if (mdPaths.length === 0 && blobPaths.length === 0) {
				new Notice("No files selected for restore.");
				return;
			}

			this.didRestore = true;
			this.close();
			void this.onRestore(mdPaths, blobPaths);
		});
	}

	private renderSection(
		container: HTMLElement,
		title: string,
		paths: string[],
		selectedSet: Set<string>,
	): void {
		const section = container.createDiv();
		section.createEl("h4", { text: `${title} (${paths.length})` });

		// Select all toggle
		const toggleRow = section.createDiv();
		toggleRow.style.marginBottom = "4px";
		const selectAll = toggleRow.createEl("a", { text: "Select all", href: "#" });
		selectAll.addEventListener("click", (e) => {
			e.preventDefault();
			for (const p of paths) selectedSet.add(p);
			// Re-check all checkboxes in this section
			section.querySelectorAll<HTMLInputElement>("input[type=checkbox]").forEach(
				(cb) => { cb.checked = true; },
			);
		});

		for (const path of paths) {
			const row = section.createDiv();
			row.style.padding = "2px 0";
			const label = row.createEl("label");
			const cb = label.createEl("input", { type: "checkbox" });
			cb.style.marginRight = "6px";
			label.appendText(path);

			cb.addEventListener("change", () => {
				if (cb.checked) {
					selectedSet.add(path);
				} else {
					selectedSet.delete(path);
				}
			});
		}
	}

	onClose() {
		this.contentEl.empty();
		// Always clean up the snapshot doc unless restore already handled it.
		if (!this.didRestore) {
			this.cleanup();
		}
	}
}
