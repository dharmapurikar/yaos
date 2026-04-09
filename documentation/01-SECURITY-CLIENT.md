# Client Plugin Security & Backdoor Analysis

**Scope:** All source files in `src/` (~11,600 lines across 21 TypeScript files)

---

## CRITICAL FINDINGS: NONE

The plugin does NOT contain:
- eval(), Function(), or dynamic code execution
- Obfuscated or minified source code
- Hardcoded data exfiltration URLs
- Hidden telemetry, analytics, or tracking
- Credential theft or logging

---

## HIGH SEVERITY

### 1. HTTP Connection to Remote Hosts Allowed
- **File:** `src/settings.ts:608-612`
- **Issue:** Users can configure unencrypted `http://` connections to remote servers. The sync token would be sent in plaintext.
- **Mitigation:** Plugin enforces HTTPS for non-localhost hosts (settings.ts:74-85) and displays a warning. HTTP only allowed for localhost.
- **Actual Risk:** LOW (mitigated by enforcement + warning)

### 2. Auth Token Stored in Plaintext
- **File:** `src/settings.ts:13, 47-49, 627-632`
- **Issue:** The sync token is persisted in Obsidian's `data.json` without encryption.
- **Mitigation:** This is inherent to ALL Obsidian plugins (no encrypted storage API exists). Users instructed to use password managers for backup tokens.
- **Actual Risk:** LOW (standard plugin behavior, requires local disk access to exploit)

---

## MEDIUM SEVERITY

### 3. Schema Version Downgrade Possible
- **File:** `src/sync/vaultSync.ts:398-409`
- **Issue:** Schema version check only rejects newer versions (`stored > SCHEMA_VERSION`), not older plugin reading newer data.
- **Mitigation:** Server-side `minSchemaVersion` check prevents most real-world scenarios (main.ts:119-121).

### 4. Deep Links Accept Minimal Validation
- **File:** `src/main.ts:3248-3289`
- **Issue:** `handleSetupLink()` accepts host, token, vaultId from `obsidian://yaos` URL params with minimal validation.
- **Mitigation:** User must confirm dialogs. URL scheme only activated by the Obsidian app.

### 5. IndexedDB Failure Degrades Silently
- **File:** `src/sync/vaultSync.ts:199-220`
- **Issue:** If IndexedDB fails, sync continues in volatile memory without persistence.
- **Mitigation:** Plugin shows clear user notices (main.ts:4106-4109) and disables attachment transfers.

---

## LOW SEVERITY

### 6. Debug Logging Exposes Vault Paths
- **File:** `src/main.ts:4068-4070`
- **Issue:** When `settings.debug` is enabled, file paths and vault IDs logged to console.
- **Mitigation:** Debug disabled by default. User must explicitly enable.

### 7. Update Manifest Has No Signature Verification
- **File:** `src/main.ts:86-88`
- **Issue:** Plugin fetches update manifest from `https://github.com/kavinsood/yaos/releases/latest/download/update-manifest.json` without cryptographic signature validation.
- **Mitigation:** HTTPS used. Manifest validated via `isUpdateManifest()` type guard.

### 8. Snapshot Restore Relies on Obsidian Path Sandboxing
- **File:** `src/main.ts:4000-4005`
- **Issue:** File paths from snapshots not validated for traversal. Relies on Obsidian's `normalizePath()` and vault API.
- **Mitigation:** Obsidian vault adapter prevents directory traversal by design.

### 9. QR Code Library (qrcode npm)
- **File:** `src/settings.ts:163-179`
- **Issue:** Third-party library used for QR generation. URL content is user-controlled.
- **Mitigation:** Library is well-known (8.2M weekly downloads). Only encodes the user's own mobile URL.

### 10. Minor Race Conditions in Blob Queue
- **File:** `src/sync/blobSync.ts:296-297, 391-412`
- **Issue:** Upload/download queues use Maps without atomic operations.
- **Mitigation:** Debounce timers (500ms) and per-path deduplication mitigate most scenarios.

---

## POSITIVE FINDINGS

- **Proper WebCrypto usage:** `crypto.subtle.digest("SHA-256", ...)` for hashing (blobSync.ts:177, main.ts:3457)
- **URL validation:** `new URL()` constructor with try-catch (settings.ts:76-77)
- **No obfuscated code:** All TypeScript is readable and well-structured
- **No telemetry:** Trace system logs locally only (`.obsidian/plugins/yaos/logs/`)
- **Proper auth headers:** All HTTP requests use `Authorization: Bearer ${token}` (blobSync.ts:111, snapshotClient.ts:174)
- **Clean separation of concerns:** Sync, storage, UI, and debug are properly isolated

---

## CONCLUSION

The client plugin is **safe to run**. No backdoors or data exfiltration detected. The HIGH findings are inherent to the Obsidian plugin model and are properly mitigated. The codebase demonstrates security awareness (HTTPS enforcement, auth headers, input validation).
