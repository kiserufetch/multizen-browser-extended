# Tasks — App auto-update (Phase 1)

Reads: `specs/auto-update/plan.md` + `spec.md`. Atomic, ordered, one commit each.
Bottom-up so `typecheck` + `build` stay green after every task. AC = acceptance
criterion in `spec.md`.

**Branch:** all work on `feature/app-auto-update` (never directly on `master`). Merge to
`master` only after the mandatory independent code-review loop signs off (T13).

---

- [ ] **T0 — Branch.**
  Create `feature/app-auto-update` off `master`.
  _Files:_ none. _Done:_ on the new branch, clean tree.

- [ ] **T1 — Add `electron-updater` dependency.**
  Add `electron-updater` to `apps/desktop` `dependencies` (runtime, not dev; not
  asar-unpacked); install so the lockfile updates.
  _Files:_ `apps/desktop/package.json`, root lockfile.
  _Depends:_ T0. _Done:_ `yarn install` clean, `electron-updater` resolves; typecheck/build green. _(AC: enables all below)_

- [ ] **T2 — `UpdateStatus` type.**
  Add the discriminated union (`idle | checking | up-to-date | available | downloading |
  ready | error`) to `packages/types`, mirroring `ChromiumStatus` exactly.
  _Files:_ `packages/types/src/index.ts`.
  _Depends:_ T0. _Done:_ exported, typecheck green. _(AC: state model for whole feature)_

- [ ] **T3 — `autoUpdate` setting.**
  Add `autoUpdate: boolean` to `AppSettings`, `DEFAULTS.autoUpdate = true`, and a
  boolean-validation line in `load()` (same pattern as `browserEngine`).
  _Files:_ `packages/settings-store/src/index.ts`.
  _Depends:_ T0. _Done:_ default ON, invalid values fall back; typecheck green. _(AC: auto-update on/off toggle; default ON)_

- [ ] **T4 — `UpdaterService` (main).**
  New `EventEmitter` class: holds `UpdateStatus` + `lastCheckedAt`; `init()` no-ops when
  `!app.isPackaged`, else configures `autoUpdater` (`autoDownload = platform!=="darwin"`,
  `autoInstallOnAppQuit = true`, `allowPrerelease = false`), maps all autoUpdater events
  → `UpdateStatus`, schedules post-launch check + 4h interval (gated by `autoUpdate` +
  `lastCheckedAt`); `checkForUpdates({manual})` with in-flight + time-gate throttle
  (manual bypasses time gate); `installAndRestart()` (win/linux `quitAndInstall`);
  `downloadUrlFor(version)` (macOS DMG `MultiZen-mac-<arch>.dmg`, release-page fallback);
  on macOS treat `update-available` as terminal `available{downloadUrl}` and **swallow**
  Squirrel signature errors.
  _Files:_ `apps/desktop/src/main/UpdaterService.ts` (new).
  _Depends:_ T1, T2, T3. _Done:_ compiles, exports class; not yet wired; typecheck/build green.
  _(AC: background check/download win/linux; macOS check-only; graceful errors; throttle)_

- [ ] **T5 — Wire service + IPC in `index.ts`.**
  Construct `UpdaterService` in `app.whenReady()` (after window/bootstrap), give it the
  settings accessor + window; forward `updater.on("status", …)` →
  `webContents.send("update:status", …)`; register `update:status`, `update:check`,
  `update:install`, `update:download` (→ `shell.openExternal(downloadUrlFor)`) handlers;
  refresh updater behavior when `settings:update` flips `autoUpdate`.
  _Files:_ `apps/desktop/src/main/index.ts`.
  _Depends:_ T4. _Done:_ app boots, updater inits (no-op in dev), IPC reachable; typecheck/build green.
  _(AC: checks run after launch + periodically; existing flows unaffected)_

- [ ] **T6 — Preload `update` namespace.**
  Add `update: { status, check, install, download, onStatus }` to `api`, mirroring
  `chromium`.
  _Files:_ `apps/desktop/src/preload/index.ts`.
  _Depends:_ T5. _Done:_ bridge exposes `window.multizen.update`; typecheck/build green.

