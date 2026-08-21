# Upstream merge status — v0.3.1

**Status:** COMPLETED  
**Merge commit:** `cd24cd1` (`Merge upstream v0.3.1 into fork`)  
**Date:** 2026-08-21  
**Remote:** `upstream` → `https://github.com/multizenteam/multizen-browser.git`  
**Branch merged:** `upstream/master` into local `master`  
**Upstream tip:** `306d9bb` (`fix(proxy): bound the whole geo probe by an overall deadline`)  
**Upstream release tag:** `v0.3.1` (`83c6898 chore: release v0.3.1`; tip is +13 commits after the release)  
**Fork tip before merge:** `ec7af91` (`release: v0.7.1 (#11)`)  
**Backup branch:** `backup/pre-upstream-merge-v0.3.0`  
**Divergence at start:** fork **16** commits ahead / **14** commits behind upstream (merge-base `0871ad3`, prior sync at upstream `v0.3.0`)

## Decisions

No user-facing policy conflicts this time. Fork MCP/CDP surface and strict-pin timezone policy did not collide with upstream hunks.

| # | Topic | Choice | Outcome |
| --- | --- | --- | --- |
| 1 | App / desktop version | Keep fork | `package.json` and `apps/desktop/package.json` stay **0.7.1** (upstream is 0.3.1) |
| 2 | MCP raw CDP / timezone | Unchanged | No conflict markers; `resolveLaunchTimezone` + always-on CDP extras remain |

## Upstream commits pulled

From `0871ad3` → `306d9bb`:

- **v0.3.1 release**
- **Engine updates in Settings** — `EngineUpdateService` + IPC + preload + `engineAutoUpdate` setting; side-by-side stage, apply on next profile launch
- Bootstrap refactor: reusable `installVersion` / `stageVersion` / `resolveLatestVersion`; GC keeps the session’s in-use engine
- Proxy geo: fall back across providers when ipapi is down; whole probe bounded by one deadline
- SOCKS5 bridge failure logs throttled
- Linux: inherit desktop session env (`DISPLAY` / Wayland / DBus) so headful Chromium can attach
- macOS: one arch per runner in `electron-builder.yml` so native modules match the package
- Session restore: stop writing protected `restore_on_startup` (was resetting the default search engine)
- Debug post-bootstrap probe gated behind `MULTIZEN_DEBUG`
- Renderer IPC sends guarded against destroyed `webContents`
- Engine auto-check only on an off→on `engineAutoUpdate` toggle flip

## Mechanical conflicts resolved

| File | Resolution |
| --- | --- |
| `package.json`, `apps/desktop/package.json` | Keep fork version **0.7.1** |

All other incoming files auto-merged. Spot-checked `ChromiumBrowserDriver.ts`, `index.ts`, `Settings.tsx`, `packages/types`, `ChromiumBootstrap.ts`, `proxyGeo.ts`.

## About this fork

`README.md` → **About this fork** now lists **Based on upstream release: `v0.3.1`** and fork app version **0.7.1**.

## Optional follow-ups

```powershell
yarn workspace @multizen/desktop typecheck
yarn test:fingerprint
yarn test:launch-timezone
git stash pop   # restores pre-merge edit to .cursor/skills/publish-release/SKILL.md if desired
# push only when asked
```
