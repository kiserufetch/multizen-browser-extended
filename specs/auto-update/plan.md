# Plan — App auto-update (Phase 1)

Reads: `specs/auto-update/spec.md` (resolved decisions) + `specs/auto-update/research.md`.
Architecture decisions here; atomic task breakdown is for `/tasks`. No implementation
code in this doc.

## Approach

Add `electron-updater` and wrap it in a single main-process **`UpdaterService`** that
mirrors the existing `ChromiumBootstrap` shape (an `EventEmitter` holding a
discriminated-union status, pushed to the renderer over IPC exactly like
`chromium:status`). The service owns all platform branching:

- **Windows (NSIS) + Linux (AppImage):** full flow — background check → `autoDownload`
  → on `update-downloaded` emit `ready`; renderer shows a persistent banner whose
  "Restart" calls `quitAndInstall()`. Also installs on quit (electron-updater default).
- **macOS:** **check-only**. `autoDownload = false`; on `update-available` emit a
  terminal `available` carrying a DMG deep-link; renderer shows a passive "Download"
  banner that opens the URL externally. Never call `quitAndInstall`; catch and swallow
  the Squirrel signature `error` so it never surfaces raw.

The renderer gets a small `update` namespace on `window.multizen` (mirroring
`chromium`), one **persistent dismissible banner** in `App.tsx`, and an **Updates
section** in the existing `Settings.tsx`. A new `autoUpdate` boolean in `AppSettings`
(default **ON**) gates the automatic background activity; the manual "Check for updates"
button always works regardless.

Guard rails: the service is a **no-op when `!app.isPackaged`** (dev) or when
electron-updater can't operate (e.g. Linux not launched as a real `.AppImage`), so dev
runs and extracted builds never crash or spam. A DIY `lastCheckedAt` throttle +
in-flight flag prevents electron-updater's known double-download.

## Architecture & components

### Main process — `apps/desktop/src/main/UpdaterService.ts` (new)

Class `UpdaterService extends EventEmitter`, constructed in `app.whenReady()` after the
window/bootstrap wiring, given a `() => AppSettings` accessor (or current settings
snapshot) + the `BrowserWindow` for pushes. Responsibilities:

- Holds `private status: UpdateStatus` (+ getter) and `private lastCheckedAt: number`.
- `init()` — if `!app.isPackaged` → set `idle`, log, return (no electron-updater). Else:
  configure `autoUpdater` (logger, `autoDownload = process.platform !== "darwin"`,
  `autoInstallOnAppQuit = true`, `allowPrerelease = false`), register event handlers,
  then schedule the first check (~a few seconds after ready, only if `autoUpdate` on) and
  a periodic re-check `setInterval` (**cadence: every 4h**, gated by `lastCheckedAt`).
- `checkForUpdates({ manual })` — throttle: skip if a check is in-flight, or if
  automatic and `< cadence` since `lastCheckedAt`; manual bypasses the time gate but not
  the in-flight guard. Sets `checking`, calls `autoUpdater.checkForUpdates()`, stamps
  `lastCheckedAt`. On `manual` with no update → emit transient `up-to-date`.
- `installAndRestart()` — win/linux only; `autoUpdater.quitAndInstall()`.
- `downloadUrlFor(version)` — build macOS DMG deep-link
  `…/releases/download/v<version>/MultiZen-mac-<arch>.dmg` (`arch` from `process.arch`
  → `arm64`/`x64`); fallback to the release page.
- autoUpdater event mapping → `UpdateStatus`:
  - `checking-for-update` → `checking`
  - `update-available(info)` → win/linux: leave as `checking`/`downloading` (download
    auto-starts); macOS: `available { version, downloadUrl }` (terminal)
  - `download-progress(p)` → `downloading { version, percent, bytesPerSecond }`
  - `update-downloaded(info)` → `ready { version }`
  - `update-not-available` → `idle` (or transient `up-to-date` if the check was manual)
  - `error(e)` → `error { message }`; on macOS, signature-rejection errors are mapped to
    the last `available`/`idle` instead of surfacing (never raw)
- Every status change → `this.emit("status", next)`; `index.ts` forwards to renderer.

