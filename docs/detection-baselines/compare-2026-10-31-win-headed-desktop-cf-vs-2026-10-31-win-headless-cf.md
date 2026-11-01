# win-headed-desktop-cf vs win-headless-cf

| | A | B |
| --- | --- | --- |
| label | "win-headed-desktop-cf" | "win-headless-cf" |
| date | "2026-10-31" | "2026-10-31" |
| engine | "camoufox" | "camoufox" |
| engineVersion | "152.0.4-beta.30" | "152.0.4-beta.30" |
| mode | "headed" | "headless" |
| displayMode | "headed" | "headless" |
| egress | "allow-all" | "allow-all" |
| seed | "mz-baseline-70" | "mz-baseline-70" |
| platform | "win32" | "win32" |
| persona | windows-desktop-nvidia | windows-desktop-nvidia |

## Thresholds

None fired: no `HeadlessChrome`, no `webdriver: true`, no `pointer: none`.

1 differences; left out: 23 by the noise rules, 154 that also differ between a setup and its own repeat.

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
| `creepjs.audio.totalUniqueSamples` | 4736 | 4735 |

## rebrowser (0)

No differences.

## covered (0)

No differences.
