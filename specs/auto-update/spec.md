# Spec — App auto-update (Phase 1)

Scope: **the MultiZen app updating itself.** The CloakBrowser **runtime/engine**
updater is a separate, later spec (Phase 2) and is explicitly out of scope here.
Builds on `specs/auto-update/research.md`.

## Problem / Why

MultiZen has **no self-update mechanism**. Users download an installer once and
never get fixes unless they manually re-download. This is not hypothetical — the
download-corruption fixes (v0.2.5 → v0.2.7) shipped, but the affected Discord users
stayed on the broken version because nothing tells them a newer build exists or
updates them to it. Every future fix and feature has the same reach problem.

electron-builder already publishes the update feed (`latest.yml` /
`latest-mac.yml` / `latest-linux.yml`) to GitHub Releases on every CI publish — we
produce it but nothing consumes it. Closing this gap means a fix reaches users within
a day instead of never.

In the anti-detect domain, staleness also erodes the product: an old app ships an old
CloakBrowser and old fingerprint logic. Keeping users current is part of the value,
not just hygiene. (The engine half of that is Phase 2.)

## Goal & non-goals

### Goals
- **Windows + Linux:** the app checks for, downloads, and installs updates on its own,
  with a calm, non-intrusive UX — the user never has to visit GitHub or the site.
- **macOS:** the app **detects** a newer version and surfaces a passive "download"
  prompt linking to the release/DMG; the user installs manually. No silent failure.
- A clear, well-designed **in-app update flow** with explicit, legible states — this is
  the primary emphasis of this phase.
- A **Settings** surface: current version, a manual "Check for updates" action, and an
  on/off toggle for automatic updates.
- Honest failure: errors (including the macOS Squirrel signature failure) are caught
  and shown as a friendly state, never a crash or a confusing dialog.

### Non-goals (explicitly out of scope)
- **macOS auto-install** — blocked without an Apple Developer ID (verified against
  Squirrel.Mac source). Not attempted in this phase.
- **Buying the Apple Developer ID** — a separate business decision.
- **CloakBrowser runtime/engine auto-update** — Phase 2.
- **Delta/differential tuning, staged rollout, release-pipeline hardening** beyond a
  noted follow-up — not blocking for Phase 1.
- **In-app release-notes rendering** beyond showing the version (and optionally a link
  to the GitHub release notes).

## Definitions — update states

A single discriminated status drives the whole UX. Conceptual states:

| State | Meaning |
|---|---|
| `idle` | No update known; nothing shown. |
| `checking` | A check is in flight (manual or automatic). |
| `up-to-date` | A check completed and the app is current (shown only right after a *manual* check). |
| `available` | A newer version exists. On win/linux this transitions into downloading; on macOS this is the terminal "download manually" state. |
| `downloading` | Update is downloading in the background, with progress (bytes / percent). |
| `ready` | Update downloaded and staged; a restart will apply it. |
| `error` | Check/download/install failed (includes macOS signature failure); carries a human message. |

The same state model serves all three platforms; only the *transitions* differ
(macOS stops at `available`).

## User stories / scenarios

### S1 — Windows/Linux: silent background update (happy path)
1. User launches MultiZen and works normally.
2. Shortly after launch (and periodically thereafter), the app checks the feed in the
   background. No UI unless something is found.
3. A newer version is found; it downloads in the background. The user can keep working;
   download progress is available but never blocks or steals focus.
4. When the download is staged, a **non-intrusive banner/toast** appears:
   "MultiZen vX is ready — Restart to update" with **Restart now** and **Later**.
5. **Restart now** → app quits and relaunches on the new version.
   **Later** → the update is applied automatically the next time the app quits/starts.

### S2 — Windows/Linux: user keeps dismissing
- If the user chooses **Later**, the banner does not nag aggressively; the "ready"
  state remains discoverable (e.g. a subtle indicator + the Settings panel) so they can
  restart on their own terms. The update still applies on the next natural quit.

### S3 — macOS: detect + manual download
1. Same background check.
2. A newer version is found. Because auto-install is impossible, the app shows a passive
   banner: "MultiZen vX is available — Download" linking to the release/DMG.
3. No download/restart happens in-app. If electron-updater ever reaches the install path
   and Squirrel rejects the ad-hoc signature, that error is caught and never surfaces as
   a raw failure — the user only ever sees the friendly "Download" prompt.

### S4 — Manual check from Settings (all platforms)
1. User opens Settings and sees the **current version** and a **Check for updates**
   button.
2. Clicking it runs a check with visible feedback: `checking` → then `up-to-date`
   ("You're on the latest version") or `available`/`downloading` as appropriate.
3. Unlike the automatic check, the manual check always gives explicit feedback
   (including the up-to-date confirmation).

