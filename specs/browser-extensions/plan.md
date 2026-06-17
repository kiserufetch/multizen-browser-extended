# Plan — Browser extensions (Phase 1)

Reads `specs/browser-extensions/spec.md` + `research.md`. Architecture only; atomic
tasks are for `/tasks`. No implementation code here.

Resolved decisions: `.crx`-by-ID download accepted (user-initiated, upload fallback);
companion↔app over **CDP binding**; post-install toast + optional Relaunch; ~150 MB
per-extension cap, no count cap; deterministic absolute-path extension ID.

## Approach

Extensions become a per-profile data field (like `proxy`/`fingerprint`). A main-process
**extensions service** owns acquisition (download/validate/unpack) and on-disk layout
under each profile's dir. `ChromiumBrowserDriver` loads a profile's enabled extensions —
plus an always-present first-party **companion extension** — via
`--load-extension`/`--disable-extensions-except` (the exact pair CloakBrowser's own
`extension_paths` emits). The companion injects an **"Add to MultiZen"** button on Web
Store pages and signals the chosen ID back to the app over a **CDP binding** (the driver
is already attached to each profile by CDP, so the originating profile is implicit). The
profile UI gets an Extensions section for manual add/manage.

## Architecture & components

### 1. Data model — `packages/types`
- `ExtensionConfig = { id: string; name: string; enabled: boolean; dir: string;  // relative to profile dataDir
  source: "web-store" | "file" | "folder" }`.
- `Profile.extensions?: ExtensionConfig[]`; add to `CreateProfileInput`/`UpdateProfileInput`.

### 2. Persistence — `packages/profile-manager/ProfileManager.ts`
- Idempotent migration mirroring `proxy_country`:
  `if (!cols.some(c=>c.name==="extensions")) ALTER TABLE profiles ADD COLUMN extensions TEXT`.
- JSON-(de)serialize in `create`/`update`/`rowToProfile` exactly like `proxy`.
- **`delete(id)` cleanup:** today `delete` only removes the DB row — the profile's
  `dataDir` (and thus its extensions) is left on disk (pre-existing leak). Add best-effort
  `rmSync(dataDir, {recursive,force})` in `delete` (or in the `profiles:delete` IPC) so
  extensions don't orphan. Small, isolated fix; satisfies the "delete removes extensions" AC.

