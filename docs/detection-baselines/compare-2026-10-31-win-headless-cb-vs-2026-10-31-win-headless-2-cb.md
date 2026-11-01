# win-headless-cb vs win-headless-2-cb

| | A | B |
| --- | --- | --- |
| label | "win-headless-cb" | "win-headless-2-cb" |
| date | "2026-10-31" | "2026-10-31" |
| engine | "cloakbrowser" | "cloakbrowser" |
| engineVersion | "146.0.7680.177.5" | "146.0.7680.177.5" |
| mode | "headless" | "headless" |
| displayMode | "headless" | "headless" |
| egress | "allow-all" | "allow-all" |
| seed | "mz-baseline-70" | "mz-baseline-70" |
| platform | "win32" | "win32" |
| persona | windows-desktop-nvidia | windows-desktop-nvidia |

## Thresholds

None fired: no `HeadlessChrome`, no `webdriver: true`, no `pointer: none`.

2 differences; left out: 19 by the noise rules.

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
| `creepjs.audio.noise` | 990.9966266935847 | 1007.6483474296446 |
| `creepjs.hashes.offlineAudioContext` | "c4197d66bec0868adc6125aa7b8d788f0abc722e2dbe5cf8ea4bb6100cd8bdfb" | "54a1bd75dafa73858c5055cb56e4157f765a31d9cc527fa4567e922efbc01079" |

## rebrowser (0)

No differences.
