# linux-headless-cb vs linux-headless-2-cb

| | A | B |
| --- | --- | --- |
| label | "linux-headless-cb" | "linux-headless-2-cb" |
| date | "2026-10-31" | "2026-10-31" |
| engine | "cloakbrowser" | "cloakbrowser" |
| engineVersion | "146.0.7680.177.5" | "146.0.7680.177.5" |
| mode | "headless" | "headless" |
| displayMode | "headless" | "headless" |
| egress | "allow-all" | "allow-all" |
| seed | "mz-baseline-70" | "mz-baseline-70" |
| platform | "linux" | "linux" |
| persona | windows-desktop-nvidia | windows-desktop-nvidia |

## Thresholds

None fired: no `HeadlessChrome`, no `webdriver: true`, no `pointer: none`.

2 differences; left out: 18 by the noise rules.

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

## creepjs (2)

| path | A | B |
| --- | --- | --- |
| `creepjs.audio.noise` | 979.6096726796231 | 1002.2113542320743 |
| `creepjs.hashes.offlineAudioContext` | "a635ac173848dd4ee4b39f7eda96e3e9a29e4cadfc4d416a0dac2d366c59efd8" | "f7e50f6d5c4075a8fdb2f72e7e70cf674e55e729d929f3f0356b8f07bc42b562" |

## rebrowser (0)

No differences.