### 3. On-disk layout
- Each extension unpacked to `{profileDataDir}/extensions/{extId}/` (absolute path stable
  across launches → deterministic ID, verified). Lives under the profile dir, so it's
  covered by the delete-cleanup above and by per-profile isolation (its runtime state
  goes to the profile's Chromium `Default/` like any installed extension).

### 4. CRX/ZIP pipeline — new `apps/desktop/src/main/extensions/crxPipeline.ts`
- `unpackToProfile(srcPathOrBuffer, profileDataDir) → ExtensionConfig`:
  - Detect input: folder (has `manifest.json`) → copy; `.zip` → extract; `.crx` → detect
    `Cr24` magic, read version int32, compute zip offset (CRX3: `12 + headerLen`; CRX2:
    `16 + pubKeyLen + sigLen` — per research) → slice to zip → extract. Use the existing
    `extract-zip` dep.
  - Validate: `manifest.json` at root parses; `manifest_version === 3` (reject MV2 with a
    clear error); derive a display `name` (manifest `name`, deref `__MSG_` default-locale
    if needed → fallback to id).
  - Atomic install: unpack to a temp dir under the profile, then `rename` into
    `extensions/{extId}/`; on any failure scrub the temp dir (no partial install).
  - Enforce ~150 MB cap on the unpacked size.

### 5. Web Store download — `apps/desktop/src/main/extensions/webstoreDownload.ts`
- `downloadCrxById(id, prodversion) → Buffer` via
  `clients2.google.com/service/update2/crx?response=redirect&acceptformat=crx2,crx3&prodversion=<engineVersion>&x=id%3D<id>%26installsource%3Dondemand%26uc`,
  using **Electron `net`** (follows the 302 to the CDN; consistent with the updater work).
  `prodversion` = the running engine's major (from ChromiumBootstrap current version) to
  avoid 404s. Parse a store URL → bare 32-char id.

### 6. Extensions service — `apps/desktop/src/main/extensions/ExtensionsService.ts`
- `installFromFile(profile, filePath)`, `installFromWebStore(profile, urlOrId)`,
  `remove(profile, extId)`, `setEnabled(profile, extId, enabled)`, `list(profile)`.
- Each install: acquire → `unpackToProfile` → append `ExtensionConfig` → persist via
  ProfileManager.update. Remove: drop entry + `rm` its dir. All operate on the profile's
  `dataDir` (from ProfileManager).

### 7. Launch integration — `ChromiumBrowserDriver`
- After the proxy block in the args builder: collect enabled extension dirs (absolute) +
  the companion dir; push `--load-extension=<a,b,…>` and `--disable-extensions-except=<same>`.
  (Verified pair; persistent user-data-dir already in place.) If a profile has none, still
  load the companion alone.
- **CDP binding for "Add to MultiZen":** inside `session.bootstrapTargets(setup)`, for page
  targets call `send("Runtime.addBinding", { name: "__multizenAddExtension" })`. Register a
  `client.on("Runtime.bindingCalled", …)` (in CdpSession or via an exposed hook) that, when
  `name === "__multizenAddExtension"`, parses the payload `{id}` and routes
  `{ profileId, id }` to `ExtensionsService.installFromWebStore`. **profileId is implicit**:
  this CdpSession belongs to exactly one launched profile (the driver maps session→profile).
  On success, push a renderer event (toast + offer Relaunch) and refresh the profile.
  - Binding visibility: bindings live in the MAIN world; the companion's click handler must
    run in MAIN world (companion `content_scripts` entry uses `"world": "MAIN"`, Chrome
    111+/our engine supports it) so `window.__multizenAddExtension(...)` reaches the binding.
  - CdpSession may need a small addition to expose `Runtime.bindingCalled` (it already
    wraps `client.on`); plan to add an optional `onBinding(name, cb)` to CdpSession.

### 8. Companion extension — `apps/desktop/resources/companion/` (new, shipped in bundle)
- MV3 manifest: `content_scripts` matching **only** `https://chromewebstore.google.com/detail/*`
  (narrow — minimizes footprint), `"world": "MAIN"`, `"run_at": "document_idle"`. **No**
  `web_accessible_resources`, minimal permissions → smallest detectable surface.
- `cs.js`: find the disabled "Add to Chrome" control, inject an **"Add to MultiZen"**
  button beside it; on click extract the id from `location.pathname` and call
  `window.__multizenAddExtension(JSON.stringify({ id }))`; show a tiny inline "added…" state.
- Packaging: `apps/desktop/electron-builder.yml` `extraResources` copies `resources/companion`
  → `process.resourcesPath/companion`. Resolve dir: `app.isPackaged ?
  join(process.resourcesPath,"companion") : join(__dirname, "../../resources/companion")`.
- The companion is never written into `Profile.extensions`, so it stays out of the user's
  list (AC: invisible to user).

### 9. IPC / preload / renderer — mirror `profiles`/`proxy`
- `index.ts`: `extensions:list(profileId)`, `extensions:addFromFile(profileId)` (uses
  `dialog.showOpenDialog` for `.crx/.zip`/folder), `extensions:addFromWebStore(profileId, urlOrId)`,
  `extensions:remove(profileId, extId)`, `extensions:toggle(profileId, extId, enabled)`;
  plus a main→renderer `extensions:installed` push (from the CDP-binding path).
- `preload/index.ts`: `extensions` namespace; `renderer/src/types.ts`: `MultizenApi.extensions`.

### 10. UI — `NewProfileSheet.tsx` + `ProfileEditSheet.tsx`
- An **Extensions** section mirroring the Proxy section: list (name, enable/disable toggle,
  remove), "Add from file" and "Add from Web Store (URL/ID)" actions. On an in-browser
  "Add to MultiZen" completion, a toast appears with an optional **Relaunch profile**.

## Data model / schema changes

SQLite only (no Drizzle in this project): one additive `extensions TEXT` JSON column via
the existing idempotent-migration pattern. Backward-compatible (old rows → `undefined` →
no extensions). No other schema changes.

## Affected files

**New**
- `apps/desktop/src/main/extensions/crxPipeline.ts`
- `apps/desktop/src/main/extensions/webstoreDownload.ts`
- `apps/desktop/src/main/extensions/ExtensionsService.ts`
- `apps/desktop/resources/companion/{manifest.json,cs.js}`
- renderer: an `ExtensionsSection.tsx` shared by both sheets (or inline in each, matching
  how Proxy is done)

**Changed**
- `packages/types/src/index.ts` — `ExtensionConfig` + `Profile.extensions`
- `packages/profile-manager/src/ProfileManager.ts` — column/migration/plumbing + delete cleanup
- `apps/desktop/src/main/ChromiumBrowserDriver.ts` — args + CDP binding wiring
- `packages/cdp-driver/src/CdpSession.ts` — optional `onBinding` hook
- `apps/desktop/src/main/index.ts` — extensions IPC + companion-dir resolution + delete dir cleanup
- `apps/desktop/src/preload/index.ts`, `renderer/src/types.ts` — `extensions` API
- `NewProfileSheet.tsx`, `ProfileEditSheet.tsx` — Extensions section
- `apps/desktop/electron-builder.yml` — `extraResources: resources/companion`

## Risks & trade-offs

- **CRX endpoint ToS (grey area).** User-initiated only; file upload always available as
  fallback. Documented; no bulk/automated server-side fetching.
- **Companion-extension detectability.** It's loaded in every profile → a constant
  presence. Mitigate now: no `web_accessible_resources` (kills the main WAR probe), content
  script scoped to the Web Store domain only, minimal manifest. Deeper stealth (dynamic
  id, removing even the store-page footprint) is a later phase — noted, not solved in v1.
- **`prodversion` drift** on the CRX endpoint → 404. Use the live engine version; on
  download failure, surface a clear error and the upload fallback.
- **Profile attribution with many running profiles.** Each profile = its own CdpSession;
  the driver maps session→profileId, so a binding call is unambiguous. Cover with the
  two-profile isolation test.
- **MAIN-world binding nuance.** If `"world":"MAIN"` or `addBinding` misbehaves on the
  engine, fall back to the companion dispatching a `CustomEvent`/`postMessage` that a
  MAIN-world shim relays to the binding. Verify empirically during implement.
- **Not breaking existing launches.** Profiles with no extensions still launch (companion
  only); the args push is additive and guarded.
- **Large downloads / disk.** ~150 MB cap per extension; extensions live under the profile
  dir and are removed on profile delete (with the new cleanup).
- **Engine version (mac 145) vs `world:MAIN`/addBinding** — verified extension loading
  already; verify the binding path on the real binary early.

## Test strategy (per `/verify`)

1. **Dev no-op / regression:** app launches; profiles with no extensions behave as today.
2. **Manual add:** add MetaMask via Web-Store URL and via `.crx` upload; appears in list;
   loads on launch (provider injected, content scripts run) — real CloakBrowser launch.
3. **"Add to MultiZen":** open the Phantom store page in a profile, click the injected
   button, confirm it installs into *that* profile and works after relaunch.
4. **Isolation:** same login-bearing extension in two profiles → independent sessions.
5. **MV2 rejection** + corrupt input rejection (no partial install).
6. **Enable/disable + remove** reflected on next launch; delete profile removes ext files.
7. `typecheck` + `build`; then the **mandatory independent code-review loop** before merge
   to `master`.

## Spec gaps / notes

- `ProfileManager.delete` not cleaning `dataDir` is a pre-existing leak; this plan fixes it
  as a side effect (needed for the delete-removes-extensions AC). Flagging since it changes
  delete behavior slightly (now also removes on-disk profile data — which is the correct
  behavior anyway).
- Companion deep-stealth (footprint hiding) is explicitly deferred to a later phase.

---

Plan path: `specs/browser-extensions/plan.md`. Proceeding to `/tasks` per the "do
everything" mandate (will surface anything that needs a decision).
