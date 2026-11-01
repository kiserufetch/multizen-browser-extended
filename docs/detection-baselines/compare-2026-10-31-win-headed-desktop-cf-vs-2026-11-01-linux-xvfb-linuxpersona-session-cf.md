# win-headed-desktop-cf vs linux-xvfb-linuxpersona-session-cf

| | A | B |
| --- | --- | --- |
| label | "win-headed-desktop-cf" | "linux-xvfb-linuxpersona-session-cf" |
| date | "2026-10-31" | "2026-11-01" |
| engine | "camoufox" | "camoufox" |
| engineVersion | "152.0.4-beta.30" | "152.0.4-beta.30" |
| mode | "headed" | "xvfb" |
| displayMode | "headed" | "xvfb" |
| egress | "allow-all" | "block-private" |
| seed | "mz-baseline-70" | "mz-baseline-70" |
| platform | "win32" | "linux" |
| persona | windows-desktop-nvidia | linux-laptop-nvidia |

## Thresholds

None fired: no `HeadlessChrome`, no `webdriver: true`, no `pointer: none`.

90 differences; left out: 22 by the noise rules, 147 that also differ between a setup and its own repeat.

## probe (20)

| path | A | B |
| --- | --- | --- |
| `probe.appVersion` | "5.0 (Windows)" | "5.0 (X11)" |
| `probe.audio.live.maxChannelCount` | 8 | 2 |
| `probe.devices` | audioinput, videoinput | audioinput |
| `probe.gpu` | "no adapter" | null |
| `probe.oscpu` | "Windows NT 10.0; Win64; x64" | "Linux x86_64" |
| `probe.platform` | "Win32" | "Linux x86_64" |
| `probe.screen.height` | 1080 | 1440 |
| `probe.screen.width` | 1920 | 2560 |
| `probe.userAgent` | "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0" | "Mozilla/5.0 (X11; Linux x86_64; rv:152.0) Gecko/20100101 Firefox/152.0" |
| `probe.voices` | Microsoft Zira Desktop - English (United States)\|en-US\|true |  |
| `probe.webgl.extensionCount` | 27 | 29 |
| `probe.webgl.extensionsHash` | -771883384 | -1712155958 |
| `probe.webgl.params.ALIASED_LINE_WIDTH_RANGE` | 1, 1 | 1, 7.375 |
| `probe.webgl.params.MAX_COMBINED_TEXTURE_IMAGE_UNITS` | 32 | 192 |
| `probe.webgl.params.MAX_RENDERBUFFER_SIZE` | 16384 | 8192 |
| `probe.webgl.params.MAX_TEXTURE_SIZE` | 16384 | 8192 |
| `probe.webgl.params.MAX_VIEWPORT_DIMS` | 32767, 32767 | 16384, 16384 |
| `probe.webgl.unmaskedVendor` | "Google Inc. (Intel)" | "Intel" |
| `probe.windowProps.count` | 1003 | 937 |
| `probe.windowProps.hash` | -636466067 | -278472104 |

## headers (2)

| path | A | B |
| --- | --- | --- |
| `headers.navigation.values.user-agent` | "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0" | "Mozilla/5.0 (X11; Linux x86_64; rv:152.0) Gecko/20100101 Firefox/152.0" |
| `headers.subresourceAfterAcceptCh.values.user-agent` | "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0" | "Mozilla/5.0 (X11; Linux x86_64; rv:152.0) Gecko/20100101 Firefox/152.0" |

## fonts (10)

| path | A | B |
| --- | --- | --- |
| `fonts.counts.mac` | 1 | 0 |
| `fonts.counts.windows` | 56 | 2 |
| `fonts.present.mac` | Helvetica |  |
| `fonts.present.windows` | only here (54 of 56): Arial, Arial Black, Bahnschrift, Calibri, Cambria, Cambria Math, Candara, Comic Sans MS, Consolas, Constantia, Corbel, Ebrima, Gabriola, Gadugi, Georgia, Impact, Ink Free, Javanese Text, Leelawadee UI, Lucida Console, Lucida Sans Unicode, Malgun Gothic, Marlett, Microsoft Himalaya, Microsoft JhengHe... | only here (0 of 2):  |
| `fonts.systemFonts.caption` | "Segoe UI 12px" | "sans-serif 15px" |
| `fonts.systemFonts.icon` | "Segoe UI 12px" | "sans-serif 15px" |
| `fonts.systemFonts.menu` | "Segoe UI 12px" | "sans-serif 15px" |
| `fonts.systemFonts.message-box` | "Segoe UI 12px" | "sans-serif 15px" |
| `fonts.systemFonts.small-caption` | "Segoe UI 12px" | "sans-serif 15px" |
| `fonts.systemFonts.status-bar` | "Segoe UI 12px" | "sans-serif 15px" |

## input (0)

No differences.

## tls (0)

No differences.

## h2 (2)

