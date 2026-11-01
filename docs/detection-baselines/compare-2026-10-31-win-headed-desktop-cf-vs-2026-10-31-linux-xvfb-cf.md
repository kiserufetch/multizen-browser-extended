# win-headed-desktop-cf vs linux-xvfb-cf

| | A | B |
| --- | --- | --- |
| label | "win-headed-desktop-cf" | "linux-xvfb-cf" |
| date | "2026-10-31" | "2026-10-31" |
| engine | "camoufox" | "camoufox" |
| engineVersion | "152.0.4-beta.30" | "152.0.4-beta.30" |
| mode | "headed" | "xvfb" |
| displayMode | "headed" | "xvfb" |
| egress | "allow-all" | "allow-all" |
| seed | "mz-baseline-70" | "mz-baseline-70" |
| platform | "win32" | "linux" |
| persona | windows-desktop-nvidia | windows-desktop-nvidia |

## Thresholds

None fired: no `HeadlessChrome`, no `webdriver: true`, no `pointer: none`.

28 differences; left out: 24 by the noise rules, 142 that also differ between a setup and its own repeat.

## probe (8)

| path | A | B |
| --- | --- | --- |
| `probe.audio.live.maxChannelCount` | 8 | 0 |
| `probe.audio.live.sampleRate` | 48000 | 44100 |
| `probe.devices` | audioinput, videoinput |  |
| `probe.gpu` | "no adapter" | null |
| `probe.voices` | Microsoft Zira Desktop - English (United States)\|en-US\|true |  |
| `probe.webgl.unmaskedVendor` | "Google Inc. (Intel)" | "Google Inc. (NVIDIA)" |
| `probe.windowProps.count` | 1003 | 959 |
| `probe.windowProps.hash` | -636466067 | -1408371116 |

## headers (0)

No differences.

## fonts (2)

| path | A | B |
| --- | --- | --- |
| `fonts.counts.mac` | 1 | 0 |
| `fonts.present.mac` | Helvetica |  |

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

## webrtc (0)

No differences.

## creepjs (16)

| path | A | B |
| --- | --- | --- |
| `creepjs.fonts.emojiSet` | only here (0 of 5):  | only here (18 of 23): 🤵‍♂️, ⚧, ⁉, 🏳️‍⚧️, 🧑‍🤝‍🧑, ⏱, ☂, ♟, 👩‍❤️‍💋‍👨, 👨‍👩‍👦, ⛓, ⚰, ♀, 〰, ⚜, ▪, ✌, ❄ |
| `creepjs.hashes.maths` | "c7d8800b950174bb01bd38788b464387254ef282d5e1c038ac3acb655b792e50" | "1747db31bad6b2749bd71b3aba945993478a86a376bb75d7722dd9be755cf3df" |
| `creepjs.hashes.media` | "b395e83d4853a5d3a02d2ba81f6b761e830c8adbea21722ae21bab34990cb41a" | "5cee837b6a8c8ce55cd43c70b0cf2ddbe4ad3869a28bb791ea33f5b34d3d7aa8" |
| `creepjs.hashes.voices` | "bd24e3aadac54006e93fffb25a6f75c40d75820abcb454e35cdc79649415a289" | (absent) |
| `creepjs.hashes.windowFeatures` | "d86a004ea9471561bd0d5794bde0f7c5a468ad5aeec545e54dcef71289e0a01f" | "ad3473d1ad93688202aed8076bb3726462083ae5798e721cabd6f56bf3392911" |
| `creepjs.voices` | (absent) | null |
| `creepjs.voices.$hash` | "bd24e3aadac54006e93fffb25a6f75c40d75820abcb454e35cdc79649415a289" | (absent) |
| `creepjs.voices.defaultVoiceLang` | "" | (absent) |
| `creepjs.voices.defaultVoiceName` | "" | (absent) |
| `creepjs.voices.languages` | en-US | (absent) |
| `creepjs.voices.lied` | false | (absent) |
| `creepjs.voices.local` | Microsoft Zira Desktop - English (United States) | (absent) |
| `creepjs.voices.remote` |  | (absent) |
| `creepjs.webgl.gpu.parts` | "ANGLE, Direct3D, Graphics, Intel, Intel(R) HD Graphics" | "ANGLE, Direct3D, GeForce, NVIDIA" |
| `creepjs.worker.gpu.parts` | "ANGLE, Direct3D, Graphics, Intel, Intel(R) HD Graphics" | "ANGLE, Direct3D, GeForce, NVIDIA" |
| `creepjs.worker.webglVendor` | "Google Inc. (Intel)" | "Google Inc. (NVIDIA)" |

## rebrowser (0)

No differences.

## covered (0)

No differences.
