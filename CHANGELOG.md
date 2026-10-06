# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.9.0] - 2026-10-07

Agent-automation improvements (the "Stage B" set from the October 2026 research
review). New MCP tools and driver robustness; the anti-detect surface is
unchanged from 0.8.2. The browser-level target model is landed only in part
(see below) and still needs live validation for the routing layer.

### Added

- **Ref-addressed page model.** `extract` now tags each interactive/meaningful
  accessibility node with a short stable `ref` (e1, e2, …). Two new tools act on
  those refs without a CSS selector: **`click_ref`** and **`type_ref`** (resolve
  via DOM.resolveNode + getBoundingClientRect, scroll into view, humanized
  input). Refs are invalidated when the page changes.
- **Human-handoff protocol for CAPTCHA / 2FA.** New tools **`request_human`**,
  **`wait_for_human`** and **`resume_human`**: the agent hands control to a
  person (it never solves the challenge), the window comes forward, and
  `wait_for_human` blocks until the operator resumes or a timeout elapses.
  Pending handoffs are exposed to the desktop UI over IPC
  (`window.api.handoff`).
- `screenshot` returns a proper MCP image content block instead of base64 in
  JSON text; the MCP server reports the real app version in `initialize`.

### Changed

- **Correct synthetic input.** `type` emits full key descriptors
  (`key`/`code`/`keyCode`, Shift for uppercase/symbols) with a non-zero hold;
  `click` sets the pointer button mask and pressure with a press hold — the old
  events had empty `KeyboardEvent.key`/`.code` and zero `PointerEvent.pressure`.

### Fixed

- Every `cdpSend` command is bounded by a timeout (default 30s) so a wedged
  renderer / stalled transport can't hang an MCP call forever.
- JavaScript dialogs (`alert` / `confirm` / `beforeunload`) are auto-handled so
  they no longer hang the driver.
- Safe `cdp_send` refuses `Page.disable`, `Runtime.addBinding` and
  `*.exposeDevToolsProtocol`.
