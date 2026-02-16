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
import { isExcluded, parseExcludePatterns } from "./sync/exclude";
import { applyDiffToYText } from "./sync/diff";
import {
	type DiskIndex,
	filterChangedFiles,
	updateIndex,
	moveIndexEntries,
	waitForStable,
} from "./sync/diskIndex";

type SyncStatus = "disconnected" | "loading" | "syncing" | "connected" | "offline" | "error" | "unauthorized";

/** Minimum interval between reconcile runs (prevents rapid reconnect churn). */
const RECONCILE_COOLDOWN_MS = 10_000;

export default class VaultCrdtSyncPlugin extends Plugin {
	settings: VaultSyncSettings = DEFAULT_SETTINGS;

	private vaultSync: VaultSync | null = null;
	private editorBindings: EditorBindingManager | null = null;
	private diskMirror: DiskMirror | null = null;
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

			// 5. Status tracking
			this.vaultSync.provider.on("status", () => this.refreshStatusBar());
			this.statusInterval = setInterval(() => this.refreshStatusBar(), 3000);
			this.register(() => {
				if (this.statusInterval) clearInterval(this.statusInterval);
			});

			// 6. Vault events (gated by this.reconciled)
			this.registerVaultEvents();

			// 7. Commands
			this.registerCommands();

			// 8. Rename batch callback → update editor bindings + disk mirror observers + disk index
			this.vaultSync.onRenameBatchFlushed((renames) => {
				this.editorBindings?.updatePathsAfterRename(renames);

				// Move disk index entries
				moveIndexEntries(this.diskIndex, renames);

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
				if (isExcluded(file.path, this.excludePatterns)) {
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
			}),
		);

		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (!this.reconciled) return;
				if (!(file instanceof TFile)) return;
				if (!file.path.endsWith(".md")) return;
				if (isExcluded(file.path, this.excludePatterns)) return;
				if (this.diskMirror?.isSuppressed(file.path)) {
					this.log(`Suppressed modify event for "${file.path}"`);
					return;
				}
				void this.syncFileFromDisk(file);
			}),
		);

		// Rename: use batched queueRename for atomic folder renames
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (!this.reconciled) return;
				if (!(file instanceof TFile)) return;
				if (!oldPath.endsWith(".md") && !file.path.endsWith(".md")) return;
				if (isExcluded(file.path, this.excludePatterns)) return;
				this.vaultSync?.queueRename(oldPath, file.path);
				this.log(`Rename queued: "${oldPath}" -> "${file.path}"`);
			}),
		);

		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (!this.reconciled) return;
				if (!(file instanceof TFile)) return;
				if (!file.path.endsWith(".md")) return;
				if (isExcluded(file.path, this.excludePatterns)) return;
				if (this.diskMirror?.isSuppressed(file.path)) {
					this.log(`Suppressed delete event for "${file.path}"`);
					return;
				}
				// Bug 3: unbind editor if the deleted file was open
				this.editorBindings?.unbindByPath(file.path);
				this.diskMirror?.notifyFileClosed(file.path);
				this.openFilePaths.delete(file.path);

				this.vaultSync?.handleDelete(
					file.path,
					this.settings.deviceName,
				);
				this.log(`Delete: "${file.path}"`);
			}),
		);

		this.registerEvent(
			this.app.vault.on("create", (file) => {
				if (!this.reconciled) return;
				if (!(file instanceof TFile)) return;
				if (!file.path.endsWith(".md")) return;
				if (isExcluded(file.path, this.excludePatterns)) return;
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
				if (!this.vaultSync) {
					new Notice("Sync not initialized");
					return;
				}
				const info = [
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
					`Untracked files: ${this.untrackedFiles.length}`,
					`Active disk observers: ${this.diskMirror?.activeObserverCount ?? 0}`,
				].join("\n");
				new Notice(info, 10000);
				console.log("[vault-crdt-sync] Debug status:\n" + info);
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
							`${counts.idCount} texts, ${counts.metaCount} meta`,
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

	private async syncFileFromDisk(file: TFile): Promise<void> {
		if (!this.vaultSync) return;
		if (isExcluded(file.path, this.excludePatterns)) return;

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
		this.statusBarEl.setText(labels[state]);
	}

	onunload() {
		this.log("Unloading plugin");
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
	}

	async saveSettings() {
		await this.saveData({
			...this.settings,
			_diskIndex: this.diskIndex,
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
		});
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