### S5 — Auto-update turned off
1. User toggles **automatic updates** off in Settings.
2. No background checks/downloads happen. The manual **Check for updates** button still
   works on demand. (Toggling off does not uninstall a download already staged.)

### S6 — Failure is graceful
- Network down, feed unreachable, corrupted download, or macOS signature rejection →
  the app lands in `error` with a short, honest message and a retry affordance; it never
  crashes, blocks the app, or shows a raw stack/dialog.

## UX/UI requirements (primary focus)

- **Non-intrusive by default.** Automatic activity (checking, downloading) shows **no**
  modal and never steals focus. The only proactive surface is a dismissible
  banner/toast when there's something the user can act on (`ready` on win/linux,
  `available` on macOS).
- **One obvious primary action per state:** `ready` → "Restart to update"; macOS
  `available` → "Download"; `error` → "Retry".
- **Progress is available, not in the user's face.** Downloading shows progress
  (bytes/percent) in a calm location (e.g. the banner or Settings), consistent with the
  existing Chromium-bootstrap progress styling — but it must not block the main UI the
  way the first-run bootstrap modal does.
- **Settings panel** shows: current app version, last-checked time, automatic-updates
  toggle, and a manual **Check for updates** button that reflects live state.
- **Restart UX:** "Restart now" cleanly quits and relaunches; "Later" defers without
  nagging and lets the OS-natural quit apply it.
- **macOS degradation is first-class, not an afterthought:** the macOS path shows a
  genuinely useful "Download" CTA (deep link to the correct asset/release), not a dead
  "Restart" button or a hidden error.
- **Consistency:** mirror existing patterns — status pushed main→renderer like
  `chromium:status`, a `window.multizen` preload namespace like `chromium`, the
  existing toast in `App.tsx`, and a discriminated-union status type like
  `ChromiumStatus`. (These are integration hints from research; the plan owns specifics.)
- **No duplicate-download / nag bugs:** repeated checks must not download twice or spam
  banners (research flagged electron-updater lacks a daily throttle).

## Acceptance criteria

Behavioral, testable:

- [ ] On Windows and Linux, with a newer published release, a freshly launched app
      detects it automatically (no user action) and downloads it in the background.
- [ ] After the background download completes, a non-intrusive "Restart to update"
      banner/toast appears; **Restart now** relaunches into the new version; **Later**
      dismisses without blocking and the update applies on next quit/launch.
- [ ] On macOS, a newer release produces a passive "vX available — Download" banner that
      links to the GitHub release/DMG; **no** in-app install or restart is attempted, and
      no raw error/dialog appears even if the install path is reached.
- [ ] Settings shows the current app version and a working **Check for updates** button
      whose result is reflected in the UI, including an explicit "up to date" state.
- [ ] An **automatic-updates on/off** toggle exists; when off, no background
      checks/downloads occur, but manual check still works.
- [ ] All failure modes (no network, unreachable feed, bad download, macOS signature
      rejection) resolve to a friendly `error` state with a retry affordance — never a
      crash, block, or raw dialog.
- [ ] Automatic checks run shortly after launch and periodically, but a single logical
      check never triggers a double download, and banners do not nag repeatedly.
- [ ] The current app version shown in-app matches `app.getVersion()` and the released
      build.
- [ ] Existing flows (first-run Chromium bootstrap, profile launch, MCP) are unaffected
      by the updater being present.
- [ ] `typecheck` + `build` pass; the feature is verified by driving the real app (per
      `/verify`) on at least Linux or Windows for the auto-install path, and the macOS
      banner path is verified by behavior/observation.

## Resolved decisions

1. **Auto-update default:** **ON** by default, with a Settings off-switch. _(decided)_
2. **Update-ready surface (win/linux):** a **persistent, dismissible banner** that sticks
   until the user clicks "Restart" or dismisses — not a 4s auto-dismiss toast, since the
   restart is an action we want the user to actually take. _(decided)_
3. **macOS "Download" target:** deep-link to the exact `MultiZen-mac-<arch>.dmg` asset of
   the new release (fall back to the release page if the arch asset can't be resolved).
   _(decided)_
4. **Pre-release/channel:** stable-only — ignore drafts/prereleases. _(decided)_
5. **"Later" persistence:** after "Later", show a subtle persistent indicator (e.g. in
   the Settings/version area) and re-show the banner once per app launch until updated.
   _(decided)_

## Open questions (for `/plan`)

- **Re-check cadence:** launch + every N hours while running — pick N in `/plan`
   (research: periodic with a DIY `lastCheckedAt` gate to avoid double-download).

---

Spec path: `specs/auto-update/spec.md`. Please review — especially the **Open
questions** and the **UX/UI requirements** — before I move to `/plan`.
