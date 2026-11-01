# Fingerprint defects from the 0.11.0 baselines (2026-11-01)

**Status:** fixed, apart from the engine limits listed at the end
**Reported in:** `docs/detection-baselines/README.md` ("Что видно во всех режимах"), `docs/server-mode.md`
**Affects:** Linux personas on CloakBrowser (WebGL), every Camoufox profile (all surfaces), CloakBrowser direct profiles (WebRTC), MCP `probe_fingerprint` (timezone)

## Summary

| # | Defect | Cause | Fix | Before → after |
| --- | --- | --- | --- | --- |
| 1 | `linux-*-nvidia`: WebGL `ANGLE (…/PCIe/SSE2/PCIe/SSE2…)`, `probe_fingerprint` drift `webgl` | Linux pairs were stored as bare GL strings. CloakBrowser wraps a bare `NVIDIA …` renderer itself and appends its own `/PCIe/SSE2`; anything else it shows raw | Linux pairs stored as Chrome reports them; saved profiles migrated to the same GPU | CreepJS GPU moderate/C, gibberish `PCIe, PCIe` → high/A; Mesa personas: vendor `Mesa` → `Google Inc. (Intel)` / `(AMD)` |
| 2 | Camoufox: avail/outer/inner ignore the persona; threads, GPU and noise new at every launch | camoufox-js draws a fresh BrowserForge fingerprint, WebGL sample and seeds per launch and only fills keys we leave unset; we set screen size and timezone only. Playwright's default 1280×720 viewport | Every identifying key set from the persona or the profile's seed; `viewport: null` | 138 → 12 differences between two launches of one profile (the 12 are the engine's canvas noise and per-tab history length); inner 1280×720 → the persona's window |
| 3 | CloakBrowser WebRTC: zero candidates | The engine's own default gathers nothing, with or without our flag, on direct profiles too | Direct profiles: `--webrtc-ip-handling-policy=default_public_interface_only` | Direct: 0 → 1 srflx candidate, the same address HTTP shows. Proxied / bridged: still 0, no STUN request |
| 4 | `America/Argentina/Buenos_Aires` reports timezone drift | Chromium's ICU reports legacy aliases | Zones compared as zones | All four catalog aliases: drift → none |

## How it was measured

On a Linux x86-64 cloud container with no GPU, Xvfb, and this repository's `scripts/detection-baseline` run as an unprivileged user (CloakBrowser's sandbox refuses root, and the server never passes `--no-sandbox`). Engines: CloakBrowser 146.0.7680.177.5 and Camoufox 152.0.4-beta.30, the pinned builds. The "before" runs are from an unmodified `v0.11.0` worktree (`5f4d19c`), the "after" runs from this branch, with the same seed (`mz-baseline-70`) and `--device`. The runs and comparisons are stored under `docs/detection-baselines/2026-11-01-{before,after}-*` and `compare-2026-11-01-*`.

Not re-run here: the Windows host and the Docker image of the 0.11.0 matrix, and macOS.

Besides the baseline runs:

