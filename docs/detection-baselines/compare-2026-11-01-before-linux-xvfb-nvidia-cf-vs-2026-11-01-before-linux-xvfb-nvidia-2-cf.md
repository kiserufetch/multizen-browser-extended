# before-linux-xvfb-nvidia-cf vs before-linux-xvfb-nvidia-2-cf

| | A | B |
| --- | --- | --- |
| label | "before-linux-xvfb-nvidia-cf" | "before-linux-xvfb-nvidia-2-cf" |
| date | "2026-11-01" | "2026-11-01" |
| engine | "camoufox" | "camoufox" |
| engineVersion | "152.0.4-beta.30" | "152.0.4-beta.30" |
| mode | "xvfb" | "xvfb" |
| displayMode | "xvfb" | "xvfb" |
| egress | "allow-all" | "allow-all" |
| seed | "mz-baseline-70" | "mz-baseline-70" |
| platform | "linux" | "linux" |
| persona | linux-desktop-nvidia | linux-desktop-nvidia |

## Thresholds

None fired: no `HeadlessChrome`, no `webdriver: true`, no `pointer: none`.

138 differences; left out: 13 by the noise rules.

## probe (17)

| path | A | B |
| --- | --- | --- |
| `probe.audio.canvasLikeSum` | 75.78831756219006 | 75.8159295998048 |
| `probe.canvasHash` | -604245921 | 1747653585 |
| `probe.screen.availHeight` | 1080 | 928 |
| `probe.screen.availWidth` | 1920 | 1485 |
| `probe.webgl.canvasHash` | 791588552 | 1726622321 |
| `probe.webgl.extensionCount` | 28 | 29 |
| `probe.webgl.extensionsHash` | -456376935 | -1712155958 |
| `probe.webgl.params.ALIASED_LINE_WIDTH_RANGE` | 1, 10 | 1, 7.375 |
| `probe.webgl.params.MAX_RENDERBUFFER_SIZE` | 32768 | 8192 |
| `probe.webgl.params.MAX_TEXTURE_SIZE` | 32768 | 8192 |
| `probe.webgl.params.MAX_VIEWPORT_DIMS` | 32768, 32768 | 16384, 16384 |
| `probe.webgl.renderer` | "NVIDIA GeForce GTX 980, or similar" | "Intel(R) HD Graphics, or similar" |
| `probe.webgl.unmaskedRenderer` | "NVIDIA GeForce GTX 980, or similar" | "Intel(R) HD Graphics, or similar" |
| `probe.webgl.unmaskedVendor` | "NVIDIA Corporation" | "Intel" |
| `probe.window.historyLength` | 5 | 3 |
| `probe.window.outerHeight` | 1040 | 896 |
| `probe.window.outerWidth` | 1920 | 1485 |

## headers (0)

No differences.

## fonts (89)

