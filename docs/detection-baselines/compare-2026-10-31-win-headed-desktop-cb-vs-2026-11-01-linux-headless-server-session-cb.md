# win-headed-desktop-cb vs linux-headless-server-session-cb

| | A | B |
| --- | --- | --- |
| label | "win-headed-desktop-cb" | "linux-headless-server-session-cb" |
| date | "2026-10-31" | "2026-11-01" |
| engine | "cloakbrowser" | "cloakbrowser" |
| engineVersion | "146.0.7680.177.5" | "146.0.7680.177.5" |
| mode | "headed" | "headless" |
| displayMode | "headed" | "headless" |
| egress | "allow-all" | "block-private" |
| seed | "mz-baseline-70" | "mz-baseline-70" |
| platform | "win32" | "linux" |
| persona | windows-desktop-nvidia | windows-desktop-nvidia |

## Thresholds

None fired: no `HeadlessChrome`, no `webdriver: true`, no `pointer: none`.

122 differences; left out: 27 by the noise rules, 23 that also differ between a setup and its own repeat.

## probe (17)

| path | A | B |
| --- | --- | --- |
| `probe.audio.live.baseLatency` | 0.01 | 0.010666666666666666 |
| `probe.audio.live.maxChannelCount` | 8 | 2 |
| `probe.canvasHash` | 429033674 | -1880325330 |
| `probe.connection.rtt` | 100 | 0 |
| `probe.devices` | audioinput, videoinput, audiooutput | audioinput, audiooutput |
| `probe.maxTouchPoints` | 10 | 0 |
| `probe.media.(any-pointer: coarse)` | true | false |
| `probe.media.(prefers-color-scheme: dark)` | true | false |
| `probe.media.(prefers-reduced-motion: reduce)` | true | false |
| `probe.screen.colorDepth` | 32 | 24 |
| `probe.screen.pixelDepth` | 32 | 24 |
| `probe.webgl.canvasHash` | 2131711150 | -37762976 |
| `probe.webgl.extensionCount` | 35 | 33 |
| `probe.webgl.extensionsHash` | -826598732 | -101185691 |
| `probe.window.innerHeight` | 951 | 959 |
| `probe.window.innerWidth` | 1904 | 1920 |
| `probe.window.visualViewport` | 1904, 951, 1 | 1920, 959, 1 |

## headers (1)

| path | A | B |
| --- | --- | --- |
| `headers.subresourceAfterAcceptCh.values.viewport-width` | "1904" | "1920" |

## fonts (65)

| path | A | B |
| --- | --- | --- |
| `fonts.baseWidths.monospace` | 672.961800698127 | 736.9111014749473 |
| `fonts.counts.linux` | 0 | 2 |
| `fonts.counts.windows` | 57 | 5 |
| `fonts.emoji.canvasHash` | 1435629655 | 2009971888 |
| `fonts.emoji.width` | 32.95316726853922 | 30.000038480604697 |
| `fonts.present.linux` |  | Noto Sans CJK SC, Noto Color Emoji |
| `fonts.present.windows` | only here (52 of 57): Arial Black, Bahnschrift, Cambria Math, Candara, Comic Sans MS, Consolas, Constantia, Corbel, Ebrima, Franklin Gothic Medium, Gabriola, Gadugi, Georgia, Impact, Ink Free, Javanese Text, Leelawadee UI, Lucida Console, Lucida Sans Unicode, Malgun Gothic, Marlett, Microsoft Himalaya, Microsoft JhengHei... | only here (0 of 5):  |
| `fonts.systemFonts.menu` | "\"Segoe UI\" 12px" | "Arial 16px" |
| `fonts.systemFonts.small-caption` | "\"Segoe UI\" 12px" | "Arial 16px" |
| `fonts.systemFonts.status-bar` | "\"Segoe UI\" 12px" | "Arial 16px" |
| `fonts.widths.Arial Black` | 1025.2278775446025 | 884.8487912324292 |
| `fonts.widths.Bahnschrift` | 872.0167435229519 | 884.8487912324292 |
| `fonts.widths.Cambria` | 873.7394019825803 | 839.2334373121346 |
| `fonts.widths.Cambria Math` | 873.7394019825803 | 884.8487912324292 |
| `fonts.widths.Candara` | 849.7979650232539 | 884.8487912324292 |
| `fonts.widths.Comic Sans MS` | 856.3721922059177 | 884.8487912324292 |
| `fonts.widths.Consolas` | 672.961800698127 | 884.8487912324292 |
| `fonts.widths.Constantia` | 895.8878678920893 | 884.8487912324292 |
| `fonts.widths.Corbel` | 868.4659577184115 | 884.8487912324292 |
| `fonts.widths.Ebrima` | 901.5831876973915 | 884.8487912324292 |
| `fonts.widths.Franklin Gothic Medium` | 883.1261327728007 | 884.8487912324292 |
| `fonts.widths.Gabriola` | 641.8660576870784 | 884.8487912324292 |
| `fonts.widths.Gadugi` | 901.5831876973915 | 884.8487912324292 |
| `fonts.widths.Georgia` | 918.1418026868815 | 884.8487912324292 |
| `fonts.widths.Impact` | 795.4814891023154 | 884.8487912324292 |
| `fonts.widths.Ink Free` | 789.2649283940501 | 884.8487912324292 |
| `fonts.widths.Javanese Text` | 870.3995539486067 | 884.8487912324292 |
| `fonts.widths.Leelawadee UI` | 901.5831876973915 | 884.8487912324292 |
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
| `fonts.widths.Verdana` | 1005.2239456358556 | 884.8487912324292 |
| `fonts.widths.Webdings` | 872.8604946052188 | 884.8487912324292 |
| `fonts.widths.Wingdings` | 1127.7436340400438 | 884.8487912324292 |
| `fonts.widths.Yu Gothic` | 897.2589634007732 | 884.8487912324292 |