`autoUpdate` toggle semantics: when **off**, skip the launch check + clear the interval
(or no-op the periodic tick); manual `checkForUpdates({manual:true})` still runs. Toggle
flip is handled by re-reading settings on `settings:update`.

### Shared type — `packages/types/src/index.ts`

`UpdateStatus` discriminated union mirroring `ChromiumStatus`:

```
type UpdateStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "up-to-date"; version: string }
  | { kind: "available"; version: string; downloadUrl: string }   // macOS terminal
  | { kind: "downloading"; version: string; percent: number; bytesPerSecond?: number }
  | { kind: "ready"; version: string }
  | { kind: "error"; message: string }
```

### IPC — `apps/desktop/src/main/index.ts`

- Construct `UpdaterService` inside `app.whenReady()`; subscribe
  `updater.on("status", s => mainWindow?.webContents.send("update:status", s))`
  (mirrors the `chromium:status` push at lines 130–132).
- Handlers alongside the chromium ones (lines 206–207):
  - `update:status` → `updater.getStatus()`
  - `update:check` → `updater.checkForUpdates({ manual: true })`
  - `update:install` → `updater.installAndRestart()` (win/linux)
  - `update:download` → `shell.openExternal(updater.downloadUrlFor(version))` (macOS)
- Re-init/refresh updater when `settings:update` flips `autoUpdate`.

### Preload — `apps/desktop/src/preload/index.ts`

Add an `update` namespace to `api` (mirrors `chromium`, lines 108–115):
`status()`, `check()`, `install()`, `download()`, `onStatus(cb) → unsubscribe`.

### Renderer types — `apps/desktop/src/renderer/src/types.ts`

Import `UpdateStatus` from `@multizen/types`; add `update: { status, check, install,
download, onStatus }` to `MultizenApi` (next to `chromium`, lines 86–89).

### Settings — `packages/settings-store/src/index.ts`

`AppSettings` += `autoUpdate: boolean`; `DEFAULTS.autoUpdate = true`; validation in
`load()` (`if (typeof merged.autoUpdate !== "boolean") merged.autoUpdate = DEFAULTS…`),
same pattern as `browserEngine`.

### Renderer UX

- **`UpdateBanner.tsx` (new)** — persistent, dismissible bar rendered in `App.tsx`
  directly under `<TopBar>` (inside the root `flex flex-col`, so it pushes content, not
  floats). Subscribes via `window.multizen.update.onStatus`. Visible only for actionable
  states:
  - `ready` (win/linux): "MultiZen v{X} is ready — **Restart now** / Later". Restart →
    `update.install()`. Later → local-dismiss for this launch (re-show next launch, per
    decision).
  - `available` (macOS): "MultiZen v{X} is available — **Download**". → `update.download()`.
  - `downloading`: optional slim progress (percent), non-blocking.
  - **Suppressed while the Chromium bootstrap modal is active** (i.e. until chromium
    status is `ready`/`dev-system`) so it never competes with first-run.
- **Settings → new "Updates" section** in `Settings.tsx` (same `Row`/section styling):
  current app version (from `system:info.appVersion`, already exposed), last-checked
  time, a **Check for updates** button reflecting live `UpdateStatus`
  (checking/up-to-date/available/error), and the **automatic updates** toggle
  (`patch({ autoUpdate })`). On macOS the section explains "auto-install isn't available
  on macOS yet — we'll notify you to download."
