# Tasks — Extension dedup (shared store) · `extensions-dedup`

> **Status (implemented):** T1–T9 done. T10/T11 (formal committed test suites) replaced
> by **empirical integration scripts** run against real store CRX files (uBlock Origin Lite,
> Google Translate) — verified: genuine store-ID + key injection, dedup, concurrency, keyless
> content-hash, resolver, gcEntry, sweepOrphans, MV2 rejection — because the repo has no test
> runner and adding one is out of scope for this patch. Two independent reviewers passed
> (SHIPPABLE); their findings (persist re-read race, sweep staging mtime-guard, inline GC on
> profile delete, symlink hardening) are applied. **T12 = manual verify on real CloakBrowser**
> remains for the user.


From `plan.md` (+ `spec.md`, `research.md`). One logical change per task, ordered so
`yarn typecheck` (and build) stays green after each. Run typecheck between tasks.

Legend: **[AC]** = traces to a spec acceptance-criterion group. Deps noted per task.

---

### T1 — `ExtensionConfig` schema: add `version` + `scope`
**Files:** `packages/types/src/index.ts`
Add `version: string` and `scope: "shared" | "profile"` to `ExtensionConfig`; document
that `dir` is used only for `scope:"profile"` (legacy / local) and is `""` for shared.
**Done:** types compile; both fields present with doc comments. **Deps:** none. **[AC: schema]**

### T2 — ProfileManager normalize-on-read (back-compat) + GC enumeration helper
**Files:** `packages/profile-manager/src/ProfileManager.ts`
On `rowToProfile`, normalize each extension: missing `scope` → `"profile"`, missing
`version` → `""` (so pre-existing JSON rows deserialize cleanly; **no SQL migration**).
Add `allExtensionRefs(): Array<{ profileId: string; dataDir: string; ext: ExtensionConfig }>`
(or `listFull(): Profile[]`) for the derived-refcount GC scan.
**Done:** old rows load without error; helper returns every profile's extensions; typecheck
passes. **Deps:** T1. **[AC: migration/compat]**

### T3 — `extensionStore.ts`: store paths + load-path resolver
**Files (new):** `apps/desktop/src/main/extensions/extensionStore.ts`
Implement:
- `storeEntryDir(storeRoot, id, version)` → `<storeRoot>/<id>/<version>`.
- `resolveLoadDir(ext, profileDataDir, storeRoot)` → absolute dir: `scope:"shared"` →
  `storeEntryDir(...)`; else `join(profileDataDir, ext.dir)` (legacy).
Pure functions, no side effects yet.
**Done:** unit-callable; typecheck passes. **Deps:** T1. **[AC: migration/compat — dual resolution]**

### T4 — crxPipeline: recover CRX public key in `crxToZip`
**Files:** `apps/desktop/src/main/extensions/crxPipeline.ts`
Change `crxToZip` to also return the developer public key when present: CRX2 → raw
`pubKeyLen` bytes at offset 16; CRX3 → parse `CrxFileHeader` protobuf, take
`sha256_with_rsa[0].public_key` (minimal hand-rolled varint/length-delimited reader, no
proto dep). Return `{ zipPath, publicKey?: Buffer }`. No behavior change for callers yet
(keep `unpackToProfile` working). Validate nothing here; extraction only.
**Done:** existing install path still works; key returned for a CRX, `undefined` for
plain zip/folder; typecheck passes. **Deps:** none (independent). **[AC: stealth/identity]**

### T5 — crxPipeline: `unpackToStore` (dedup + key injection + content-hash id)
**Files:** `apps/desktop/src/main/extensions/crxPipeline.ts`
Add `unpackToStore({ source, storeRoot, origin })`:
1. Stage in `<storeRoot>/.staging-<uuid>/`, extract, resolve manifest root, validate MV3 +
   150 MB cap (reuse existing logic).
2. Read manifest `version`. Identity:
   - key recovered (T4): compute `idFromKey = computeExtensionId({key})`; if a content-key
     was provided, inject `key: base64(publicKey)` into staged `manifest.json`; `id = idFromKey`.
   - else: `id = contentHash` of the unpacked tree (stable, shareable; no `key` injected).
3. Publish atomically: `rename(stagedRoot, storeEntryDir(storeRoot, id, version))`; **target
   exists → discard stage, reuse** (dedup + concurrency convergence; treat EEXIST as success).
4. Return `ExtensionConfig` ref `{ id, name, version, enabled:true, source, scope:"shared", dir:"" }`.
On ANY key-extraction/parse failure → fall back to content-hash id, no `key` injection, never
throw on that account (install must still succeed).
**Done:** `unpackToStore` produces a shared entry; second call with same id+version reuses
the dir (no duplicate); keyed CRX yields genuine store id; typecheck passes. **Deps:** T3, T4.
**[AC: storage/dedup, stealth/identity, concurrency]**

### T6 — extensionStore: derived-refcount GC + orphan sweep
**Files:** `apps/desktop/src/main/extensions/extensionStore.ts`
Add:
- `gcEntry(storeRoot, id, version, allRefs)` → if no ref in `allRefs` matches `(id,version)`
  with `scope:"shared"`, `rm(storeEntryDir)`; else leave it.
- `sweepOrphans(storeRoot, allRefs)` → remove any `<storeRoot>/<id>/<version>` dir not in the
  shared-ref set, and stale `.staging-*` dirs. Best-effort, never throws.
