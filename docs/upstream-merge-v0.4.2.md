# Upstream merge status — v0.4.2 (2026-10-31)

**Status:** COMPLETED  
**Merge commit:** `e9294af` (`Merge upstream v0.4.2 into fork`)  
**Date:** 2026-10-31  
**Remote:** `upstream` → `https://github.com/multizenteam/multizen-browser.git`  
**Branch merged:** `upstream/master` into `release/v0.10.0`  
**Upstream tip:** `794bbf4` (`chore(release): 0.4.2`), tagged `v0.4.2`  
**Fork tip before merge:** `acfed5d` (`release: v0.9.0`)  
**Divergence at start:** fork **44** commits ahead / **53** commits behind upstream (merge-base `b0bc604`)  
**Fork release:** `0.10.0`

## Fetching upstream

`git fetch --tags upstream` fails with "would clobber existing tag": `v0.2.11`, `v0.3.0`, `v0.3.1`, `v0.4.0` and `v0.4.1` exist on both sides with different content. Use `git fetch upstream --no-tags`, and never push upstream tags here. A reachable upstream tag would also become the "previous tag" that `scripts/release-notes.sh` compares against.

## Decisions

| # | Topic | Choice | Why |
| --- | --- | --- | --- |
| 1 | App / desktop version | Fork semver, **0.10.0** (minor) | New engine, one engine removed |
| 2 | CFT engine | Taken from upstream: **removed** | The per-profile engine work is built on its removal. Stored `"cft"` coerces to CloakBrowser |
| 3 | `--fingerprint-webrtc-ip=auto` | **Fork: not passed** | The binary leaks the literal `auto` as a cohort marker and bypasses the non-proxied-UDP policy (0.8.2) |
| 4 | Launch timezone | **Fork: strict-pin** | Upstream still aligns to proxy geo unconditionally and lists that as known debt |
| 5 | Raw CDP | **Fork: always on** | Upstream gates `cdp_send` behind `MULTIZEN_MCP_ALLOW_RAW_CDP` plus a denylist. `cdp_send_no_safety` stays unrestricted by owner decision |
| 6 | `get_cookies` urls | **Fork: optional** | Upstream requires them. The verb signature is `urls?: string[]` on every driver |
| 7 | Human handoff | **Fork: kept**, including the README row upstream dropped | The fork ships `request_human` / `wait_for_human` / `resume_human` |
| 8 | Thordata referral link + README logo | Taken from upstream, unchanged | Not a conflict. The referral code belongs to upstream, so remove it if the fork should not carry it |

## Upstream commits pulled

From `b0bc604` → `794bbf4`:

- **Per-profile engine** — profile `engine` column, engine picker, export/import with a not-in-roster fallback, `EngineRegistry`, `EngineRouter`, engine icon on cards and rows
- **Camoufox** — `FirefoxBrowserDriver` over `playwright-core` + `camoufox-js`, `CamoufoxBootstrap` with a pinned SHA-256, fingerprint mapping, WebRTC blocked on proxied profiles, download progress banner
- **Engine-neutral `BrowserDriver` verbs** — `evaluateJs`, `getCookies`, `setCookies`, `listTabs`, `newTab`, `activateTab`, `closeTab`
- **CFT removal** — bootstrap, driver branches, Settings UI, `reconcileDeviceFamilyToHost`
- **Linux sandbox** — AppArmor secure setup (`linuxSandbox.ts`), sandbox-failure backstop, host `--no-sandbox` no longer forwarded
- `adm-zip` security bump (GHSA-vwc7-r8mq-g2x9), typecheck gate that really runs `tsc`, Thordata referral and README changes

## Conflicts

| File | Blocks | Resolution |
| --- | --- | --- |
| `apps/desktop/src/main/ChromiumBrowserDriver.ts` | 9 | Took upstream's CFT removal and `attemptSpawn` backstop. Kept the fork's imports, EXE-metadata version lookup, strict-pin timezone, WebRTC note and `closeAll(opts)`. Inside `attemptSpawn`: `detached` process groups and `killProcessTree` replace upstream's `killPid` / `waitForPidDeath` |
| `packages/profile-manager/src/ProfileManager.ts` | 6 | Union of `engine` with `align_timezone_to_proxy` + `strict_geo_coherence` in the row type, migrations, `INSERT` and `UPDATE` |
| `packages/mcp-server/src/server.ts` | 1 | Kept the fork's `probe_fingerprint`; dropped upstream's raw-CDP gate and its duplicate `get_cookies` / `set_cookies` / `new_tab` cases |
| `apps/desktop/src/main/index.ts` | 1 | `EngineRouter` plus the fork's shared `ActivityLog`; per-session MCP servers unchanged |
| `README.md` | 2 | Both engine and WebRTC rows; merged tool list |
| `package.json`, `apps/desktop/package.json` | 1 each | Fork version |

## Changes git did not flag