- Reuse existing toast (`App.tsx:429`) for transient confirmations (e.g. "You're up to
  date" after a manual check) if the banner isn't the right surface.

### Build / packaging — `apps/desktop/electron-builder.yml`

No publish-config change needed (GitHub provider already set). electron-builder writes
`app-update.yml` into the package automatically; confirm it lands. `electron-updater`
moves into `dependencies` (runtime), and is included in the asar (not unpacked).

## Data model / schema changes

None in SQLite (no Drizzle/DB touch). Only the JSON `AppSettings` gains `autoUpdate`
(additive, backward-compatible via the existing merge-with-DEFAULTS + validation).

## Affected files

**New**
- `apps/desktop/src/main/UpdaterService.ts`
- `apps/desktop/src/renderer/src/components/.../UpdateBanner.tsx`

**Changed**
- `packages/types/src/index.ts` — `UpdateStatus`
- `apps/desktop/src/main/index.ts` — construct service, status push, 4 IPC handlers,
  settings-flip refresh
- `apps/desktop/src/preload/index.ts` — `update` namespace
- `apps/desktop/src/renderer/src/types.ts` — `MultizenApi.update` + import
- `packages/settings-store/src/index.ts` — `autoUpdate` field + default + validation
- `apps/desktop/src/renderer/src/App.tsx` — mount `<UpdateBanner>` under `<TopBar>`
- `apps/desktop/src/renderer/src/components/screens/Settings.tsx` — Updates section
- `apps/desktop/package.json` — add `electron-updater` dependency
- `apps/desktop/electron-builder.yml` — only if `app-update.yml` needs nudging

## Risks & trade-offs

- **macOS auto-install impossible (verified).** Handled by design: check-only,
  `autoDownload=false`, never `quitAndInstall`, swallow Squirrel `error`. UX is a
  first-class "Download" path, not a broken "Restart".
- **Unsigned win/linux trust only sha512 + HTTPS to GitHub.** A compromised release
  pipeline = RCE on users. Phase-1 acceptable; **follow-up** (out of scope): scoped/
  short-lived `GH_TOKEN`, 2FA, release/branch protections. Note in plan, don't block.
- **electron-updater double-download / no daily throttle.** Mitigated by the in-flight
  guard + `lastCheckedAt` time gate; manual check bypasses only the time gate.
- **Dev / non-AppImage no-op.** `!app.isPackaged` short-circuits `init()`; on Linux,
  electron-updater self-detects a non-`.AppImage` launch and won't proceed — we treat
  any updater unavailability as `idle`, never an error toast. Prevents dev-run crashes.
- **Don't disturb first-run.** UpdaterService init is independent and async; the banner
  is suppressed until Chromium bootstrap is `ready`. The first update check is delayed a
  few seconds after `ready` so it doesn't compete with the 560 MB runtime download.
- **Banner nagging.** Decision: persistent-but-dismissible, re-show once per launch; no
  repeated popups within a session.
- **AppImage in-place update needs the real `.AppImage`** (APPIMAGE env). Documented;
  no-op otherwise.

## Test strategy (per `/verify`)

Tests are optional in this repo (no framework wired); rely on driving the real app +
targeted manual simulation:

1. **Dev no-op:** `electron-vite dev` → updater stays `idle`, no crash, no banner; app
   behaves exactly as today. (Fast regression guard.)
2. **Linux auto-install path (primary):** build an AppImage with `version` set *below*
   the current published release (e.g. 0.2.6 while latest is 0.2.7), run the real
   `.AppImage` → observe background download → persistent "Restart" banner → click
   Restart → relaunches into the newer version. Also verify "Later" dismiss + re-show
   next launch, and the Settings "Check for updates" + up-to-date state.
3. **macOS check-only:** build with a lower `version`, launch → "vX available →
   Download" banner; clicking Download opens the correct
   `MultiZen-mac-<arch>.dmg`; confirm **no** install/restart attempted and **no** raw
   error appears (force an `error` event to confirm it's swallowed on mac).
4. **Windows NSIS** (if a Windows env is available): same as Linux path; otherwise rely
   on the shared code path + Linux verification and a follow-up Windows smoke test.
5. **Throttle:** trigger several rapid checks → assert a single download / no banner
   spam (observable via logs).
6. **Gate:** `typecheck` + `build` pass; existing flows (first-run bootstrap, profile
   launch, MCP, Settings) unaffected.
7. **Mandatory:** independent code-review loop before merging to `master` (per project
   rule), iterating until the reviewer signs off.

## Spec gaps / notes for review

- **Re-check cadence resolved here:** every **4h** while running + once shortly after
  launch (research-backed; was the lone open question in the spec).
- **macOS Settings copy:** the Updates section will state auto-install isn't available
  on macOS yet — confirm that wording direction is acceptable, or if you'd rather it
  stay silent and only show the banner.
- **Where exactly the banner sits:** under `TopBar`, full-width, pushing content down
  (not an overlay). Flag if you'd prefer it inside the main content column instead.

---

Plan path: `specs/auto-update/plan.md`. Please review — especially the **cadence (4h)**,
the **macOS UX copy**, and **banner placement** — before I run `/tasks`.
