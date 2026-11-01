# linux-headless-cf vs linux-headless-server-cf

| | A | B |
| --- | --- | --- |
| label | "linux-headless-cf" | "linux-headless-server-cf" |
| date | "2026-10-31" | "2026-10-31" |
| engine | "camoufox" | "camoufox" |
| engineVersion | "152.0.4-beta.30" | "152.0.4-beta.30" |
| mode | "headless" | "headless" |
| displayMode | "headless" | "headless" |
| egress | "allow-all" | "block-private" |
| seed | "mz-baseline-70" | "mz-baseline-70" |
| platform | "linux" | "linux" |
| persona | windows-desktop-nvidia | windows-desktop-nvidia |

## Thresholds

None fired: no `HeadlessChrome`, no `webdriver: true`, no `pointer: none`.

27 differences; left out: 16 by the noise rules, 121 that also differ between a setup and its own repeat.

## probe (2)

| path | A | B |
| --- | --- | --- |
| `probe.windowProps.count` | 959 | 937 |
| `probe.windowProps.hash` | -1408371116 | -278472104 |

## headers (0)

No differences.

## fonts (0)

No differences.

## input (0)

No differences.

## tls (0)

No differences.

## h2 (1)

| path | A | B |
| --- | --- | --- |
| `h2.frameOrder` | only here (1 of 8): GOAWAY | only here (0 of 7):  |

## webrtc (23)

| path | A | B |
| --- | --- | --- |
| `webrtc.blocked` | (absent) | true |
| `webrtc.candidates[0].kind` | "mdns" | (absent) |
| `webrtc.candidates[0].protocol` | "udp" | (absent) |
| `webrtc.candidates[0].sameAsStun` | false | (absent) |
| `webrtc.candidates[0].type` | "host" | (absent) |
| `webrtc.candidates[1].kind` | "mdns" | (absent) |
| `webrtc.candidates[1].protocol` | "tcp" | (absent) |
| `webrtc.candidates[1].sameAsStun` | false | (absent) |
| `webrtc.candidates[1].type` | "host" | (absent) |
| `webrtc.candidates[2].kind` | "ipv4" | (absent) |
| `webrtc.candidates[2].protocol` | "udp" | (absent) |
| `webrtc.candidates[2].sameAsStun` | true | (absent) |
| `webrtc.candidates[2].type` | "srflx" | (absent) |
| `webrtc.candidates[3].kind` | "none" | (absent) |
| `webrtc.candidates[3].protocol` | null | (absent) |
| `webrtc.candidates[3].sameAsStun` | false | (absent) |
| `webrtc.candidates[3].type` | null | (absent) |
| `webrtc.gatheringState` | "complete" | (absent) |
| `webrtc.host` | 2 | (absent) |
| `webrtc.ipLiteralHost` | 0 | (absent) |
| `webrtc.sdpHasCandidateLines` | true | (absent) |
| `webrtc.srflx` | 1 | (absent) |
| `webrtc.stunRequestsSeen` | 1 | 0 |

## creepjs (1)

| path | A | B |
| --- | --- | --- |
| `creepjs.hashes.windowFeatures` | "ad3473d1ad93688202aed8076bb3726462083ae5798e721cabd6f56bf3392911" | "066db60486896ee3acf36a731ca28d056eb215ed8298e7b55c36c1f58be594f1" |

## rebrowser (0)

No differences.
