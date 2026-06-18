# Research — Browser extensions in MultiZen profiles

Slug: `browser-extensions`. Goal: let users run Chrome extensions (wallets like
Phantom/MetaMask, etc.) in CloakBrowser profiles, where the Chrome Web Store is
stripped (ungoogled) and MultiZen currently has **no** extension support.

## Summary

- **The core mechanism works on our engine.** `--load-extension=<dir>` loads an
  unpacked extension (manifest.json at root). Chrome 137 (2025) **removed this flag
  in Google-branded Chrome only** — *"continues to function in non-Chrome brands such
  as Chromium and Chrome for Testing."* CloakBrowser is patched **unbranded** Chromium,
  so the flag is available. ungoogled removes only the *store UI*, not `--load-extension`
  or chrome://extensions "Load unpacked".
- **Re-pass the flag every launch.** Persistence of `--load-extension` across launches
  is not guaranteed (only chrome://extensions UI-loaded paths persist via Secure
  Preferences). Our driver already rebuilds args per launch, so we pass
  `--load-extension` each time from a stable per-profile path → stable extension ID.
- **Integration is a clean fit.** `ChromiumBrowserDriver` assembles a CLI args array
  (`ChromiumBrowserDriver.ts:213-308`) before `spawn` (`:339`); `--user-data-dir` is at
  `:214`. An `--load-extension=<dirs>` push slots in after the proxy block. Profiles
  already have a persistent per-profile user-data-dir
  (`{userData}/data/profiles/{id}/`), and the data model has an established
  JSON-column + idempotent-migration pattern (the `proxy_country` migration) to add an
  `extensions` field.
- **Wallets (MetaMask, Phantom) are MV3.** MetaMask ships a prebuilt zip; Phantom ships
  only a CRX (must extract). MV3 unpacked loads fine; state lives in `chrome.storage`,
  surviving service-worker restarts.
- **Acquisition: three methods** — (a) user-provided unpacked/.crx/.zip folder,
  (b) `.crx`-by-ID via Google's CRX endpoint (verified live, HTTP 200, 2026-06-17),
  (c) bundle the MIT **chromium-web-store** restorer so the in-browser store works again.
- **Competitors converge on "library + assign".** AdsPower / Dolphin / Undetectable use
  a shared extension library assigned to profiles (often by group); GoLogin / Multilogin
  are strictly per-profile. All replace the live store with "paste Web-Store URL" or
  "upload .crx/.zip/folder". Raw `.crx` alone doesn't load — needs the unpacked tree.
- **Anti-detect caveats are the hard part, not UX.** Extensions are detectable
  (web-accessible-resource probing, injected globals). Two engine-level tells from
  `--load-extension`: the **"developer mode extensions" warning bubble** (no CLI flag
  hides it — needs a source patch) and **extension-ID stability** (a random dev-path ID
  is anomalous; a fixed genuine store ID is WAR-probeable). Wallets are worst-case:
  `window.ethereum.address` is identical across profiles if the wallet is reused, linking
  them regardless of fingerprint spoofing.

## Empirical verification (done) + CloakBrowser specifics

**Live test on the cached CloakBrowser 145 binary — extension loading CONFIRMED.**
Launched the binary with `--load-extension=<dir> --disable-extensions-except=<dir>`
(persistent `--user-data-dir`) and an unpacked MV3 test extension. Result via CDP:
- service worker target `chrome-extension://fnacdpemljpmiboggldfmdhffmdadblo/bg.js` →
  **MV3 extension active**;
- page title became `MZEXT_LOADED::Example Domain` → **content script ran**;
- the ID is deterministic from the absolute path (stable across launches).

So MV3 (MetaMask/Phantom class) loads, and the mechanism is proven on our actual engine.

