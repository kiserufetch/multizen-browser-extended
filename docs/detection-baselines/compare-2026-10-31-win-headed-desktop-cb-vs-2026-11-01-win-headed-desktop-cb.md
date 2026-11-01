# win-headed-desktop-cb vs win-headed-desktop-cb

| | A | B |
| --- | --- | --- |
| label | "win-headed-desktop-cb" | "win-headed-desktop-cb" |
| date | "2026-10-31" | "2026-11-01" |
| engine | "cloakbrowser" | "cloakbrowser" |
| engineVersion | "146.0.7680.177.5" | "146.0.7680.177.5" |
| mode | "headed" | "headed" |
| displayMode | "headed" | "headed" |
| egress | "allow-all" | "allow-all" |
| seed | "mz-baseline-70" | "mz-baseline-70" |
| platform | "win32" | "win32" |
| persona | windows-desktop-nvidia | windows-desktop-nvidia |

## Thresholds

None fired: no `HeadlessChrome`, no `webdriver: true`, no `pointer: none`.

34 differences; left out: 29 by the noise rules, 23 that also differ between a setup and its own repeat.

## probe (9)

| path | A | B |
| --- | --- | --- |
| `probe.document.hasFocus` | true | false |
| `probe.document.hidden` | false | true |
| `probe.document.paints` | first-paint, first-contentful-paint |  |
| `probe.document.rafRunning` | true | false |
| `probe.document.visibility` | "visible" | "hidden" |
| `probe.window.outerHeight` | 1032 | 0 |
| `probe.window.outerWidth` | 1920 | 0 |
| `probe.window.screenX` | 10 | 1565 |
| `probe.window.screenY` | 35 | 71 |

## headers (0)

No differences.

## fonts (0)

No differences.

## input (25)

| path | A | B |
| --- | --- | --- |
| `input.click_ref.sequence` | only here (2 of 19): blur, focusout | only here (0 of 51):  |
| `input.click.click` | (absent) | null |
| `input.click.click.button` | 0 | (absent) |
| `input.click.click.buttons` | 0 | (absent) |
| `input.click.click.detail` | 1 | (absent) |
| `input.click.click.pointerType` | "mouse" | (absent) |
| `input.click.click.pressure` | 0 | (absent) |
| `input.click.error` | null | "Click on #btn was not delivered: Chromium accepted the click but the page received no pointer events. The page is visible. Take a screenshot to check whether something covers the target, then retry." |
| `input.click.mousedown` | (absent) | null |
| `input.click.mousedown.button` | 0 | (absent) |
| `input.click.mousedown.buttons` | 1 | (absent) |
| `input.click.mousedown.detail` | 1 | (absent) |
| `input.click.pointerdown` | (absent) | null |
| `input.click.pointerdown.button` | 0 | (absent) |
| `input.click.pointerdown.buttons` | 1 | (absent) |
| `input.click.pointerdown.height` | 1 | (absent) |
| `input.click.pointerdown.isPrimary` | true | (absent) |
| `input.click.pointerdown.pointerType` | "mouse" | (absent) |
| `input.click.pointerdown.pressure` | 0.5 | (absent) |
| `input.click.pointerdown.tangentialPressure` | 0 | (absent) |
| `input.click.pointerdown.tiltX` | 0 | (absent) |
| `input.click.pointerdown.tiltY` | 0 | (absent) |
| `input.click.pointerdown.twist` | 0 | (absent) |
| `input.click.pointerdown.width` | 1 | (absent) |
| `input.click.sequence` | only here (4 of 13): pointerdown, mousedown, focusin, click | only here (1 of 10): visibilitychange |

## tls (0)

No differences.

## h2 (0)

No differences.

## webrtc (0)

No differences.

## creepjs (0)

No differences.

## rebrowser (0)

No differences.

## covered (0)

No differences.
