# Network & Data Flow Analysis

**Scope:** Complete codebase - all outbound network communication traced

---

## KEY FINDING: NO DATA EXFILTRATION

All vault data (file contents, metadata, attachments) is sent **exclusively to the user's own Cloudflare Worker**. There is NO telemetry, NO analytics, NO tracking, and NO third-party data sharing.

---

## Data Flow Diagram

```
+-------------------------------------+
|   Obsidian Plugin (Client)          |
|-------------------------------------|
| - Vault file contents               |
| - File metadata (mtime, path)       |
| - Attachments/blobs (binary)        |
| - Device name (for awareness)       |
| - Trace IDs (for debugging)         |
+------------------+------------------+
                   |
                   | HTTPS/WSS (Encrypted)
                   | Bearer Token Auth
                   v
+-------------------------------------+
| User's Cloudflare Worker            |
| (Configured in plugin settings)     |
|-------------------------------------|
| - Syncs CRDT updates (Y.js)        |
| - Stores blobs in R2 bucket         |
| - Creates snapshots                 |
| - Returns server capabilities       |
+------------------+------------------+
                   |
                   | Internal Durable Objects
                   v
+-------------------------------------+
| Cloudflare R2 (User's Bucket)       |
| (Only if attachments enabled)       |
+-------------------------------------+
```

---

## All Outbound Network Calls

### Client Plugin -> User's Server

| Endpoint | Method | File | Data Sent | Purpose |
|----------|--------|------|-----------|---------|
| `wss://{host}/vault/sync/{vaultId}` | WebSocket | `src/sync/vaultSync.ts:233-238` | CRDT updates, file contents, metadata | Real-time sync |
| `{host}/vault/{vaultId}/blobs/{hash}` | PUT | `src/sync/blobSync.ts:115-135` | Binary file data | Upload attachment |
| `{host}/vault/{vaultId}/blobs/{hash}` | GET | `src/sync/blobSync.ts:136-169` | - | Download attachment |
| `{host}/vault/{vaultId}/blobs/exists` | POST | `src/sync/blobSync.ts:153-169` | JSON array of hashes | Batch existence check |
| `{host}/api/capabilities` | GET | `src/sync/serverCapabilities.ts:19-29` | - | Server version/feature check |
| `{host}/vault/{vaultId}/snapshots/maybe` | POST | `src/sync/snapshotClient.ts:159-195` | `{ device }` | Request daily snapshot |
| `{host}/vault/{vaultId}/snapshots` | POST | `src/sync/snapshotClient.ts:196-230` | `{ device }` | Force snapshot |
| `{host}/vault/{vaultId}/snapshots` | GET | `src/sync/snapshotClient.ts:231-260` | - | List snapshots |
| `{host}/vault/{vaultId}/snapshots/{id}` | GET | `src/sync/snapshotClient.ts:261-289` | - | Download snapshot |

### Client Plugin -> GitHub (Public, Read-Only)

| URL | Method | File | Data Sent | Purpose |
|-----|--------|------|-----------|---------|
| `https://github.com/kavinsood/yaos/releases/latest/download/update-manifest.json` | GET | `src/main.ts:86-88` | None | Check for plugin updates |

**Note:** This is a standard HTTP GET to a public GitHub URL. No vault data, no auth tokens, no identifying info sent. Cached for 24 hours.

### Server Setup Page -> CDN (One-Time)

| URL | Method | File | Data Sent | Purpose |
|-----|--------|------|-----------|---------|
| `https://cdn.jsdelivr.net/npm/qrious@4.0.2/dist/qrious.min.js` | GET | `server/src/setupPage.ts:399` | None | QR code JS library for setup page |

**Note:** Only loaded when the server setup page is viewed in a browser (initial one-time setup). No vault data involved.

### CI/CD Pipelines -> GitHub (Server Update)

| URL | Method | File | Data Sent | Purpose |
|-----|--------|------|-----------|---------|
| `https://github.com/{repo}/releases/latest/download/yaos-server.zip` | GET | `server/scripts/update-from-release.mjs:146` | None | Download server update |
| `https://github.com/{repo}/releases/download/{tag}/yaos-server.zip` | GET | `server/scripts/update-from-release.mjs:163` | None | Download specific version |

---

## Authentication Details

- **WebSocket:** Token passed as query parameter `?token=...` over WSS
- **HTTP API:** `Authorization: Bearer {token}` header
- **All trace context:** Optional query params (`device`, `trace`, `boot`) sent only to user's server

---

## What Is NOT Sent

- No vault data to third parties
- No analytics or telemetry to any service
- No user identification tokens
- No device fingerprinting
- No usage statistics
- No crash reports to external services

---

## Local-Only Data Storage

| Data | Location | Purpose |
|------|----------|---------|
| CRDT cache | IndexedDB (`yaos-{vaultId}`) | Offline persistence |
| Trace logs | `.obsidian/plugins/yaos/logs/` | Local debugging |
| Plugin settings | `.obsidian/plugins/yaos/data.json` | Configuration + auth token |
| Blob hash cache | IndexedDB | Prevent redundant uploads |

---

## Conclusion

YAOS has a **clean network profile**. Data flows exclusively between the user's devices and their own Cloudflare Worker. The only external calls are to GitHub for update checks (public, read-only, no user data). No hidden communication channels exist.
