# Tasks — Browser extensions (Phase 1)

Reads `specs/browser-extensions/plan.md` + `spec.md`. Atomic, one commit each, on branch
`feature/browser-extensions`. Bottom-up so `typecheck` + `build` stay green after each.
AC = acceptance criterion in `spec.md`.

**Merge to `master` only after the mandatory independent code-review loop signs off (T14).**

---

- [ ] **T0 — Branch + spec docs.** Create `feature/browser-extensions` off `master`;
  commit `specs/browser-extensions/*`. _Done:_ on branch, docs committed.

- [ ] **T1 — Types.** Add `ExtensionConfig {id,name,enabled,dir,source}` and
  `Profile.extensions?: ExtensionConfig[]` (+ `CreateProfileInput`/`UpdateProfileInput`).
  _Files:_ `packages/types/src/index.ts`. _Depends:_ T0. _Done:_ exported, typecheck green.
  _(AC: data model for the feature)_

- [ ] **T2 — ProfileManager persistence + delete cleanup.** Idempotent
  `ALTER TABLE profiles ADD COLUMN extensions TEXT` (mirror `proxy_country`); JSON
  (de)serialize in `create`/`update`/`rowToProfile`; `delete(id)` also `rm`s the profile's
  `dataDir`. _Files:_ `packages/profile-manager/src/ProfileManager.ts`. _Depends:_ T1.
  _Done:_ round-trips extensions; delete removes dir; typecheck green.
  _(AC: persist; delete removes extension files; backward-compatible migration)_

- [ ] **T3 — CRX/ZIP pipeline.** `crxPipeline.ts`: accept folder/`.zip`/`.crx`; strip
  `Cr24` CRX2/CRX3 header → zip; extract via `extract-zip`; validate `manifest.json` +
  `manifest_version===3` (reject MV2); derive name/id; atomic tmp→rename into
  `{profileDataDir}/extensions/{extId}/`; ~150 MB cap; scrub on failure.
  _Files:_ `apps/desktop/src/main/extensions/crxPipeline.ts` (new). _Depends:_ T1.
  _Done:_ unit-callable; typecheck/build green. _(AC: file add; MV2 reject; no partial install)_

- [ ] **T4 — Web Store download.** `webstoreDownload.ts`: parse store URL→id; `downloadCrxById(id, prodversion)`
  via Electron `net` (follow redirect), prodversion from live engine version.
  _Files:_ `apps/desktop/src/main/extensions/webstoreDownload.ts` (new). _Depends:_ T0.
  _Done:_ returns a CRX buffer for a real id; typecheck/build green. _(AC: add from Web Store)_

- [ ] **T5 — Extensions service.** `ExtensionsService.ts`:
  `installFromFile`/`installFromWebStore`/`remove`/`setEnabled`/`list` over a profile's
  `dataDir`, persisting via ProfileManager. _Files:_
  `apps/desktop/src/main/extensions/ExtensionsService.ts` (new). _Depends:_ T2,T3,T4.
  _Done:_ install/remove/toggle update DB + disk; typecheck/build green.
  _(AC: add/remove/enable-disable)_

- [ ] **T6 — Companion extension + packaging.** `resources/companion/{manifest.json,cs.js}`
  (MV3, `world:MAIN`, match `chromewebstore.google.com/detail/*`, no web_accessible_resources;
  cs injects "Add to MultiZen" → `window.__multizenAddExtension(JSON.stringify({id}))`);
  `extraResources` in electron-builder; a `companionDir()` resolver (packaged vs dev).
  _Files:_ `apps/desktop/resources/companion/*` (new), `apps/desktop/electron-builder.yml`,
  resolver in `apps/desktop/src/main/extensions/`. _Depends:_ T0. _Done:_ companion dir
  resolves in dev + packaged; build green. _(AC: companion present + invisible to user)_

- [ ] **T7 — CdpSession onBinding hook.** Expose `Runtime.bindingCalled` (e.g.
  `onBinding(name, cb)`), reusing the existing `client.on` wiring.
  _Files:_ `packages/cdp-driver/src/CdpSession.ts`. _Depends:_ T0. _Done:_ callback fires
  on binding; typecheck/build green.

