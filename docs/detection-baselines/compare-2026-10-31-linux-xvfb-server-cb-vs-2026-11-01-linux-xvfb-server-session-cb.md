# linux-xvfb-server-cb vs linux-xvfb-server-session-cb

| | A | B |
| --- | --- | --- |
| label | "linux-xvfb-server-cb" | "linux-xvfb-server-session-cb" |
| date | "2026-10-31" | "2026-11-01" |
| engine | "cloakbrowser" | "cloakbrowser" |
| engineVersion | "146.0.7680.177.5" | "146.0.7680.177.5" |
| mode | "xvfb" | "xvfb" |
| displayMode | "xvfb" | "xvfb" |
| egress | "block-private" | "block-private" |
| seed | "mz-baseline-70" | "mz-baseline-70" |
| platform | "linux" | "linux" |
| persona | windows-desktop-nvidia | windows-desktop-nvidia |

## Thresholds

None fired: no `HeadlessChrome`, no `webdriver: true`, no `pointer: none`.

6 differences; left out: 19 by the noise rules, 2 that also differ between a setup and its own repeat.

## probe (2)

| path | A | B |
| --- | --- | --- |
| `probe.audio.live.baseLatency` | 0.0091875 | 0.010666666666666666 |
| `probe.devices` | audiooutput, audiooutput, audioinput, videoinput | audioinput, audiooutput |

## headers (0)

No differences.

## fonts (4)

| path | A | B |
| --- | --- | --- |
| `fonts.counts.windows` | 3 | 5 |
| `fonts.present.windows` | Arial, Courier New, Times New Roman | Arial, Calibri, Cambria, Courier New, Times New Roman |
| `fonts.widths.Calibri` | 884.8487912324292 | 837.3174802647211 |
| `fonts.widths.Cambria` | 884.8487912324292 | 839.2334373121346 |

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

## rebrowser (0)

No differences.
