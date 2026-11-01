# win-headed-desktop-cb vs win-headed-server-cb

| | A | B |
| --- | --- | --- |
| label | "win-headed-desktop-cb" | "win-headed-server-cb" |
| date | "2026-10-31" | "2026-10-31" |
| engine | "cloakbrowser" | "cloakbrowser" |
| engineVersion | "146.0.7680.177.5" | "146.0.7680.177.5" |
| mode | "headed" | "headed" |
| displayMode | "headed" | "headed" |
| egress | "allow-all" | "block-private" |
| seed | "mz-baseline-70" | "mz-baseline-70" |
| platform | "win32" | "win32" |
| persona | windows-desktop-nvidia | windows-desktop-nvidia |

## Thresholds

None fired: no `HeadlessChrome`, no `webdriver: true`, no `pointer: none`.

1 differences; left out: 25 by the noise rules, 23 that also differ between a setup and its own repeat.

## probe (1)

| path | A | B |
| --- | --- | --- |
| `probe.connection.rtt` | 100 | 0 |

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

## rebrowser (0)

No differences.

## covered (0)

No differences.