- [ ] **T8 — Launch args.** In `ChromiumBrowserDriver` args (after proxy block) push
  `--load-extension`/`--disable-extensions-except` = companion dir + enabled extension abs
  dirs; additive + guarded (profiles with none still launch with companion only).
  _Files:_ `apps/desktop/src/main/ChromiumBrowserDriver.ts`. _Depends:_ T5,T6.
  _Done:_ enabled extensions + companion load on launch (real CloakBrowser check);
  typecheck/build green. _(AC: launch loads enabled extensions; disabled not loaded)_

- [ ] **T9 — CDP "Add to MultiZen" wiring.** Register `Runtime.addBinding`
  (`__multizenAddExtension`) per page target in `bootstrapTargets`; route
  `bindingCalled {id}` + this session's `profileId` → `ExtensionsService.installFromWebStore`;
  push `extensions:installed` to renderer. _Files:_ `ChromiumBrowserDriver.ts`,
  `apps/desktop/src/main/index.ts` (push). _Depends:_ T5,T7,T8. _Done:_ clicking the
  injected button installs into the correct profile (verified); typecheck/build green.
  _(AC: Add-to-MultiZen button installs into current profile)_

- [ ] **T10 — IPC + index wiring.** `extensions:list/addFromFile(dialog)/addFromWebStore/remove/toggle`
  handlers; companion-dir injection into the driver; `delete` dataDir cleanup path; wire
  ExtensionsService. _Files:_ `apps/desktop/src/main/index.ts`. _Depends:_ T5,T6.
  _Done:_ IPC reachable; typecheck/build green. _(AC: manual add/manage from UI)_

- [ ] **T11 — Preload + renderer types.** `extensions` namespace on `window.multizen`
  (+ `extensions:installed` listener), mirroring `chromium.onStatus`.
  _Files:_ `apps/desktop/src/preload/index.ts`, `apps/desktop/src/renderer/src/types.ts`.
  _Depends:_ T10. _Done:_ typed bridge; typecheck/build green.

- [ ] **T12 — UI Extensions section.** Shared Extensions section in `NewProfileSheet` +
  `ProfileEditSheet` (list w/ enable-disable + remove, "Add from file", "Add from Web Store
  URL/ID"); post-install toast + optional **Relaunch profile**; mirror the Proxy section.
  _Files:_ `apps/desktop/src/renderer/src/components/profile/*`. _Depends:_ T11.
  _Done:_ end-to-end add/manage from UI; typecheck/build green.
  _(AC: Extensions section in create+edit; manage; next-launch messaging)_

- [ ] **T13 — Verify (per `/verify`).** (a) dev no-op + profiles with no extensions
  unaffected; (b) add MetaMask via URL and via `.crx` upload → loads on launch (provider
  injected); (c) "Add to MultiZen" on the Phantom store page → installs into that profile;
  (d) two-profile isolation (independent logins); (e) MV2 + corrupt rejection; (f)
  enable/disable + remove + delete-removes-files; (g) `typecheck`+`build`.
  _Depends:_ T9,T12. _Done:_ all behave per spec. _(AC: all)_

- [ ] **T14 — Independent review loop + merge.** Independent reviewer over the full diff;
  fix; re-review until sign-off; then merge to `master`. (Note: branch push touches no
  `.github/workflows`, so normal HTTPS push is fine.) _Depends:_ T13. _Done:_ approved +
  merged.

---

## Traceability (task → AC)
- Add-to-MultiZen button installs → T6, T9, T13
- Add from Web Store / from file → T3, T4, T5, T10, T12, T13
- MV2 / corrupt rejection → T3, T13
- Extensions section in create+edit → T12
- Launch loads enabled; disabled not → T8, T13
- Persist / delete removes files → T2, T13
- Isolation across profiles → T8 (per-profile user-data-dir) + T13
- Companion invisible + always loaded → T6, T8
- Next-launch messaging → T12
- Backward-compatible migration → T2
- typecheck/build + verified + review → T13, T14

Tasks path: `specs/browser-extensions/tasks.md`. Proceeding to `/implement`.
