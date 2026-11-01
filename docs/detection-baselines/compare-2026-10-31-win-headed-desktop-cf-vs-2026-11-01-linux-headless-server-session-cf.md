# win-headed-desktop-cf vs linux-headless-server-session-cf

| | A | B |
| --- | --- | --- |
| label | "win-headed-desktop-cf" | "linux-headless-server-session-cf" |
| date | "2026-10-31" | "2026-11-01" |
| engine | "camoufox" | "camoufox" |
| engineVersion | "152.0.4-beta.30" | "152.0.4-beta.30" |
| mode | "headed" | "headless" |
| displayMode | "headed" | "headless" |
| egress | "allow-all" | "block-private" |
| seed | "mz-baseline-70" | "mz-baseline-70" |
| platform | "win32" | "linux" |
| persona | windows-desktop-nvidia | windows-desktop-nvidia |

## Thresholds

None fired: no `HeadlessChrome`, no `webdriver: true`, no `pointer: none`.

76 differences; left out: 23 by the noise rules, 148 that also differ between a setup and its own repeat.

## probe (20)

| path | A | B |
| --- | --- | --- |
| `probe.audio.live.maxChannelCount` | 8 | 2 |
| `probe.devices` | audioinput, videoinput | audioinput |
| `probe.gpu` | "no adapter" | null |
| `probe.voices` | Microsoft Zira Desktop - English (United States)\|en-US\|true |  |
| `probe.webgl` | (absent) | null |
| `probe.webgl.extensionCount` | 27 | (absent) |
| `probe.webgl.extensionsHash` | -771883384 | (absent) |
| `probe.webgl.params.ALIASED_LINE_WIDTH_RANGE` | 1, 1 | (absent) |
| `probe.webgl.params.MAX_COMBINED_TEXTURE_IMAGE_UNITS` | 32 | (absent) |
| `probe.webgl.params.MAX_RENDERBUFFER_SIZE` | 16384 | (absent) |
| `probe.webgl.params.MAX_TEXTURE_SIZE` | 16384 | (absent) |
| `probe.webgl.params.MAX_VERTEX_ATTRIBS` | 16 | (absent) |
| `probe.webgl.params.MAX_VIEWPORT_DIMS` | 32767, 32767 | (absent) |
| `probe.webgl.shading` | "WebGL GLSL ES 1.0" | (absent) |
| `probe.webgl.unmaskedVendor` | "Google Inc. (Intel)" | (absent) |
| `probe.webgl.vendor` | "Mozilla" | (absent) |
| `probe.webgl.version` | "WebGL 1.0" | (absent) |
| `probe.webgl.webgl2` | true | (absent) |
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

## creepjs (28)

| path | A | B |
| --- | --- | --- |
| `creepjs.fonts.emojiSet` | only here (0 of 5):  | only here (18 of 23): 🤵‍♂️, ⚧, ⁉, 🏳️‍⚧️, 🧑‍🤝‍🧑, ⏱, ☂, ♟, 👩‍❤️‍💋‍👨, 👨‍👩‍👦, ⛓, ⚰, ♀, 〰, ⚜, ▪, ✌, ❄ |
| `creepjs.hashes.headless` | "e9d45bc0188a9305257fa7ef153b8f240f3422135b55e04bae5d7ee1f8f19723" | "77d71583e8c4ee9b3a4f4dc7ddb53b827bf6c22a36ab6d6b7dfcaec0ce187085" |
| `creepjs.hashes.maths` | "c7d8800b950174bb01bd38788b464387254ef282d5e1c038ac3acb655b792e50" | "1747db31bad6b2749bd71b3aba945993478a86a376bb75d7722dd9be755cf3df" |
| `creepjs.hashes.media` | "b395e83d4853a5d3a02d2ba81f6b761e830c8adbea21722ae21bab34990cb41a" | "5cee837b6a8c8ce55cd43c70b0cf2ddbe4ad3869a28bb791ea33f5b34d3d7aa8" |
| `creepjs.hashes.voices` | "bd24e3aadac54006e93fffb25a6f75c40d75820abcb454e35cdc79649415a289" | (absent) |
| `creepjs.hashes.windowFeatures` | "d86a004ea9471561bd0d5794bde0f7c5a468ad5aeec545e54dcef71289e0a01f" | "066db60486896ee3acf36a731ca28d056eb215ed8298e7b55c36c1f58be594f1" |
| `creepjs.headless.stealth.hasBadWebGL` | false | (absent) |
| `creepjs.voices` | (absent) | null |
| `creepjs.voices.$hash` | "bd24e3aadac54006e93fffb25a6f75c40d75820abcb454e35cdc79649415a289" | (absent) |
| `creepjs.voices.defaultVoiceLang` | "" | (absent) |
| `creepjs.voices.defaultVoiceName` | "" | (absent) |
| `creepjs.voices.languages` | en-US | (absent) |
| `creepjs.voices.lied` | false | (absent) |
| `creepjs.voices.local` | Microsoft Zira Desktop - English (United States) | (absent) |
| `creepjs.voices.remote` |  | (absent) |
| `creepjs.webgl.gpu` | (absent) | null |
| `creepjs.webgl.gpu.confidence` | "high" | (absent) |
| `creepjs.webgl.gpu.gibbers` | "" | (absent) |
| `creepjs.webgl.gpu.grade` | "A" | (absent) |
| `creepjs.webgl.gpu.parts` | "ANGLE, Direct3D, Graphics, Intel, Intel(R) HD Graphics" | (absent) |
| `creepjs.webgl.gpu.warnings` |  | (absent) |
| `creepjs.webgl.lied` | false | null |
| `creepjs.worker.gpu.confidence` | "high" | (absent) |
| `creepjs.worker.gpu.gibbers` | "" | (absent) |
| `creepjs.worker.gpu.grade` | "A" | (absent) |
| `creepjs.worker.gpu.parts` | "ANGLE, Direct3D, Graphics, Intel, Intel(R) HD Graphics" | (absent) |
| `creepjs.worker.gpu.warnings` |  | (absent) |
| `creepjs.worker.webglVendor` | "Google Inc. (Intel)" | (absent) |

## rebrowser (0)

No differences.

## covered (0)

No differences.