- `EngineRouter` and `FirefoxBrowserDriver` were written without `clickRef` / `typeRef`. Added them; Camoufox returns a clear error because its `extract` produces no refs.
- `EngineRouter.closeAll` dropped `{ gracefulMs, reap }`, which the quit path needs to land the tree-kill before the 3s watchdog. It now forwards them and closes both engines concurrently.
- `get_cookies`, `set_cookies` and `new_tab` in the fork's dispatch still composed CDP, so they would have failed on Camoufox. They now call the verbs.
- `probe_fingerprint` called `cdpSend`, which throws on Camoufox. It now uses `evaluateJs`, and compares only screen + timezone when the live UA is Firefox.
- Camoufox launches ignored `alignTimezoneToProxy` and `strictGeoCoherence`, so a launch that must fail went through. The policy moved to `launchGeo.ts` and both engines call it (`52214fe`).
- `check-chrome-version` stopped accepting a leftover CFT cache (`17c8a63`).
- `gracefulShutdown` no longer awaits `Browser.close` or the socket close before the kill. Upstream bounded both; the fork's version did not, so a wedged browser could block Stop and outlive the quit watchdog. The SIGTERM wait is now half the budget, which keeps the quit path under its 3s watchdog.
- The `engine` migration pins existing rows to `cloakbrowser`. Otherwise changing the default engine moves every upgraded profile onto an empty data dir, contradicting the Settings text "Existing profiles keep their own". Profiles created through MCP are still unpinned.

## Verification

| Check | Result |
| --- | --- |
| `yarn typecheck` (all workspaces) | pass |
| `yarn install --immutable` | pass |
| `yarn test:unit` | cdp-driver 28, mcp-server 35, desktop 38: all pass |
| `yarn test:fingerprint`, `test:fingerprint-entropy`, `check:chrome-version`, `test:launch-timezone` | pass |
| `test-engine-resolution.ts` (from upstream, not in CI) | 12/12 pass |
| `yarn smoke:fingerprint-seed` | offline checks pass |
| Packaged Windows build (`electron-builder --dir`) | builds; `playwright-core`, `camoufox-js`, `better-sqlite3` are in `app.asar.unpacked` |
| Packaged app over real MCP HTTP, isolated user data, CloakBrowser 146 | 52/52 checks with the window brought to front first, see below |

The live run covered launch, navigate, `extract` refs, `click_ref` / `type_ref`, `evaluate_js`, `probe_fingerprint`, screenshot, cookies, tabs, waits, both raw CDP tools, handoff, close with no process left, relaunch with session restore, a proxied profile on a dead proxy, and app quit with a profile still running (no process left).

On the real command line of a proxied profile: no `--fingerprint-webrtc-ip`, `--webrtc-ip-handling-policy=disable_non_proxied_udp` present, `--proxy-server` pointing at the local socks5 bridge, the pinned timezone, and exactly one `--disable-features`.

## Independent review

A separate read-only review of the resolution found no blockers. The two should-fix items are fixed above. Left as they are:

- The New Profile sheet always preselects CloakBrowser, ignoring the default engine setting (upstream).
- On Linux, when the sandbox backstop fires, the abandoned readiness poll of the first attempt can connect its closed session to the relaunched browser, leaving an extra CDP client until the profile closes (upstream, rare path).
- `child.on("exit")` is registered after the awaited bootstrap, and there is no `child.on("error")`, so a spawn failure raises an uncaught `error` event (both parents).
- The handoff has no Resume control in the UI, so only `resume_human` ends a wait early (already noted in 0.9.0).

## Not verified

- **Camoufox was not run live.** It would have needed a large browser download. It is covered by typecheck, the unit tests of the shared geo policy, and the packaging check, and upstream has shipped it since its 0.4.0.
- macOS and Linux were only built by CI, not run. The AppArmor flow was not exercised.
- `strictGeoCoherence` rejecting a real launch needs a working proxy in another country. Unit tests only.

## Defects found, not caused by this merge

- **Input can be silently dropped while the page is hidden.** `click_ref` / `type_ref` can return `ok` although no event reaches the page. In a 12-run sample the page reported `document.visibilityState === "hidden"` in 6 runs and 3 of those lost all input; no run with a visible page lost any. The likely cause is the window opening behind others, which was not measured directly. `CdpSession`'s input path and the launch flags that could affect it match 0.9.0, so this does not look like a regression, though 0.9.0 itself was not re-run. **Fixed after the merge:** the input tools now verify delivery and fail with `INPUT_NOT_DELIVERED`. Measurements and the choice between the options are in `docs/input-delivery-hidden-page.md`.
- **`probe_fingerprint` reports false drift on CloakBrowser.** The browser reduces the UA to `Chrome/146.0.0.0` while the stored one has the full version, and `deviceMemory` compares the physical GB (16) against the capped API value (8).

## Local test note

Chromium fails to write its profile (`Failed to create directory`, no session files) when the user-data path is near `MAX_PATH`, which looks like a broken session restore. Use a short path for isolated runs, such as `%TEMP%\mzlive`.
