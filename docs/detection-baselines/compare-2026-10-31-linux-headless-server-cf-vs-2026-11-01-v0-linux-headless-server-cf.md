# linux-headless-server-cf vs v0-linux-headless-server-cf

| | A | B |
| --- | --- | --- |
| label | "linux-headless-server-cf" | "v0-linux-headless-server-cf" |
| date | "2026-10-31" | "2026-11-01" |
| engine | "camoufox" | "camoufox" |
| engineVersion | "152.0.4-beta.30" | "152.0.4-beta.30" |
| mode | "headless" | "headless" |
| displayMode | "headless" | "headless" |
| egress | "block-private" | "block-private" |
| seed | "mz-baseline-70" | "mz-baseline-70" |
| platform | "linux" | "linux" |
| persona | windows-desktop-nvidia | windows-desktop-nvidia |

## Thresholds

None fired: no `HeadlessChrome`, no `webdriver: true`, no `pointer: none`.

1 differences; left out: 14 by the noise rules, 94 that also differ between a setup and its own repeat.

## probe (0)

No differences.

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

## creepjs (1)

| path | A | B |
| --- | --- | --- |
| `creepjs.audio.totalUniqueSamples` | 4735 | 4734 |

## rebrowser (0)

No differences.
