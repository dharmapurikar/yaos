# Server Security & Backdoor Analysis

**Scope:** All files in `server/src/`, CI/CD workflows, update scripts, configuration

---

## CRITICAL FINDINGS

### 1. No Rate Limiting on Auth Endpoints
- **File:** `server/src/index.ts:579-619`
- **Issue:** The `/claim` endpoint allows unlimited attempts. An attacker can brute-force the initial server claim with no throttling.
- **Impact:** Server takeover if claim token is weak.
- **Recommendation:** Implement per-IP rate limiting via Cloudflare Rate Limiting rules (10 requests/hour on `/claim`).

### 2. Cross-Vault Data Access via Durable Object Routing
- **File:** `server/src/index.ts:728-729`
- **Issue:** Vault sync is delegated to Durable Objects via `getServerByName(env.YAOS_SYNC, syncRoute.vaultId)`. If authorization check at lines 682-688 is bypassed (e.g., via a bug), changing the vaultId grants access to any vault.
- **Impact:** One compromised token could access all vaults on the same Worker.
- **Recommendation:** Embed vaultId in request context, validate it matches the Durable Object's actual room ID.

### 3. Unsafe CI/CD Update Pipeline
- **File:** `server/.github/workflows/update-yaos.yml:29-46`, `server/.github/workflows/yaos-ops.yml`
- **Issue:** The workflow parameter `release_repo` is configurable. No signature verification on downloaded artifacts.
- **Impact:** Compromised GitHub account or social engineering could push malicious code to all instances.
- **Recommendation:** Hardcode the release repository. Add GPG signature verification to artifacts.

---

## HIGH SEVERITY

### 4. Timing Attack on Environment Token
- **File:** `server/src/index.ts:268-269`
- **Issue:** When `SYNC_TOKEN` is set via environment, comparison uses `token === state.envToken` (plaintext equality), which is vulnerable to timing attacks.
- **Recommendation:** Hash environment tokens or use timing-safe comparison.

### 5. No Encryption at Rest
- **File:** `server/src/chunkedDocStore.ts` (entire file)
- **Issue:** All vault CRDT documents stored as plaintext in Durable Object SQLite. Cloudflare account compromise exposes all vault contents.
- **Recommendation:** Implement client-side encryption before transmission.

### 6. Overly Permissive CORS
- **File:** `server/src/index.ts:61-66`
- **Issue:** `Access-Control-Allow-Origin: *` allows any website to make authenticated requests.
- **Impact:** Combined with token in URL params, a malicious website could trigger sync operations.
- **Recommendation:** Implement origin whitelisting or require custom headers.

### 7. Vault IDs Not Strictly Validated
- **File:** `server/src/index.ts:118-127, 129-138`
- **Issue:** Vault IDs from URL params accepted without character validation. Minimum 8 chars checked but no whitelist.
- **Impact:** Special characters in vault IDs could cause storage key collisions or path traversal in R2 keys.
- **Recommendation:** Strict alphanumeric + hyphen validation regex.

### 8. SHA256 Used for Token Hashing (Not bcrypt/argon2)
- **File:** `server/src/index.ts:186-189`
- **Issue:** SHA256 is a fast hash, not designed for password/token storage. Brute-force is feasible.
- **Recommendation:** Use bcrypt or argon2 for token hashing.

### 9. Predictable Snapshot IDs
- **File:** `server/src/snapshot.ts:36-42`
- **Issue:** Snapshot IDs use `Date.now()` (base36) + 4 random bytes (32 bits). Only ~40 bits of entropy.
- **Recommendation:** Use 16+ bytes of randomness.

### 10. Snapshot Index Reveals Vault Structure
- **File:** `server/src/snapshot.ts:118-130`
- **Issue:** Snapshot metadata includes `markdownFileCount`, `blobFileCount`, `referencedBlobHashes` in plaintext.

### 11. No Rate Limiting on Blob Uploads
- **File:** `server/src/index.ts:440-475`
- **Issue:** 10MB per-file limit but no overall quota. Attacker can exhaust R2 storage.

### 12. Unsafe Server Update Script
- **File:** `server/scripts/update-from-release.mjs:146-167`
- **Issue:** Downloads zip from GitHub releases without checksum or signature verification.

### 13. Error Messages Expose Server State
- **File:** `server/src/config.ts:137`, `server/src/index.ts:648-654`
- **Issue:** Detailed error messages returned to clients reveal configuration details.
- **Recommendation:** Return generic errors, log details server-side.

---

## MEDIUM SEVERITY

### 14. No Auth on Config Durable Object Internal Endpoints
- **File:** `server/src/config.ts:85-155`
- **Issue:** Internal HTTP requests to ServerConfig DO not validated for origin.

### 15. WebSocket Upgrade Accepts Any Origin
- **File:** `server/src/index.ts:140-142, 663-730`
- **Issue:** No origin validation before WebSocket upgrade.

### 16. Trace Store Logs Contain Client Data
- **File:** `server/src/traceStore.ts:65-117`
- **Issue:** Trace entries store client-provided data including user agents and connection details.

### 17. Storage Key Injection via Vault IDs
- **File:** `server/src/snapshot.ts:32-34, 44-46`
- **Issue:** Vault IDs used directly in R2 key construction (`v1/${vaultId}/blobs/${hash}`). No path traversal prevention.

### 18. WebSocket Message Size Not Limited
- **File:** `server/src/server.ts:83-141`
- **Issue:** No explicit limit on Yjs update sizes. Memory exhaustion possible.

### 19. JSON Parsing Without Schema Validation
- **File:** `server/src/index.ts:113-125, 584-596, 793-797`
- **Issue:** Multiple endpoints parse JSON without strict schema validation (no Zod/Ajv).

### 20. R2 Snapshot Listing Has No Pagination Limit
- **File:** `server/src/snapshot.ts:58-78`
- **Issue:** `listAllKeys()` fetches all snapshots without bounds. Memory exhaustion possible.

### 21. Journal Entry Accumulation Without Bounds
- **File:** `server/src/chunkedDocStore.ts:368-415`
- **Issue:** Compaction triggers at 50 entries or 1MB, but no absolute vault size limit.

### 22. HTTP URLs Accepted for Update Repo
- **File:** `server/src/config.ts:40-63`
- **Issue:** `normalizeUpdateRepoUrl()` accepts both http and https.

---

## BACKDOORS: NONE FOUND

- No hidden admin endpoints
- No hardcoded bypass tokens
- No data sent to external services from the server
- No phone-home behavior
- All endpoints are documented and serve the sync protocol

---

## CONCLUSION

The server has **no backdoors** but has **significant security gaps** that should be addressed before deploying with sensitive data. The most critical issues are the lack of rate limiting, overly permissive CORS, and the unsigned auto-update pipeline. These are quality/design issues, not malicious intent.

### Priority Actions
1. Add rate limiting on `/claim` endpoint
2. Restrict CORS to specific origins
3. Add signature verification to update pipeline
4. Validate vault IDs strictly
5. Consider client-side encryption for data at rest