| path | A | B |
| --- | --- | --- |
| `fonts.baseWidths.monospace` | 886.3833618164062 | 884.933349609375 |
| `fonts.baseWidths.sans-serif` | 886.3833618164062 | 884.933349609375 |
| `fonts.baseWidths.serif` | 886.3833618164062 | 884.933349609375 |
| `fonts.emoji.canvasHash` | 1917238586 | 1080270462 |
| `fonts.emoji.width` | 24.08333396911621 | 24 |
| `fonts.widths.Apple Color Emoji` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Arial` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Arial Black` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Avenir` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Bahnschrift` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Calibri` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Cambria` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Cambria Math` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Candara` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Cantarell` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Comic Sans MS` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Consolas` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Constantia` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Corbel` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Courier New` | 736.0999755859375 | 734.683349609375 |
| `fonts.widths.DejaVu Sans` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.DejaVu Sans Mono` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.DejaVu Serif` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Droid Sans` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Ebrima` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Franklin Gothic Medium` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.FreeSans` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Gabriola` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Gadugi` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Geneva` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Georgia` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Helvetica` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Helvetica Neue` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.HoloLens MDL2 Assets` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Impact` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Ink Free` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Javanese Text` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Leelawadee UI` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Liberation Mono` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Liberation Sans` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Liberation Serif` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Lucida Console` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Lucida Grande` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Lucida Sans Unicode` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Malgun Gothic` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Marlett` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Menlo` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Microsoft Himalaya` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Microsoft JhengHei` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Microsoft New Tai Lue` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Microsoft PhagsPa` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Microsoft Sans Serif` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Microsoft Tai Le` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Microsoft YaHei` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Microsoft Yi Baiti` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.MingLiU-ExtB` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Monaco` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Mongolian Baiti` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.MS Gothic` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.MV Boli` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Myanmar Text` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Nirmala UI` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Noto Color Emoji` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Noto Sans` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Noto Sans CJK SC` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Noto Serif` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Palatino Linotype` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Roboto` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.San Francisco` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Segoe MDL2 Assets` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Segoe Print` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Segoe Script` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Segoe UI` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Segoe UI Emoji` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Segoe UI Historic` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Segoe UI Symbol` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.SF Pro Text` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.SimSun` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Sitka Text` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Sylfaen` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Symbol` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Tahoma` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Times New Roman` | 843.9166870117188 | 842.2666625976562 |
| `fonts.widths.Trebuchet MS` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Ubuntu` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Verdana` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Webdings` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Wingdings` | 886.3833618164062 | 884.933349609375 |
| `fonts.widths.Yu Gothic` | 886.3833618164062 | 884.933349609375 |

## input (0)

No differences.

## tls (0)

No differences.

## h2 (0)

No differences.

## webrtc (0)

No differences.

## creepjs (32)

