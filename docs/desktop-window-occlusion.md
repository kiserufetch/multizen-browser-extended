# Window occlusion on the desktop (2026-11-01)

**Status:** recommendation for the owner to decide. The desktop's launch flags are unchanged. Only the `INPUT_NOT_DELIVERED` advice changed (last section).  
**Question:** should desktop launches on Windows use the server's two occlusion settings? Those are `serverDisabledFeatures` (`CalculateNativeWinOcclusion`) and `serverFirefoxPrefs` (`widget.windows.window_occlusion_tracking.enabled=false`), both in `apps/server/src/runtime.ts`.  
**Builds on:** `docs/input-delivery-hidden-page.md` ("Measured on Windows") and `docs/detection-baselines/README.md` ("Заметно ли страницам отключение отслеживания перекрытия")

## Recommendation

Adopt both on the desktop, on Windows only, as the server does. In `apps/desktop/src/main/index.ts`, pass `extraDisabledFeatures: serverDisabledFeatures(process.platform)` to the `ChromiumBrowserDriver` and `extraPrefs: serverFirefoxPrefs(process.platform)` in the `EngineRouter`'s `firefoxOptions`. The evidence was measured on Windows 11 (CloakBrowser 146.0.7680.177.5, Camoufox 152.0.4-beta.30) unless marked otherwise:

1. **A page can't tell while the window is uncovered.** In the stored baselines, CloakBrowser shows 0 differences. Camoufox shows only values it redraws at every launch.
2. **On a covered window, the settings make both engines work.** Without them, a CloakBrowser page goes `hidden` and stops producing frames, and a click takes 5.1 s. A Camoufox page stays `visible`, but its click never arrives within 7 s. With them, both pages keep producing frames and clicks take about 0.1 s.
3. **With the display off, today nothing an agent can do recovers the page.** `Page.bringToFront` failed 5 of 5 times, and so did `SetWindowPos(HWND_TOPMOST)` and `ES_DISPLAY_REQUIRED`. With the flag the page read `visible` and painted. Windows turns the display off after idle minutes, so an agent working while the operator is away hits this routinely.
4. **Today pages see more than they would with the settings.** A desktop window that opened behind others reported `hidden`, no paint entries and no animation frames. It also reported `outerWidth` and `outerHeight` of 0, and its click failed. On a covered window, the CloakBrowser page received the click while it read `hidden`. With the settings, a covered page looks like an ordinary foreground window.
5. **One population.** Server and desktop then behave the same on Windows.

**Cost:** a covered profile window keeps rendering at full rate. In the covered sample that was 150 frames against 0 without the flag (Camoufox: 155 against 1). That is CPU and GPU time the operator's own windows compete for. How much was not measured. Minimizing still hides a CloakBrowser window with the flag (source, below), so operators keep a way to park profiles.

**Open, not blocking:**

- the session lock was not tested;
- the CPU cost with many covered profiles was not measured;
- Camoufox with the display off was not tested;
- the packaged desktop app was not run with the settings. The covered runs used the baseline harness with the desktop's launch configuration plus the server's settings (`win-headed-occlusion-*`).

## What was measured

The stored runs are under `docs/detection-baselines/`. The display-off figures come from `docs/input-delivery-hidden-page.md`.

**Covered window** (the `covered` section, second sample, with a black full-screen window on top):

| | CloakBrowser, desktop launch | CloakBrowser + flag | Camoufox, desktop launch | Camoufox + pref |
| --- | --- | --- | --- | --- |
| `visibilityState` | `hidden` | `visible` | `visible` | `visible` |
| `hasFocus` | false | false | true | true |
| Frames since the previous sample | 0 | 150 | 1 | 155 |
| Click while covered | delivered, 5,073 ms | delivered, 110 ms | **not delivered in 7,014 ms** | delivered, 96 ms |
| `visibilitychange` events | hidden, then visible | none | none | none |

Runs: `2026-10-31-win-headed-desktop-cb`, `-occlusion-cb`, `-desktop-cf` and `-occlusion-cf`.

**Uncovered:** `compare.ts` between the desktop launch and the desktop launch plus the settings gives CloakBrowser 0 differences. Camoufox gives 6, all values it redraws at every launch: the GPU vendor, an audio sample count and `history.length`.

**The stored comparison files understate the covered difference.** `compare-…-win-headed-desktop-*-vs-…-win-headed-occlusion-*.md` say `covered (0)`. The repeat runs (`win-headed-desktop-2-*`) have no `covered` section, so every `covered.*` path also "differs from its own repeat" and is dropped as noise. Re-run without `--repeat`, CloakBrowser gives 8 differences. Six are in `covered` (visibility, `visibilitychange`, frames). The other two are CreepJS audio values that also differ between the desktop run and its own repeat. Camoufox gives 135: 1 in `covered` (the click), the rest its per-launch fingerprint. The README's table is right. `compare.ts` could stop counting a section the repeat doesn't have as noise.

**Display off** (bare binary over CDP, `data:` page; the display was presumably off after 69 idle minutes with a 15-minute timeout, not checked directly):

| Launch | `[visibilityState, paint entries, hasFocus]` |
| --- | --- |
| Plain | `["hidden",0,true]` at all three samples |
| `--disable-features=CalculateNativeWinOcclusion` | `["visible",2,true]` at all three samples |

In that state `Page.bringToFront` returned success 5 of 5 times and did not help. The foreground stayed with the user's other app, and `hasFocus` turned true while the page stayed hidden.

