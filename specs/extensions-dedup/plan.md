# Plan — Extension dedup (shared store) · `extensions-dedup`

From `spec.md` + `research.md`. Open questions resolved with leaned defaults:
**(1)** add a best-effort orphan sweep at app start; **(2)** opportunistic per-item
migration — re-installing a legacy extension routes through the shared-store path;
**(3)** legacy installs keep their random path-derived id until re-installed.

## Approach

Introduce a profile-independent **shared extension store** at
`userData/data/extension-store/<extId>/<version>/`. New installs unpack **once** into the
store (deduped by `id+version`), with the genuine developer public key injected into
`manifest.key` so Chromium loads the real Chrome Web Store ID. Profiles stop owning the
bytes and instead hold a **reference** (`ExtensionConfig` gains `version` + a `scope`
discriminator). The launch path resolves a reference to an absolute load dir, handling both
**new shared refs** and **legacy per-profile dirs** (untouched by lazy migration). Disk is
reclaimed by a **derived refcount**: an entry is GC'd when no profile in the DB references
that `(id, version)` — checked inline on remove/profile-delete and via a best-effort sweep
at startup.

Everything stays in the Electron **main** process; no renderer or IPC contract changes
(install/list/remove/toggle signatures are unchanged). TypeScript strict, Yarn 4 workspaces.

## Architecture & components

```
userData/data/
  profiles.db                         # profiles table (extensions JSON column)
  profiles/<profileId>/
    extensions/<uuid>/                # LEGACY per-profile copies (left as-is)
    engines/<engine>/Default/...      # per-profile extension STATE (logins) — unchanged
  extension-store/                    # NEW shared store
    <extId>/<version>/                # unpacked tree, manifest.key injected
      .staging-<uuid>/                # transient publish staging
```

### (a) Store layout + resolver
- New module `extensions/extensionStore.ts` owns the store root and path math:
  - `storeEntryDir(root, id, version)` → `<root>/<id>/<version>`.
  - `resolveLoadDir(ext, profileDataDir, storeRoot)` → absolute dir:
    - `ext.scope === "shared"` → `storeEntryDir(storeRoot, ext.id, ext.version)`.
    - else (legacy / `scope === "profile"`) → `join(profileDataDir, ext.dir)`.
  - Resolver is the single source of truth used by the driver and by GC.
- Store root threaded from `index.ts` (`join(dataRoot, "extension-store")`).

### (b) crxPipeline split — `unpackToStore`
- Keep `crxToZip()` but change it to **return the recovered public key** alongside the zip
  (CRX2: raw `pubKeyLen` bytes at offset 16; CRX3: parse `CrxFileHeader` protobuf →
  `sha256_with_rsa[0].public_key`). Folder/zip with no CRX → no key.
- New `unpackToStore({ source, storeRoot, origin })`:
  1. Stage into `<storeRoot>/.staging-<uuid>/`, extract, resolve manifest root, validate
     MV3 + size cap (reuse existing logic).
  2. Read `manifest.json` `version`. Determine identity:
     - If a key was recovered: validate `idFromKey(pubkey)` (= `SHA256(DER)[:16]` a–p) and
       **inject** `key: base64(pubkey)` into the staged `manifest.json`. `id = idFromKey`.
     - Else: `id` is path-derived from the **final store dir** (see step 3) — but since the
       final path is `<id>/<version>` and `id` depends on the path, path-derived ids use the
       staging-independent rule below.
  3. Publish atomically: `rename(stagedRoot, storeEntryDir(root, id, version))`.
     - **EEXIST / target exists → reuse**: discard the stage, keep the existing entry (this
       is the dedup + concurrency convergence point).
  4. Return `ExtensionConfig` ref: `{ id, name, version, enabled: true, source, scope:
     "shared", dir: "" }`.
