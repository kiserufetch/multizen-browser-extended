# Research — Auto-update (app + CloakBrowser runtime)

Status: **complete** — ready for `/specify auto-update`. Slug: `auto-update`.

## Summary (so far)

- **Nothing auto-updates today.** The MultiZen app has no `electron-updater` wiring
  (it's not even a dependency), and the CloakBrowser runtime is pull-on-demand —
  once `current.json` points at a cached version it never refreshes.
- **electron-builder already publishes the update feed.** `latest.yml` /
  `latest-mac.yml` / `latest-linux.yml` are produced and uploaded to GitHub Releases
  on every CI publish. We generate the feed; nothing consumes it.
- **Per-platform app auto-update reality (unsigned/ad-hoc):**
  - **Linux (AppImage): works** — no signing involved, sha512 + blockmap diff.
  - **Windows (NSIS): works** — Authenticode check is *skipped* when the app is
    unsigned; only SmartScreen warns the end user (cosmetic).
  - **macOS: genuinely blocked** — Squirrel.Mac validates the update bundle against
    the running app's designated code requirement; ad-hoc `"-"` has none, so it
    fails with an `error` event and does **not** update. No supported bypass without
    a paid Apple Developer ID ($99/yr).
- **Runtime auto-update is NOT blocked by notarization** — it's just a file download
  we manage ourselves, identical on all 3 platforms. Highest ROI, lowest risk, and
  the install is already atomic (`tmpExtract → rename` + `current.json` pointer + GC).

## Thread 1 — Codebase integration points (complete)

All references in `apps/desktop` unless noted.

| Concern | Location | Note |
|---|---|---|
| App version at runtime | `app.getVersion()` (`src/main/index.ts:306`, `:98`) | electron-builder inlines from `apps/desktop/package.json:4` (all 7 workspaces version-locked) |
| Publish config | `electron-builder.yml:103-110` | `provider: github`, `owner: multizenteam`, `repo: multizen-browser`, `releaseType: release` |
| Mac signing | `electron-builder.yml:76-79` | `hardenedRuntime: false`, `notarize: false`, `identity: "-"` (ad-hoc) |
| Main init / whenReady | `src/main/index.ts:101-315` | autoUpdater init slots in here, a few s after ready |
| IPC handler block | `src/main/index.ts:175-250` (chromium at `:206-207`) | add `app:update-*` / `runtime:update-*` handlers alongside |
| Status → renderer bridge | `src/main/index.ts:130-132` | `mainWindow?.webContents.send("chromium:status", …)` — mirror it |
| Preload bridge shape | `src/preload/index.ts:108-115` | `window.multizen.chromium.{status,retry,onStatus}` — add `update` namespace |
| Status-driven modal | `src/renderer/.../onboarding/ChromiumBootstrapModal.tsx:16-52` | pattern for an update banner/modal |
| Toast component | `src/renderer/src/App.tsx:151-154`, `:429-442` | existing 4s auto-dismiss toast — reuse for "Update ready — Restart" |
| Runtime lifecycle | `src/main/ChromiumBootstrap.ts` `ensure()`/`findCached()`/`gcOldVersions()` | `current.json` = `{version, binaryRelative, sha256, installedAt, channel}`; GC keeps current, deletes version-shaped dirs |
| "latest" resolution | `ChromiumBootstrap.ts` `fetchCloakBrowserManifest()` | walks `CloakHQ/CloakBrowser` releases newest→oldest for the platform asset + SHA256SUMS |
| Binary path resolve | `ChromiumBrowserDriver.ts:99` `resolveBinaryPath()` → `spawn` (`:339`) | **resolved per-launch**; running Chromium does not lock the file → atomic swap safe |
| Settings shape | `packages/settings-store/src/index.ts:17-35` | `AppSettings` + `DEFAULTS` + validation in `load()`; add `autoUpdate*` toggles here |
| Status types | `packages/types/src/index.ts:173-181` | `ChromiumStatus` discriminated union — model `UpdateStatus` the same way |

Key insight: because `resolveBinaryPath()` reads `current.json` on **every** profile
launch and the OS doesn't lock a running binary, a background runtime update can
download to a new `versionDir`, flip `current.json`, and the next launch picks it up
while in-flight browsers keep their old inode. Atomicity + GC already exist.

## Thread 2 — electron-updater feasibility (complete)

| Platform | Works unsigned? | Mechanism | Blocker |
|---|---|---|---|
| Linux (AppImage) | ✅ | `AppImageUpdater`, embedded blockmap diff, sha512 | none — must run as real `.AppImage` (`APPIMAGE` env set) |
| Windows (NSIS) | ✅ | downloads NSIS exe, sha512-verify, relaunch on `quitAndInstall`; Authenticode check **skipped** when no `publisherName` | none for updating; SmartScreen warns end user (cosmetic) |
| macOS (Squirrel.Mac) | ❌ | electron-updater proxies the zip to **native Squirrel.Mac**, which runs `SecStaticCodeCheckValidityWithErrors` against the running app's designated requirement | **hard** — ad-hoc `"-"` → no requirement → `SQRLCodeSignatureErrorDidNotPass`; surfaces as `error` event, user not updated |

macOS specifics (verified against electron-updater `MacUpdater.ts` + Squirrel.Mac
`SQRLCodeSignature.m`):
- No option to disable mac update signature validation (unlike Windows'
  `verifyUpdateCodeSignature`). The install path delegates to the OS framework.
- Self-signed certs don't help: Gatekeeper blocks first launch for end users before
  auto-update is even reached, and you'd be building bespoke reproducible-CI PKI to
  dodge a $99 fee. Nobody ships this.
- Realistic mac options without paying: **check-and-notify only** — `electron-updater`
  can still read `latest-mac.yml` to detect a newer version and show an in-app
  "update available → open GitHub release / download DMG" banner; the user
  drag-installs. Just never call the install path on mac. Catch the `error` event.

Security note (Win/Linux unsigned): the **only** integrity mechanism is the sha512 in
`latest*.yml` over HTTPS to GitHub. A compromised release pipeline = RCE on users.
Mitigation short of code-signing: scoped/short-lived `GH_TOKEN`, 2FA, release
protections. (Doyensec documented even the signed-Windows verifier could be bypassed;
unsigned skips it entirely.)

API surface: `autoUpdater` from `electron-updater`; events `checking-for-update`,
`update-available`, `download-progress`, `update-downloaded`, `error`; methods
`checkForUpdates()`, `autoDownload`, `autoInstallOnAppQuit`, `quitAndInstall()`.
For a **public** repo no runtime token is needed; electron-builder writes
`app-update.yml` into the package — do **not** call `setFeedURL`. Recommended UX:
check ~few s after ready + periodic (1–4h) `setInterval`, `autoDownload` in
background, toast "Update ready — Restart" → `quitAndInstall()`, else installs on quit.

Blockmap/delta: emitted automatically by electron-builder for win/mac/linux; no extra
config.

## Thread 3 — Runtime-swap pattern & anti-detect staleness (complete)

### Part A — safe background swap of the Chromium binary

- **Side-by-side versioned dirs + flip a pointer** is the universal pattern (Chrome's
  updater installs each version in its own `{VERSION}` dir "to prevent concurrent
  access," never mutating the running one). We already have
  `chromium/<engine>/<version>/` — keep it. A running process mmaps/locks its binary,
  so writing a *new* dir and flipping `current.json` can't corrupt it.
  [chromium updater functional_spec]
- **Atomic pointer flip:** `rename()` is atomic only on the **same filesystem**, so
  stage the download under `userData/chromium/` (same volume as `current.json`). Write
  the pointer as `current.json.tmp` → `fsync` → `rename` over `current.json` so a
  reader never sees a half-written pointer. [POSIX rename]
- **When to swap:** stage in background, apply on relaunch (Chrome's "Relaunch to
  apply"; Electron applies "next time the app starts"). For our two-process reality
  (Electron app + spawned browsers), the **hybrid**: keep a **live-instance refcount**
  (we own the spawned PIDs), flip `current.json` the moment it hits **zero**, and also
  opportunistically at app startup. New profile launches pick up the new core via
  `resolveBinaryPath()`; already-running browsers keep their old inode until they exit.
  This *is* the "swap on next browser launch" UX without touching a live process.
- **Throttle:** daily check gated by a stored `lastCheckedAt` (Sparkle's default is
  1 day). electron-updater has **no** daily throttle and double-checks can
  double-download — so we DIY the timestamp gate. The metadata/JSON check is tiny and
  can run freely; only the 560 MB pull needs gating.
- **Metered/consent:** a 560 MB silent auto-pull is antisocial. No portable Electron
  metered API exists (`navigator.connection` unreliable on desktop). Pragmatic: cheap
  daily metadata check is free; when a new core is found, **prompt** ("New browser core
  ~560 MB. Download now?") or honor an "auto-download core updates" setting (default:
  ask / off-on-metered). Native metered detection is optional later polish.
- **Pinning/rollback (keep distinct):** keep **N and N-1**; record `previous` in
  `current.json`. On launch, health-check the new core (spawns? quick CDP handshake?);
  if it fails, **auto-revert** the pointer to `previous` and notify. Rollback is a
  *temporary safety valve*, not a resting state (a stale pin reintroduces Part B risk).
- **Adopt from Playwright:** (1) versioned dirs keyed by build (have it); (2) an
  **`INSTALLATION_COMPLETE` marker** written only after a verified extract, checked
  before reuse — distinguishes "fully installed" from "crashed mid-extract" better than
  "dir exists"; (3) **reference-counted GC** keyed on live instances so we never delete
  a core an open profile is using. (Puppeteer is the anti-pattern: no GC, no hash, no
  resume → cache corruption.) Chrome's **component-updater** idea applies to our
  *fingerprint/UA data assets* — ship those out-of-band on a fast cadence without a
  560 MB core re-download.

### Part B — staleness is itself a detection signal

- Chrome ships a new **major every 4 weeks** (→ **2 weeks from Sept 2026 / Chrome 153**),
  weekly security refreshes. Mid-2026 stable ≈ Chrome 149–150 (use chromiumdash live).
- **UA Reduction froze everything but the major version** — so the major is exactly
  what a stale core *advertises* (UA string + `Sec-CH-UA` + `userAgentData`), and it's
  cross-checkable against high-entropy hints and JS-API presence.
- **TLS tell:** Chrome ≥110 permutes ClientHello extension order per connection; an
  older core emits no permutation + an older cipher/extension profile — a TLS-layer
  mismatch independent of the claimed UA. Anti-bot engines (Cloudflare JA3/JA4) hash the
  ClientHello before any HTTP and score UA-vs-TLS-vs-API inconsistency as automation.
- **A stale core is detectable on multiple independent axes at once** — stale UA major,
  missing newer JS APIs, older HTTP/2 priority, older TLS ClientHello, older
  Canvas/Audio. The *combination* spikes the bot score. So the runtime updater is a
  **feature, not hygiene** — central to the product's value.
- **Competitors:** all track Chrome stable closely. Per-profile version pinning is a
  real, marketed feature in **AdsPower** and **GoLogin** (upgrade-biased — AdsPower
  blocks downgrades); **Multilogin** locks fingerprint↔core with a deliberate **1–2 week
  lag** after Chrome release (ship after the dust settles — a good target for us);
  **Dolphin Anty / Undetectable** use a single shared core, auto-applied on restart.
  Every one surfaces the core version to the user.

Takeaways: track Chrome stable with a ~1–2 wk lag (not day-zero); **make the core
version user-visible** ("CloakBrowser core: Chromium X · Chrome stable: Y · up to
date / update available"); support an **optional per-profile pin** but bias hard toward
current and warn when a pinned profile falls behind.

## Options compared

| Concern | Option A | Option B | Lean |
|---|---|---|---|
| App update transport | `electron-updater` (win/linux now) | hand-rolled checker | **electron-updater** — feed already published, win/linux work unsigned |
| macOS app update | check-and-notify banner → DMG | buy Apple Dev ID → full auto-update | **banner now**, revisit Dev ID (also kills "is damaged") |
| Runtime update check | daily, `lastCheckedAt`-gated | every launch | **daily timestamp gate** (avoid double-download) |
| Runtime 560 MB pull | prompt / setting-gated | silent auto-pull | **consent-gated** (metered-antisocial otherwise) |
| Runtime swap timing | flip when live refcount==0 + at startup | flip immediately | **refcount==0 / startup** (never touch a live browser) |
| "installed" check | `INSTALLATION_COMPLETE` marker | "dir exists" | **marker file** (survives crash-mid-extract) |
| GC | reference-counted, keep N-1 | time-based | **refcount GC + keep N-1** for rollback |
| Version pinning | global core + optional per-profile pin | global only | **global + optional pin**, upgrade-biased |

## Recommendation

Phased, ordered by ROI vs. the notarization blocker:

1. **Runtime auto-update first** — unblocked by notarization, highest detection-risk
   payoff, infra mostly exists. Daily `lastCheckedAt`-gated metadata check → on newer
   CloakBrowser, consent-gated background download into a new `<version>/` dir →
   `INSTALLATION_COMPLETE` marker after verify → flip `current.json` (temp+fsync+rename)
   when the live-browser refcount hits zero or at next startup → keep N-1 + health-check
   auto-revert. Surface core version + state in the UI.
2. **electron-updater for Windows + Linux** — works unsigned today; closes the
   "users stuck on old version" gap (the literal cause of the phamhareal/water8700
   reports). Check shortly after ready + periodic, `autoDownload`, toast
   "Update ready — Restart" → `quitAndInstall()`.
3. **macOS: check-and-notify banner only** — detect newer via `latest-mac.yml`, link
   to the release/DMG; catch the Squirrel `error` event; defer real auto-install until
   a paid Developer ID exists.

Cross-cutting decision to raise in `/specify`: **buying the $99/yr Apple Developer ID**
would unlock mac auto-update *and* eliminate the "is damaged" Gatekeeper friction in one
move — worth weighing as an alternative to the macOS banner.

## Constraints & risks

- **macOS auto-install is genuinely impossible** without a $99/yr Apple Developer ID
  (verified down to Squirrel.Mac source). Same root cause as the "is damaged" friction.
- Unsigned win/linux updates trust **only sha512 + HTTPS to GitHub** — a compromised
  release pipeline = RCE on users. Harden: scoped/short-lived `GH_TOKEN`, 2FA, release
  protections.
- Runtime swap must never touch a live browser — mitigated by per-launch path
  resolution + same-filesystem atomic rename + refcount; needs the refcount plumbed.
- 560 MB re-download on every Chromium bump → consent + daily throttle + (optional)
  metered awareness; ship core updates with a ~1–2 wk lag, not day-zero.
- electron-updater has no daily throttle and can double-download on repeated checks —
  DIY the timestamp gate.
- AppImage auto-update requires running as the real `.AppImage` (`APPIMAGE` env set).

## Open questions for `/specify`

- **Buy the Apple Developer ID** ($99/yr) to unlock mac auto-update + fix "is damaged",
  or ship the macOS check-and-notify banner for now?
- App auto-update **on by default** (competitor norm) with a Settings off-switch?
- Runtime core updates: **prompt** before the 560 MB pull, or a "core auto-download"
  setting (and what default)?
- Runtime swap timing: refcount==0 *and* startup, or startup-only for v1 simplicity?
- Ship **per-profile version pinning** in v1, or just a visible global core version +
  global updater, with pinning deferred?
- Core-tracking cadence: match Multilogin's ~1–2 wk lag behind Chrome stable?
- App-updater re-check cadence: launch-only vs. periodic (e.g. every 4h)?
