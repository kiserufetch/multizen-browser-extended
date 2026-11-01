# win-headless-netlog-direct-cb vs win-headless-netlog-bridged-cb

| | A | B |
| --- | --- | --- |
| label | "win-headless-netlog-direct-cb" | "win-headless-netlog-bridged-cb" |
| date | "2026-10-31" | "2026-10-31" |
| engine | "cloakbrowser" | "cloakbrowser" |
| engineVersion | "146.0.7680.177.5" | "146.0.7680.177.5" |
| mode | "headless" | "headless" |
| displayMode | "headless" | "headless" |
| egress | "allow-all" | "block-private" |
| seed | "mz-baseline-70" | "mz-baseline-70" |
| platform | "win32" | "win32" |
| persona | windows-desktop-nvidia | windows-desktop-nvidia |

## Thresholds

None fired: no `HeadlessChrome`, no `webdriver: true`, no `pointer: none`.

11 differences; left out: 20 by the noise rules.

## probe (1)

| path | A | B |
| --- | --- | --- |
| `probe.connection.rtt` | 150 | 0 |

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

## netlog (8)

| path | A | B |
| --- | --- | --- |
| `netlog.events.HOST_RESOLVER_MANAGER_JOB` | 2 | 0 |
| `netlog.events.HOST_RESOLVER_MANAGER_REQUEST` | 90 | 76 |
| `netlog.events.HOST_RESOLVER_SYSTEM_TASK` | 2 | 0 |
| `netlog.events.QUIC_SESSION_POOL_JOB` | 8 | 0 |
| `netlog.events.SOCKS5_CONNECT` | 0 | 11 |
| `netlog.namesAsked` | http://localhost, https://localhost, https://mz-name-probe.multizen-baseline.invalid | 127.0.0.1, http://localhost, https://localhost, https://mz-name-probe.multizen-baseline.invalid |
| `netlog.resolvedByTheBrowser.https://mz-name-probe.multizen-baseline.invalid.queryTypes` | A, AAAA, HTTPS | (absent) |
| `netlog.resolvedByTheBrowser.https://mz-name-probe.multizen-baseline.invalid.secureDns` | "off" | (absent) |

## creepjs (2)

| path | A | B |
| --- | --- | --- |
| `creepjs.audio.noise` | 986.7826917833241 | 986.5495611098262 |
| `creepjs.hashes.offlineAudioContext` | "0a4d9c347131a4404d737aeb13bfcea7a4f955fdd6f082f51e74e913db86ea3a" | "21d8e85145304f9bf158838f226faf21e5201794cc140d0e4e970d0b16194e6f" |

## rebrowser (0)

No differences.