- **Path-derived id without a key:** to keep the id stable and shareable, derive it from the
  *canonical store path* `<storeRoot>/<idPlaceholder>...` — chicken-and-egg. Resolution:
  for keyless installs, compute id from a **content hash** of the unpacked tree (stable,
  shareable, independent of path), and place at `<storeRoot>/<contentId>/<version>/`. This
  removes the path dependency entirely for keyless items and still dedups identical uploads.
  (Keyed items use the genuine store id; keyless use a content-hash id. Both are stable and
  shareable — see Risks.)
- Keep `unpackToProfile` temporarily ONLY if needed for fallback; target is to route all new
  installs through `unpackToStore`. Legacy dirs are never produced anymore.

### (c) Schema additions
- `packages/types` `ExtensionConfig`:
  - add `version: string` (manifest version).
  - add `scope: "shared" | "profile"` (default `"profile"` for back-compat on read).
  - `dir` stays (used for legacy `scope:"profile"`; empty for shared).
- `ProfileManager` serialization: JSON column already stores the whole `ExtensionConfig[]`;
  on read, **normalize** missing `scope` → `"profile"` and missing `version` → `""` so old
  rows deserialize cleanly. No DB migration needed (column already exists, JSON is additive).
- Add `ProfileManager.allWithExtensions(): Array<{ id; dataDir; extensions }>` (or reuse
  `list()` + `get()`) for the GC scan.

### (d) ExtensionsService — install/remove/GC
- `installFromFile` / `installFromWebStore`: call `unpackToStore({ storeRoot, ... })` instead
  of `unpackToProfile`. Persist the shared ref on the profile.
- `persist`: replace-by-id as today, but on replacement do **not** blindly `rm` the old dir —
  call GC for the prior `(id, version)` (it may still be shared). Opportunistic migration:
  re-installing a legacy item produces a `scope:"shared"` ref; the old per-profile dir is GC'd
  (it was profile-private, so safe to delete).
- `remove`: drop the ref, then `gcEntry(prior)`:
  - legacy `scope:"profile"` → `rm(join(dataDir, dir))` (private, always safe).
  - shared → delete `storeEntryDir(id, version)` **only if** no other profile references
    `(id, version)` (scan all profiles).
- `gcEntry(id, version)`: scan all profiles' extensions; if none references `(id,version)` →
  `rm(storeEntryDir)`.

### (e) Driver load-path resolution
- `ChromiumBrowserDriver` lines 327–334: replace `join(profile.dataDir, ext.dir)` with
  `resolveLoadDir(ext, profile.dataDir, storeRoot)`. Keep the `existsSync` guard. Driver needs
  the store root injected (constructor opt, like `onCompanionInstall`).

### (f) Startup orphan sweep
- `extensionStore.sweepOrphans(storeRoot, allRefs)`: list `<storeRoot>/<id>/<version>` dirs,
  delete any not present in the union of all profiles' shared refs. Also remove stale
  `.staging-*` dirs. Called once from `index.ts` app-ready, after ProfileManager init,
  best-effort (never throws into startup).

### Companion flow
- `onCompanionInstall` already calls `installFromWebStore` → now store-backed automatically.
  Auto-relaunch logic unchanged.

## Data model / schema changes

- No SQL migration (JSON `extensions TEXT` column is additive; new fields tolerated by
  normalize-on-read). Project uses raw better-sqlite3 (not Drizzle) for this table — follow
  existing pattern.
- `ExtensionConfig` TS type: `+version: string`, `+scope: "shared" | "profile"`.

## Affected files

- `packages/types/src/index.ts` — `ExtensionConfig` fields.
- `apps/desktop/src/main/extensions/crxPipeline.ts` — `crxToZip` returns pubkey; new
  `unpackToStore`; key-injection + content-hash-id helpers; keep `computeExtensionId`.
- `apps/desktop/src/main/extensions/extensionStore.ts` — **new**: store paths, resolver,
  `gcEntry`, `sweepOrphans`.
- `apps/desktop/src/main/extensions/ExtensionsService.ts` — route installs to store; GC on
  remove/replace; needs storeRoot dep.
