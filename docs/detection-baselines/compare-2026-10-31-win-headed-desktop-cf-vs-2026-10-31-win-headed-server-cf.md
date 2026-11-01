# win-headed-desktop-cf vs win-headed-server-cf

| | A | B |
| --- | --- | --- |
| label | "win-headed-desktop-cf" | "win-headed-server-cf" |
| date | "2026-10-31" | "2026-10-31" |
| engine | "camoufox" | "camoufox" |
| engineVersion | "152.0.4-beta.30" | "152.0.4-beta.30" |
| mode | "headed" | "headed" |
| displayMode | "headed" | "headed" |
| egress | "allow-all" | "block-private" |
| seed | "mz-baseline-70" | "mz-baseline-70" |
| platform | "win32" | "win32" |
| persona | windows-desktop-nvidia | windows-desktop-nvidia |

## Thresholds

None fired: no `HeadlessChrome`, no `webdriver: true`, no `pointer: none`.

27 differences; left out: 20 by the noise rules, 136 that also differ between a setup and its own repeat.

## probe (3)

| path | A | B |
| --- | --- | --- |
| `probe.window.historyLength` | 3 | 1 |
| `probe.windowProps.count` | 1003 | 981 |
| `probe.windowProps.hash` | -636466067 | 1920123233 |

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
| `creepjs.hashes.windowFeatures` | "d86a004ea9471561bd0d5794bde0f7c5a468ad5aeec545e54dcef71289e0a01f" | "567abddb5c524383447e4e35df2b0a0b8dbe6f2daea6d043bb17d2ded575df54" |

## rebrowser (0)

No differences.

## covered (0)

No differences.