- [ ] **T7 — Renderer API types.**
  Import `UpdateStatus`; add `update: {…}` to `MultizenApi` next to `chromium`.
  _Files:_ `apps/desktop/src/renderer/src/types.ts`.
  _Depends:_ T2, T6. _Done:_ `window.multizen.update` typed; typecheck green.

- [ ] **T8 — `UpdateBanner` component.**
  New persistent, dismissible, full-width bar; subscribes via `update.onStatus`; renders
  only for `ready` (win/linux: "Restart now / Later" → `install()` / local-dismiss
  re-shown next launch), `available` (macOS: "Download" → `download()`), optional slim
  `downloading` progress. Self-contained (no placement yet).
  _Files:_ `apps/desktop/src/renderer/src/components/.../UpdateBanner.tsx` (new).
  _Depends:_ T7. _Done:_ renders per status in isolation; typecheck/build green.
  _(AC: ready→restart banner; macOS download banner; non-blocking)_

- [ ] **T9 — Mount banner in `App.tsx`.**
  Render `<UpdateBanner>` directly under `<TopBar>` (in the root `flex flex-col`, pushes
  content, not overlay); suppress it until Chromium bootstrap status is
  `ready`/`dev-system`.
  _Files:_ `apps/desktop/src/renderer/src/App.tsx`.
  _Depends:_ T8. _Done:_ banner appears under TopBar on relevant states, hidden during
  first-run; typecheck/build green. _(AC: doesn't compete with first-run; non-intrusive)_

- [ ] **T10 — Settings "Updates" section.**
  Add a section to `Settings.tsx` (existing `Row`/section styling): current version
  (`system:info.appVersion`), last-checked time, **Check for updates** button reflecting
  live `UpdateStatus` (checking/up-to-date/available/error), **automatic updates** toggle
  (`patch({ autoUpdate })`), and on macOS the copy stating auto-install isn't available
  yet (notify-to-download).
  _Files:_ `apps/desktop/src/renderer/src/components/screens/Settings.tsx`.
  _Depends:_ T7. _Done:_ section works end-to-end; typecheck/build green.
  _(AC: version shown; manual check works incl. up-to-date; toggle works)_

- [ ] **T11 — Packaging sanity.**
  Confirm electron-builder emits `app-update.yml` into the package and `electron-updater`
  is bundled (asar, not unpacked); adjust `electron-builder.yml` only if needed.
  _Files:_ `apps/desktop/electron-builder.yml` (only if needed).
  _Depends:_ T5. _Done:_ a local `--dir`/packaged build contains `app-update.yml`; build green.

- [ ] **T12 — Verify (per `/verify`).**
  (a) `electron-vite dev` → updater `idle`, no crash, no banner (regression guard).
  (b) Linux AppImage built with `version` below latest → background download → persistent
  Restart banner → relaunches updated; verify Later→re-show next launch + Settings
  check/up-to-date. (c) macOS lower-version build → "Download" banner opens correct DMG,
  no install/restart, forced `error` swallowed. (d) rapid checks → single download / no
  spam. (e) full `typecheck` + `build`.
  _Files:_ none (observation; transient version bump for the test build only).
  _Depends:_ T9, T10, T11. _Done:_ all paths behave per spec; gate green. _(AC: all)_

- [ ] **T13 — Independent review loop, then merge.**
  Run an independent reviewer (fresh agent / `/code-review`) over the full diff; fix
  findings; re-review until it genuinely signs off. Only then open PR / merge to
  `master`. (Mandatory project rule.)
  _Depends:_ T12. _Done:_ reviewer approves; merged to `master`; release follows.

---

## Traceability (task → AC)

- AC "win/linux auto-detect + background download" → T4, T5, T12
- AC "ready banner → restart / later" → T8, T9, T12
- AC "macOS available → download, no install, no raw error" → T4, T8, T9, T12
- AC "Settings version + check + up-to-date" → T10, T12
- AC "auto-update toggle (default ON)" → T3, T10
- AC "graceful error states" → T4, T8, T12
- AC "no double-download / no nag" → T4, T8, T12
- AC "version matches app.getVersion()" → T10, T12
- AC "existing flows unaffected" → T5, T9, T12
- AC "typecheck/build pass + verified" → T12, T13

Tasks path: `specs/auto-update/tasks.md`. Please review before `/implement`.
