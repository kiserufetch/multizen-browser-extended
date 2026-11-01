# linux-headless-netlog-direct-cb vs linux-headless-netlog-bridged-cb

| | A | B |
| --- | --- | --- |
| label | "linux-headless-netlog-direct-cb" | "linux-headless-netlog-bridged-cb" |
| date | "2026-10-31" | "2026-10-31" |
| engine | "cloakbrowser" | "cloakbrowser" |
| engineVersion | "146.0.7680.177.5" | "146.0.7680.177.5" |
| mode | "headless" | "headless" |
| displayMode | "headless" | "headless" |
| egress | "allow-all" | "block-private" |
| seed | "mz-baseline-70" | "mz-baseline-70" |
| platform | "linux" | "linux" |
| persona | windows-desktop-nvidia | windows-desktop-nvidia |

## Thresholds

None fired: no `HeadlessChrome`, no `webdriver: true`, no `pointer: none`.

13 differences; left out: 19 by the noise rules.

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

## netlog (10)

| path | A | B |
| --- | --- | --- |
| `netlog.events.DNS_TRANSACTION` | 9 | 0 |
| `netlog.events.HOST_RESOLVER_DNS_TASK` | 2 | 0 |
| `netlog.events.HOST_RESOLVER_MANAGER_JOB` | 2 | 0 |
| `netlog.events.HOST_RESOLVER_MANAGER_REQUEST` | 90 | 76 |
| `netlog.events.HOST_RESOLVER_SYSTEM_TASK` | 2 | 0 |
| `netlog.events.QUIC_SESSION_POOL_JOB` | 8 | 0 |
| `netlog.events.SOCKS5_CONNECT` | 0 | 9 |
| `netlog.namesAsked` | http://localhost, https://localhost, https://mz-name-probe.multizen-baseline.invalid | 127.0.0.1, http://localhost, https://localhost, https://mz-name-probe.multizen-baseline.invalid |
| `netlog.resolvedByTheBrowser.https://mz-name-probe.multizen-baseline.invalid.queryTypes` | A, AAAA, HTTPS | (absent) |
| `netlog.resolvedByTheBrowser.https://mz-name-probe.multizen-baseline.invalid.secureDns` | "off" | (absent) |

## creepjs (2)

| path | A | B |
| --- | --- | --- |
| `creepjs.audio.noise` | 998.4834474043145 | 991.9237028313486 |
| `creepjs.hashes.offlineAudioContext` | "d7d9d78e9bf1cd417bd78ba30526648aec158a77ee2f4cc7e2d9d507a894af33" | "8b54b38436ee15d17e561812d4b92741c0f324bcbf5d1bec618ef32dc967b61d" |

## rebrowser (0)

No differences.