- direct launches of each engine binary with only the flag under test, to find which flag or default causes what (sections below);
- a scratch harness, not committed, that launches many personas through the server runtime, calls the real MCP `probe_fingerprint` on each, and launches each profile twice: [results](#many-personas).

## 1. Linux WebGL strings

### Reproduced

`--device linux-desktop-nvidia` (`before-linux-xvfb-nvidia-cb`):

```
unmaskedVendor   NVIDIA Corporation
unmaskedRenderer ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 4070/PCIe/SSE2/PCIe/SSE2, OpenGL 4.5.0 NVIDIA 565.77)
CreepJS gpu      confidence moderate, grade C, gibbers "PCIe, PCIe"
```

### Cause

The persona's pair goes to CloakBrowser as `--fingerprint-gpu-vendor` / `--fingerprint-gpu-renderer`. Measured on the binary, one flag pair at a time:

| Flags passed | Page reads |
| --- | --- |
| `NVIDIA Corporation` / `NVIDIA GeForce RTX 4070/PCIe/SSE2` | `NVIDIA Corporation` / `ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 4070/PCIe/SSE2/PCIe/SSE2, OpenGL 4.5.0 NVIDIA 565.77)` |
| `NVIDIA Corporation` / `NVIDIA GeForce RTX 4070` | `NVIDIA Corporation` / `ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 4070/PCIe/SSE2, OpenGL 4.5.0 NVIDIA 565.77)` |
| `Mesa` / `Mesa Intel(R) Iris(R) Xe Graphics (TGL GT2)` | the same strings, raw |
| `Google Inc. (NVIDIA Corporation)` / `ANGLE (NVIDIA Corporation, …/PCIe/SSE2, OpenGL 4.5.0 NVIDIA 550.120)` | the same strings, unchanged |
| `Google Inc. (Intel)` / `ANGLE (Intel, Mesa Intel(R) …, OpenGL 4.6 (Core Profile) Mesa …)` | the same strings, unchanged |
| none (seed only, 60 seeds) | always `Google Inc. (NVIDIA Corporation)` / `ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX …/PCIe/SSE2, OpenGL 4.5.0 NVIDIA 565.77)` |

The binary holds the template `ANGLE (%s, NVIDIA %s%s)` and the suffix `/PCIe/SSE2, OpenGL 4.5.0 NVIDIA 565.77`. A renderer already in ANGLE form is passed through, a bare NVIDIA one is wrapped, anything else is shown raw. The catalog's Linux pairs were bare GL strings, so all 12 personas of a Linux run failed the Chrome shape (vendor `Google Inc. (…)`, renderer `ANGLE (…)`), and the NVIDIA ones also doubled the suffix. Windows and macOS pairs were already in ANGLE form.

### Fix

`packages/profile-manager/src/fingerprint.ts`: Linux pairs are built by `linuxNvidia(model)` and `linuxMesa(glVendor, glRenderer)`:

- NVIDIA: `Google Inc. (NVIDIA Corporation)` / `ANGLE (NVIDIA Corporation, <model>/PCIe/SSE2, OpenGL 4.5.0 NVIDIA 565.77)`. The driver string is the engine's own (every seed-generated Linux GPU reads it) and what pages already saw for these personas.
- Mesa: `Google Inc. (Intel|AMD)` / `ANGLE (Intel|AMD, <Mesa renderer>, OpenGL 4.6 (Core Profile) Mesa 24.0.9)`.
- Dropped: the nouveau entries (`Mesa` / `NV178`, `NV137`; NV178 is not a real chip, CreepJS grades it F) and `Mesa` with a proprietary NVIDIA renderer. The two non-Mesa Intel strings (`… (0x0000A7A0)`, `… (0x000056A0)`) became the Mesa strings for the same chips.

### Saved profiles

`migrateFingerprint` maps an old Linux pair to the same GPU in the new form. `ProfileManager` applies it on every read (so imported `.mzar` profiles are covered at once) and writes the result back once when the database opens, leaving `updated_at` alone. A legacy pair reaching `reconcileFingerprint` lands on the same GPU too.

| Stored | Becomes | What pages see change |
| --- | --- | --- |
| `NVIDIA Corporation` / `NVIDIA GeForce RTX 4070/PCIe/SSE2` | `Google Inc. (NVIDIA Corporation)` / `ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 4070/PCIe/SSE2, OpenGL 4.5.0 NVIDIA 565.77)` | vendor gains `Google Inc. (…)`, one `/PCIe/SSE2` less |
| `Mesa` / `NVIDIA GeForce RTX 4070/PCIe/SSE2` | same as above | vendor `Mesa` → `Google Inc. (NVIDIA Corporation)`, one suffix less |
| `Mesa` / `Mesa Intel(R) …`, `Mesa` or `AMD` / `AMD … (radeonsi, …)` | `Google Inc. (Intel)` or `(AMD)` / `ANGLE (<Intel or AMD>, <same renderer>, OpenGL 4.6 (Core Profile) Mesa 24.0.9)` | both strings gain the ANGLE wrapping |
| `Mesa` / `NV178`, `NV137` | the family's first GPU (RTX 4060 Laptop, RTX 4070) | the GPU: there is no same GPU to keep |

Not touched: Windows and macOS personas, and everything but `webgl` in the fingerprint.

### Measured

| Run | Unmasked vendor / renderer | CreepJS GPU |
| --- | --- | --- |
| before, `linux-desktop-nvidia` | `NVIDIA Corporation` / `…RTX 4070/PCIe/SSE2/PCIe/SSE2…` | moderate, C, gibbers `PCIe, PCIe` |
| after, `linux-desktop-nvidia` | `Google Inc. (NVIDIA Corporation)` / `…RTX 4070/PCIe/SSE2, OpenGL 4.5.0 NVIDIA 565.77)` | high, A |
| before, `linux-laptop-intel` | `Mesa` / `Mesa Intel(R) Iris(R) Xe Graphics (TGL GT2)` | high, A |
| after, `linux-laptop-intel` | `Google Inc. (Intel)` / `ANGLE (Intel, Mesa Intel(R) Iris(R) Xe Graphics (TGL GT2), OpenGL 4.6 (Core Profile) Mesa 24.0.9)` | high, A |
| before, `linux-desktop-amd` | `Mesa` / `AMD Radeon RX 7800 XT (radeonsi, …)` | high, A |
| after, `linux-desktop-amd` | `Google Inc. (AMD)` / `ANGLE (AMD, AMD Radeon RX 7800 XT (radeonsi, …), OpenGL 4.6 (Core Profile) Mesa 24.0.9)` | high, A |

CreepJS doesn't grade the bare Mesa strings down, so for Intel and AMD the gain is the shape, which no Chrome reports otherwise, not a CreepJS score. Headers, TLS, HTTP/2, fonts, input and rebrowser: no differences.

Caveat: the Mesa version (`24.0.9`) and the `radeonsi` renderer details are a plausible Ubuntu-24.04-era set, not read off real hardware; this container has no GPU.

## 2. Camoufox: window and per-launch drift

### Reproduced

Two launches of one profile, `linux-desktop-nvidia`, screen 1920×1080 (`before-linux-xvfb-nvidia-cf` and `-2-cf`): 138 differences. Among them the GPU (NVIDIA GTX 980, then Intel HD Graphics), avail 1920×1080 then 1485×928, outer 1920×1040 then 1485×896, every font width, audio and canvas. Inner was 1280×720 in both. With a Windows persona: avail 3072×1680 on a 1920×1080 screen, threads 12 for a persona of 8.

### Cause

`camoufox-js`'s `launchOptions()` draws a new BrowserForge fingerprint each call and merges it under the config, filling only keys the config leaves unset. It also draws `fonts:spacing_seed`, `audio:seed`, `canvas:seed`, `canvas:aaOffset` and a weighted WebGL sample per call. We set screen size and timezone only. Over 300 BrowserForge draws per OS, the keys that vary are screen and avail sizes, `availTop`/`availLeft`, outer size, `screenX/Y`, `hardwareConcurrency`, `maxTouchPoints` (Windows), and on Linux the UA and `appVersion` (`X11; Ubuntu;` in 12 %).

Separately, Playwright gives a persistent context a fixed 1280×720 viewport unless it is passed `viewport: null`. With the window keys set but that viewport kept, `innerWidth` read 1600 while `clientWidth` and `@media (width: …)` read 1280: a contradiction a page can see.

### Fix

`packages/browser-runtime/src/firefoxFingerprint.ts`, `camoufoxConfigFor(profile, env)`:

- screen size and available area from the persona (`availScreenFor`: the stored `availScreen`, or the generator's default for profiles that predate it);
- a maximized window on that area: outer = avail (Windows: 16 px larger, `screenX/Y` −8, as a maximized window overhangs the work area), inner = outer minus Firefox's tab strip and toolbar (85 px Linux, 79 Windows, 80 macOS; estimates, no real Firefox measured here);
- `navigator.hardwareConcurrency` from the persona, `maxTouchPoints` 0;
- `navigator.userAgent` / `appVersion` with the installed Firefox version and the OS token BrowserForge gives most;
- `fonts:spacing_seed`, `audio:seed`, `canvas:seed`, `canvas:aaOffset` derived from the profile's seed (`fingerprint.seed`, else its id), as CloakBrowser's `--fingerprint=` is;
- `webgl_config`: one of camoufox-js's own pairs for the OS, sanitized (", or similar", as Firefox reports), not a software renderer, of the persona's GPU vendor, picked by rendezvous hashing on the seed so a camoufox-js update that adds or drops other pairs moves few profiles.

`FirefoxBrowserDriver` launches with `viewport: null`; Camoufox then sizes the content area to `window.inner*` (checked: layout, `visualViewport` and media queries agree, headed and headless). The config now needs the installed version and the WebGL pairs, read lazily from camoufox-js like the driver itself.

### Saved profiles

Nothing is stored. The values are derived, so a profile's Camoufox fingerprint changes once, at its first launch on this version (it was new at every launch before), and then stays put. A camoufox-js update that changes its WebGL data can move some profiles' GPU.

### Measured

| | before | after |
| --- | --- | --- |
| differences between two launches, Linux persona | 138 | 12 |
| differences between two launches, Windows persona | – | 8 |
| GPU across launches | NVIDIA, then Intel | NVIDIA GeForce GTX 980, or similar, both |
| screen / avail / outer / inner (Linux persona, 1920×1080) | 1920×1080 / 1485×928 / 1485×896 / 1280×720 | 1920×1080 / 1920×1050 / 1920×1050 / 1920×965 |
| same, Windows persona | 1920×1080 / 3072×1680 / 1786×1311 / 1280×720 | 1920×1080 / 1920×1040 / 1936×1056 / 1920×961 |
| headless inner | 1280×720 | 1920×965 |

The 12 that remain: canvas, WebGL readback, emoji and SVG hashes and CreepJS's font hashes built on them (engine, see below), and `history.length` of the first tab, which is per session.

## 3. CloakBrowser WebRTC

### Reproduced

0 candidates and 0 STUN requests in every run here, direct and bridged, as in all 26 runs of the 0.11.0 matrix.

### Cause

Direct launches of the binary against a local STUN server, the same page each time:

| Browser and flags | Candidates | STUN request sent |
| --- | --- | --- |
| stock Chromium, no flag | mDNS host + srflx | yes |
| stock Chromium, `disable_non_proxied_udp` | none | no |
| CloakBrowser, no flag at all | none | no |
| CloakBrowser, `--fingerprint` seed only | none | no |
| CloakBrowser, `default` (with or without `WebRtcHideLocalIpsWithMdns`) | host **with the raw LAN address** + srflx | yes |
| CloakBrowser, `default_public_interface_only` | srflx | yes |
| CloakBrowser, `--fingerprint-webrtc-ip=203.0.113.7` with any policy, `disable_non_proxied_udp` included | host + srflx, both 203.0.113.7 | yes, from the real interface |

So the empty result is the engine's own default, which behaves like `disable_non_proxied_udp`. The engine also turns off the mDNS names Chrome gives host candidates. `--fingerprint-webrtc-ip` rewrites the addresses but still sends STUN from the real interface whatever the policy, so a page that runs its own STUN server learns the real address: it stays unused, as the driver already noted.

### Fix

Direct profiles (no proxy, no enforcing egress bridge) launch with `--webrtc-ip-handling-policy=default_public_interface_only`. They show the real public address over HTTP anyway, so a srflx candidate with that address is coherent, not a leak, and it carries no LAN address. Chrome with uBlock Origin's "prevent WebRTC from leaking local IP addresses" behaves the same. Proxied profiles and server profiles behind the egress bridge keep `disable_non_proxied_udp`: every other policy sends STUN outside the proxy.

Caveat: a direct profile on a machine whose system proxy (not a MultiZen proxy) carries its HTTP traffic now shows the machine's address in that srflx candidate. Before, it showed nothing.

### Measured

| Run | srflx | host | STUN requests |
| --- | --- | --- | --- |
| before, direct | 0 | 0 | 0 |
| after, direct | 1 (the address the STUN server saw) | 0 | 1 |
| before, egress `block-private` (bridged) | 0 | 0 | 0 |
| after, egress `block-private` (bridged) | 0 | 0 | 0 |

The page's snapshot reads `gatheringState: gathering`: in this container ICE gathering never completes, for stock Chromium with its default policy too, so that is the environment.

## 4. Timezone aliases

### Reproduced

Through MCP `probe_fingerprint` on CloakBrowser: `America/Argentina/Buenos_Aires`, `Asia/Kolkata`, `Europe/Kyiv` and `Asia/Ho_Chi_Minh` all reported `drift: ["timezone"]`, with the page's offset correct. The page read `America/Buenos_Aires`, `Asia/Calcutta`, `Europe/Kiev`, `Asia/Saigon`. These are all the aliases among the catalog's 74 zones; the earlier run met only the first.

### Cause

V8 reports ICU's canonical ID, which for these is CLDR's legacy spelling. Firefox reports the IANA name. The probe compared strings.

### Fix

`packages/profile-manager/src/timezone.ts` (`sameTimeZone`, `findSameTimeZone`) compares through ICU's canonical ID. `probe_fingerprint` uses it, and so does the launch's proxy-geo timezone check (`launchTimezone.ts`), where a geo service answering `Europe/Kiev` for a `Europe/Kyiv` persona produced a false warning and kept `alignTimezoneToProxy` from applying. A matched zone is applied in the catalog's spelling. Nothing stored changes.

## Many personas

The scratch harness through the server runtime and the MCP server, each profile launched twice:

Twelve Linux personas (seeds `baseline-0` to `-11`, the first four given the four alias zones), each launched twice; personas failing each check:

| Check | CloakBrowser before | CloakBrowser after | Saved profiles, old catalog, after | Camoufox after (6 personas) |
| --- | --- | --- | --- | --- |
| `probe_fingerprint` drift | 5 / 12 (`timezone` ×4, `webgl` ×2) | 0 | 0 | 0 |
| WebGL in Chrome's shape | 12 / 12 | 0 | 0 | n/a (Firefox) |
| doubled `/PCIe/SSE2` | 2 / 12 | 0 | 0 | 0 |
| WebRTC gathers a candidate | 12 / 12 failing | 0 | 0 | 0 |
| window inside avail, avail inside screen, layout = `innerWidth` | 0 | 0 | 0 | 0 |
| same values at both launches | 0 | 0 | – (one launch) | 6 / 6, canvas hash only |

"Saved profiles" are the twelve fingerprints the "before" run stored, created as profiles with the old catalog's WebGL pairs, so they go through the migration on read; `Mesa / NV178` came back as the RTX 4060 Laptop, the rest as the same GPU. The Camoufox "before" side of this harness is in the baseline comparisons above (138 differences between launches).

## Not fixable without engine changes

1. **CloakBrowser, proxied and bridged profiles: no WebRTC candidate.** Every policy that gathers one sends STUN from the real interface, and `--fingerprint-webrtc-ip` does so under any policy. A candidate needs the engine to send STUN through the proxy (SOCKS5 UDP), or to make up the srflx candidate from the proxy's address without sending STUN.
2. **CloakBrowser, direct profiles: no host candidate.** Stock Chrome gives an mDNS one (`<uuid>.local`); this engine shows the raw LAN address instead, so none is the better choice. Needs the engine to keep Chrome's mDNS names.
3. **CloakBrowser's WebGPU adapter on Linux is always NVIDIA.** It parses the architecture from an NVIDIA renderer (RTX 4070 → `lovelace`), but for an Intel or AMD persona it reports `nvidia` with an architecture from its seed (`ampere`, `lovelace`, `blackwell`), next to an Intel or AMD WebGL renderer. This was so before this change. There is no flag for it.
4. **CloakBrowser's WebGL parameters on Linux.** CreepJS still lists `suspicious gpu` and `suspicious capabilities` for the NVIDIA and AMD personas, before and after: they come from the parameter values the engine reports, not from the strings.
5. **Camoufox's canvas noise changes at every launch.** With every config key the same (checked: the config handed to the browser is identical between launches), a canvas drawn on an http page differs between launches and is constant within one; `canvas:seed` doesn't make it stable. So the canvas, WebGL readback, emoji and SVG hashes change per launch.
6. **Camoufox shows Firefox's generic GPU names.** The persona's vendor is kept, but its model can only be one of camoufox-js's sanitized pairs (`NVIDIA GeForce GTX 980, or similar`), as real Firefox sanitizes too.
7. **Headless Camoufox has no WebGL** in this container, before and after.

Not engine limits, left as they were and worth a follow-up:

- CloakBrowser reports `availHeight` equal to the screen (CreepJS `noTaskbar`), while the persona stores a work area 30–80 px smaller. The binary has `--fingerprint-taskbar-height`; applying it changes what every saved CloakBrowser profile shows.
- The driver's comment says CloakBrowser has no `--fingerprint-locale`; this build's binary does list that switch.

## Tests

- `profile-manager`: `webgl.test.ts` (shape of every Linux pair, migration of each legacy pair, startup migration with `updated_at` kept), `timezone.test.ts`; `scripts/test-fingerprint.ts` checks the Linux shape.
- `browser-runtime`: `firefoxFingerprint.test.ts` (same config per profile, pinned identity, geometry on every OS, WebGL pick per vendor and its stability, a pair for every persona in camoufox-js's real data), the WebRTC flags in `driverOptions.test.ts`, `viewport: null` in `FirefoxBrowserDriver.test.ts`, aliases in `launchTimezone.test.ts`.
- `mcp-server`: the four aliases in `probe_fingerprint`, and `hardwareConcurrency` on Camoufox.

In this container two existing tests fail before and after this change, for the environment: `socks5Bridge` "an IPv6 literal goes out unbracketed" (no IPv6) and three `apps/server` serve tests (the bundle doesn't come up here).
