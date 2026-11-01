# Input dropped on a hidden page (2026-10-31)

**Status:** fixed in `CdpSession` (delivery check)  
**Reported in:** `docs/upstream-merge-v0.4.2.md`, "Defects found"  
**Affects:** MCP `click`, `type`, `click_ref`, `type_ref` (all share `CdpSession`'s input path)

## Summary

Chromium answers `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` with success even when the page never receives the event. That happens on a page that is hidden and has not painted since its document loaded. The tools passed that success on, so they returned `{ok: true}` for input that went nowhere. Each tool now checks that the page saw the input. If it did not, the call fails with `INPUT_NOT_DELIVERED` and a message saying why and what to do.

## What was measured

The harness drives the real `CdpSession` (the four input methods, unchanged callers) against page targets in different states, under Xvfb on Linux:

- CloakBrowser **146.0.7680.177** (the Linux build of the pinned release)
- Chrome for Testing **153.0.8010.12**, to see whether stock Chromium behaves the same

A capture-phase logger in the page records `pointerdown` / `mousedown` / `pointerup` / `mouseup` / `click` / `keydown` / `keyup` / `input`, as in the 0.10.0 verification. "Delivered" means the logger saw at least one of them.

| State of the page | Before the fix | After the fix |
| --- | --- | --- |
| Visible | 76/76 delivered, all `ok` | 40/40 delivered, all `ok` |
| Hidden, painted before it was hidden | 76/76 delivered, all `ok` | 40/40 delivered, all `ok` |
| Hidden since it loaded (background tab never shown) | **0/76 delivered, 76/76 `ok`** | 0/40 delivered, **40/40 throw** |
| Painted, hidden, then navigated while hidden (same-site) | **0/32 delivered, 32/32 `ok`** | 0/40 delivered, **40/40 throw** |
| Same, cross-site navigation | **0/32 delivered, 32/32 `ok`** | 0/40 delivered, **40/40 throw** |
| Hidden since it loaded, `Page.bringToFront` first | 76/76 delivered, all `ok` | 40/40 delivered, all `ok` |

Counts are tool calls over both engines (each run calls all four tools). The two engines gave the same result in every state, so this is Chromium behavior, not a CloakBrowser patch. A further run of the fixed code on CloakBrowser launched with the app's `--fingerprint-*` flags gave the same split: 36 dropped calls threw and 36 delivered calls returned `ok`.

Further findings:

- **Painting decides it, not visibility.** A hidden page that has painted keeps receiving input. This matches the 0.10.0 sample: 6 runs hidden, 3 of them lost input.
- **Navigating while hidden re-arms it.** The new document has not painted, so input is dropped again, same-site or cross-site.
- **Mouse moves still arrive.** The page gets `pointermove` / `mousemove` while presses and keys are dropped, so a move cannot count as proof of delivery.
- Turning off the `DropInputEventsBeforeFirstPaint` feature does not change the result (diagnosis only), so the drop comes from another part of Chromium's pre-paint input suppression. The exact switch was not identified.
- Mouse calls on any hidden page take about 5 s, before and after the fix. Chromium holds the mouse-move ack while the page produces no frames.

## Cause on Windows: hypothesis at the time

Confirmed later, see "Measured on Windows" below. There was no Windows machine for this work, so the original hypothesis was not measured directly. The Linux results are consistent with it. On Windows, Chromium tracks native window occlusion and reports a fully covered window's pages as hidden. A profile window that opens already covered would load its page hidden and never paint, so all input to it would be lost. A window that paints before it is covered would keep working. That fits the 3-of-6 split.

To confirm it, run the packaged app (isolated user data at a short path, for example `%TEMP%\mzlive`, with another `mcpHttpPort` in `settings.json`). Call `launch_profile`, then `evaluate_js` with `[document.visibilityState, performance.getEntriesByType("paint").length]` before any input. Then check whether the profile's window is minimized. With a single tab in a window that is not minimized, `"hidden"` can only come from occlusion, so `["hidden", 0]` means the window opened covered.

## Measured on Windows (2026-10-31, server work)

The cause is confirmed: it is Chromium's native window occlusion tracking, with no MultiZen code in the path. Windows 11, CloakBrowser 146.0.7680.177.5, the bare binary driven over CDP with a temp profile, a `data:` page, sampled at 0.5, 2 and 4 s. The console user had been idle for 69 minutes with a 15-minute display timeout, so the display was presumably off. That was not checked directly.

| Launch | `[visibilityState, paint entries, hasFocus]` |
| --- | --- |
| Plain | `["hidden",0,true]` at all three samples |
| `--disable-features=CalculateNativeWinOcclusion` | `["visible",2,true]` at all three samples |

The full MultiZen launch through `multizen-server` behaves the same. The window was a real one, not minimized: `IsWindowVisible` true, `IsIconic` false, normal rect. In that state:

- `click_ref` failed with `INPUT_NOT_DELIVERED`, as designed.
- `Page.bringToFront` returned success and did not help on 5 of 5 retries. The foreground window stayed the user's other app, and `hasFocus` flipped to true while the page stayed hidden.
- Raising the window with `SetWindowPos(HWND_TOPMOST, SWP_NOACTIVATE)` did not help either, for at least 2.5 s.
- `SetThreadExecutionState(ES_DISPLAY_REQUIRED)`, held for the whole run, did not help.

So the advice in the error message does not always work: with the display off (or the screen locked, which was not tested), nothing a client can do makes this page paint. `multizen-server` therefore launches with that one feature disabled, on Windows only (`serverDisabledFeatures` in `apps/server/src/runtime.ts`), since nobody is watching its windows. With it, the first `click_ref` on a freshly loaded page delivers. The desktop's launch flags are unchanged, and a desktop profile opened behind other windows or with the display off still reports `INPUT_NOT_DELIVERED`.

Not measured: whether a page can tell the difference (detection baselines should compare it).

### Camoufox (2026-10-31, Camoufox 152.0.4-beta.30, headed, Windows 11)

Camoufox goes through Playwright, so this probe doesn't apply, but it has the same kind of problem with a different symptom. The window was opened by a background process on a desktop in use. The page read `visible` with `hasFocus` true, and yet:

- A Playwright click hung at "performing click action", and no pointer event reached the page.
- Later clicks hung earlier, at "waiting for element to be visible, enabled and stable". `page.bringToFront()` didn't help.
- With `widget.windows.window_occlusion_tracking.enabled` set to false, the same click took about 100 ms and the page saw `pointerdown`, `mouseup` and `click`.

The window's position was not inspected: that the pref fixes it is what points at occlusion. `multizen-server` sets it, on Windows only (`serverFirefoxPrefs` in `apps/server/src/runtime.ts`). The desktop doesn't, so there the tools end in `TIMEOUT` until the window is raised, and the error's hint says so. Whether a page can tell the difference was not measured for this pref either.

### Headless (2026-10-31, CloakBrowser 146.0.7680.177.5 and Camoufox 152.0.4-beta.30, Windows 11)

The problem does not exist in headless. With no window there is nothing to occlude.

- CloakBrowser in `--headless=new`: `visibilityState` read `visible` at every sample, right after load, on the first tab and on a new tab, also on the desktop, which doesn't disable `CalculateNativeWinOcclusion`, in a run where the app's own window on the same machine was painting nothing. No `INPUT_NOT_DELIVERED` in the whole flow suite: 94 checks with real input in the main frame, a same-process iframe, an OOPIF and one nested in that.
- Paint entries come slightly later than `load`, in headless as in headed: none right after `navigate` returned and at 100 ms, `first-paint` and `first-contentful-paint` at 1 s. Input sent with no paint entry yet was delivered. So zero paint entries alone doesn't mean a dropped page: it is `hidden` plus zero that does.
- `document.hasFocus()` varied on the first tab, false in some runs, and read true on a tab `new_tab` had just activated. Headed varied the same way. It is not specific to the mode.
- Camoufox with `headless: true`: `visible`, `first-contentful-paint` already there right after load, focus true, 71 checks with no click hanging.

## Options weighed

| Option | Evidence | Verdict |
| --- | --- | --- |
| Bring the target to front before input | Delivered 76/76 on never-painted pages. Also the 52/52 Windows run | Not chosen as the fix. It brings the window to the front on every call, which takes focus away from the operator's other windows and tabs while agents drive profiles in the background. It also checks nothing: if Windows keeps the window behind, or the page navigates again while hidden, the call still reports `ok`. Doing it once at launch is not enough either, because navigating while hidden re-arms the drop |
| Detect a hidden page and return an error | Hidden pages that had painted delivered 76/76 here, and 3 of 6 in the Windows sample | Not chosen. Failing on `hidden` breaks calls that work. "Hidden and no paint entry" matched every sample, but it is a proxy: a blank page records no paint entry even when visible, and it misses any other cause of a drop |
| Verify delivery | After the fix: 120/120 dropped calls throw, 120/120 delivered calls return `ok` | **Chosen.** It measures the property the tools promise, whatever the cause |

## The fix

`packages/cdp-driver/src/CdpSession.ts`:

- Before dispatching, the input methods arm a probe in an isolated world (`Page.createIsolatedWorld` on the main frame, world `mz_input_probe`). It listens on `window` in the capture phase and counts trusted presses, releases and keydowns. Page script cannot see the isolated world's globals or listeners, and the page's main world is never touched. No launch flag was added.
- A ref action inside an iframe arms the probe in that frame's isolated world, on that frame's session: the main frame's window sees nothing of what goes to a child frame, same-process or cross-origin (server mode work). `press_key` with no target arms one in every frame, since the key goes wherever focus is. `hover` and `scroll` are not checked: mouse moves arrive even on a page dropping presses, and wheel events are not counted.
- A click must produce both a press and a release. Typing must produce one keydown per character (Shift is not counted).
- If the probe's context is gone, the input replaced the document (a link or a submitting Enter), so it counts as delivered.
- If the input did not arrive, the method throws `InputNotDeliveredError`. When the page is hidden, the message names that and says to bring the window to the front with `cdp_send Page.bringToFront` and retry.
- `typeRef` checks its focusing click before typing, so a lost click never sends the text to whatever element had focus.

`packages/mcp-server/src/server.ts` reports the error as code `INPUT_NOT_DELIVERED`, and the four tool descriptions mention it.

Edge cases on a visible page, 21 per engine, all `ok` with the expected result: link click via `click_ref` and `click` (navigates), `type_ref` with `"hi\n"` (Enter submits the form), `preventDefault` on `pointerdown`, an element that removes itself on `mousedown`, shifted text, and an empty string.

Cost: one probe adds a few local CDP round trips. Median call times on visible pages stayed within about 20 ms of the unpatched code (small samples). A lost input waits up to 300 ms before the call fails.

## Not verified

- The packaged Windows app was not run. `Page.createIsolatedWorld` worked on the CloakBrowser 146 Linux build, and on the Windows build through `multizen-server`.
- Camoufox profiles use `FirefoxBrowserDriver` (Playwright), not this path. The desktop's behaviour on a raised window was not run live: the live runs went through `multizen-server`.