| path | A | B |
| --- | --- | --- |
| `h2.frameOrder` | only here (1 of 8): GOAWAY | only here (0 of 7):  |
| `h2.headerValues.user-agent` | "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0" | "Mozilla/5.0 (X11; Linux x86_64; rv:152.0) Gecko/20100101 Firefox/152.0" |

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

## creepjs (33)

| path | A | B |
| --- | --- | --- |
| `creepjs.audio.totalUniqueSamples` | 4736 | 4735 |
| `creepjs.cssMedia.device-screen` | "1920 x 1080" | "2560 x 1440" |
| `creepjs.fonts.fontFaceLoadFonts` | only here (13 of 13): Bahnschrift, Cambria Math, Gadugi, HoloLens MDL2 Assets, Ink Free, Javanese Text, Leelawadee UI, Lucida Console, Myanmar Text, Nirmala UI, Segoe Fluent Icons, Segoe MDL2 Assets, Segoe UI Emoji | only here (2 of 2): Arimo, Cousine |
| `creepjs.fonts.platformVersion` | "Windows 11" | (absent) |
| `creepjs.hashes.css` | "108e7f7635bade858b1026464ad4fe162d37aea0cc815616ac44803170181a97" | "506435e2b449d48ec036d8defad6a8ada03d8c54cd62f44650523e45f22167b7" |
| `creepjs.hashes.cssMedia` | "202401c6c97887f7cc3b444c2b24b529a21dd8be1db4a1c41d28f43bc6300bc8" | "660438bdda8dbe4f2dba4b15a5aba6fbbdd951fe45e0ca2535d6c98124f35c9c" |
| `creepjs.hashes.headless` | "e9d45bc0188a9305257fa7ef153b8f240f3422135b55e04bae5d7ee1f8f19723" | "9e6ef6246fb4a6adfd76cd43cc26bc057d21771909ff42f3fea40422f9f57421" |
| `creepjs.hashes.maths` | "c7d8800b950174bb01bd38788b464387254ef282d5e1c038ac3acb655b792e50" | "1747db31bad6b2749bd71b3aba945993478a86a376bb75d7722dd9be755cf3df" |
| `creepjs.hashes.media` | "b395e83d4853a5d3a02d2ba81f6b761e830c8adbea21722ae21bab34990cb41a" | "5cee837b6a8c8ce55cd43c70b0cf2ddbe4ad3869a28bb791ea33f5b34d3d7aa8" |
| `creepjs.hashes.voices` | "bd24e3aadac54006e93fffb25a6f75c40d75820abcb454e35cdc79649415a289" | (absent) |
| `creepjs.hashes.windowFeatures` | "d86a004ea9471561bd0d5794bde0f7c5a468ad5aeec545e54dcef71289e0a01f" | "066db60486896ee3acf36a731ca28d056eb215ed8298e7b55c36c1f58be594f1" |
| `creepjs.headless.systemFonts` | "Segoe UI:Windows" | "sans-serif:Linux" |
| `creepjs.navigator.device` | "Windows 10 (64-bit)" | "Linux x86_64" |
| `creepjs.navigator.platform` | "Win32" | "Linux x86_64" |
| `creepjs.navigator.system` | "Windows" | "Linux" |
| `creepjs.navigator.userAgent` | "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0" | "Mozilla/5.0 (X11; Linux x86_64; rv:152.0) Gecko/20100101 Firefox/152.0" |
| `creepjs.screen.height` | 1080 | 1440 |
| `creepjs.screen.width` | 1920 | 2560 |
| `creepjs.voices` | (absent) | null |
| `creepjs.voices.$hash` | "bd24e3aadac54006e93fffb25a6f75c40d75820abcb454e35cdc79649415a289" | (absent) |
| `creepjs.voices.defaultVoiceLang` | "" | (absent) |
| `creepjs.voices.defaultVoiceName` | "" | (absent) |
| `creepjs.voices.languages` | en-US | (absent) |
| `creepjs.voices.lied` | false | (absent) |
| `creepjs.voices.local` | Microsoft Zira Desktop - English (United States) | (absent) |
| `creepjs.voices.remote` |  | (absent) |
| `creepjs.webgl.gpu.parts` | "ANGLE, Direct3D, Graphics, Intel, Intel(R) HD Graphics" | "Graphics, Intel, Intel(R) HD Graphics" |
| `creepjs.worker.device` | "Windows 10 (64-bit)" | "Linux x86_64" |
| `creepjs.worker.gpu.parts` | "ANGLE, Direct3D, Graphics, Intel, Intel(R) HD Graphics" | "Graphics, Intel, Intel(R) HD Graphics" |
| `creepjs.worker.platform` | "Win32" | "Linux x86_64" |
| `creepjs.worker.system` | "Windows" | "Linux" |
| `creepjs.worker.userAgent` | "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0" | "Mozilla/5.0 (X11; Linux x86_64; rv:152.0) Gecko/20100101 Firefox/152.0" |
| `creepjs.worker.webglVendor` | "Google Inc. (Intel)" | "Intel" |

## rebrowser (0)

No differences.

## covered (0)

No differences.
