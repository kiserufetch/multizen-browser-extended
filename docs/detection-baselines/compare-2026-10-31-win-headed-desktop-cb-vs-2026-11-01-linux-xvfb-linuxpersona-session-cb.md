# win-headed-desktop-cb vs linux-xvfb-linuxpersona-session-cb

| | A | B |
| --- | --- | --- |
| label | "win-headed-desktop-cb" | "linux-xvfb-linuxpersona-session-cb" |
| date | "2026-10-31" | "2026-11-01" |
| engine | "cloakbrowser" | "cloakbrowser" |
| engineVersion | "146.0.7680.177.5" | "146.0.7680.177.5" |
| mode | "headed" | "xvfb" |
| displayMode | "headed" | "xvfb" |
| egress | "allow-all" | "block-private" |
| seed | "mz-baseline-70" | "mz-baseline-70" |
| platform | "win32" | "linux" |
| persona | windows-desktop-nvidia | linux-laptop-nvidia |

## Thresholds

None fired: no `HeadlessChrome`, no `webdriver: true`, no `pointer: none`.

192 differences; left out: 26 by the noise rules, 23 that also differ between a setup and its own repeat.

## probe (37)

| path | A | B |
| --- | --- | --- |
| `probe.apis.share` | true | false |
| `probe.appVersion` | "5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36" | "5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36" |
| `probe.audio.live.baseLatency` | 0.01 | 0.010666666666666666 |
| `probe.audio.live.maxChannelCount` | 8 | 2 |
| `probe.canvasHash` | 429033674 | 325818622 |
| `probe.connection.rtt` | 100 | 0 |
| `probe.devices` | audioinput, videoinput, audiooutput | audioinput, audiooutput |
| `probe.gpu.architecture` | "lovelace" | "ampere" |
| `probe.hardwareConcurrency` | 8 | 12 |
| `probe.highEntropy.platform` | "Windows" | "Linux" |
| `probe.highEntropy.platformVersion` | "15.0.0" | "6.8.0" |
| `probe.maxTouchPoints` | 10 | 0 |
| `probe.media.(any-pointer: coarse)` | true | false |
| `probe.media.(prefers-color-scheme: dark)` | true | false |
| `probe.media.(prefers-reduced-motion: reduce)` | true | false |
| `probe.platform` | "Win32" | "Linux x86_64" |
| `probe.screen.availHeight` | 1032 | 1410 |
| `probe.screen.availWidth` | 1920 | 2560 |
| `probe.screen.colorDepth` | 32 | 24 |
| `probe.screen.height` | 1080 | 1440 |
| `probe.screen.pixelDepth` | 32 | 24 |
| `probe.screen.width` | 1920 | 2560 |
| `probe.systemColors.ActiveText` | "rgb(0, 102, 204)" | "rgb(255, 0, 0)" |
| `probe.systemColors.ButtonFace` | "rgb(240, 240, 240)" | "rgb(239, 239, 239)" |
| `probe.systemColors.Highlight` | "rgb(0, 120, 215)" | "rgba(0, 65, 198, 0.8)" |
| `probe.userAgent` | "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36" | "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36" |
| `probe.voices` | only here (3 of 6): Microsoft David - English (United States)\|en-US\|true, Microsoft Zira - English (United States)\|en-US\|true, Microsoft Mark - English (United States)\|en-US\|true | only here (0 of 3):  |
| `probe.webgl.params.MAX_RENDERBUFFER_SIZE` | 16384 | 32768 |
| `probe.webgl.params.MAX_TEXTURE_SIZE` | 16384 | 32768 |
| `probe.webgl.unmaskedRenderer` | "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 (0x00002786) Direct3D11 vs_5_0 ps_5_0, D3D11)" | "ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 3060 Laptop GPU/PCIe/SSE2, OpenGL 4.5.0 NVIDIA 550.120)" |
| `probe.webgl.unmaskedVendor` | "Google Inc. (NVIDIA)" | "Google Inc. (NVIDIA Corporation)" |
| `probe.window.innerHeight` | 951 | 1319 |
| `probe.window.innerWidth` | 1904 | 2560 |
| `probe.window.outerHeight` | 1032 | 1410 |
| `probe.window.outerWidth` | 1920 | 2560 |
| `probe.window.screenY` | 35 | 10 |
| `probe.window.visualViewport` | 1904, 951, 1 | 2560, 1319, 1 |

