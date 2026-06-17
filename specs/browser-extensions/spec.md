# Spec — Browser extensions (Phase 1 / v1)

Scope: **per-profile Chrome extensions**, user-supplied, with a one-click **"Add to
MultiZen"** button injected onto Chrome Web Store pages. Builds on
`specs/browser-extensions/research.md` (verified live on CloakBrowser: `--load-extension`
loads MV3, no dev-mode warning, deterministic ID; and the Web Store *detail page itself
loads* — domain substitution only affects hardcoded NTP links, not navigation). Shared
library and extension auto-update are explicitly **later phases**.

## Problem / Why

MultiZen users can't install browser extensions. The CloakBrowser engine is stealth
Chromium with the Web Store **install path** stripped — the store page opens, but
"Add to Chrome" is dead — and MultiZen itself has **no** extension support. This blocks a
top use case for a multi-profile anti-detect browser: a different logged-in identity per
profile (wallets like Phantom/MetaMask, but equally any login-bearing extension). Discord
users already hit this wall. Every competitor (AdsPower, GoLogin, Multilogin, Dolphin,
Undetectable) ships extension management; we have nothing.

Verified on our engine: `--load-extension` loads an unpacked MV3 extension cleanly (no
dev-mode warning), and the Web Store detail page **does** open in CloakBrowser. So we can
both (a) manage extensions from MultiZen's own UI and (b) inject a working "Add to
MultiZen" button right on the store page where "Add to Chrome" is disabled.

## Goal & non-goals

### Goals
- **One-click install from the Web Store:** on a `chromewebstore.google.com/detail/...`
  page inside a profile, an **"Add to MultiZen"** button appears next to (or replacing) the
  disabled "Add to Chrome". Clicking it installs that extension into the **current
  profile** (resolve ID → download `.crx` → unpack → register), no manual copy/paste.
- **Manual add too**, from the profile's Extensions UI:
  - paste a Chrome Web Store URL/ID → download + unpack, and/or
  - upload a local `.crx`, `.zip`, or unpacked folder.
- Each profile has its **own** extension list (add / remove / enable-disable).
- On launch, a profile's **enabled** extensions load into its CloakBrowser session and
  actually work (content scripts run, wallets inject providers).
- **Full per-profile isolation** — the extension *set* and its runtime *state*
  (`chrome.storage`, IndexedDB, logins, options) live in that profile's user-data-dir and
  never bleed across profiles. The same extension in two profiles = two independent
  installs with independent logins.
- Extensions persist across launches/app-restart; deleting a profile removes its
  extensions.
- MV2 is rejected with a clear message (modern Chromium won't run it).

### Non-goals (v1)
- **Shared/global extension library + assign-to-profiles** (AdsPower/Dolphin style) — later.
- **Bundling the third-party NeverDecaf `chromium-web-store` restorer** — we ship our own
  minimal companion that does *only* the "Add to MultiZen" injection + install handoff, not
  a full store reimplementation.
- **Extension auto-update** — v1 pins what was added.
- **Dev-mode-warning mitigation** — verified absent on our engine.
- **Per-extension stealth tuning** (WAR hiding, `use_dynamic_url`, ID randomization) — later.
- **Cross-profile dedupe of identical uploads** — each profile keeps its own copy.

## Definitions

- **Extension entry** (per profile): name, stable id, enabled flag, on-disk unpacked dir,
  and source (web-store / uploaded-file / folder).
- **Enabled**: included in the next launch's `--load-extension`. Disabled stays on disk,
  not loaded.
- **Companion extension**: a small first-party MultiZen extension, always loaded into every
  profile, whose only job is to (a) inject the "Add to MultiZen" button on Web Store pages
  and (b) hand the chosen extension ID to the MultiZen app to perform the install. It is
  not user-managed and does not appear in the user's extension list. (Mechanism — likely a
  CDP binding, since MultiZen is already attached to each profile over CDP and thus knows
  which profile a click came from — is a `/plan` decision.)

## User stories / scenarios

### S0 — One-click "Add to MultiZen" from the store (primary)
1. Inside a profile, the user opens a `chromewebstore.google.com/detail/<name>/<id>` page
   (it loads; "Add to Chrome" is disabled).