- The driver now fails loud with a clear message when its tab closes / the
  browser exits, instead of hanging on a dead socket (partial defect #18).

### CI

- CI and the release gate now run the cdp-driver / mcp-server / desktop unit
  suites (94 tests), not just typecheck + fingerprint/timezone scripts.
- The fingerprint-seed smoke step asserts its success marker, tolerating a
  better-sqlite3 teardown abort (exit 134) on Node 24.

### Partially landed / follow-ups

- **STE-8 browser-wide target model.** A pure, unit-tested `TargetRegistry`
  (active tab + re-selection) and fail-loud-on-disconnect shipped; the layer
  that connects at the browser level and routes actions to the active target —
  lifting the "root tab only" limit on `click_ref`/`type_ref`/handoff and
  covering new tabs/popups — is deferred because it changes the connection
  topology and needs live-browser validation.
- Not yet shipped: the desktop "Resume" button for handoffs (backend/IPC are in
  place) and an explicit `handle_dialog` tool.

## [0.8.2] - 2026-10-06

Anti-detect and automation hardening from the October 2026 research review
(`docs/antidetect-automation-research-2026-10.md`). All verified against the
code and unit tests; items needing live cross-OS / engine validation are called
out below.

### Fixed

- **WebRTC IP leak on proxied profiles.** Dropped `--fingerprint-webrtc-ip`
  (the shipped CloakBrowser binary leaves the `auto` sentinel as a literal in
  ICE candidates and bypasses the UDP policy) and the inert
  `--force-webrtc-ip-handling-policy` / `--enforce-webrtc-ip-permission-check`
  switches. WebRTC leak protection is now the Chrome-level
  `--webrtc-ip-handling-policy=disable_non_proxied_udp` for both engines, and
  the per-profile constant fake-LAN CFT spoof was removed.
  *Live STUN validation on macOS / Linux / CFT + a direct-profile check is a
  prerequisite before releasing this.*
- **Engine bootstrap no longer breaks as `-pro` releases accumulate.** The
  CloakBrowser release scan is paginated and falls back to a pinned direct
  download URL when the GitHub API is unavailable.
- **MCP security guardrails lost in the upstream v0.3.0 merge restored.** Proxy
  passwords are redacted from `list_profiles` / `create_profile` /
  `update_profile` responses (the 0.7.1 note claiming this was premature — it
  only takes effect now); `navigate` / `new_tab` reject non-http(s) URL schemes;
  the HTTP transport rejects cross-origin requests (403); the activity log no
  longer records typed text; `.mzar` import sanitizes the extension list against
  path traversal. `cdp_send_no_safety` stays intentionally unrestricted.
- **Launch flags.** `--disable-features` is emitted once (it was passed twice,
  so proxied profiles silently re-enabled Translate/MediaRouter — two
  populations). MediaRouter is no longer disabled; `--no-pings` removed.
- **First-run start page** defaults to `about:blank` instead of a fixed search
  engine (a fleet-wide first-navigation marker).
- **Input events.** `type` now emits correct `key` / `code` / `keyCode` / Shift
  with a non-zero key hold; `click` sets the button mask and pointer pressure
  with a press hold — previously `KeyboardEvent.key`/`.code` were empty and
  `PointerEvent.pressure` was 0.
- **Stealth hygiene.** The per-attach diagnostic probe runs only under
  `MULTIZEN_DEBUG`; `probe_fingerprint` uses a neutral canvas string and frees
  its WebGL context.
- **JS dialogs** (`alert` / `confirm` / `beforeunload`) are auto-handled so they
  no longer hang the MCP call.
- Safe `cdp_send` refuses `Page.disable`, `Runtime.addBinding` and
  `*.exposeDevToolsProtocol`.

### Changed

- `screenshot` returns an MCP image content block instead of base64 inside JSON
  text; the MCP server reports the real app version in `initialize`.

### Docs

- README no longer claims fonts are spoofed or that there is no telemetry, and
  describes WebRTC as leak-prevented rather than C++-spoofed.

## [0.8.1] - 2026-10-06

Synced with upstream `multizenteam/multizen-browser` `master` through
`b0bc604` (post-`v0.3.1`). Fork MCP/CDP surface and strict-pin timezone policy
unchanged.

### Added

- **Proxy latency in the tester** — a successful proxy test shows the round-trip
  time through the proxy, colored green / amber / red.
- **More proxy paste formats** — `user:pass:host:port` (reversed order),
  `host:port##user:pass`, and `host,port,user,pass` fill the proxy fields.

### Changed

- MCP `initialize` guidance tells agents to finish authorized tasks on their
  own instead of handing work back to a human; they still stop on CAPTCHA / 2FA
  and let you handle it.

### Fixed

- Proxy test errors are now plain-language (wrong credentials, wrong HTTP vs
  SOCKS5 type, refused, dropped, DNS failure, unreachable, timeout) instead of
  raw TLS / socket messages.

## [0.8.0] - 2026-08-21

Stable release of the upstream `v0.3.1` merge (promotes `0.8.0-canary.1`).

### Added

- **Browser engine updates in Settings** — check/stage a newer CloakBrowser /
  Chrome-for-Testing build; it applies on the next profile launch. Optional
  `engineAutoUpdate` keeps the engine fresh in the background.
- **Proxy geo provider fallback** — if ipapi is down, the probe tries other
  providers, with one overall deadline so launch cannot stall.

### Fixed

- Linux headful Chromium inherits the desktop session (`DISPLAY` / Wayland /
  DBus) so the window can attach.
- macOS release builds one arch per runner so the native module matches the
  package (Intel Macs no longer get an arm64 `.node`).
- Session restore no longer writes the protected `restore_on_startup` pref
  (that reset the default search engine).
- SOCKS5 bridge failure logs are throttled; renderer IPC sends are skipped
  after the window is destroyed.
- Engine GC keeps the in-use version; auto-check only re-runs on an off→on
  `engineAutoUpdate` flip. Debug post-bootstrap probe is gated by
  `MULTIZEN_DEBUG`.

## [0.8.0-canary.1] - 2026-08-21

Prerelease of 0.8.0. Superseded by the stable `0.8.0` release.

## [0.7.1] - 2026-07-24

Synced with upstream `multizenteam/multizen-browser` v0.3.0 while keeping this
fork's MCP/CDP surface (always-on `cdp_send` / `cdp_send_no_safety` /
`probe_fingerprint`) and strict-pin launch timezone policy.

### Added

- **MCP HTTP bearer auth** — local MCP server requires a token; Settings shows
  the token and connection docs use it so Cursor / Claude / Codex can authenticate.
- **Real extension manifest icons** for non-catalog extensions in the profile UI.
- **Shared extensions bundled into `.mzar` exports** so import restores
  attached extensions without a separate download step.

### Changed

- Profile **List view** brought to visual parity with grid cards; menu clicks no
  longer open Edit Profile by accident.