## headers (6)

| path | A | B |
| --- | --- | --- |
| `headers.navigation.values.sec-ch-ua-platform` | "\"Windows\"" | "\"Linux\"" |
| `headers.navigation.values.user-agent` | "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36" | "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36" |
| `headers.subresourceAfterAcceptCh.values.sec-ch-ua-platform` | "\"Windows\"" | "\"Linux\"" |
| `headers.subresourceAfterAcceptCh.values.sec-ch-ua-platform-version` | "\"15.0.0\"" | "\"6.8.0\"" |
| `headers.subresourceAfterAcceptCh.values.user-agent` | "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36" | "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36" |
| `headers.subresourceAfterAcceptCh.values.viewport-width` | "1904" | "2560" |

## fonts (73)

| path | A | B |
| --- | --- | --- |
| `fonts.baseWidths.monospace` | 672.961800698127 | 736.9111014749473 |
| `fonts.counts.linux` | 0 | 11 |
| `fonts.counts.windows` | 57 | 5 |
| `fonts.emoji.canvasHash` | 1435629655 | -2109959406 |
| `fonts.emoji.width` | 32.95316726853922 | 29.944984699050526 |
| `fonts.present.linux` | only here (0 of 0):  | only here (11 of 11): Liberation Sans, Liberation Serif, Liberation Mono, DejaVu Sans, DejaVu Serif, DejaVu Sans Mono, Noto Sans CJK SC, Noto Color Emoji, Ubuntu, Cantarell, FreeSans |
| `fonts.present.windows` | only here (52 of 57): Arial Black, Bahnschrift, Cambria Math, Candara, Comic Sans MS, Consolas, Constantia, Corbel, Ebrima, Franklin Gothic Medium, Gabriola, Gadugi, Georgia, Impact, Ink Free, Javanese Text, Leelawadee UI, Lucida Console, Lucida Sans Unicode, Malgun Gothic, Marlett, Microsoft Himalaya, Microsoft JhengHei... | only here (0 of 5):  |
| `fonts.systemFonts.menu` | "\"Segoe UI\" 12px" | "Arial 16px" |
| `fonts.systemFonts.small-caption` | "\"Segoe UI\" 12px" | "Arial 16px" |
| `fonts.systemFonts.status-bar` | "\"Segoe UI\" 12px" | "Arial 16px" |
| `fonts.widths.Arial Black` | 1025.2278775446025 | 884.8487912324292 |
| `fonts.widths.Bahnschrift` | 872.0167435229519 | 884.8487912324292 |
| `fonts.widths.Cambria` | 873.7394019825803 | 839.2334373121346 |
| `fonts.widths.Cambria Math` | 873.7394019825803 | 884.8487912324292 |
| `fonts.widths.Candara` | 849.7979650232539 | 884.8487912324292 |
| `fonts.widths.Cantarell` | 884.8487912324292 | 923.76149983659 |
| `fonts.widths.Comic Sans MS` | 856.3721922059177 | 884.8487912324292 |
| `fonts.widths.Consolas` | 672.961800698127 | 884.8487912324292 |
| `fonts.widths.Constantia` | 895.8878678920893 | 884.8487912324292 |
| `fonts.widths.Corbel` | 868.4659577184115 | 884.8487912324292 |
| `fonts.widths.DejaVu Sans` | 884.8487912324292 | 1007.0520729807674 |
| `fonts.widths.DejaVu Sans Mono` | 884.8487912324292 | 736.9111014749473 |
| `fonts.widths.DejaVu Serif` | 884.8487912324292 | 1002.6575360939601 |
| `fonts.widths.Ebrima` | 901.5831876973915 | 884.8487912324292 |
| `fonts.widths.Franklin Gothic Medium` | 883.1261327728007 | 884.8487912324292 |
| `fonts.widths.FreeSans` | 884.8487912324292 | 868.4654084013007 |
| `fonts.widths.Gabriola` | 641.8660576870784 | 884.8487912324292 |
| `fonts.widths.Gadugi` | 901.5831876973915 | 884.8487912324292 |
| `fonts.widths.Georgia` | 918.1418026868815 | 884.8487912324292 |
| `fonts.widths.Impact` | 795.4814891023154 | 884.8487912324292 |
| `fonts.widths.Ink Free` | 789.2649283940501 | 884.8487912324292 |
| `fonts.widths.Javanese Text` | 870.3995539486067 | 884.8487912324292 |
| `fonts.widths.Leelawadee UI` | 901.5831876973915 | 884.8487912324292 |
| `fonts.widths.Liberation Mono` | 884.8487912324292 | 734.5204734085241 |
| `fonts.widths.Liberation Serif` | 884.8487912324292 | 842.3096741681343 |
| `fonts.widths.Lucida Console` | 737.5087584915531 | 884.8487912324292 |
| `fonts.widths.Lucida Sans Unicode` | 959.4856057179649 | 884.8487912324292 |
| `fonts.widths.Malgun Gothic` | 921.2004003600995 | 884.8487912324292 |
| `fonts.widths.Marlett` | 1209.095300888621 | 884.8487912324292 |
| `fonts.widths.Microsoft Himalaya` | 564.2233799709666 | 884.8487912324292 |
| `fonts.widths.Microsoft JhengHei` | 969.7864001806413 | 884.8487912324292 |
| `fonts.widths.Microsoft New Tai Lue` | 901.5831876973915 | 884.8487912324292 |
| `fonts.widths.Microsoft PhagsPa` | 901.5831876973915 | 884.8487912324292 |
| `fonts.widths.Microsoft Sans Serif` | 886.1144178558297 | 884.8487912324292 |
| `fonts.widths.Microsoft Tai Le` | 901.5831876973915 | 884.8487912324292 |
| `fonts.widths.Microsoft YaHei` | 980.5442264795456 | 884.8487912324292 |
| `fonts.widths.Microsoft Yi Baiti` | 668.7782015818865 | 884.8487912324292 |
| `fonts.widths.MingLiU-ExtB` | 612.0007850043359 | 884.8487912324292 |
| `fonts.widths.Mongolian Baiti` | 842.3096741681343 | 884.8487912324292 |
| `fonts.widths.MS Gothic` | 612.0007850043359 | 884.8487912324292 |
| `fonts.widths.MV Boli` | 882.5987883463839 | 884.8487912324292 |
| `fonts.widths.Myanmar Text` | 901.5831876973915 | 884.8487912324292 |
| `fonts.widths.Nirmala UI` | 901.5831876973915 | 884.8487912324292 |
| `fonts.widths.Noto Color Emoji` | 884.8487912324292 | 934.8058865616549 |
| `fonts.widths.Noto Sans CJK SC` | 884.8487912324292 | 951.6256102845027 |
| `fonts.widths.Palatino Linotype` | 912.2707014061069 | 884.8487912324292 |
| `fonts.widths.Segoe Print` | 1045.0911842729715 | 884.8487912324292 |
| `fonts.widths.Segoe Script` | 1059.8568282126444 | 884.8487912324292 |
| `fonts.widths.Segoe UI` | 901.5831876973915 | 884.8487912324292 |
| `fonts.widths.Segoe UI Emoji` | 901.5831876973915 | 884.8487912324292 |
| `fonts.widths.Segoe UI Historic` | 901.5831876973915 | 884.8487912324292 |
| `fonts.widths.Segoe UI Symbol` | 901.5831876973915 | 884.8487912324292 |
| `fonts.widths.SimSun` | 612.0007850043359 | 884.8487912324292 |
| `fonts.widths.Sitka Text` | 940.3530128174965 | 884.8487912324292 |
| `fonts.widths.Sylfaen` | 878.5909707056156 | 884.8487912324292 |
| `fonts.widths.Symbol` | 701.7548063804887 | 884.8487912324292 |
| `fonts.widths.Tahoma` | 874.9698723108863 | 884.8487912324292 |
| `fonts.widths.Trebuchet MS` | 863.8956393561318 | 884.8487912324292 |
| `fonts.widths.Ubuntu` | 884.8487912324292 | 907.4174847317391 |
| `fonts.widths.Verdana` | 1005.2239456358556 | 884.8487912324292 |
| `fonts.widths.Webdings` | 872.8604946052188 | 884.8487912324292 |
| `fonts.widths.Wingdings` | 1127.7436340400438 | 884.8487912324292 |
| `fonts.widths.Yu Gothic` | 897.2589634007732 | 884.8487912324292 |

