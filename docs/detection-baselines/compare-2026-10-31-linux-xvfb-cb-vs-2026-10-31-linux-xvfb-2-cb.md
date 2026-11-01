# linux-xvfb-cb vs linux-xvfb-2-cb

| | A | B |
| --- | --- | --- |
| label | "linux-xvfb-cb" | "linux-xvfb-2-cb" |
| date | "2026-10-31" | "2026-10-31" |
| engine | "cloakbrowser" | "cloakbrowser" |
| engineVersion | "146.0.7680.177.5" | "146.0.7680.177.5" |
| mode | "xvfb" | "xvfb" |
| displayMode | "xvfb" | "xvfb" |
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
| `creepjs.audio.noise` | 1006.7563259421933 | 1004.67726318708 |
| `creepjs.hashes.offlineAudioContext` | "3c311d6994bd9af0cdb1cc281429aec07bedda63b89eeac6ecf314b906d5a54c" | "68e15d19e8b9b8cf315d63fe31e6a88fe13c0442ce69aa7c4e2cefebda73c7e7" |

## rebrowser (0)

No differences.