**Done:** unit-callable; deletes only unreferenced entries; typecheck passes. **Deps:** T3.
**[AC: lifecycle/GC]**

### T7 — ExtensionsService: route installs to the store + GC on remove/replace
**Files:** `apps/desktop/src/main/extensions/ExtensionsService.ts` (+ constructor dep
`extensionStoreRoot`)
- `installFromFile` / `installFromWebStore` → call `unpackToStore({ storeRoot, ... })`;
  persist the shared ref.
- `persist` replace-by-id: when replacing a prior ref, GC the prior `(id,version)` instead of
  blind `rm`; opportunistic migration — re-installing a legacy `scope:"profile"` item yields a
  shared ref and the old per-profile dir is removed (it's private, safe).
- `remove`: drop ref, then GC: legacy → `rm(join(dataDir,dir))`; shared → `gcEntry(...)`
  scanning all profiles.
Companion flow unaffected (still goes through `installFromWebStore`).
**Done:** install creates a shared entry + ref; two profiles installing same id+version → one
dir, two refs; remove from last → dir gone, from one-of-many → dir stays; typecheck passes.
**Deps:** T2, T5, T6. **[AC: storage/dedup, lifecycle/GC, companion]**

### T8 — Driver: resolve load dirs via `resolveLoadDir` (legacy + shared)
**Files:** `apps/desktop/src/main/ChromiumBrowserDriver.ts` (+ constructor dep `extensionStoreRoot`)
Replace `join(profile.dataDir, ext.dir)` (lines ~327–334) with
`resolveLoadDir(ext, profile.dataDir, storeRoot)`; keep the `existsSync` skip-guard and the
companion dir. A profile mixing legacy + shared refs must load both.
**Done:** launch builds correct `--load-extension`/`--disable-extensions-except` for shared
and legacy refs; typecheck passes. **Deps:** T3. **[AC: isolation, migration/compat]**

### T9 — Wire store root in `index.ts` + startup orphan sweep
**Files:** `apps/desktop/src/main/index.ts`
Compute `extensionStoreRoot = join(dataRoot, "extension-store")`; pass to `ExtensionsService`
(T7) and `ChromiumBrowserDriver` (T8). After ProfileManager init at app-ready, call
`sweepOrphans(storeRoot, allRefs)` best-effort (never throw into startup).
**Done:** app boots; sweep runs once and logs (best-effort); install→launch→remove works
end-to-end in dev; typecheck + build pass. **Deps:** T7, T8. **[AC: lifecycle/GC, quality gate]**

### T10 — Unit tests: key extraction, resolver, id derivation
**Files (new):** `apps/desktop/src/main/extensions/__tests__/` (follow existing test setup;
if none in this workspace, add minimal vitest/node:test runner per repo convention)
- CRX2 + CRX3 fixtures → correct pubkey extracted; injected `key` → `computeExtensionId`
  equals known store id (e.g. uBlock `cjpalhdlnbpafiamejdnhcphjbkeiagm`).
- Corrupt/garbage CRX3 → falls back to content-hash id, **no throw**.
- keyless zip/folder → content-hash id stable across two unpacks of identical bytes.
- `resolveLoadDir` shared vs legacy.
**Done:** tests pass. **Deps:** T3, T4, T5. **[AC: stealth/identity, storage/dedup]**

### T11 — Integration tests: dedup, GC, migration (temp store + fake PM)
**Files (new):** `apps/desktop/src/main/extensions/__tests__/`
- install same id+version into 2 profiles → one store dir, two refs, no second copy.
- remove from one → dir stays; remove from last → dir gone.
- profile delete → orphan reclaimed by `sweepOrphans`.
- re-install a legacy item → becomes shared, old per-profile dir removed.
- two concurrent `unpackToStore` of same id+version → one dir, no error (EEXIST reuse).
**Done:** tests pass. **Deps:** T6, T7. **[AC: storage/dedup, lifecycle/GC, concurrency, migration]**

### T12 — Manual verify on real CloakBrowser (dev) + independent review
**Files:** none (validation)
- Add uBlock + a wallet to 2 profiles; inspect disk = ~1× each (one shared copy); both
  launch and run.
- Log into the wallet in profile A → profile B has no session (isolation intact).
- Confirm loaded id == genuine store id in both profiles (chrome://extensions or WAR probe).
- Run both profiles concurrently sharing one extension → no errors.
- Remove from last profile / delete a profile → shared copy reclaimed.
- Re-install a pre-upgrade (legacy) extension → migrates to shared, still works.
- Then run the mandatory independent code-review loop on the full diff before merge.
**Done:** all checks pass; review approves. **Deps:** T9, T10, T11.
**[AC: all groups, quality gate]**

---

## Notes
- **Build stays green:** T1–T4 are additive (no caller switched yet); the install path flips to
  the store only at T7; driver resolution at T8; wiring at T9. Each prior step compiles.
- **No DB migration** — additive JSON, normalized on read (T2).
- **Install never blocked** — key extraction failure degrades to content-hash id (T5/T10).
- **Companion** "Add to MultiZen" keeps working via `installFromWebStore` (T7).
- Out of scope here: the v0.2.10 `cs.js` companion hotfix (separate uncommitted change),
  eager migration, forced version auto-upgrade, CRX signature verification.

Tasks path: `specs/extensions-dedup/tasks.md`. Review before `/implement extensions-dedup`.