**CloakBrowser's own mechanism (from its source, CloakHQ/CloakBrowser):** the documented
`extension_paths` option emits exactly **`--load-extension=<abs,…>` AND
`--disable-extensions-except=<abs,…>`** (absolute, comma-joined) — the same flag pair we
just verified. README: *"extensions only work from a real user data dir"* (need a
persistent `user_data_dir`, which our profiles already have). CloakBrowser ships passing
tests asserting the flag is emitted; no custom/renamed flag.

**Corrections to assumptions:**
- CloakBrowser is **not** advertised as ungoogled — it's a custom-compiled Chromium
  (145 on macOS / 146 on win+linux) with C++ source patches. The Chrome-137
  `--load-extension` removal (branded-Chrome-only) does not apply — confirmed by their
  tests *and* our live run.
- CloakBrowser has **no** built-in extension manager, web-store restorer, or wallet
  examples; their separate CloakBrowser-Manager answered "install on profile creation"
  requests with "just use `extension_paths`".

**Dev-mode warning bubble — VERIFIED ABSENT (visual check, 2026-06-17).** Ran the
CloakBrowser 145 binary with `--load-extension` and the owner visually confirmed **no
"Disable developer mode extensions" warning appears** — no infobar under the omnibox, no
bubble from the puzzle/Extensions menu, nothing. So on our macOS engine (Chromium 145)
the dev-mode tell does NOT show; v1 needs no bubble mitigation. (Windows/Linux run
Chromium 146 — worth a quick re-confirm there, but the macOS result is settled.) This
removes the main stealth concern from the research.

## Codebase integration points

| Concern | Location | Note |
|---|---|---|
| CLI args array | `ChromiumBrowserDriver.ts:213-308` | push `--load-extension=<a,b>` (+ optional `--disable-extensions-except`) after the proxy block |
| spawn | `ChromiumBrowserDriver.ts:339-343` | args consumed here; extensions need no extra CDP |
| user-data-dir | `:214`, `browserDataDirForEngine()` `:895-904` | persistent per profile/engine |
| Profile type | `packages/types/src/index.ts:98-114` | add `extensions?: ExtensionConfig[]` |
| DB schema + migration | `ProfileManager.ts:48-69` | idempotent `ALTER TABLE profiles ADD COLUMN extensions TEXT` (mirror `proxy_country`) |
| create/update/rowToProfile | `ProfileManager.ts:105-225` | JSON-(de)serialize like `proxy`/`fingerprint` |
| storage dir | convention `{profileId}/extensions/{extId}/` | sibling of Chromium's `Default/` |
| IPC / preload / renderer | `index.ts:185-203`, `preload:55-152`, `renderer types:55-116` | mirror the `profiles` namespace |
| Profile UI | `NewProfileSheet.tsx`, `ProfileEditSheet.tsx` (Proxy section) | add an "Extensions" group next to Proxy |

## Options compared — acquisition

