# win-headed-desktop-cf vs linux-xvfb-server-session-cf

| | A | B |
| --- | --- | --- |
| label | "win-headed-desktop-cf" | "linux-xvfb-server-session-cf" |
| date | "2026-10-31" | "2026-11-01" |
| engine | "camoufox" | "camoufox" |
| engineVersion | "152.0.4-beta.30" | "152.0.4-beta.30" |
| mode | "headed" | "xvfb" |
| displayMode | "headed" | "xvfb" |
| egress | "allow-all" | "block-private" |
| seed | "mz-baseline-70" | "mz-baseline-70" |
| platform | "win32" | "linux" |
| persona | windows-desktop-nvidia | windows-desktop-nvidia |

## Thresholds

None fired: no `HeadlessChrome`, no `webdriver: true`, no `pointer: none`.

52 differences; left out: 23 by the noise rules, 136 that also differ between a setup and its own repeat.

## probe (7)

| path | A | B |
| --- | --- | --- |
| `probe.audio.live.maxChannelCount` | 8 | 2 |
| `probe.devices` | audioinput, videoinput | audioinput |
| `probe.gpu` | "no adapter" | null |
| `probe.voices` | Microsoft Zira Desktop - English (United States)\|en-US\|true |  |
| `probe.webgl.unmaskedVendor` | "Google Inc. (Intel)" | "Google Inc. (AMD)" |
| `probe.windowProps.count` | 1003 | 937 |
| `probe.windowProps.hash` | -636466067 | -278472104 |

## headers (0)

No differences.

## fonts (4)

| path | A | B |
| --- | --- | --- |
| `fonts.counts.mac` | 1 | 0 |
| `fonts.counts.windows` | 56 | 57 |
| `fonts.present.mac` | Helvetica |  |
| `fonts.present.windows` | only here (1 of 56): Arial | only here (2 of 57): Franklin Gothic Medium, HoloLens MDL2 Assets |

## input (1)

| path | A | B |
| --- | --- | --- |
| `input.click.sequence` | only here (0 of 15):  | only here (2 of 23): mouseout, mouseleave |

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

## creepjs (16)

| path | A | B |
| --- | --- | --- |
| `creepjs.fonts.emojiSet` | only here (0 of 5):  | only here (18 of 23): 🤵‍♂️, ⚧, ⁉, 🏳️‍⚧️, 🧑‍🤝‍🧑, ⏱, ☂, ♟, 👩‍❤️‍💋‍👨, 👨‍👩‍👦, ⛓, ⚰, ♀, 〰, ⚜, ▪, ✌, ❄ |
| `creepjs.hashes.maths` | "c7d8800b950174bb01bd38788b464387254ef282d5e1c038ac3acb655b792e50" | "1747db31bad6b2749bd71b3aba945993478a86a376bb75d7722dd9be755cf3df" |
| `creepjs.hashes.media` | "b395e83d4853a5d3a02d2ba81f6b761e830c8adbea21722ae21bab34990cb41a" | "5cee837b6a8c8ce55cd43c70b0cf2ddbe4ad3869a28bb791ea33f5b34d3d7aa8" |
| `creepjs.hashes.voices` | "bd24e3aadac54006e93fffb25a6f75c40d75820abcb454e35cdc79649415a289" | (absent) |
| `creepjs.hashes.windowFeatures` | "d86a004ea9471561bd0d5794bde0f7c5a468ad5aeec545e54dcef71289e0a01f" | "066db60486896ee3acf36a731ca28d056eb215ed8298e7b55c36c1f58be594f1" |
| `creepjs.voices` | (absent) | null |
| `creepjs.voices.$hash` | "bd24e3aadac54006e93fffb25a6f75c40d75820abcb454e35cdc79649415a289" | (absent) |
| `creepjs.voices.defaultVoiceLang` | "" | (absent) |
| `creepjs.voices.defaultVoiceName` | "" | (absent) |
| `creepjs.voices.languages` | en-US | (absent) |
| `creepjs.voices.lied` | false | (absent) |
| `creepjs.voices.local` | Microsoft Zira Desktop - English (United States) | (absent) |
| `creepjs.voices.remote` |  | (absent) |
| `creepjs.webgl.gpu.parts` | "ANGLE, Direct3D, Graphics, Intel, Intel(R) HD Graphics" | "AMD, ANGLE, Direct3D, Graphics, Radeon" |
| `creepjs.worker.gpu.parts` | "ANGLE, Direct3D, Graphics, Intel, Intel(R) HD Graphics" | "AMD, ANGLE, Direct3D, Graphics, Radeon" |
| `creepjs.worker.webglVendor` | "Google Inc. (Intel)" | "Google Inc. (AMD)" |

## rebrowser (0)

No differences.

## covered (0)

No differences.
