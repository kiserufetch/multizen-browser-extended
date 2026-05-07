# Patched Chromium — build, update, test, security plan

> Source for the patched Chromium binary that ships fingerprint coherence
> (Sec-CH-UA, navigator.userAgentData, locale/timezone, canvas/audio/WebGL
> noise, JA3/JA4 normalization). Bundled with **all** MultiZen tiers; the
> tier difference is update lag, not Chromium itself.

## 0. North star and constraints

- **One person + small team, $2–4K/yr operating budget.**
  - Brave maintains its fork with ~50 engineers; we cannot copy them. Patch
    surface must stay tiny so rebase cost stays bounded.
- **Chrome cadence:** 4-week milestones today, **2-week starting Sep 2026**
  (CEF #4114). Doubling cadence is the single biggest risk to this plan.
  Mitigation: extended-stable channel for Free, milestone-only for Pro/Team,
  hard cap on patch LoC, automated rebase CI.
- **Coherence > novelty.** We do not invent new fingerprint protections.
  We make every signal we already control match. The only thing the patched
  binary adds beyond what stock Chrome + CDP + preload scripts can already
  do is: (a) Sec-CH-UA / userAgentData full overrides per-context, (b)
  canvas/audio/WebGL deterministic noise, (c) font enumeration cap, (d)
  WebRTC IP leak block, (e) TLS extension order normalization (only if
  measurement shows we drift from Chrome stable).
- **Open-core split.** Patches live in private `multizen-pro/chromium-patches/`.
  Build pipeline scripts live in `multizen-pro/chromium-build/`. The OSS
  app dynamically downloads the prebuilt binary; OSS users without a Pro
  key fall back to system Chrome (already implemented in `chromium/`
  package via `ChromiumStatus`).

## 1. Phasing — **do not ship phase 1 before phase 0 is in production**

### Phase 0 — runtime injection (ships first, no fork yet)

Goal: validate that our coherence model + UI + MCP product is wanted, on
top of stock Chromium, **before** taking on the fork-maintenance tax
(≈ $99/yr Apple Developer + owner's overnight build slot during v0; later
≈ €100/mo Hetzner once we add Linux+Windows). We already generate
coherent fingerprints; we just need to apply them without patches.

What we control today via stock Chromium + CDP + preload:

| Signal                        | How                                           | Coherent? |
| ----------------------------- | --------------------------------------------- | --------- |
| `User-Agent` HTTP header      | `--user-agent=` flag                          | yes       |
| `navigator.userAgent`         | same flag                                     | yes       |
| `Accept-Language` HTTP        | `--accept-lang=` flag (already wired)         | yes       |
| `navigator.language(s)`       | preload monkey-patch                          | yes       |
| `Sec-CH-UA*` request headers  | `Network.setExtraHTTPHeaders` per target      | partial — must be re-applied on every navigation |
| `navigator.userAgentData`     | preload monkey-patch with `Object.defineProperty` | partial — leaks via `Object.getOwnPropertyDescriptor` |
| Timezone (`Intl`, `Date`)     | `Emulation.setTimezoneOverride` (CDP)         | yes       |
| `screen.*`, `devicePixelRatio`| `Emulation.setDeviceMetricsOverride`          | yes       |
| `navigator.platform`          | preload monkey-patch                          | partial   |
| WebGL UNMASKED\_VENDOR/RENDERER | preload monkey-patch on `getParameter`      | partial — `WEBGL_debug_renderer_info` extension presence is itself a signal |
| Canvas/Audio noise            | preload script wraps `getImageData`/`toDataURL`/`AudioContext` | partial — wrappers detectable via `toString()`, `Function.prototype.toString` |
| JA3 / JA4                     | not controllable — stock Chrome's TLS         | accept stock — Chrome 110+ randomizes extension order anyway |
| Font enumeration              | not controllable                              | NO        |
| WebRTC IP leak                | `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` | yes |

**Phase 0 DoD:**
1. CDP driver in `apps/desktop/src/main/ChromiumBrowserDriver.ts` applies
   every signal above on launch + on every navigation in the launched
   browser (cross-tab, cross-iframe).
2. Preload script bundle (`chromium/preload-fingerprint.js`) is injected
   via `Page.addScriptToEvaluateOnNewDocument` for every target (page,
   worker, iframe). Wrappers are stealthy — `Function.prototype.toString`
   on each patched function returns the original `[native code]` form.
3. CreepJS run on a launched profile shows: matching UA family, matching
   platform, matching timezone, matching screen, no `userAgent !== userAgentData`
   discrepancy, no obvious `[Function: getParameter]` tampering.
4. Cloudflare bot test (`/cdn-cgi/trace`, `bot-fight` test page) returns
   "human" verdict on a clean residential proxy.
5. CI (GitHub Actions) runs the full Playwright fingerprint suite on every
   PR; gate green required to merge.

We ship phase 0 to Pro EA buyers. We watch for two signals:
- Detection-vendor regression rate (CreepJS + a private "detection
  honeypot" set of pages we maintain).
- Sales rate. If we cannot sell phase 0 at $49 lifetime EA, we do **not**
  build phase 1 — the market has spoken.

### Phase 1 — minimal patch fork (after $5K MRR or ~100 paying users)

Trigger: phase 0 proven sellable AND a specific detection failure exists
that runtime injection cannot fix (in priority order, only patch what
empirically breaks):

1. `Sec-CH-UA` brand list spoof leaks via `delegate.IsBrandFullList()` —
   patch in `services/network/public/cpp/client_hints.cc` to always read
   from CDP-set override.
2. `navigator.userAgentData.getHighEntropyValues()` returns inconsistent
   data — patch `third_party/blink/renderer/modules/client_hints/`.
3. Canvas farbling — port the well-tested
   [Bromite canvas noise patch](https://github.com/ungoogled-software/ungoogled-chromium/blob/master/patches/extra/bromite/flag-fingerprinting-canvas-image-data-noise.patch)
   into `third_party/blink/renderer/modules/canvas/canvas2d/canvas_rendering_context_2d.cc`.
4. AudioContext noise — port Brave's `audio_buffer_source_node.cc` patch.
5. WebGL `getParameter` proxy — patch `third_party/blink/renderer/modules/webgl/webgl_rendering_context_base.cc`.
6. Font enumeration cap — patch `third_party/blink/renderer/modules/font_access/`.
7. WebRTC mDNS hostname — patch `third_party/webrtc/`.

**Patch budget: ≤ 7 patches, ≤ 500 LoC total, each patch ≤ 80 LoC.**
If a patch grows past 80 LoC it must be re-architected as a runtime hook
behind a Chromium feature flag we toggle via command line, not a code
change. This is what keeps rebase tractable.

### Phase 2 — TLS normalization (only if measured drift)

Only if our build's BoringSSL produces a JA4 different from Chrome stable
of the same major version. Chrome 110+ already randomizes extension order,
so JA3 is already noisy by default; JA4 sorts ciphers, so it stays stable.
We instrument JA4 of every shipped build against Chrome stable and only
patch if a real divergence appears.

## 2. Build pipeline

### 2.1 Hardware

**Phase 1 (mac-only, v0):** owner's MacBook Pro 16" M4 Max. Builds run
overnight. Realistic timing on M4 Max (extrapolated from community-reported
M3 Max 64GB numbers):

| Build kind          | Time   |
| ------------------- | ------ |
| Clean macOS arm64   | ~3–4h  |
| Incremental (1 patch) | 15–30 min |
| `gclient sync` to next milestone | ~30–60 min |
| Full disk footprint (`src/` + `out/`) | ~250GB |

A clean overnight build is comfortable. Constraints to know:

- **No cross-compile from macOS** — Chrome Windows binaries need Windows
  SDK + MSVC; Linux binaries need clang sysroot + glibc. From mac you
  get **mac arm64 only**. (Mac x64 is also possible via `target_cpu="x64"`
  but Apple silicon shipped 5 years ago — not worth the build slot for EA.)
- **Laptop is a single point of failure** — closed lid = paused build.
  Run with `caffeinate -dis autoninja …` and AC plugged. Acceptable for
  v0. We commit to dedicated infra **only after** Phase 0 is selling.
- **Disk pressure** — M4 Max usually ships 1–4TB. 250GB for one platform
  is fine. If we add Linux later in the same checkout, plan for 500GB+.

**Phase 1 v1 (when revenue justifies, ≥ $5K MRR):**

| Box           | Purpose                  | Cost           |
| ------------- | ------------------------ | -------------- |
| MacBook Pro M4 Max (existing) | macOS arm64 native build | $0 (already owned) |
| Hetzner AX52 (Ryzen 7 7700, 64GB, 2x1TB NVMe) | Linux + Windows cross-compile | €99/mo |
| Cloudflare R2 | Binary distribution      | <$5/mo         |

Recurring at v1: **€100/mo + $99/yr (Apple Developer) + (later) $300/yr Windows EV cert**.
For v0 (mac-only): **$99/yr Apple Developer + R2 fees**, nothing else.

### 2.1a What is `depot_tools`?

Google's mandatory toolkit for fetching and building Chromium. It is **not
our code**, it is the canonical Chromium-development bootstrap. Without
`depot_tools` you cannot check out or compile Chromium at all.

Cloned once via:

```bash
git clone https://chromium.googlesource.com/chromium/tools/depot_tools.git ~/depot_tools
export PATH="$HOME/depot_tools:$PATH"
```

Contents we actually use:

| Tool        | Role |
| ----------- | ---- |
| `gclient`   | Meta-checkout. Chromium is ~100 git repos glued by `DEPS` files; `gclient sync` pulls them all in lockstep at the right revisions. |
| `gn`        | Generates Ninja build files from `BUILD.gn`. We invoke `gn gen out/Release --args="…"` once per config. |
| `autoninja` | Wrapper around `ninja` that auto-tunes parallelism (`-j` based on RAM/CPU). What we actually run for compile. |
| `cipd`      | Binary toolchain package manager. `gclient sync` calls it to fetch pinned LLVM, Windows SDK proxy, etc. |
| `vpython3`  | Pinned Python interpreter. Chromium's build scripts require it. |
| `fetch`     | One-shot bootstrap that runs the very first `gclient` for a fresh checkout. |

Pin `depot_tools` to a specific commit in our build container / `Brewfile`
so a Google-side regression doesn't break our reproducible builds. We
record the pinned commit hash in `multizen-pro/chromium-build/.depot_tools_commit`.

### 2.2 Source layout (`multizen-pro` private repo)

```
multizen-pro/
  chromium-build/
    .depot_tools_commit           # pinned depot_tools commit hash
    .gclient                      # solution { name = "src", url = chromium }
    scripts/
      bootstrap.sh                # clone depot_tools + fetch chromium
      sync.sh                     # gclient sync to a milestone branch
      apply-patches.sh            # git am from chromium-patches/
      build-mac.sh                # gn gen + autoninja chrome (M4 Max)
      build-linux.sh              # later, on Hetzner
      build-win.sh                # later, cross-compile from Linux
      package.sh                  # zip + sha256 + manifest
      sign.sh                     # codesign + notarize (mac), signtool (win)
    config/
      args.gn.mac                 # is_official_build=true, is_debug=false,
      args.gn.linux               #   chrome_pgo_phase=0, symbol_level=0,
      args.gn.win                 #   blink_symbol_level=0, dcheck_always_on=false
                                  #   ffmpeg_branding="Chromium"
                                  #   target_cpu="arm64" (mac), "x64" (lin/win)
  chromium-patches/
    series                        # ordered list of patches
    0001-sec-ch-ua-override.patch
    0002-canvas-noise.patch
    ...
  ci/
    .github/workflows/            # GitHub-hosted only for tests; builds run locally
      detection-suite.yml         # post-build: run Playwright vs CreepJS et al.
      rebase-check.yml            # nightly: try `git am` on tip-of-tree, alert on fail
```

### 2.3 Build steps — macOS arm64 on M4 Max

```bash
# one-time bootstrap (~30 min, ~50GB to start, grows to ~200GB after first sync)
git clone https://chromium.googlesource.com/chromium/tools/depot_tools.git ~/depot_tools
export PATH="$HOME/depot_tools:$PATH"
mkdir -p ~/multizen-chromium && cd ~/multizen-chromium
fetch --no-history chromium                  # ~30–60 min, ~150GB

# every milestone (~30–60 min)
cd ~/multizen-chromium/src
git fetch --tags
git checkout refs/branch-heads/$MILESTONE
gclient sync --no-history -D                 # syncs all 100+ DEPS

# apply our patches (seconds; aborts on conflict)
git am ~/multizen-pro/chromium-patches/*.patch

# generate build files (seconds)
gn gen out/Release --args="$(cat ~/multizen-pro/chromium-build/config/args.gn.mac)"

# build (3–4h clean, 15–30 min incremental on M4 Max)
caffeinate -dis autoninja -C out/Release chrome chromedriver

# package + sign (5 min)
~/multizen-pro/chromium-build/scripts/package.sh out/Release
~/multizen-pro/chromium-build/scripts/sign.sh    # codesign + notarize

# upload (varies, ~150–250 MB final zip)
rclone copy out/Release/multizen-chromium-mac-arm64.zip r2:multizen-chromium/stable/$MILESTONE/
```

`caffeinate -dis` keeps the laptop awake (`-d` display, `-i` idle, `-s`
sleep) — required so a closed lid mid-build doesn't pause the job.

The signing key is held on a YubiKey plugged in only at the `sign.sh`
step, never during build. See §6.1.

### 2.4 Distribution to clients

- App startup checks `https://updates.getmultizen.com/chromium/{channel}/latest`.
- Manifest signature verified against an Ed25519 public key **embedded in
  the app binary** (key rotation = app release).
- App downloads zip, verifies SHA-256 from manifest, extracts atomically
  to `~/Library/Application Support/MultiZen/chromium/{milestone}/`.
- Atomic swap of a `current` symlink. On launch failure, symlink reverts.
- Old milestones GC'd after 7 days.

### 2.5 Channels

| Channel         | Tier          | Lag                   | Purpose                  |
| --------------- | ------------- | --------------------- | ------------------------ |
| `stable`        | Pro / Team    | < 24h after upstream  | Customer baseline        |
| `extended`      | Free / Anon   | 8 weeks behind stable | Reduces our rebase load  |
| `beta`          | opt-in        | week ahead of stable  | Catches breakage early   |

`extended` is critical — without it, Free users force us to ship every
2 weeks (post-Sep 2026). With it, we ship Free updates every 8 weeks.

## 3. Update flow

### 3.1 App-side (Electron) updates

`electron-updater` with our self-hosted manifest endpoint at
`updates.getmultizen.com`. macOS via Sparkle-style DMG diffs, Windows via
`AppImageUpdate`-style block-level. **No auto-update without user consent
on the first launch** (we are not Chrome — explicit opt-in, can be
toggled in settings).

### 3.2 Chromium binary updates

Independent of the app. App polls manifest every 6h on launch and again
on profile launch. New milestone available → background download → ready
banner → user clicks "Restart launched profiles to update" → atomic swap.

### 3.3 Rollback

If a launched profile crashes within 5 seconds of launching ≥ 3 times in
a row on a given Chromium milestone, app force-reverts to previous
milestone (kept on disk for 7 days) and reports telemetry (opt-in only).

## 4. Change management for patches

1. **Each patch is a single PR** in `multizen-pro/chromium-patches/`.
2. **Required**: detection-vendor regression test result attached to PR
   (CreepJS, Cloudflare bot test, BotD, BrowserLeaks, FingerprintJS demo).
3. **Required**: rebase test on `tip-of-tree` Chromium — if a patch breaks
   on ToT, we know we're 4 weeks from a bad rebase and start the fix.
4. **Owner review** — every patch reviewed by Jop before merge, no
   exceptions, no auto-merge.
5. **Squashing**: never. Each detection-fix patch is its own commit so
   `git log` traces exactly which detection vendor each patch addresses.

## 5. Testing

### 5.1 Unit (in-Chromium)

- Each patch ships its own browser test under `chrome/test/data/multizen/`.
- Run with `out/Release/browser_tests --gtest_filter=Multizen*`.

### 5.2 Integration — Playwright fingerprint suite

Located in `multizen-pro/chromium-build/test/fingerprint/`. Runs against
a freshly-built binary, reports a structured JSON.

| Test page                                  | Pass criteria |
| ------------------------------------------ | ------------- |
| `creepjs.dev`                              | trust score ≥ 75, no contradiction flags, "lies" array empty |
| `browserleaks.com/javascript`              | no ToString() detection of patched APIs |
| `bot.sannysoft.com`                        | all green   |
| `arh.antoinevastel.com/bots/areyouheadless` | "not headless" |
| `fingerprintjs.com/products/bot-detection/` | "human"     |
| `https://www.cloudflare.com/cdn-cgi/trace` | not flagged |
| `https://datadome.co/products/bot-protection/` (their demo)| not flagged |

### 5.3 Coherence test

Run 50 randomly-generated profiles. For each:
1. Sec-CH-UA platform string == `navigator.platform` family.
2. Sec-CH-UA-Full-Version-List version == `navigator.appVersion` version.
3. `Intl.DateTimeFormat().resolvedOptions().timeZone` ∈ locale.timezones.
4. `screen.width` ∈ device.screens for the chosen device family.
5. `Accept-Language` matches `navigator.languages[0]`.
6. WebGL UNMASKED\_RENDERER family matches device family.
7. `navigator.hardwareConcurrency` and `deviceMemory` ∈ device range.

Already implemented in `packages/profile-manager/scripts/test-fingerprint.ts`
for the **generator**. Phase 0 must add a Playwright variant that runs
these checks against an actually-launched browser, not just the type.

### 5.4 Detection drift monitor

Weekly cron: launch one profile of each device family on a clean
residential proxy, run all suite pages, post diff to a private Slack/Discord
channel. Drift > threshold = manual investigation.

## 6. Security

### 6.1 Supply-chain (the AdsPower lesson)

January 2025: AdsPower attackers replaced the legitimate plugin download,
stole $4.7M from users' wallets. Single point of failure was unsigned
download with no client-side signature verification. **We must not
repeat this**.

| Mitigation | Implementation |
| ---------- | -------------- |
| Offline signing key | Ed25519 private key on YubiKey, never present on any networked machine; only used at sign time |
| Manifest signature  | Ed25519 detached signature over `manifest.json`; embedded pubkey in app binary |
| Binary integrity    | SHA-256 in manifest, verified by app **before** extraction |
| Reproducible builds | Pin `depot_tools` commit in `.gclient`; `SOURCE_DATE_EPOCH=$(git log -1 --format=%ct)`; toolchain pinned by hash |
| Public verification | Build logs published; users can rebuild and compare hashes |
| TLS pinning         | Manifest endpoint TLS pin in app (`Cloudflare Origin CA`) |
| Sigstore (later)    | Cosign signature uploaded to Rekor for public transparency log |

### 6.2 Code signing

- **macOS**: Apple Developer ID + notarization mandatory from day one.
  Without it, gatekeeper blocks the launch and our churn rate explodes.
  $99/yr.
- **Windows**: Start with self-signed (SmartScreen reputation builds over
  ~30 days of installs). Upgrade to EV cert (~$300/yr) once revenue >
  $1K/mo. Without EV cert we will see "unknown publisher" warnings —
  acceptable cost during validation phase.
- **Linux**: GPG-signed `.AppImage` + `.deb` + `.rpm`. Detached signature
  in manifest.

### 6.3 Build environment

- **Hetzner box hardening**: Tailscale-only SSH, public WAN port 80/443
  closed (Caddy proxies through Tailscale), no PR builds for forks
  (only owner branches), unattended-upgrades on, daily backup of
  `chromium-patches/` to encrypted offsite.
- **No secrets in CI env vars**: signing happens **on the developer's
  laptop with the YubiKey**, not on the runner. CI uploads unsigned
  artifact + sha256 to a staging R2 bucket; developer's local
  `release.sh` downloads, signs, uploads to prod.
- **Mac mini lockdown**: FileVault on, idle screen lock, SSH via Tailscale
  only, no auto-update of macOS during a build window.

### 6.4 In-product

- **Sandbox stays on**. Never `--no-sandbox`, including dev builds. Pro
  users running our binary get the same renderer-process sandbox stock
  Chrome ships with.
- **Crash reporting disabled by default** — a renderer crash in a
  patched Canvas function would leak the patch payload to Google's crash
  servers. We point Breakpad's URL to `crash.getmultizen.com` (later) or
  an empty endpoint (now).
- **Field trials / variations server disabled** — `--disable-field-trial-config`,
  `--variations-server-url=` empty.
- **Safe Browsing** disabled by default (privacy + Google contact).
- **Component updater** disabled — Chrome's own auto-component-updater
  would otherwise fetch updates we didn't sign.
- **Default search engine** = DuckDuckGo, configurable to anything via
  `master_preferences.json`.

### 6.5 Profile data isolation

- Profile data dir per-profile, never shared.
- Profile data **never** uploaded by any patch we add.
- Cloud sync (Pro/Team feature) operates only on the Electron-side store,
  encrypted client-side with the user's passphrase before any network IO
  (already in the monetization plan, AES-256-GCM + scrypt).
- Crash dumps redacted before any opt-in upload (strip cookies, URLs,
  form data).

### 6.6 Patch review for security

Each patch in `chromium-patches/` is reviewed for:
1. Does it introduce a memory-safety bug? (the canvas farbling patch
   touches a hot path — must keep bounds checks).
2. Does it add a renderer→browser channel that could exfiltrate data?
   (no patch should add IPC).
3. Does it reduce sandbox confinement? (none should).
4. Does it ship debug strings that fingerprint our build? (no
   `MULTIZEN_PATCHED` literals — patches must be invisible at runtime).

## 7. Risk register

| Risk | Likelihood | Impact | Mitigation |
| ---- | ---------- | ------ | ---------- |
| Sep 2026 2-week cycle doubles rebase cost | Certain | High | Patch budget cap; extended channel for Free; CI auto-rebase |
| Solo maintainer burns out on rebase tax | High | Critical | Phase 0 ships first; phase 1 only after revenue justifies a part-time co-maintainer |
| Detection vendor (Cloudflare, DataDome) flips a model and breaks our build overnight | Likely | High | Detection drift monitor + ability to ship a hotfix without a full rebuild (preload script update can hotpatch) |
| Build infra compromise (laptop) | Low–Med | Critical | YubiKey for signing (build itself unsigned); FileVault on; lock screen; public hashes; reproducible builds; **never sign on a laptop that's been on untrusted Wi-Fi without verifying** |
| Laptop unavailable mid-cycle (travel, repair) | Med | High | Phase 1 v0 accepts this risk; v1 moves builds to Hetzner; in v0, document a 48h SLO ("hotfix within 2 days") not 24h |
| Apple revokes Developer ID after notarization scrutiny | Low | Critical | Have a backup Чили SpA / EU corporate identity ready before scaling |
| Patch breaks on a milestone we cannot rebase in time | Medium | High | Pin to extended-stable; hot-revert path; ship phase 0 fallback (CDP-only mode) as emergency |
| User runs malicious extension that exfiltrates profile | Medium | High | Document in onboarding; consider extension allow-list in Team tier |
| Legal: anti-detect category in some jurisdictions | Low | Medium | EU/US OK; document acceptable-use policy; refuse obviously-fraud customers |

## 7a. Gaps caught on second pass

These were missing from the first draft — incorporate before Phase 0 ships.

### 7a.1 CDP detection vector — **blocker for Phase 0**

`Runtime.enable` (which `chrome-remote-interface` calls implicitly on
every connection) sets a flag observable from JS via the `cdp` global on
some Chromium versions, and triggers reliable detection by DataDome /
PerimeterX / Cloudflare's bot-management. Phase 0 mitigations:

1. Never call `Runtime.enable` on attached browser tabs we hand to the
   user. Inject preload with `Page.addScriptToEvaluateOnNewDocument`
   without enabling Runtime.
2. Always launch with `--disable-blink-features=AutomationControlled` —
   this removes `navigator.webdriver = true`.
3. Do **not** start with `--remote-debugging-port=` listening on
   `0.0.0.0`. CDP is over a UNIX domain socket pipe (`--remote-debugging-pipe`),
   not TCP. Already correct in driver but document it.
4. Audit `chrome-remote-interface` calls — most should be one-shot
   `Page.setLifecycleEventsEnabled` / `Network.setExtraHTTPHeaders`
   without retaining the connection during user browsing.

This is the single most important Phase 0 task. Without it, a single
DataDome-protected site reveals everything.

### 7a.2 License compliance (BSD-3 + LGPL ffmpeg + others)

Distributing a Chromium-derived binary requires bundling the upstream
LICENSE files. macOS / Windows installers must include:

- Chromium `LICENSE` (BSD-3-Clause).
- `LICENSES.chromium.html` (auto-generated by upstream, ~50MB of
  third-party).
- Our own patches under whatever license we choose.
- Special-case **ffmpeg** — Chromium can be built with `ffmpeg_branding =
  "Chrome"` (proprietary codecs) or `"Chromium"` (free codecs only). We
  ship `"Chromium"` to avoid licensing fees from MPEG-LA. **Do not** flip
  to `"Chrome"` without legal review.
- BoringSSL is ISC, OpenH264 from Cisco for WebRTC needs separate
  attribution.

Add `LICENSES/` bundle step to `package.sh`.

### 7a.3 Windows builds from Linux — fragile

Cross-compile from Linux (per ungoogled-chromium-windows #293) works but
breaks every few milestones. Plan B: dedicated Windows builder. Cheapest
option is a self-hosted Hetzner Windows VPS (~€40/mo) or a Hyper-V VM on
the AX52. Decide at Phase 1 start; until then accept the cross-compile
risk.

### 7a.4 Extensions story

Without Google API keys our Chromium cannot connect to the Chrome Web
Store. Options:

1. Ship without extension support (simplest — most antidetect users
   don't need extensions; cookies/session is the workflow).
2. CRX-file sideload via drag-drop, Brave-style. Requires
   `--enable-easy-off-store-extension-install`.
3. Fork chrome-web-store-mirror later (Pro/Team feature).

Pick (1) for Phase 0. Revisit at Phase 1 only if user research demands.

### 7a.5 Crash collection

We disable Google's Breakpad upload (security-critical: a renderer crash
in our patched canvas function would leak the patch payload). But we
still need crashes for our own debugging. Plan:

- Ship with crash-upload **off by default**.
- Settings toggle "Send anonymous crash reports to MultiZen" — explicit
  opt-in, disabled until Phase 1.
- Endpoint = `crash.getmultizen.com` running Sentry's open-source
  collector (or a thin custom endpoint).
- Redact: cookies, URLs (keep host only), form data, headers (keep only
  `Sec-CH-UA*`, `Accept-Language`, `User-Agent`).
- GDPR consent banner before first upload.

### 7a.6 Time-to-Phase-0 ramp

Realistic estimate for a single dev:

| Task | Days |
| ---- | ---- |
| Preload script bundle (UA, languages, platform, screen, hwc, mem, WebGL params, canvas/audio noise — all stealthy) | 5 |
| CDP driver re-applies on every navigation, `--remote-debugging-pipe` not TCP | 2 |
| Stealth review: `Function.prototype.toString` patches | 2 |
| Coherence Playwright suite (50 profiles vs CreepJS, BotD, Cloudflare, DataDome) | 4 |
| App auto-update (electron-updater + manifest + Ed25519) | 3 |
| Code signing flow (mac notarization + Win signing) | 2 |
| End-to-end shakedown on 5 residential proxies x 5 countries | 2 |

**~20 working days = ~4 calendar weeks** before Phase 0 ships to the
first 10 EA buyers. Plan accordingly.

## 8. Open questions to resolve before Phase 1 starts

1. EU corporate entity for code-signing identity — Cyprus? Estonia? Чили SpA?
2. Laptop-as-builder physical safety: travel insurance, theft cover, AppleCare+ — the M4 Max **is** the build infra during v0.
3. Patch licensing: GPL-compat? — Chromium is BSD-3, our patches can be
   any license; we'll choose **proprietary** for `multizen-pro` to keep
   the open-core split clean.
4. Do we ship Linux from day one? Recommendation: **no** — defer to v1.0,
   focus mac+win for the Pro EA cohort.
5. M4 Max disk capacity: ≥ 1TB internal recommended; if smaller, use
   external NVMe over Thunderbolt 4 for `~/multizen-chromium/`.
6. Do we expose a "use my system Chrome" toggle for Pro users who don't
   trust our build? Recommendation: **yes**, gives them an audit lever
   and reduces support load if our binary breaks.

## 9. Definition of Done — Phase 0

- [ ] Preload script bundle covers UA, userAgentData, languages, platform,
      timezone, screen, hardwareConcurrency, deviceMemory, WebGL params,
      canvas noise, audio noise — all stealthy.
- [ ] CDP driver applies metrics + timezone + headers per launched browser
      and re-applies on every navigation.
- [ ] Coherence test (50 profiles) passes 100% on a launched browser.
- [ ] Detection suite: CreepJS trust ≥ 75, Cloudflare bot test green,
      BotD "human", on a clean residential proxy in 5 different countries.
- [ ] Signed update channel for **the Electron app itself** working with
      manifest + Ed25519 + YubiKey flow (Chromium binary swap deferred to
      Phase 1).
- [ ] First 10 paying Pro EA customers retained ≥ 30 days with no
      detection-related refund.

Only after all of the above do we open the `chromium-build/` repo and
start cloning depot_tools.
