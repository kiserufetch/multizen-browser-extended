# Research — Extension dedup (shared store) · `extensions-dedup`

Phase 2 of browser extensions. Source: GitHub issue #10 (ahive): *"How about avoiding
having to create duplicate copies of the same extension, one for each instance?"*

Today MultiZen unpacks every extension into `{profileDataDir}/extensions/{uuid}/` — a
**full copy per profile**. MetaMask/Phantom are ~16–60 MB, so N profiles with the same
wallet = N× disk. Goal: one **shared, content-addressed store** loaded into many
profiles via `--load-extension`, with per-profile state (logins / `chrome.storage`)
staying isolated.

---

## Summary (key findings)

- **Industry-standard model is "shared extension library + per-profile state."** AdsPower,
  Multilogin, Dolphin{anty}, Undetectable all expose a central library that assigns one
  extension to many profiles while keeping login state per profile. GoLogin is the partial
  outlier (per-profile assignment from a shared catalogue). The *physical on-disk* dedup
  (single copy vs. copy-per-profile) is an undocumented internal detail for all vendors —
  the **UX/management** model is confirmed, the disk layout is our own call.
- **Mechanism works:** `--load-extension` pointing multiple concurrently-running profiles
  at the *same* unpacked dir is fine. Extension *code* is read-only-shared; extension
  *state* (chrome.storage / IndexedDB / cookies / logins) lives in **each profile's own
  user-data-dir** (`Default/`), so login isolation is preserved automatically. Concurrent
  reads of one dir are safe — Chromium does not write into the loaded extension dir.
- **CRITICAL stealth correction.** A naive shared store (shared path, no manifest `key`)
  makes stealth **worse**, not neutral. Chromium derives an unpacked extension's ID from
  the manifest `key` **if present, else from a hash of the absolute path**. A shared path
  → the *same* path-derived ID in every profile → a website's web-accessible-resource
  (WAR) probe sees an identical, **non-store, anomalous** ID across profiles → it
  **cross-links the profiles**. The fix is to **inject the genuine store public key** into
  `manifest.key` so every profile exposes the *real* Chrome Web Store ID — the same ID
  millions of real users have, which looks normal and does **not** link profiles to each
  other. So key-injection is not a "bonus"; it's a near-mandatory companion to sharing.
- **The genuine key is recoverable from the CRX we already download.** Web-store CRX
  `manifest.json` does **not** carry a `key`, but the developer public key is embedded in
  the CRX header (CRX2: raw bytes after the header; CRX3: in the protobuf `CrxFileHeader`).
  We already strip that header in `crxToZip()` and currently throw the key away. For
  file/folder uploads with no CRX and no `key`, no genuine store ID exists — a path-derived
  ID is unavoidable there and is acceptable (it matches a real dev-loaded unpacked
  extension; those installs are not "blend into the store crowd" cases anyway).
