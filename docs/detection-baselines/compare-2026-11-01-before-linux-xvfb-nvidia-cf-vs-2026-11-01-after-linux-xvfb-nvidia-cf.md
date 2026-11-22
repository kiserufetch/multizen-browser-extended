# before-linux-xvfb-nvidia-cf vs after-linux-xvfb-nvidia-cf

| | A | B |
| --- | --- | --- |
| label | "before-linux-xvfb-nvidia-cf" | "after-linux-xvfb-nvidia-cf" |
| date | "2026-11-01" | "2026-11-01" |
| engine | "camoufox" | "camoufox" |
| engineVersion | "152.0.4-beta.30" | "152.0.4-beta.30" |
| mode | "xvfb" | "xvfb" |
| displayMode | "xvfb" | "xvfb" |
| egress | "allow-all" | "allow-all" |
| seed | "mz-baseline-70" | "mz-baseline-70" |
| platform | "linux" | "linux" |
| persona | linux-desktop-nvidia | linux-desktop-nvidia |

## Thresholds

None fired: no `HeadlessChrome`, no `webdriver: true`, no `pointer: none`.

9 differences; left out: 15 by the noise rules, 118 that also differ between a setup and its own repeat.

## probe (3)

| path | A | B |
| --- | --- | --- |
| `probe.window.innerHeight` | 720 | 965 |
| `probe.window.innerWidth` | 1280 | 1920 |
| `probe.window.visualViewport` | 1280, 720, 1 | 1920, 965, 1 |

## headers (0)

No differences.

## fonts (0)

No differences.

## input (0)

No differences.

## tls (0)

No differences.

## h2 (0)

No differences.

## webrtc (0)

No differences.

## creepjs (0)

No differences.

## rebrowser (6)

| path | A | B |
| --- | --- | --- |
| `rebrowser.afterAgentCalls.green` | only here (0 of 10):  | only here (1 of 11): viewport |
| `rebrowser.afterAgentCalls.notes.viewport` | "Viewport has default Playwright values. Use viewport: null in options." | (absent) |
| `rebrowser.afterAgentCalls.yellow` | popupBlocking, viewport | popupBlocking |
| `rebrowser.passive.green` | only here (0 of 10):  | only here (1 of 11): viewport |
| `rebrowser.passive.notes.viewport` | "Viewport has default Playwright values. Use viewport: null in options." | (absent) |
| `rebrowser.passive.yellow` | popupBlocking, viewport | popupBlocking |
