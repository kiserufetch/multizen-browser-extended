# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.3.0]: https://github.com/kiserufetch/multizen-browser-extended/compare/v0.2.11...v0.3.0
[0.2.11]: https://github.com/kiserufetch/multizen-browser-extended/compare/v0.2.10...v0.2.11
[0.2.10]: https://github.com/kiserufetch/multizen-browser-extended/compare/v0.2.9...v0.2.10
[0.2.9]: https://github.com/kiserufetch/multizen-browser-extended/compare/v0.2.8...v0.2.9
[0.2.8]: https://github.com/kiserufetch/multizen-browser-extended/compare/v0.2.2...v0.2.8
[0.2.2]: https://github.com/kiserufetch/multizen-browser-extended/compare/v0.2.0...v0.2.2
[0.2.0]: https://github.com/kiserufetch/multizen-browser-extended/releases/tag/v0.2.0