| Method | How it gets the extension | Stable store ID | Auto-update | Web-Store UX | ToS/legal | Our maintenance |
|---|---|---|---|---|---|---|
| **User-provided folder/.crx/.zip** | user supplies; we unpack to per-profile dir | yes (pinned path or `key`) | no | none | lowest (user brings artifact) | low |
| **.crx-by-ID download** | app hits `clients2.google.com/service/update2/crx?...x=id%3D<ID>`, strip CRX header → unpacked | yes (CRX carries store key) | no (must re-fetch) | none (programmatic) | highest (automating Google's endpoint + 3rd-party IP) | medium (endpoint/prodversion drift, CRX parsing) |
| **chromium-web-store restorer (NeverDecaf, MIT)** | in-browser Install button; the extension downloads the CRX itself | real store ID | yes (semi-auto) | full | lower (user's own browser fetches) | low (bundle MIT ext) — but needs `extension-mime-request-handling` enabled on ungoogled |

## Options compared — UX model

| Model | Who does it | Pros | Cons |
|---|---|---|---|
| **Per-profile list** | GoLogin, Multilogin | simplest, full isolation, matches our profile model | re-add per profile; no scale story |
| **Shared library + assign (by group)** | AdsPower, Dolphin, Undetectable | scales to many profiles, one upload → many | more data model + UI; storage sharing vs isolation tension |

## Recommendation — phased

**v1 (this spec): per-profile, user-provided extensions.**
- Add `extensions` to the profile model (`ExtensionConfig[]`: id, name, source dir,
  enabled).
- Ingest: user picks a **.crx / .zip / unpacked folder**; we validate (`Cr24` header →
  strip to zip; or zip; or folder), reject MV2, confirm `manifest.json`, unpack to
  `{profileId}/extensions/{extId}/`.
- Load: pass `--load-extension=<enabled dirs>` (stable absolute paths → stable IDs) on
  every launch.
- UI: an "Extensions" section in the profile create/edit sheet (add / remove / toggle),
  mirroring the Proxy section.
- This directly unblocks the Discord users' Phantom/MetaMask case with the lowest
  legal/maintenance surface.

**v2 (later): Web-Store convenience.**
- Either bundle **chromium-web-store** (MIT) as an always-loaded extension so operators
  get a real "browse & install" button, OR add **paste-Web-Store-URL → .crx-by-ID
  download**. Both need decisions about the ungoogled `extension-mime-request-handling`
  flag and the ToS posture.

**v3 (scale + stealth): library + assign + engine patches.**
- Shared extension library assignable to profiles/groups (competitor-grade).
- CloakBrowser-core work: suppress the dev-mode warning bubble; ID/WAR stealth.

## Constraints & risks

- **Dev-mode warning bubble (unverified on CloakBrowser).** `--load-extension` normally
  triggers Chrome's "Disable developer mode extensions" popup — no CLI flag suppresses
  it; only a source patch. **Must verify empirically whether CloakBrowser already
  suppresses it.** If not, it's both a UX wart and a detection tell, and the fix lives in
  the CloakBrowser core (out of MultiZen's repo) → v1 may ship with the bubble present.
- **`--load-extension` actually working on CloakBrowser is assumed, not yet verified.**
  Confirm with a real launch before building UI on top.
- **Detection.** Extensions are fingerprintable (WAR probing, injected globals). Loading
  is not "stealth-free." For wallets, `window.ethereum.address` reuse links profiles
  regardless of spoofing — a product-honesty issue we should surface to users.
- **MV2 is dead** on current Chromium — reject MV2 uploads.
- **Stable ID:** use a fixed per-profile absolute path (deterministic ID) or inject the
  store `key`. A random ID looks anomalous.
- **Phantom** ships only a CRX (closed source) — users must provide the CRX; we extract.
- **Disk/size:** competitors cap (~60 MB). Consider a sane limit + cleanup on profile
  delete (extensions live under the profile dir, so delete is already covered).

## Open questions for `/specify`

1. **v1 scope:** per-profile only (recommended, matches our model), or jump straight to
   a shared library + assign like AdsPower/Dolphin?
2. **Ingest in v1:** local **.crx/.zip/folder upload** only, or also **paste Web-Store
   URL** (pulls in the .crx-by-ID download + its ToS posture) now?
3. **Bundle chromium-web-store** for a real in-browser store in v1, or defer to v2 and
   ship the simple manager first?
4. **Dev-mode warning bubble:** do we verify/patch it as part of this work (CloakBrowser
   core), or accept it for v1 and note it?
5. **Wallet-linkage UX:** show an in-app warning about reused wallet addresses / unique
   seed per profile, or stay silent?
6. **Extension enable/disable & per-profile vs reusable:** is toggling per-profile enough
   for v1, or do users expect to reuse one uploaded extension across profiles (→ shared
   storage) from the start?

---

Research path: `specs/browser-extensions/research.md`. Suggested next step:
`/specify browser-extensions` — but first I'd verify empirically that `--load-extension`
loads cleanly in CloakBrowser (and whether the dev-mode bubble appears), since that gates
the whole approach.