## input (0)

No differences.

## tls (0)

No differences.

## h2 (0)

No differences.

## webrtc (0)

No differences.

## creepjs (39)

| path | A | B |
| --- | --- | --- |
| `creepjs.audio.floatFrequencyDataSum` | 164537.64795303345 | 164537.64805984497 |
| `creepjs.canvas.textMetricsSystemSum` | 0.010083639643119487 | 0.0021600613644286956 |
| `creepjs.clientRects.domrectSystemSum` | 0.023718509063720705 | 0.008438730773925781 |
| `creepjs.cssMedia.any-pointer` | "coarse" | "fine" |
| `creepjs.cssMedia.prefers-color-scheme` | "dark" | "light" |
| `creepjs.cssMedia.prefers-reduced-motion` | "reduce" | "no-preference" |
| `creepjs.fingerprintId` | "FP ID: ac4dafdcd8c07f9411ee30469be1dea31ec061f5827053ba68a6e563b0e598ce" | "FP ID: 5be06df2b408ed9c85ea8283e04dd14aedf092f1db02130d8f51962b63376e59" |
| `creepjs.fonts.$hash` | "260095ffcd9cc2271671b91ad8c6ccc92f973d7022130bf050f4bfe3357bd0f2" | "5abad0ad671d8aad7b029d12d35b28d61c9c59b6cb81f136c2730e31b24de467" |
| `creepjs.fonts.emojiSet` | 😀, 👨‍👩‍👧‍👦, ©, ™, ◼ | 😀, ☺ |
| `creepjs.fonts.fontFaceLoadFonts` | only here (12 of 12): "Cambria Math", "Ink Free", "Javanese Text", "Leelawadee UI", "Lucida Console", "Myanmar Text", "Nirmala UI", "Segoe Fluent Icons", "Segoe MDL2 Assets", "Segoe UI Emoji", Bahnschrift, Gadugi | only here (1 of 1): "Noto Color Emoji" |
| `creepjs.fonts.pixelSizeSystemSum` | 0.02369484 | 0.00843031 |
| `creepjs.hashes.canvas2d` | "d209e900438943fcbd06b9761a7a39538c5466cce838dae62f200e3baf7ddd01" | "4097162d329300fd683032ef5ffe429a03ce72eeb7d3e37ae4f603afdd2b64a5" |
| `creepjs.hashes.canvasWebgl` | "229721b7c953eddcd00fd7910a4529ba22bc70f753f07015e1a7848583a52af9" | "028ae783d743dfa0816510e0afb25271bc2fcd484bc80efda12aaeaa28fa48b8" |
| `creepjs.hashes.clientRects` | "28cfc76bb90c0ac4169af442d5c80ea421c8046ff01c65a518c6747d55fada33" | "4be09e42e11d5ba58f38a894dd486cee03f607c7291a2e26ce38b8f7c9b5e90e" |
| `creepjs.hashes.css` | "7c3d2adde0b7c02c881d98c3c2009c5f0f81f4f8913fca5c8043e43f5c7be56f" | "ba68db46479a9239ca42a2c5da5bfc4b386e157d5fdf1579a55fdcdbbbf0e093" |
| `creepjs.hashes.cssMedia` | "79c151b7062beb905a4d21b1fbbb850f86f3f6af8f323fd0667ebd210c705278" | "202401c6c97887f7cc3b444c2b24b529a21dd8be1db4a1c41d28f43bc6300bc8" |
| `creepjs.hashes.fonts` | "260095ffcd9cc2271671b91ad8c6ccc92f973d7022130bf050f4bfe3357bd0f2" | "5abad0ad671d8aad7b029d12d35b28d61c9c59b6cb81f136c2730e31b24de467" |
| `creepjs.hashes.headless` | "ce2546a9850048cb250ed1e5aec8862ef11c1fdac645ab32611a58425ec9a9cb" | "9191dd69fae89dca475a6b5a09596195208c629f410ba716f2d857ce1ed76d5c" |
| `creepjs.hashes.navigator` | "4f0ea2ece7195b852d58a1d806f5da4680a335b8859f4f57d5eddfe67f3d895b" | "dc884e1c4869ff8bc36d027d6a4f0f876058f93eff5bff44753cc26e556c0d28" |
| `creepjs.hashes.screen` | "32aa7017a937e599c711ff15e0cfde7334946a5003b640d62f37d52056669908" | "9d83f24afdec28df7ee8211ac5e5c909f6d47bd00bc27aa23fc4be7b604d4c9e" |
| `creepjs.hashes.svg` | "43f113b0afca4c2034d2fe9ef08b5bf67e2dcb352ec8b52b4ce646a3f2c95e02" | "4592c4524cc979bc8f26d9efa3d81ec16642b00d72f0c84d54b0525a58f539ea" |
| `creepjs.hashes.trash` | "1affd279445bca932557cbc04d48a5280483c9a4a51d0db3bc6f497279e60651" | "1e322b56b3457db4170759c3cc1a1eca3bc5ffc4cbef8a668153382f8118ce19" |
| `creepjs.headless.likeHeadless.prefersLightColor` | false | true |
| `creepjs.headless.likeHeadlessRating` | 19 | 25 |
| `creepjs.headless.systemFonts` | "Arial,\"Segoe UI\"" | "Arial" |
| `creepjs.navigator.maxTouchPoints` | 10 | 0 |
| `creepjs.screen.$hash` | "32aa7017a937e599c711ff15e0cfde7334946a5003b640d62f37d52056669908" | "9d83f24afdec28df7ee8211ac5e5c909f6d47bd00bc27aa23fc4be7b604d4c9e" |
| `creepjs.screen.colorDepth` | 32 | 24 |
| `creepjs.screen.pixelDepth` | 32 | 24 |
| `creepjs.svg.svgrectSystemSum` | 0.010394303741455078 | 0.003697712326049805 |
| `creepjs.trash.count` | 2 | 4 |
| `creepjs.trash.items[0].name` | "AudioBuffer" | "WebGLRenderingContext.getParameter" |
| `creepjs.trash.items[0].value` | "5000 unique samples of 5000 is too high" | "suspicious gpu" |
| `creepjs.trash.items[1].name` | "AudioBuffer" | "WebGLRenderingContext.getParameter" |
| `creepjs.trash.items[1].value` | "suspicious frequency data" | "suspicious capabilities" |
| `creepjs.trash.items[2].name` | (absent) | "AudioBuffer" |
| `creepjs.trash.items[2].value` | (absent) | "5000 unique samples of 5000 is too high" |
| `creepjs.trash.items[3].name` | (absent) | "AudioBuffer" |
| `creepjs.trash.items[3].value` | (absent) | "suspicious frequency data" |

## rebrowser (0)

No differences.

## covered (0)

No differences.