2. An **"Add to MultiZen"** button is present (next to / replacing "Add to Chrome").
3. User clicks it → MultiZen resolves the extension ID, downloads the `.crx`, validates MV3,
   unpacks it under the current profile, adds it to that profile's extension list, and
   confirms (e.g. a toast). The user is told it'll be active on the next profile launch (or
   is offered a relaunch).

### S1 — Add by Web Store URL from the Extensions UI
- In a profile's Extensions section → "Add from Web Store" → paste store URL/ID →
  download + unpack + list.

### S2 — Add a local extension (.crx / .zip / folder)
- "Add from file" → pick `.crx`, `.zip`, or an unpacked folder → validate (strip CRX header
  if present; manifest present; MV3) → unpack + list. Covers Phantom's CRX-only distribution.

### S3 — Manage the list
- The Extensions section lists each extension with name, an enable/disable toggle, and
  remove. Remove deletes files + drops it. Disable keeps it installed but unloaded.

### S4 — Apply on launch
- Launch loads exactly the profile's enabled extensions. If the profile is already running,
  the UI is clear that changes apply on the **next** launch (Chromium loads extensions at
  startup) — no false "applied live" claim; optionally offer a relaunch.

### S5 — Create-time
- The Extensions section is also in the create-profile flow.

### S6 — Rejected / failed inputs
- MV2 → "Manifest V2 isn't supported by modern Chromium." Corrupt/no-manifest → clear
  reason, nothing half-installed. Web Store download failure → clear error, retry or fall
  back to file upload.

### S7 — Isolation across profiles
- The same login-bearing extension added to profiles A and B keeps separate state: a login
  under A does not appear under B.

## Acceptance criteria

- [ ] On a Web Store detail page inside a profile, an **"Add to MultiZen"** button appears
      (next to/replacing the disabled "Add to Chrome").
- [ ] Clicking it installs that extension into the **current** profile (correct profile
      attribution) and confirms; the extension appears in that profile's list and works on
      next launch — verified with a real extension.
- [ ] **Add from Web Store** (paste URL/ID) and **Add from file** (`.crx`/`.zip`/folder)
      both work from the Extensions UI.
- [ ] **MV2 rejected** with a clear message; corrupt/invalid inputs rejected with a reason
      and no partial install.
- [ ] Profile create + edit screens have an **Extensions** section (list, enable/disable,
      remove) consistent with the Proxy section's look/placement.
- [ ] Launch loads exactly the **enabled** extensions; a wallet injects its provider and
      content scripts run — verified in a real CloakBrowser launch. Disabled aren't loaded;
      removed are deleted from disk.
- [ ] Extensions persist across launches/app-restart; deleting a profile removes them.
- [ ] **Isolation:** same extension in two profiles keeps fully separate state — verified.
- [ ] The companion extension is invisible to the user (not in their list) and is loaded in
      every profile without the user managing it.
- [ ] UI communicates that changes apply on the **next** launch when the profile is running.
- [ ] Existing profiles (pre-feature) open and launch normally with no extensions
      (backward-compatible migration).
- [ ] `typecheck` + `build` pass; verified by a real profile launch + a real "Add to
      MultiZen" install; independent code-review loop passes before merge to `master`.

## Open questions (for `/plan`)

1. **Web Store `.crx`-by-ID download ToS:** grey area (research-flagged). Accept for v1 as
   the user-initiated mechanism behind both the button and paste-URL, with file-upload as
   fallback. (Assumed yes per user; flag the risk in the plan.)
2. **Companion ↔ app channel:** CDP binding (preferred — profile identity is implicit in
   the CDP session) vs. a per-profile localhost endpoint. `/plan` decides.
3. **Relaunch UX after install:** just toast "active next launch", or offer/auto a profile
   relaunch so the new extension is immediately live? (Lean: toast + optional "Relaunch".)
4. **Size/count limits:** a sane per-extension size cap (competitors ~60 MB) and/or count
   cap, or unbounded? (Lean: generous size cap.)
5. **`.crx` ID pinning:** deterministic absolute-path ID (verified) vs. injecting the
   manifest `key` to pin the genuine store ID. (`/plan` detail.)

---

Spec path: `specs/browser-extensions/spec.md`. Proceeding to `/plan` per user's "do
everything" mandate.