## input (0)

No differences.

## tls (0)

No differences.

## h2 (2)

| path | A | B |
| --- | --- | --- |
| `h2.headerValues.sec-ch-ua-platform` | "\"Windows\"" | "\"Linux\"" |
| `h2.headerValues.user-agent` | "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36" | "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36" |

## webrtc (0)

No differences.

## creepjs (74)

| path | A | B |
| --- | --- | --- |
| `creepjs.audio.floatFrequencyDataSum` | 164537.64795303345 | 164537.64805984497 |
| `creepjs.canvas.textMetricsSystemSum` | 0.010083639643119487 | 0.014303734320088388 |
| `creepjs.clientRects.domrectSystemSum` | 0.023718509063720705 | 0.06810501136779785 |
| `creepjs.cssMedia.any-pointer` | "coarse" | "fine" |
| `creepjs.cssMedia.device-screen` | "1920 x 1080" | "2560 x 1440" |
| `creepjs.cssMedia.prefers-color-scheme` | "dark" | "light" |
| `creepjs.cssMedia.prefers-reduced-motion` | "reduce" | "no-preference" |
| `creepjs.fingerprintId` | "FP ID: ac4dafdcd8c07f9411ee30469be1dea31ec061f5827053ba68a6e563b0e598ce" | "FP ID: f67d72919ab9cb66f1b0c62d0873ccede6baa91824ad71277ba7eff5208004cd" |
| `creepjs.fonts.$hash` | "260095ffcd9cc2271671b91ad8c6ccc92f973d7022130bf050f4bfe3357bd0f2" | "7ed462d18ac9c66bdd5c7a75b408f843899b3d1c3c4e990f6422ff3027ae781e" |
| `creepjs.fonts.emojiSet` | only here (1 of 5): 👨‍👩‍👧‍👦 | only here (13 of 17): ☺, 🤵‍♂️, ♨, ⚧, ⁉, ℹ, ⌨, ⚰, ☦, ▶, ⏏, ⚕, ☝ |
| `creepjs.fonts.fontFaceLoadFonts` | only here (12 of 12): "Cambria Math", "Ink Free", "Javanese Text", "Leelawadee UI", "Lucida Console", "Myanmar Text", "Nirmala UI", "Segoe Fluent Icons", "Segoe MDL2 Assets", "Segoe UI Emoji", Bahnschrift, Gadugi | only here (4 of 4): "DejaVu Sans", "Liberation Mono", "Noto Color Emoji", Ubuntu |
| `creepjs.fonts.pixelSizeSystemSum` | 0.02369484 | 0.068037024 |
| `creepjs.hashes.canvas2d` | "d209e900438943fcbd06b9761a7a39538c5466cce838dae62f200e3baf7ddd01" | "85eca175699c464fb2f30ff4db636be5fdaefda11ac1a306d492c261b5368bf5" |
| `creepjs.hashes.canvasWebgl` | "229721b7c953eddcd00fd7910a4529ba22bc70f753f07015e1a7848583a52af9" | "112a4814ea1a70909ddd9ef0310ef181c1a211a2d3ce3160b64d1d55bfb32ef2" |
| `creepjs.hashes.clientRects` | "28cfc76bb90c0ac4169af442d5c80ea421c8046ff01c65a518c6747d55fada33" | "59ab0731b763464ecfcfb10ab0fd3eda517754bc97cc48c4ca3fba3825fbf391" |
| `creepjs.hashes.css` | "7c3d2adde0b7c02c881d98c3c2009c5f0f81f4f8913fca5c8043e43f5c7be56f" | "07ea6cd8033e186e74227b37edb94b7bf7973191302edca5e3dc4051a3325529" |
| `creepjs.hashes.cssMedia` | "79c151b7062beb905a4d21b1fbbb850f86f3f6af8f323fd0667ebd210c705278" | "660438bdda8dbe4f2dba4b15a5aba6fbbdd951fe45e0ca2535d6c98124f35c9c" |
| `creepjs.hashes.fonts` | "260095ffcd9cc2271671b91ad8c6ccc92f973d7022130bf050f4bfe3357bd0f2" | "7ed462d18ac9c66bdd5c7a75b408f843899b3d1c3c4e990f6422ff3027ae781e" |
| `creepjs.hashes.headless` | "ce2546a9850048cb250ed1e5aec8862ef11c1fdac645ab32611a58425ec9a9cb" | "b96a4bee2cd789f1daf7484c21a4fcb67bae6891bba219288bd480622af7da73" |
| `creepjs.hashes.navigator` | "4f0ea2ece7195b852d58a1d806f5da4680a335b8859f4f57d5eddfe67f3d895b" | "284974d79b7f302958d2ca99e236e72cf0479a6763ddafc11c846ea686c9e48a" |
| `creepjs.hashes.screen` | "32aa7017a937e599c711ff15e0cfde7334946a5003b640d62f37d52056669908" | "b57e72f6cf79dd54d64c70234693bbd060c695630103cb976e247ee6dbee3c76" |
| `creepjs.hashes.svg` | "43f113b0afca4c2034d2fe9ef08b5bf67e2dcb352ec8b52b4ce646a3f2c95e02" | "a414038acb289ec0ceeeb8175fb0d3ed4a3e28b94b5595a829e76b19346d4856" |
| `creepjs.hashes.trash` | "1affd279445bca932557cbc04d48a5280483c9a4a51d0db3bc6f497279e60651" | "1e322b56b3457db4170759c3cc1a1eca3bc5ffc4cbef8a668153382f8118ce19" |
| `creepjs.hashes.voices` | "a3c36387746ff93e753e26cf634182e2511bcb685bb1443cf0e272cae55ba9ab" | (absent) |
| `creepjs.hashes.workerScope` | "d13b6c6353f907bf39951aafc19a31ac1b5c36c640c798490daaca6203460bc2" | "97b55929110d32edc9c0a798a805c305da71d1aa5da3d42dcf740d51e2709e8b" |
| `creepjs.headless.likeHeadless.hasKnownBgColor` | false | true |
| `creepjs.headless.likeHeadless.noWebShare` | false | true |
| `creepjs.headless.likeHeadless.prefersLightColor` | false | true |
| `creepjs.headless.likeHeadlessRating` | 19 | 38 |
| `creepjs.headless.systemFonts` | "Arial,\"Segoe UI\"" | "Arial" |
| `creepjs.navigator.device` | "Windows 10 (64-bit)" | "Linux x86_64" |
| `creepjs.navigator.hardwareConcurrency` | 8 | 12 |
| `creepjs.navigator.maxTouchPoints` | 10 | 0 |
| `creepjs.navigator.platform` | "Win32" | "Linux x86_64" |
| `creepjs.navigator.system` | "Windows" | "Linux" |
| `creepjs.navigator.userAgent` | "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36" | "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36" |
| `creepjs.screen.$hash` | "32aa7017a937e599c711ff15e0cfde7334946a5003b640d62f37d52056669908" | "b57e72f6cf79dd54d64c70234693bbd060c695630103cb976e247ee6dbee3c76" |
| `creepjs.screen.availHeight` | 1032 | 1410 |
| `creepjs.screen.availWidth` | 1920 | 2560 |
| `creepjs.screen.colorDepth` | 32 | 24 |
| `creepjs.screen.height` | 1080 | 1440 |
| `creepjs.screen.pixelDepth` | 32 | 24 |
| `creepjs.screen.width` | 1920 | 2560 |
| `creepjs.svg.svgrectSystemSum` | 0.010394303741455078 | 0.0278837077331543 |
| `creepjs.trash.count` | 2 | 4 |
| `creepjs.trash.items[0].name` | "AudioBuffer" | "WebGLRenderingContext.getParameter" |
| `creepjs.trash.items[0].value` | "5000 unique samples of 5000 is too high" | "suspicious gpu" |
| `creepjs.trash.items[1].name` | "AudioBuffer" | "WebGLRenderingContext.getParameter" |
| `creepjs.trash.items[1].value` | "suspicious frequency data" | "suspicious capabilities" |
| `creepjs.trash.items[2].name` | (absent) | "AudioBuffer" |
| `creepjs.trash.items[2].value` | (absent) | "5000 unique samples of 5000 is too high" |
| `creepjs.trash.items[3].name` | (absent) | "AudioBuffer" |
| `creepjs.trash.items[3].value` | (absent) | "suspicious frequency data" |
| `creepjs.voices` | (absent) | null |
| `creepjs.voices.$hash` | "a3c36387746ff93e753e26cf634182e2511bcb685bb1443cf0e272cae55ba9ab" | (absent) |
| `creepjs.voices.defaultVoiceLang` | "en-US" | (absent) |
| `creepjs.voices.defaultVoiceName` | "Microsoft David - English (United States)" | (absent) |
| `creepjs.voices.languages` | en-US, en-GB | (absent) |
| `creepjs.voices.lied` | false | (absent) |
| `creepjs.voices.local` | Microsoft David - English (United States), Microsoft Zira - English (United States), Microsoft Mark - English (United States) | (absent) |
| `creepjs.voices.remote` | Google US English, Google UK English Female, Google UK English Male | (absent) |
| `creepjs.webgl.gpu.compressedGPU` | "NVIDIA, NVIDIA GeForce RTX 4000s (0x00002786)" | "NVIDIA Corporation, NVIDIA GeForce RTX 3000s Laptop GPU/PCIe/SSE2, OpenGL 4.5.0 )" |
| `creepjs.webgl.gpu.parts` | "ANGLE, D3D11, Direct3D, GeForce, NVIDIA" | "ANGLE, GeForce, NVIDIA, NVIDIA Corporation, OpenGL, PCIe, SSE2" |
| `creepjs.worker.device` | "Windows 10 (64-bit)" | "Linux x86_64" |
| `creepjs.worker.gpu.compressedGPU` | "NVIDIA, NVIDIA GeForce RTX 4000s (0x00002786)" | "NVIDIA Corporation, NVIDIA GeForce RTX 3000s Laptop GPU/PCIe/SSE2, OpenGL 4.5.0 )" |
| `creepjs.worker.gpu.parts` | "ANGLE, D3D11, Direct3D, GeForce, NVIDIA" | "ANGLE, GeForce, NVIDIA, NVIDIA Corporation, OpenGL, PCIe, SSE2" |
| `creepjs.worker.hardwareConcurrency` | 8 | 12 |
| `creepjs.worker.platform` | "Win32" | "Linux x86_64" |
| `creepjs.worker.system` | "Windows" | "Linux" |
| `creepjs.worker.userAgent` | "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36" | "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36" |
| `creepjs.worker.userAgentData.platform` | "Windows" | "Linux" |
| `creepjs.worker.userAgentData.platformVersion` | "15.0.0" | "6.8.0" |
| `creepjs.worker.webglRenderer` | "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 (0x00002786) Direct3D11 vs_5_0 ps_5_0, D3D11)" | "ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 3060 Laptop GPU/PCIe/SSE2, OpenGL 4.5.0 NVIDIA 550.120)" |
| `creepjs.worker.webglVendor` | "Google Inc. (NVIDIA)" | "Google Inc. (NVIDIA Corporation)" |

## rebrowser (0)

No differences.

## covered (0)

No differences.
