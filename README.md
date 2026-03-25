# YAOS

**A zero-terminal, real-time sync engine for Obsidian, powered by your own Cloudflare Worker.**

Your notes stay in sync instantly across devices, without conflicted copies, delayed file sync, or database-heavy self-hosting.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/kavinsood/yaos/tree/main/server)

No terminal, no `.env` files, no database setup required. R2 is optional.

The Worker setup page also walks you through the remaining steps, so you do not need to memorize the setup flow from this README.

## What YAOS gives you

- **Real-time sync:** changes show up across devices instantly.
- **No conflicted copies:** YAOS keeps your vault in live agreement instead of asking devices to upload files later and hope for the best.
- **Zero-terminal setup:** deploy your own backend in one click, claim it in the browser, and pair devices with a setup link or QR code.
- **Local-first control:** your vault stays normal local Markdown files, and the server runs in your own Cloudflare account.
- **Optional attachments and snapshots:** add R2 later for file sync and recovery.

If you want the official, fully managed experience, pay for Obsidian Sync and support the team. If you want a fast, self-hosted, local-first alternative that you fully control, this is YAOS.

## Quick Start

YAOS has two parts: the Obsidian plugin, and a small Cloudflare server that you deploy to your own account.

**1. Deploy your server**  
Use the **Deploy to Cloudflare** button above. The Worker setup page will guide you through claim, pairing, and plugin setup from there.

**2. Claim your server**  
Open the URL Cloudflare gives you. Click **Claim** to generate your setup token and lock the server to you.

**3. Install the plugin (beta)**  
*YAOS is currently in the Obsidian Marketplace review queue. To use it today:*
1. Install **BRAT** from **Settings → Community plugins**.
2. Open BRAT settings, click **Add Beta plugin**, and paste: `kavinsood/yaos`
3. Go back to **Community plugins** and enable **YAOS**.

**4. Connect your vault**  
From the claim page, open the setup link or scan the QR code. YAOS will fill in the connection details automatically.

## Updating your server

YAOS is designed to be zero-terminal, but because you own your infrastructure, you control when updates apply.

### 1-minute summary

1. One-time setup: click **Initialize updater** in YAOS settings.
2. Normal use: do nothing until YAOS notifies you that an update is available.
3. Update: click **Open update action**, run workflow with `update`, and Cloudflare redeploys automatically.

### Phase 1: Initialize updater (one-time only)

1. Open **Settings → YAOS → Advanced**.
2. Set **Deployment repo URL** to your generated repository (for example `https://github.com/your-username/yaos`).
3. Click **Initialize updater**.
4. GitHub opens with a pre-filled workflow file. Click **Commit changes**.

You only do this once per deployment repo.

### Phase 2: Apply an update

1. Open YAOS settings and click **Open update action**.
2. In GitHub Actions, click **Run workflow**.
3. Leave action as `update` and run it.
4. Cloudflare detects the new commit and redeploys your existing Worker.

### Phase 3: Roll back an update

1. Open the same update workflow.
2. Click **Run workflow**.
3. Change action to `revert` and run.

This reverts the last YAOS update commit and redeploys the previous server code.

### Migration-required releases

Some releases require manual infrastructure or data migration steps. For those releases, the 1-click updater intentionally aborts and prints a clear warning in workflow logs.

If update fails with a migration-required message:

1. Do not force apply blindly.
2. Read the release notes.
3. Follow the migration instructions, then retry.

### Why not click Deploy to Cloudflare again?

Re-clicking Deploy is not a safe update path for a stateful server. YAOS uses a Git-driven update workflow so the same Worker identity, Durable Object bindings, and history are preserved.

## Why YAOS exists

Most ways to sync Obsidian do one of two things:

- keep files in sync after the fact
- ask you to self-host a full database stack

The first category can work well, until it does not:

- a change on one device is still "not here yet" on another
- a mobile app closes too fast and the latest edit never really makes it
- two devices move independently and you end up with conflicted copies

The second category can solve more of the sync problem, but often asks you to become your own infrastructure team.

YAOS takes a different path:

- it keeps the **state of your vault** in sync in real time
- it treats your notes as shared state, not just files to upload later
- it gives you a browser-based, zero-terminal setup flow instead of asking you to wire up a database and secrets by hand

That is why it feels different in practice: less waiting, less drift, less weirdness.

## Engineering docs

If you want the design rationale and internals, this repository keeps deep architecture notes under [`engineering/`](./engineering):

- **[Monolithic vault CRDT](./engineering/monolith.md):** Why YAOS keeps one vault-level `Y.Doc`, what we gain (cross-file transactional behavior), and what we consciously trade off.
- **[Filesystem bridge](./engineering/filesystem-bridge.md):** How noisy Obsidian file events are converted into safe CRDT updates with dirty-set draining and content-acknowledged suppression.
- **[Attachment sync and R2 proxy model](./engineering/attachment-sync.md):** Native Worker proxy uploads, capability negotiation, and bounded fan-out under Cloudflare connection limits.
- **[Checkpoint + journal persistence](./engineering/checkpoint-journal.md):** The storage-engine rewrite that removed full-state rewrites and introduced state-vector-anchored delta journaling.
- **[Zero-config auth and claim flow](./engineering/zero-config-auth.md):** Browser claim UX, `obsidian://yaos` deep-link pairing, and env-token override behavior.
- **[Zero-ops update pipeline](./engineering/zero-ops-update-pipeline.md):** Why detached deploy repos need bootstrap injection, reusable workflows, and migration safety gates.
- **[Warts and limits](./engineering/warts-and-limits.md):** Canonical limits, safety invariants, and the pragmatic compromises currently in production.