**Window opened behind others, desktop launch** (`2026-11-01-win-headed-desktop-cb`, 34 differences from the stored desktop run): `hidden`, no paint entries, no animation frames, `hasFocus` false, `outerWidth` and `outerHeight` 0, `screenX` 1565. `click` failed with `INPUT_NOT_DELIVERED`. The page logged `focus` and `visibilitychange` during that click, and only the release arrived. The window had come forward mid-click. The message then said "The page is visible. Take a screenshot…", which was wrong (see the last section). The other three input tools in that run delivered.

## Why (engine source)

Chromium is read at `refs/branch-heads/7680`, the branch of CloakBrowser 146.

- `ui/base/ui_base_features.cc:38`: `kCalculateNativeWinOcclusion` exists only on Windows and is on by default. `ui/aura/window_tree_host.cc:478-480`: a window is tracked only while that feature is on.
- `ui/aura/native_window_occlusion_tracker_win.cc:222-225`: "If the screen is locked or off, ignore occlusion state results and mark the window as occluded." `OnSessionChange` (256-258) and `OnDisplayStateChanged` (262-279) mark every window that is not minimized as occluded. Raising a window cannot change that, which explains the 5 of 5. The lock takes the same path, so it should behave like the display off. Not tested.
- `ui/views/widget/desktop_aura/desktop_window_tree_host_win.cc:1159-1163`: minimizing hides the window without the tracker, so minimized windows stay hidden with the flag.
- `content/browser/web_contents/web_contents_impl.cc:11630-11637`: `--disable-backgrounding-occluded-windows` would also keep covered pages visible, with the tracker still running. Playwright passes it on every Chromium launch. Use the server's flag for parity.

Firefox and Camoufox:

- `modules/libpref/init/StaticPrefList.yaml` (mozilla-central tip): occlusion tracking is on by default. Display-state tracking (`..._display_state.enabled`) is off by default, so a display that is off alone should not stop Camoufox. Not tested. Session-lock tracking (`..._session_lock.enabled`) is on.
- Camoufox fixed the covered-window case itself in commit `2d59a8f` (2026-10-15, issue #804, first shipped in v156.0.1-beta.39). Juggler sets `browsingContext.forceAppWindowActive = true` on every window (`browser/additions/juggler/TargetRegistry.js:264`), which keeps it active when occluded or minimized (`CanonicalBrowsingContext::RecomputeAppWindowVisibility`). The desktop pins v152.0.4-beta.30 (`packages/browser-runtime/src/CamoufoxBootstrap.ts:53-56`), which predates it. A pin bump would make the pref redundant on Camoufox, and minimized Camoufox windows would then keep running too. The bump needs the review that file describes.
- An earlier version of this note predicted from the source that a covered Camoufox page reads `hidden`. The measurement says `visible`, with frames all but stopped and input hanging.

## Effect on the operator's other windows

- **Scope.** The feature is read from each browser process's own command line, and the pref belongs to the profile. Only browsers that MultiZen launches change. The operator's own browsers and the MultiZen window don't.
- **Focus.** Neither setting moves a window or takes focus. Today's recoveries do: raising the window takes focus each time it works. On the display-off run it moved `hasFocus` without bringing the window forward.
- **Resources.** Covered windows keep rendering: the frame counts above. Not measured as CPU or GPU load.

## What still needs measuring

On the Windows machine, with the packaged app and the settings applied:

1. `win-headed-*` with `--cover-test` for both engines, to confirm the desktop app matches `win-headed-occlusion-*`;
2. the session locked (Win+L) while an agent drives a profile, with and without the settings;
3. Camoufox with the display off;
4. the CPU of five covered profiles on an animated page, against the same profiles minimized.

Adopt if items 1-3 deliver input with the settings and the owner accepts item 4. Once the settings are on, the error message below lists causes that no longer apply to CloakBrowser (a covered window, the display, the lock) and can be shortened.

## The error message (changed)

`inputLostHint` in `packages/cdp-driver/src/CdpSession.ts`:

- **Hidden page.** The message used to say: "Bring its window to the front (cdp_send Page.bringToFront), then retry." That failed 5 of 5 times with the display off. It now lists the causes and offers `activate_tab` or `cdp_send Page.bringToFront`. Both end in `WebContentsImpl::Activate()` (`target_handler.cc:1228` through `render_frame_devtools_agent_host.cc:921`, and `page_handler.cc:1595`), and `cdp_send` is in the `raw` tool group that a server token may lack. It warns that raising takes the operator's focus, and says to retry only if `document.visibilityState` is then `"visible"`. Otherwise it explains that Windows can keep another app in the foreground or, with the display off or the session locked, reports every window as covered, and says to call `request_human` or wait.
- **Hidden when the input was sent, visible by the read.** This is new. The probe now records whether the page was hidden at any point after it was armed (`wasHidden`). Such a failure now says "Retry." instead of blaming something covering the target, which was the wrong advice in `2026-11-01-win-headed-desktop-cb`. The probe was checked in Chrome for Testing 153, headed under Xvfb, launched directly and driven over CDP. It read `wasHidden` false while visible throughout. It read true after the tab was backgrounded and brought back with `Page.bringToFront`, and true when armed while hidden and shown with `Target.activateTarget`. The page's main world never saw it.
- **Tests.** The test fakes recognised the probe's read by the string `visibilityState`, which the install script now contains too. Six fakes in `packages/cdp-driver` and `apps/server` now match `return JSON.stringify`, which only the read contains.
