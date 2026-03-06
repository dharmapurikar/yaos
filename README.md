# YAOS (Yet Another Obsidian Sync)

**YAOS makes Obsidian sync feel like Apple Notes or Google Docs.** It is a free, self-hosted, and local-first sync engine that updates your notes instantly across all your devices.

Under the hood, it is a real-time CRDT engine running on Cloudflare Durable Objects.

For the average user, hosting it yourself costs exactly $0/month on Cloudflare's free tier.

### One-click self-hosting
- Click this button, then 'Create and deploy'
- Open the URL created for you, and continue from there.
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/kavinsood/yaos/tree/main/server)

### Features

- **Instant Sync:** Changes update in milliseconds.
- **Zero Conflicts:** You never see a "File modified externally" error again.
- **Offline-First:** Go offline, edit for days, and everything merges perfectly when you reconnect.
- **Zero-Config Setup:** Deploy with one click. Claim your server in the browser. Scan a link to pair your devices. *No terminal required.*
- **Attachments & Backups (Optional):** Sync your images/PDFs and automatic daily backups, allowing you to selectively restore files if you accidentally delete something.

If you want the absolute best, zero-effort experience, you should pay for the official Obsidian Sync. If you want a free, instant, local-first alternative that you fully control, this is YAOS.

### How is this different from iCloud or Remotely Save?

*Most free ways to sync Obsidian (like Dropbox, iCloud, or community plugins) are just moving files back and forth on a timer. This can lead to conflicted copies and delays in sync.

YAOS syncs *keystrokes*. If you edit on two devices at once, the text merges flawlessly.

If you want to read the longer rant, `<read here>`
If you want the design rationale and internals, read these:

This repository keeps deep architecture notes under [`engineering/`](./engineering), with diagrams and operational limits documented alongside implementation details

- **[Monolithic vault CRDT](./engineering/monolith.md):** Why YAOS keeps one vault-level `Y.Doc`, what we gain (cross-file transactional behavior), and what we consciously trade off.
- **[Filesystem bridge](./engineering/filesystem-bridge.md):** How noisy Obsidian file events are converted into safe CRDT updates with dirty-set draining and content-acknowledged suppression.
- **[Attachment sync and R2 proxy model](./engineering/attachment-sync.md):** Native Worker proxy uploads, capability negotiation, and bounded fan-out under Cloudflare connection limits.
- **[Checkpoint + journal persistence](./engineering/checkpoint-journal.md):** The storage-engine rewrite that removed full-state rewrites and introduced state-vector-anchored delta journaling.
- **[Zero-config auth and claim flow](./engineering/zero-config-auth.md):** Browser claim UX, `obsidian://yaos` deep-link pairing, and env-token override behavior.
- **[Warts and limits](./engineering/warts-and-limits.md):** Canonical limits, safety invariants, and the pragmatic compromises currently in production.
- **[Queue pool behavior](./engineering/queue-pool.md):** Why attachment transfer queues currently favor deterministic behavior over maximal throughput.

### Installation

After you click deploy:

- The Worker is deployed from this repo to your Cloudflare account.
- The default deploy is **text sync first**. No R2 bucket is required up front.
- On first visit to the deployed URL, the server starts in **unclaimed** mode and shows a small setup page.
- That page generates a token in the browser and gives you a deep link `obsidian://yaos?...`, and a QR code, so you can open on desktop or mobile.

Later, if you want attachments and snapshots, add an R2 binding named `YAOS_BUCKET` in the Cloudflare dashboard and redeploy. The same deployed Worker will begin reporting those features as available.

### Configuration

After enabling, go to **Settings → YAOS**:

| Setting | Description |
|---------|-------------|
| **Server host** | Your server URL (e.g., `https://sync.yourdomain.com`) |
| **Token** | Paste the token from the YAOS setup link (or from a manual `SYNC_TOKEN` override if you use one) |
| **Vault ID** | Unique ID for this vault (auto-generated if blank). Same ID = same vault across devices. |
| **Device name** | Shown in remote cursors |

### Optional settings

| Setting | Description |
|---------|-------------|
| **Exclude patterns** | Comma-separated prefixes to skip (e.g., `templates/, .trash/`) |
| **Max file size** | Skip files larger than this (default 2 MB) |
| **Max attachment size** | Skip attachments larger than this (default 10 MB) |
| **External edit policy** | How to handle edits from git/other tools: Always, Only when closed, Never |
| **Sync attachments** | Enable R2-based sync for non-markdown files |
| **Show remote cursors** | Display collaborator cursor positions |
| **Debug logging** | Verbose console output |

Changes to host/token/vault ID require reloading the plugin.

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

1. Each markdown file gets a stable ID and a `Y.Text` CRDT for its content
2. Today, those per-file `Y.Text` values live inside one shared vault-level `Y.Doc`, which keeps collaboration simple and fast for normal-sized note vaults
3. Live editor edits flow through the Yjs binding to that shared document
4. One vault maps to one Durable Object-backed sync room, so the shared state survives server restarts
5. Offline edits are stored in IndexedDB and sync on reconnect
6. Attachments sync separately via content-addressed R2 storage instead of being forced through the text CRDT
7. Daily and on-demand snapshots exist as a safety net

In practice, that means:

- your vault still exists locally as normal files
- Obsidian keeps behaving like Obsidian
- YAOS keeps the disk mirror and the shared CRDT state aligned instead of asking devices to take polite turns uploading files later

## Limits and Tradeoffs

YAOS is optimized for personal or small-team note vaults, not for arbitrarily huge filesystem trees.

It currently keeps one shared `Y.Doc` for the vault, which keeps collaboration simple but gives the design a memory ceiling for large vaults.

If you're going to dump 100K line log files or scrape Wikipedia, a dumb sync platform like Google Drive or Syncthing is preferable.

YAOS trades infinite scalability for perfect real-time ergonomics.

A vault of upto 50 MB of raw text (not including attachments like images and PDFs) will work beautifully.

## Troubleshooting

**"Unauthorized" errors**: Token mismatch between plugin and server. Check both match exactly.

**"R2 not configured"**: The server does not have a `YAOS_BUCKET` binding yet. See the server README for setup.

**Sync stops on mobile**: Use "Reconnect to sync server" command. Check you have network connectivity.

**Files not syncing**: Check exclude patterns. Files over max size are skipped. Use debug logging to see what's happening, and then raise an issue on GitHub.

**Conflicts after offline edits**: CRDTs merge automatically but the result depends on operation order. Review merged content if needed.

## License

[0-BSD](LICENSE)