| path | A | B |
| --- | --- | --- |
| `creepjs.audio.floatFrequencyDataSum` | 167703.7896347046 | 167701.03243637085 |
| `creepjs.audio.floatTimeDomainDataSum` | 148.41406476083648 | 148.43746387851934 |
| `creepjs.audio.sampleSum` | 35.73034000393818 | 35.743336641902715 |
| `creepjs.audio.totalUniqueSamples` | 4735 | 4736 |
| `creepjs.canvas.mods.pixelImage` | "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAYAAACM/rhtAAAAR0lEQVRYR+3QMQ0AMAzAsJU/6A6Enx4xgiizu/sOmwJRB1UHVQdVB1UHVQdVB1UHVQdVB1UHVQdVB1UHVQdVB1UHVQfV+YMfyAWfiSN598oAAAAQZGVCRzVGNzY0M0YxMThDRTJFQTDXxds7AAAAAElFTkSuQmCC" | "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAYAAACM/rhtAAAAR0lEQVRYR+3QMQ0AMAzAsJU/6A6Enx4xgiizu/sOmwJRB1UHVQdVB1UHVQdVB1UHVQdVB1UHVQdVB1UHVQdVB1UHVQfV+YMfyAWfiSN598oAAAAQZGVCR0E1NzE1MjRDODdDRDFFNzhxbgSvAAAAAElFTkSuQmCC" |
| `creepjs.canvas.textMetricsSystemSum` | 0.027648031232357026 | 0.027582697920799256 |
| `creepjs.clientRects.domrectSystemSum` | 0.3150070007324219 | 0.3149576679992676 |
| `creepjs.fingerprintId` | "FP ID: 3e6088a6e40811505a7c822e863976e0312392ae72417601121b606ee56d1079" | "FP ID: 0554822e7256c8638e8968daf2329c971f2c42e5fa2a64ff0e35a89561f83e21" |
| `creepjs.fonts.$hash` | "2795545d3f6da31753bc9703028d75820f3f2f61cb34ecdad984f9bc4956e98a" | "3b9ce27230dbd3c407f699cc81bdc38ca0b2ca2f13e2ce66000294ad366fba41" |
| `creepjs.fonts.emojiSet` | only here (27 of 55): ♨, ☂, ☄, ♟, ⛑, ⌨, ✉, ✏, ✒, ⛏, ⛓, ☢, ☣, ⏭, ✖, ✔, ✳, ❇, ◼, ❣, ❤, ✌, ✍, ❄, ↪, ☑, ✴ | only here (1 of 29): ✂ |
| `creepjs.fonts.pixelSizeSystemSum` | 0.291716336 | 0.15942517 |
| `creepjs.hashes.canvas2d` | "fb95ed30bbb1b5bbbb7142975bc2374bff42a1ca32d7e3262a8351b9501f9709" | "4e6d5aa794b804990a664a53fc6884edf6d3b4fe559888cb7275fd8ff8eb2707" |
| `creepjs.hashes.canvasWebgl` | "1f54957c692d79d320f866162acab102799460113c0a7c60d9dd711541864f99" | "2f98514e2c3a55c1be498396619b84e51d46633edb38362296c2e9c7ed915c68" |
| `creepjs.hashes.clientRects` | "766e078812e0a28a0763bb3784a9aaa8caeb090989d71b4d809356626542c366" | "1ab1ac821cbf3d93de7cc184e69f0803f817c2e6c2d1f95c9a3e5f6a7c39e409" |
| `creepjs.hashes.fonts` | "2795545d3f6da31753bc9703028d75820f3f2f61cb34ecdad984f9bc4956e98a" | "3b9ce27230dbd3c407f699cc81bdc38ca0b2ca2f13e2ce66000294ad366fba41" |
| `creepjs.hashes.headless` | "acd47299711c2c828427098d19bdf803167d7dcb5f695c4f60c335a5056c2f82" | "9e6ef6246fb4a6adfd76cd43cc26bc057d21771909ff42f3fea40422f9f57421" |
| `creepjs.hashes.offlineAudioContext` | "9ef48a839756060413b0976d0557d1e8e68497bbcfbe45553226c1d21e08c70b" | "ecde1aae56157ff175329ddcfa510114c2c98f77a9d70a564431e6ea6afb802d" |
| `creepjs.hashes.screen` | "5ccbceb608522b5b5f702ca3ff96bb2a755ca5b9b939d8e6e1f0fef5df2b6506" | "cfbdd9f67a69b72315a9c3f0e3c44583c6647a728274da47e1ce085a2f8de2f1" |
| `creepjs.hashes.svg` | "ae5898c5b8fc922b5acbab295e1708b77f51befddf1bb07db3a2f293b2676792" | "65993c03d480df03c891354efd75a90ca03cb454880041ca6d89042750129a46" |
| `creepjs.hashes.workerScope` | "484781bca2e6be39ec86cb7f5909ccc225e85b6429ca0f6d3707517fad349885" | "a8f1ecd061a26341fbb76183521449691eb93e51da9e033235b8c004403511ac" |
| `creepjs.headless.likeHeadless.noTaskbar` | true | false |
| `creepjs.headless.likeHeadlessRating` | 13 | 6 |
| `creepjs.screen.$hash` | "5ccbceb608522b5b5f702ca3ff96bb2a755ca5b9b939d8e6e1f0fef5df2b6506" | "cfbdd9f67a69b72315a9c3f0e3c44583c6647a728274da47e1ce085a2f8de2f1" |
| `creepjs.screen.availHeight` | 1080 | 928 |
| `creepjs.screen.availWidth` | 1920 | 1485 |
| `creepjs.svg.svgrectSystemSum` | 0.09519916641235353 | 0.095153166847229 |
| `creepjs.webgl.gpu.compressedGPU` | "NVIDIA GeForce GTX 900s, or similar" | "Intel(R) HD Graphics, or similar" |
| `creepjs.webgl.gpu.parts` | "GeForce, NVIDIA" | "Graphics, Intel, Intel(R) HD Graphics" |
| `creepjs.worker.gpu.compressedGPU` | "NVIDIA GeForce GTX 900s, or similar" | "Intel(R) HD Graphics, or similar" |
| `creepjs.worker.gpu.parts` | "GeForce, NVIDIA" | "Graphics, Intel, Intel(R) HD Graphics" |
| `creepjs.worker.webglRenderer` | "NVIDIA GeForce GTX 980, or similar" | "Intel(R) HD Graphics, or similar" |
| `creepjs.worker.webglVendor` | "NVIDIA Corporation" | "Intel" |

## rebrowser (0)

No differences.