- Launch uses a **profile-local Safe Storage key** instead of the OS keychain.
- Top bar brand label is non-selectable (`pointer-events: none`).
- MCP activity log / `list_profiles` redact proxy credentials (and related
  sensitive fields) more thoroughly.
- HTTP MCP transport gains Host allowlist / DNS-rebinding guards alongside the
  fork's multi-session transport.

### Fixed

- `navigator.deviceMemory` clamped to the API maximum of 8.
- Profile timezone applied correctly when no proxy is set.
- Intel Mac builds ship the correct-arch native module; clearer startup errors
  when the engine fails to load.

### CI

- Release workflow pre-creates the GitHub Release to avoid the 3-way create
  race across the OS matrix (combined with this fork's validate/typecheck gate).

## [0.7.0] - 2026-07-17

### Added

- **Strict-pin launch timezone policy** (`resolveLaunchTimezone`): pinned
  `fingerprint.timezone` wins by default; proxy geo still feeds WebRTC IP +
  geolocation. Opt-in profile flags `alignTimezoneToProxy` /
  `strictGeoCoherence` (MCP create/update + SQLite).
- **`check-chrome-version`** script + bump notes in
  [`docs/fingerprint-entropy-verification.md`](docs/fingerprint-entropy-verification.md)
  to keep `CHROME_VERSION_*` aligned with CloakBrowser/CFT (skips cleanly when
  no binary is present). Generate-time constants set to **146.0.7680.177** to
  match the current CloakBrowser cache major (launch still reconciles UA/CH).
- Expanded **Mac (M2/M3/M4 Pro/Air/mini/iMac)** and **Linux laptop + desktop**
  device catalogs; entropy thresholds Mac/Linux ≥15 coarse / ≥8 WebGL;
  `generateFingerprint(seed, { hostFilter: false })` for CloakBrowser-style
  full-catalog tests.
- MCP **`probe_fingerprint`**: live UA/platform/languages/hwc/memory/screen/
  WebGL/timezone (+ canvas hash) vs stored fingerprint → `{ ok, live, expected, drift }`.
- **`smoke-fingerprint-seed`** script (offline always; live canvas path when
  MultiZen MCP is reachable).

### Changed

- CI runs fingerprint unit/entropy/version-check scripts, desktop timezone
  tests, and offline smoke after typecheck.
- Archived 0.6.0 brief [`docs/multizen-fork-fingerprint-tasks.md`](docs/multizen-fork-fingerprint-tasks.md);
  verification notes point at the post-0.6 backlog.

### Out of scope (not in 0.7.0)

- F UA/CH build jitter
- G fonts / speech / mediaDevices / extra client hints

## [0.6.0] - 2026-07-17

### Added

- **Higher fingerprint entropy and OS/device coherence** so profiles drawn from
  the pool look more like real hardware combinations and are harder to correlate
  across accounts.
- Optional **fingerprint seed** for canvas/audio (and related) noise - rotate
  spoofed noise without changing the profile id or recreating the profile.
- Fingerprint entropy verification helpers under `profile-manager` for
  checking pool uniqueness and coherence.

### Changed

- Mac device families are recognized more broadly (`mac*` / `imac`) for
  platform icons and CloakBrowser native platform args.
- MCP profile create/update surfaces accept the expanded fingerprint fields
  (including seed) so automation stays in sync with the desktop app.

## [0.5.0] - 2026-07-07

Synced with upstream `multizenteam/multizen-browser` v0.2.12, bringing its
feature set into the extended fork while keeping the fork's MCP/CDP tooling.

### Added

- **Per-profile start page.** Each profile can set its own start URL, opened on
  first launch (sanitized, with a safe default) instead of a fixed page.
- **In-app extensions catalog.** Browse a curated set of MV3 extensions — shown
  with their real Chrome Web Store icons — and add or attach them while creating
  a profile.
- **Emoji profile avatars.** Choose an emoji (with automatic color tinting) as a
  profile avatar through the new emoji picker.
- **In-app MCP panel** with a Copy-for-LLM connect card, so pointing
  Cursor / Claude / Codex at the local server is a one-click copy.
- **Opt-in anonymous telemetry** — a default-off onboarding consent step plus a
  self-hostable ingest service. Nothing is ever sent from dev/unpackaged builds.

### Changed

- **Redesigned profile create/edit flow and cards** — Discord-style sidebar
  navigation in the New and Edit profile sheets (with edit autosave), roomier
  modals, refreshed profile tiles, and a clear terminating state while a profile
  winds down.
- Per-profile proxy health is now surfaced in the UI.

### Fixed

- Profile import now restores faithfully (id, data directory, and every field)
  and rejects unsafe archive ids and path-traversal attempts.

## [0.4.1] - 2026-07-01

### Added

- Four new fingerprint locales — Pakistan (`en-PK`), Bangladesh (`bn-BD`),
  Cambodia (`km-KH`) and Bolivia (`es-BO`) — each with its matching languages
  and timezone, widening the pool of regions a profile can convincingly
  emulate.

## [0.4.0] - 2026-06-29

### Added

- **Direct CDP (Chrome DevTools Protocol) access over MCP.** New `cdp_send`
  tool runs any CDP command safely — it auto-disables only the domains it had
  to enable, never disturbs the page session, and refuses automation-revealing
  enables on anti-detect (CloakBrowser) engines — plus `cdp_send_no_safety`
  for an unrestricted raw passthrough when you knowingly need it.
- **CDP convenience tools** built on top of `cdp_send`: `evaluate_js`,
  `wait_for_selector`, `get_cookies` / `set_cookies`, tab control
  (`list_tabs`, `new_tab`, `activate_tab`, `close_tab`), and
  `wait_for_navigation` / `wait_for_load`.

### Changed

- `launch_profile` now waits until the browser is actually drivable (CDP
  endpoint → page target → attach) before returning, so an immediate
  `navigate` / `extract` right after launch no longer fails with
  "not connected" or "no execution context". Cloaking is armed before the
  wait so restored tabs are never exposed.

### Fixed

- Closing a profile now reliably terminates the **entire** Chromium process
  tree (renderers, GPU, utility children) instead of just the root process, so
  orphaned processes can no longer linger and lock a profile's data directory
  on the next launch. The force tree-kill is a fallback after the graceful
  shutdown, so session-restore is preserved (Windows `taskkill /T`, Unix
  process-group kill).

## [0.3.1] - 2026-06-29

### Fixed

- Launching a profile on Windows no longer flashes an extra Chromium window:
  version detection now reads the cached bootstrap version or the EXE file
  metadata instead of spawning `chrome.exe --version` (which opens a normal
  browser window on Windows).
- Profile row and tile action-menu clicks no longer bubble to the row and
  open the edit modal on top of the chosen action (e.g. the delete-confirm
  dialog).
- The in-app updater now links to releases on this repository instead of the
  upstream `multizenteam` repo.

### Changed

- Settings About now displays "MultiZen Extended".

## [0.3.0] - 2026-06-29

### Added

- MCP HTTP server now supports the modern Streamable HTTP transport (`POST/GET/DELETE /mcp`) in addition to the legacy HTTP+SSE endpoints, so up-to-date Cursor/Claude clients connect over the current protocol.
- `/healthz` now reports active MCP session counts per transport for easier diagnostics.

### Fixed

- MCP no longer becomes unresponsive after a client reconnects: each connection now gets its own session and dedicated server binding, so a dropped or zombie SSE connection can no longer wedge the active session (previously this required killing the app via Task Manager).
- Closing MultiZen with the window close button now reliably quits the app even while an MCP client is connected — the shutdown path no longer hangs on an open keep-alive SSE socket. Added forced socket teardown in the HTTP transport and a quit watchdog in the main process.
- Closing a profile no longer risks a shutdown deadlock between the SOCKS5 proxy bridge and a still-running Chromium: Chromium is shut down before the bridge, and bridge sockets are force-closed.

### Changed

- Multiple MCP clients can now connect concurrently without breaking each other's sessions.

## [0.2.11] - 2026-06-29

### Added

- **Full profile CRUD over MCP.** New `update_profile` and `delete_profile`
  tools, plus a `list_fingerprint_options` discovery tool that enumerates the
  valid device families (with real screen sizes) and locale groups (locale,
  country, plausible timezones).
- `create_profile` now accepts an optional `proxy` and high-level `fingerprint`
  configuration at creation time, so a profile can be fully provisioned in a
  single call.
- High-level fingerprint knobs for `create_profile` / `update_profile`
  (`device`, `localeId`, `timezone`, `screen`, `hardwareConcurrency`,
  `deviceMemory`). Raw fingerprint surfaces (User-Agent, Client Hints, WebGL)
  cannot be set individually — the server derives a coherent configuration via
  `reconcileFingerprint` so detection vendors can't flag a mismatch.

### Changed

- `delete_profile` closes a running browser before removing the profile's data
  directory, so a live Chromium handle can't block deletion on Windows.
- `update_profile` reports `appliesOnNextLaunch` when the target profile is
  running, since proxy/fingerprint changes only take effect on relaunch.

### Security

- Proxy `username` / `password` are now redacted from the activity log so
  credentials never reach the audit stream.

### CI

- Added a `CI` workflow (typecheck on every pull request and push to `master`).
- The release workflow now runs a typecheck gate before building.
- Retargeted the electron-builder publish provider to this repository.

## [0.2.10] - 2026-06-28

### Added

- Shared, deduplicated extension store with genuine store-ID injection — one
  copy per extension version is shared across profiles.

### Fixed

- "Add to MultiZen" companion button now places correctly on the current
  Chrome Web Store layout.
- CI: disabled `setup-node` package-manager cache, which conflicted with the
  Yarn 4 / Corepack activation order.

## [0.2.9] - 2026-06-18

### Added

- **Per-profile browser extensions (Phase 1).** CRX / ZIP / folder unpack
  pipeline (MV3-only, atomic), download `.crx` by ID from the Web Store, a
  bundled "Add to MultiZen" companion extension, an Extensions section in the
  profile sheets, and a CDP binding that routes the companion button back to
  the host with auto-relaunch.
- Auto-fill proxy fields from a pasted one-line proxy string.

### Fixed

- Proxy parser disambiguates `host:port@user:pass` when the password is
  numeric.

## [0.2.8] - 2026-06-17

### Added

- **App self-update (Phase 1).** `electron-updater`-based updater with a
  platform-gated service, an Updates section in Settings (current version,
  manual check, auto-update toggle), and a dismissible update banner.
  Auto-install on Windows/Linux; notify-only on macOS (no Apple Developer ID).
- `autoUpdate` setting (default on) and an `UpdateStatus` discriminated union.

### Changed

- Release workflow and CI moved to Node 24 with `actions/*@v5`.

## [0.2.2] - 2026-05-14

### Added

- Modern README with screenshots, badges, and install paths.

### Fixed

- macOS builds are now ad-hoc signed to avoid the "is damaged" Gatekeeper
  dialog.
- Resumable, self-verifying patched-Chromium download with retries and
  truncation detection, fetched via the Electron `net` stack.
- Cross-platform packaging: bundle native dependencies, `asarUnpack` for
  `better-sqlite3`, and strip `@multizen/*` workspace symlinks between
  electron-vite and electron-builder.

## [0.2.0] - 2026-05-13

### Added

- **v2 pivot: AI-native MCP browser.** Full repository rewrite around a
  Model Context Protocol server that drives anti-detect Chromium profiles.
- MCP server with the core browser-drive tool surface (`list_profiles`,
  `create_profile`, `launch_profile`, `close_profile`, `navigate`, `click`,
  `type`, `extract`, `screenshot`), stdio + HTTP/SSE transports, and a mock
  driver for protocol testing.
- Real CDP driver (`chrome-remote-interface`), profile manager with SQLite
  storage and a coherent fingerprint pool, encrypted profile export/import,
  per-profile SOCKS5 bridge with persona alignment, and the activity log.
- GitHub Actions release workflow with stable, version-less download URLs.

[0.8.1]: https://github.com/kiserufetch/multizen-browser-extended/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/kiserufetch/multizen-browser-extended/compare/v0.8.0-canary.1...v0.8.0
[0.8.0-canary.1]: https://github.com/kiserufetch/multizen-browser-extended/compare/v0.7.1...v0.8.0-canary.1
[0.7.1]: https://github.com/kiserufetch/multizen-browser-extended/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/kiserufetch/multizen-browser-extended/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/kiserufetch/multizen-browser-extended/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/kiserufetch/multizen-browser-extended/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/kiserufetch/multizen-browser-extended/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/kiserufetch/multizen-browser-extended/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/kiserufetch/multizen-browser-extended/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/kiserufetch/multizen-browser-extended/compare/v0.2.11...v0.3.0
[0.2.11]: https://github.com/kiserufetch/multizen-browser-extended/compare/v0.2.10...v0.2.11
[0.2.10]: https://github.com/kiserufetch/multizen-browser-extended/compare/v0.2.9...v0.2.10
[0.2.9]: https://github.com/kiserufetch/multizen-browser-extended/compare/v0.2.8...v0.2.9
[0.2.8]: https://github.com/kiserufetch/multizen-browser-extended/compare/v0.2.2...v0.2.8
[0.2.2]: https://github.com/kiserufetch/multizen-browser-extended/compare/v0.2.0...v0.2.2
[0.2.0]: https://github.com/kiserufetch/multizen-browser-extended/releases/tag/v0.2.0