- **Refcounts should be derived, not stored.** The set of profiles referencing a store
  entry is fully determined by the profiles table (each profile's `extensions[]`). A
  separate refcount file can desync; instead GC = "on removal, if no other profile
  references this `(id, version)`, delete the shared dir."

---

## 1. Current codebase (where the indirection slots in)

Verified file:line (see agent report for fuller quotes).

| Concern | Current state | File |
|---|---|---|
| Unpack destination | `{profileDataDir}/extensions/{randomUUID}/`; returns `dir: "extensions/<uuid>"` (relative) | `crxPipeline.ts:32,84,98` |
| Atomic install | stage in `.staging-<uuid>` → validate → `rename` into place | `crxPipeline.ts:34,88` |
| MV3-only, 150 MB cap | `manifest_version !== 3` rejected; post-extract size check | `crxPipeline.ts:65,77` |
| Extension ID | `computeExtensionId({key, absPath})`: SHA-256 of `manifest.key` (base64-DER) **if present, else of absolute path**; first 16 bytes → a–p | `crxPipeline.ts:140` |
| CRX header strip | `crxToZip()` parses `Cr24`, CRX2/CRX3 offsets; **discards the pubkey** | `crxPipeline.ts:108` |
| `ExtensionConfig` | `{ id, name, enabled, dir, source }` — **no `version`** | `packages/types/src/index.ts:106` |
| Install/remove/toggle/list/persist | `ExtensionsService`; `remove` does `rm(join(dataDir, cfg.dir))`; `persist` replaces-by-id, deletes stale dir | `ExtensionsService.ts` |
| Persistence | `extensions TEXT` JSON column; `delete()` does `rmSync(dataDir)` | `ProfileManager.ts:29,216` |
| Launch args | loop `profile.extensions`, `dir = join(profile.dataDir, ext.dir)`, `existsSync`-filter, build `--load-extension` + `--disable-extensions-except` | `ChromiumBrowserDriver.ts:319` |
| Companion add | `onCompanionInstall(profileId, id)` → web-store download → unpack → persist | `index.ts`, driver |
| Roots | `userData/data/profiles/<profileId>/`; proposed store sibling: `userData/data/extension-store/` | `index.ts:119`, `ProfileManager.ts:113` |

**Insertion points:**
- New shared root `userData/data/extension-store/<extId>/<version>/`.
- `unpackToProfile` → split into `unpackToStore` (writes shared, dedups, injects `key`) +
  a profile reference write. The atomic stage→rename stays, target changes.
- `ExtensionConfig` gains `version` and a way to point at the shared dir (e.g. a `scope`
  discriminator or a path resolver) instead of an in-profile relative `dir`.
- Driver resolves each `ext` to its shared absolute path; `existsSync`-filter stays.
- `remove` / profile `delete` → decrement-by-derivation + GC the shared dir if orphaned.

## 2. Mechanism (shared dir, concurrent profiles, state isolation)

- **Code shared, state per-profile.** Chromium loads extension *files* read-only from the
  `--load-extension` path; all mutable state (chrome.storage.local/sync, IndexedDB, service
  worker registration, cookies, logins) is written under the **profile's** user-data-dir
  (`<engine-data-dir>/Default/...`). Two profiles loading the same dir get independent
  state. This is exactly why "shared files + per-profile state" is safe.
- **Concurrency:** multiple processes reading the same extension dir is fine (no exclusive
  lock; Chromium doesn't write back into the loaded dir). The only write contention is at
  *install* time into the store — handled by atomic stage→rename + "skip if dir already
  exists" (see §5 concurrency).
- **ID from shared path:** deterministic from the one path ⇒ identical across profiles.
  Identical-across-profiles is desirable **only if it's the genuine store ID** (§3); a
  path-derived identical ID is the wrong kind of identical.

## 3. Stealth — store ID vs random/path ID  ✅ reasoning confirmed

- A real Chrome Web Store extension's ID is `SHA-256(developer public key)[:16]`, **identical
  for every user** (uBlock = `cjpalhdlnbpafiamejdnhcphjbkeiagm` for everyone).
  Sources: developer.chrome.com `.../manifest/key`, plasmo.com consistent-ID writeup.
- Sites fingerprint extensions by requesting `chrome-extension://<id>/<web_accessible_resource>`
  and seeing if it loads — keyed on the **ID**. (Starov & Nikiforakis; Sjösten et al.
  "To Extend or not to Extend", arXiv 1808.07359; browserleaks.com/chrome.)
- Therefore:
  - **Genuine store ID, shared across profiles** = looks like an ordinary install; the ID is
    shared by millions of real users, so a cross-profile WAR probe seeing the same ID proves
    nothing more than "this popular extension is installed" — does **not** link the profiles.
    ✅ best.
  - **Random unique ID per profile** (today) = an anomaly **no real Chrome user has**, and a
    unique per-profile probe surface. Doesn't cross-link, but each profile is individually
    "impossible." ✗ worse.
  - **Shared path-derived ID** (naive dedup) = identical anomalous non-store ID in every
    profile ⇒ **actively cross-links** them. ✗ worst for linkage.
- **3b — inject the `key`.** Path-derived IDs are not enough; we must write the genuine
  public key into `manifest.key` so the loaded ID equals the store ID. The key is in the
  CRX header we already parse — extract instead of discard. CRX2: pubkey is the
  `pubKeyLen` bytes at offset 16. CRX3: pubkey is inside the protobuf `CrxFileHeader`
  (`sha256_with_rsa[].public_key`); validate by checking `SHA-256(pubkey)[:16]` maps to the
  expected extension ID. Folder/zip uploads without a key keep a path-derived ID (no store
  identity to recover; acceptable).
- **Dedup-by-content risk:** none for linkage — file bytes aren't observable to sites. The
  only caveat is correctness (don't merge two *different* builds that happen to share an id+
  version); key the store entry by `id + version` and optionally guard with a content hash.

## 4. Prior art (cited)

"Shared library assigned to many profiles + per-profile state" is the norm:
- **AdsPower** — central Extensions area; docs say install there "instead of … inside the
  profile"; data per-profile (60 MB cap). help.adspower.com/docs/extensions
- **Multilogin** — shared engine folders (`mimic`/`stealthfox`) available to all profiles of
  that engine + optional per-profile assignment; state travels with profile.
  multilogin.com/help/.../installing-browser-extensions
- **Dolphin{anty}** — central Extensions page pushes one ext to many profiles / groups.
  help.dolphin-anty.com/en/articles/7067531
- **Undetectable** — "Extension Manager" mass-installs one extension to all profiles; sources
  = store link / unpacked folder / .crx/.zip. docs.undetectable.io/en/mass-management/extension-manager
- **GoLogin** — per-profile assignment from a shared catalogue ("each profile manages its own
  extensions"), with a flag to seed future profiles. support.gologin.com/en/articles/14403896

None document physical on-disk dedup → we choose the layout. Our `--load-extension`-from-
shared-path approach is the natural fit and is what makes one physical copy serve many
profiles.

## 5. Design notes for /specify

- **Store layout:** `userData/data/extension-store/<extId>/<version>/` (the unpacked tree,
  with `manifest.key` injected). Keyed by `extId + version`. `extId` is the **genuine store
  ID** when a key was recovered, else the path-derived id (folder/zip).
- **Profile reference:** `ExtensionConfig` → `{ id, name, enabled, source, version,
  store: true }` (or a `dir` that the resolver recognizes as a store ref). Driver resolves
  to `extension-store/<id>/<version>`.
- **Refcount = derived.** No separate counter. GC on remove/profile-delete: if **no** other
  profile's `extensions[]` references `(id, version)`, `rm` the shared dir; else leave it.
- **Migration:** on launch (or lazily on next install), move existing
  `{profile}/extensions/<uuid>/` into the store: read its `manifest.json` for version,
  inject key if a stored CRX/key is available (else keep path-derived id but note it loses
  store-ID benefit — acceptable for already-installed items), write store entry, rewrite the
  profile ref, delete the per-profile copy. Must be idempotent and safe if interrupted.
- **Concurrency (two profiles install same ext at once):** stage→`rename` into
  `extension-store/<id>/<version>`; if the target already exists, discard the stage and
  reuse. `rename` onto an existing dir must be guarded (check-then-skip; treat EEXIST as
  "already installed by the other").
- **Companion "Add to MultiZen" flow:** unchanged from the user's view; under the hood it
  now writes to the store + a profile ref instead of a per-profile copy.
- **Enable/disable:** still a per-profile flag on the ref — unaffected by sharing.

---

## Recommendation

Build a **content/identity-addressed shared store** at
`userData/data/extension-store/<extId>/<version>/`, loaded into each profile via
`--load-extension`, with **genuine-store-`key` injection** into `manifest.key` (extracted
from the CRX header we already parse). Profiles hold lightweight references; refcounts are
**derived** from the profiles table; GC deletes a store entry when the last referencing
profile drops it. Per-profile login/state isolation comes for free from Chromium's
per-user-data-dir state. This both fixes issue #10 (one copy, not N) **and** upgrades
stealth (real store ID instead of today's random per-profile ID), while avoiding the
cross-linking trap of a naive shared-path-derived ID.

## Constraints & risks

- **CRX3 key extraction** needs minimal protobuf parsing of `CrxFileHeader` — the one new
  fiddly bit. Mitigate by validating `SHA-256(pubkey)[:16] == expected id`; fall back to
  path-derived id (current behavior) if extraction fails, so a parse miss never blocks an
  install.
- **Manifest mutation** (writing `key`) must happen on the store copy before first load and
  must not break signature-free unpacked loading (it won't — `key` is a normal manifest
  field).
- **Migration of live installs** must be idempotent and crash-safe; a half-migrated profile
  must still launch (existsSync-filter already guards missing dirs).
- **Version churn:** updating an extension creates a new `<version>` dir; old versions GC
  when unreferenced. Need a story for "same id, new version" replacing a profile ref.
- **CloakBrowser** specifics (isolated content-script world, console suppression) are
  already handled in Phase 1 and don't affect storage; `--load-extension` from a shared
  path behaves the same.

## Open questions for /specify

1. **Key injection scope:** inject the genuine store `key` for web-store/CRX installs now
   (recommended), and accept path-derived ids only for folder/zip uploads — agreed?
2. **`ExtensionConfig` schema:** add `version` + a `store`/scope discriminator vs. overload
   `dir` with a sentinel — which do you prefer? (Adding fields is cleaner.)
3. **Migration timing:** migrate existing per-profile copies eagerly on next app launch, or
   lazily (leave old copies, only new installs go shared)? Eager reclaims disk immediately
   but touches every profile once.
4. **GC trigger:** GC inline on remove/delete only, or also a sweep on app start to reclaim
   orphans left by crashes?
5. **Cross-profile version policy:** if profile A has uBlock 1.50 and profile B installs
   1.51, keep both versions in the store (two dirs) or auto-upgrade A? (Default: keep both;
   sharing is per `id+version`.)
6. Scope check: is dedup **only** about disk savings for this release, or do we also want the
   stealth store-ID upgrade shipped together? (They're cheaper to do together.)