- `apps/desktop/src/main/ChromiumBrowserDriver.ts` — resolver for load dirs; storeRoot dep.
- `apps/desktop/src/main/index.ts` — compute `extension-store` root; pass to service + driver;
  call `sweepOrphans` at startup.
- `packages/profile-manager/src/ProfileManager.ts` — normalize-on-read for `scope`/`version`;
  helper to enumerate profiles+extensions for GC.

## Risks & trade-offs

- **CRX3 protobuf parsing (highest risk).** `CrxFileHeader` is protobuf; we only need the
  first `sha256_with_rsa` proof's `public_key` (field 2, wire type 2) inside field 2 of the
  header. Hand-roll a minimal varint/length-delimited reader (no proto dep). **Mitigation:**
  validate `SHA256(pubkey)[:16]` maps to the id parsed from the source URL/expected id; on
  ANY failure (parse, mismatch, no key), fall back to a content-hash id with no key injection
  — the install still succeeds (acceptance criterion). Unit-test against a real CRX3 fixture.
- **Keyless id stability.** Path-derived ids can't be shared (path differs / circular).
  Using a **content-hash id** for keyless installs keeps them stable and dedupable. Trade-off:
  a keyless extension's id won't equal any "store" id (there is none) — acceptable; these are
  dev/sideloaded items.
- **manifest.key mutation.** Writing `key` into the staged manifest before publish is a normal
  manifest field and doesn't affect unpacked loading. Done on the store copy only.
- **Concurrency.** Atomic `rename` publish; target-exists → reuse. Two installers of the same
  `id+version` converge to one entry. Staging dirs are uuid-scoped so they never collide.
- **GC races.** GC scans the live profiles table (source of truth). A removal that loses a
  race with a concurrent install of the same id: install republishes/reuses; worst case a
  redundant unpack, never data loss. GC only deletes when zero refs at scan time.
- **Lazy migration leaves old copies.** Accepted; sweep only touches the store, not legacy
  per-profile dirs. Legacy items keep random ids until re-installed (per decision).
- **In-use deletion (Windows).** Deleting a store dir while a profile loads it can EBUSY.
  `rm(..., { force: true })` best-effort; sweep retries next start. Same posture as today's
  `delete()` rmSync.

## Test strategy

- **Unit (crxPipeline/extensionStore):**
  - CRX2 and CRX3 fixtures → correct pubkey extracted, `key` injected, id == known store id
    (e.g. uBlock id). Corrupt CRX3 → falls back to content-hash id, no throw.
  - keyless zip/folder → content-hash id stable across two unpacks of same bytes.
  - `resolveLoadDir` for shared vs legacy refs.
  - `gcEntry` deletes only when unreferenced; keeps when another profile references.
- **Integration (ExtensionsService with a temp store + fake ProfileManager):**
  - install same id+version into 2 profiles → one store dir, two refs, no second copy.
  - remove from one → dir stays; remove from last → dir gone.
  - delete profile → orphan reclaimed by sweep.
  - re-install legacy item → becomes shared, old per-profile dir removed.
- **Manual / dev verify (real CloakBrowser 145):**
  - add uBlock + MetaMask to 2 profiles; inspect disk = ~1× each; both launch and run.
  - log into a wallet in profile A; confirm profile B has no session (isolation).
  - check loaded id == genuine store id in both profiles (chrome://extensions / WAR probe).
  - run two profiles concurrently sharing one extension — no errors.
- **Gate:** `yarn typecheck` + build pass; existing extension flows still work.

## Spec gaps flagged

- None blocking. The keyless-id mechanism (content-hash instead of path-derived) is a
  refinement of the spec's "path-derived id" wording — it's strictly better (shareable +
  stable) and preserves the "install never blocked" guarantee. Calling it out here so it's
  explicit going into `/tasks`.

---

Plan path: `specs/extensions-dedup/plan.md`. Review before `/tasks extensions-dedup`.