## Configuration

After enabling, go to **Settings → YAOS**.

**Key settings**

| Setting | Description |
|---------|-------------|
| **Server URL** | Your Worker URL (for example, `https://sync.yourdomain.com`) |
| **Sync token** | Filled automatically by the YAOS setup link after you claim the server |
| **Device name** | Shown to other devices in live cursors and presence |
| **Exclude paths** | Comma-separated path prefixes to skip (for example, `templates/, .trash/`) |
| **Max text file size** | Skip text files larger than this for live document sync |
| **Sync attachments** | Enable object-storage sync for images, PDFs, and other non-markdown files |
| **Max attachment size** | Skip attachments larger than this (default 10 MB) |
| **Parallel transfers** | Number of simultaneous attachment upload/download slots |
| **Show remote cursors** | Display cursor positions and selections from other devices |
| **Edits from other apps** | Control how YAOS handles changes from git, scripts, or other editors |
| **Debug logging** | Verbose console output for troubleshooting |

`Manual connection` and `Advanced` sections are available in the settings UI when you need to inspect or override connection details.

## Commands

Access via command palette (Ctrl/Cmd+P):

| Command | Description |
|---------|-------------|
| **Reconnect to sync server** | Force reconnect after network changes |
| **Force reconcile** | Re-merge disk state with CRDT |
| **Show sync debug info** | Connection state, file counts, queue status |
| **Take snapshot now** | Create an immediate backup to R2 |
| **Browse and restore snapshots** | View snapshots, diff against current state, selective restore |
| **Reset local cache** | Clear IndexedDB, re-sync from server |
| **Nuclear reset** | Wipe all CRDT state everywhere, re-seed from disk |

## Snapshots

Snapshots are point-in-time backups of your vault's CRDT state, stored in R2.

- **Daily automatic**: A snapshot is taken automatically once per day when Obsidian opens
- **On-demand**: Use "Take snapshot now" before risky operations (AI refactors, bulk edits)
- **Selective restore**: Browse snapshots, see a diff of what changed, restore individual files
- **Undelete**: Restore files that were deleted since the snapshot
- **Pre-restore backup**: Before restoring, current file content is saved to `.obsidian/plugins/yaos/restore-backups/`

Requires R2 to be configured on the server.

## How it works

YAOS keeps your vault as normal local files, while also maintaining a shared real-time state for sync.

1. Each markdown file gets a stable ID and a `Y.Text` CRDT for its content.
2. Today, those per-file `Y.Text` values live inside one shared vault-level `Y.Doc`, which keeps collaboration simple and fast for normal-sized note vaults.
3. Live editor edits flow through the Yjs binding to that shared document.
4. One vault maps to one Durable Object-backed sync room, so the shared state survives server restarts.
5. Offline edits are stored in IndexedDB and sync on reconnect.
6. Attachments sync separately via content-addressed R2 storage instead of being forced through the text CRDT.
7. Daily and on-demand snapshots exist as a safety net.

In practice, that means:

- your vault still exists locally as normal files
- Obsidian keeps behaving like Obsidian
- YAOS keeps the disk mirror and the shared CRDT state aligned instead of asking devices to take polite turns uploading files later

Because Obsidian vaults are just local Markdown files, YAOS also plays unusually well with scripts, CLI tools, and AI agents that edit files directly on disk. Those edits can propagate cleanly across devices instead of falling back to conflicted-copy workflows.

## Limits and Tradeoffs

YAOS is optimized for personal or small-team note vaults, not for arbitrarily huge text archives.

It currently keeps one shared `Y.Doc` for a vault. That gives excellent real-time ergonomics and simpler cross-file behavior, but it also creates a practical ceiling for very large vaults.

If your vault is normal notes, drafts, research, and attachments, YAOS is a great fit. If you want to sync giant text dumps or archival datasets, a simpler file-sync tool is a better choice.

YAOS trades infinite scalability for instant, local-first sync ergonomics.

A practical rule of thumb: around 50 MB of raw text (not counting attachments like images and PDFs) is a comfortable target.

## Troubleshooting

**"Unauthorized" errors**: Token mismatch between plugin and server. Check both match exactly.

**"R2 not configured"**: The server does not have a `YAOS_BUCKET` binding yet. See the server README for setup.

**Sync stops on mobile**: Use "Reconnect to sync server" command. Check you have network connectivity.

**Files not syncing**: Check exclude patterns. Files over max size are skipped. Use debug logging to see what's happening, and then raise an issue on GitHub.

**Conflicts after offline edits**: CRDTs merge automatically but the result depends on operation order. Review merged content if needed.

## License

[0-BSD](LICENSE)
