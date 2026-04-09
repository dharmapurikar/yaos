# Dependency & Supply Chain Audit

**Scope:** All npm dependencies in root `package.json` and `server/package.json`

---

## Summary

| Metric | Value |
|--------|-------|
| Total direct dependencies | 22 (some shared) |
| Known CVEs (production) | 0 |
| Known CVEs (dev-only) | 9 (all in linting/tooling chains) |
| Typosquatting risks | None |
| Malicious packages | None |
| Overall assessment | **LOW RISK** |

---

## .npmrc Configuration

```
tag-version-prefix=""
```
**SAFE** - Only removes "v" prefix from version tags. No custom registries, no auth tokens.

---

## Lockfile Analysis

- Both lockfiles use **lockfileVersion 3** (npm v7+)
- All resolved URLs point to `https://registry.npmjs.org`
- **Note:** ~86% of packages in root lockfile missing `resolved` and `integrity` fields (npm cache behavior). Run `npm install --prefer-online` to populate.

---

## Production Dependencies

| Package | Version | Weekly DL | Maintainer | Rating | Notes |
|---------|---------|-----------|------------|--------|-------|
| **fast-diff** | ^1.3.0 | 24.9M | jhchen, luin | SAFE | Text diffing. Zero deps. Used by Yjs ecosystem. |
| **fflate** | ^0.8.2 | 33.8M | 101arrowz | SAFE | Compression. Zero deps. MIT. |
| **obsidian** | 1.8.7 | 39.8K | lishid (Obsidian founder) | SAFE | Official Obsidian API types. |
| **partyserver** | 0.3.2 | 440K | threepointone (Cloudflare) | SAFE | Cloudflare PartyKit. 1 dep (nanoid). |
| **qrcode** | ^1.5.4 | 8.2M | soldair | SAFE | QR generation. 3 deps. MIT. |
| **y-codemirror.next** | ^0.3.5 | 25.4K | dmonad (Kevin Jahns) | SAFE | Yjs + CodeMirror binding. Official Yjs org. |
| **y-indexeddb** | ^9.0.12 | 202.8K | dmonad | SAFE | Yjs offline persistence. Official Yjs org. |
| **y-partyserver** | 2.1.2 | 22.7K | threepointone (Cloudflare) | SAFE | Yjs + PartyServer backend. Official Cloudflare. |
| **yjs** | ^13.6.20 | 3.2M | dmonad | SAFE | Leading CRDT framework. MIT. |

### Dev Dependencies

| Package | Version | Rating | Notes |
|---------|---------|--------|-------|
| **@codemirror/state** | ^6.0.0 | SAFE | Official CodeMirror 6 |
| **@codemirror/view** | ^6.0.0 | SAFE | Official CodeMirror 6 |
| **@eslint/js** | 9.30.1 | SAFE | Official ESLint |
| **@types/node** | ^16.11.6 | SAFE | DefinitelyTyped |
| **esbuild** | 0.25.5 | SAFE | Standard bundler. Has expected postinstall for platform binary. |
| **eslint-plugin-obsidianmd** | 0.1.9 | SAFE | Official Obsidian ESLint plugin (`obsidianmd` GitHub org) |
| **globals** | 14.0.0 | SAFE | Sindre Sorhus |
| **jiti** | 2.6.1 | SAFE | UnJS ecosystem. Zero deps. |
| **tslib** | ^2.4.0 | SAFE | Microsoft |
| **typescript** | ^5.8.3 | SAFE | Microsoft |
| **typescript-eslint** | 8.35.1 | SAFE | Official TypeScript ESLint |
| **ws** | ^8.19.0 | SAFE | Most popular WebSocket library |

### Server Dependencies

| Package | Version | Rating | Notes |
|---------|---------|--------|-------|
| **@cloudflare/workers-types** | 4.20260305.0 | SAFE | Official Cloudflare |
| **wrangler** | 4.69.0 | SAFE | Official Cloudflare CLI |

---

## Known CVEs

### Root Project (6 vulnerabilities - ALL dev-only)

| Package | Severity | In Production? | Risk |
|---------|----------|----------------|------|
| ajv <6.14.0 | Moderate | No (eslint chain) | LOW |
| brace-expansion <1.1.13 | Moderate | No (eslint chain) | LOW |
| flatted <=3.4.1 | High | No (eslint chain) | LOW |
| minimatch <=3.1.3 | High | No (eslint chain) | LOW |
| picomatch <=2.3.1 | High | No (eslint chain) | LOW |
| yaml 2.0.0-2.8.2 | Moderate | No (eslint chain) | LOW |

### Server Project (3 vulnerabilities - ALL dev-only)

| Package | Severity | In Production? | Risk |
|---------|----------|----------------|------|
| undici 7.0.0-7.23.0 (3 CVEs) | High | No (wrangler/miniflare) | LOW |

**All CVEs are in devDependencies (ESLint plugins, wrangler).** None affect the built plugin or deployed server.

Fix: `npm audit fix` (root), `npm audit fix --force` (server).

---

## Postinstall Scripts

| Package | Script | Assessment |
|---------|--------|------------|
| esbuild | `node install.js` (downloads platform binary) | SAFE - Standard behavior |
| workerd (via wrangler) | `node install.js` (downloads workerd binary) | SAFE - Standard Cloudflare tooling |
| sharp (via miniflare) | `node install/check.js` | SAFE - Standard behavior |

No unexpected or suspicious install scripts found.

---

## Typosquatting Check

All packages verified against canonical repositories:
- `partyserver` -> `github.com/cloudflare/partykit` (official)
- `y-partyserver` -> `github.com/cloudflare/partykit` (official)
- `fflate` -> well-known (33.8M/week), not a typo of "deflate"
- `eslint-plugin-obsidianmd` -> `github.com/obsidianmd/eslint-plugin` (official)

No typosquatting concerns.

---

## Recommendations

1. **Run `npm audit fix`** in both root and server directories to clear dev-only CVEs
2. **Regenerate lockfiles** with `npm install --prefer-online` to populate integrity hashes
3. **Consider pinning** range deps (`^`) for critical production packages in package.json
4. No action needed for production security - all CVEs are in dev tooling
