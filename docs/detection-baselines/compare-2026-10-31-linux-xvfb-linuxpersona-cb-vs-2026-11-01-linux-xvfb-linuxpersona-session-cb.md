# linux-xvfb-linuxpersona-cb vs linux-xvfb-linuxpersona-session-cb

| | A | B |
| --- | --- | --- |
| label | "linux-xvfb-linuxpersona-cb" | "linux-xvfb-linuxpersona-session-cb" |
| date | "2026-10-31" | "2026-11-01" |
| engine | "cloakbrowser" | "cloakbrowser" |
| engineVersion | "146.0.7680.177.5" | "146.0.7680.177.5" |
| mode | "xvfb" | "xvfb" |
| displayMode | "xvfb" | "xvfb" |
| egress | "block-private" | "block-private" |
| seed | "mz-baseline-70" | "mz-baseline-70" |
| platform | "linux" | "linux" |
| persona | linux-laptop-nvidia | linux-laptop-nvidia |

## Thresholds

None fired: no `HeadlessChrome`, no `webdriver: true`, no `pointer: none`.

57 differences; left out: 18 by the noise rules, 2 that also differ between a setup and its own repeat.

## probe (9)

| path | A | B |
| --- | --- | --- |
| `probe.audio.live.baseLatency` | 0.0091875 | 0.010666666666666666 |
| `probe.devices` | audiooutput, audiooutput, audioinput, videoinput | audioinput, audiooutput |
| `probe.gpu.architecture` | "lovelace" | "ampere" |
| `probe.screen.availHeight` | 1440 | 1410 |
| `probe.webgl.params.MAX_RENDERBUFFER_SIZE` | 16384 | 32768 |
| `probe.webgl.params.MAX_TEXTURE_SIZE` | 16384 | 32768 |
| `probe.webgl.unmaskedRenderer` | "NV178" | "ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 3060 Laptop GPU/PCIe/SSE2, OpenGL 4.5.0 NVIDIA 550.120)" |
| `probe.webgl.unmaskedVendor` | "Mesa" | "Google Inc. (NVIDIA Corporation)" |
| `probe.window.outerHeight` | 1440 | 1410 |

## headers (0)

No differences.

## fonts (9)

| path | A | B |
| --- | --- | --- |
| `fonts.counts.linux` | 8 | 11 |
| `fonts.counts.windows` | 3 | 5 |
| `fonts.present.linux` | only here (0 of 8):  | only here (3 of 11): Ubuntu, Cantarell, FreeSans |
| `fonts.present.windows` | Arial, Courier New, Times New Roman | Arial, Calibri, Cambria, Courier New, Times New Roman |
| `fonts.widths.Calibri` | 884.8487912324292 | 837.3174802647211 |
| `fonts.widths.Cambria` | 884.8487912324292 | 839.2334373121346 |
| `fonts.widths.Cantarell` | 884.8487912324292 | 923.76149983659 |
| `fonts.widths.FreeSans` | 884.8487912324292 | 868.4654084013007 |
| `fonts.widths.Ubuntu` | 884.8487912324292 | 907.4174847317391 |

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
| `creepjs.canvas.textMetricsSystemSum` | 0.014236453807763283 | 0.014303734320088388 |
| `creepjs.clientRects.domrectSystemSum` | 0.061512146377563484 | 0.06810501136779785 |
| `creepjs.fingerprintId` | "FP ID: 578c05e076c62f94236eaeedc99d770d1581cc87712379801b1230ce91dfbe46" | "FP ID: f67d72919ab9cb66f1b0c62d0873ccede6baa91824ad71277ba7eff5208004cd" |
| `creepjs.fonts.$hash` | "77cb1c9da50d0c00396116866f01096cb17aae70eded90782f1cd404e517335d" | "7ed462d18ac9c66bdd5c7a75b408f843899b3d1c3c4e990f6422ff3027ae781e" |
| `creepjs.fonts.emojiSet` | only here (0 of 15):  | only here (2 of 17): ©, ™ |
| `creepjs.fonts.fontFaceLoadFonts` | "DejaVu Sans", "Liberation Mono", "Noto Color Emoji" | "DejaVu Sans", "Liberation Mono", "Noto Color Emoji", Ubuntu |
| `creepjs.fonts.pixelSizeSystemSum` | 0.061450784 | 0.068037024 |
| `creepjs.hashes.canvas2d` | "985a672b99777d52e3cc6354ae57683de3701413c5d7a18354009619986524db" | "85eca175699c464fb2f30ff4db636be5fdaefda11ac1a306d492c261b5368bf5" |
| `creepjs.hashes.canvasWebgl` | "c47ed215a3c62475feaff723953cf697dcdb0b0a8112af2fcab17d62262d7c83" | "112a4814ea1a70909ddd9ef0310ef181c1a211a2d3ce3160b64d1d55bfb32ef2" |
| `creepjs.hashes.clientRects` | "47e68312baa685ad080dd93cbed1a24f276ff3bc3415010a6904189d6684dc22" | "59ab0731b763464ecfcfb10ab0fd3eda517754bc97cc48c4ca3fba3825fbf391" |
| `creepjs.hashes.fonts` | "77cb1c9da50d0c00396116866f01096cb17aae70eded90782f1cd404e517335d" | "7ed462d18ac9c66bdd5c7a75b408f843899b3d1c3c4e990f6422ff3027ae781e" |
| `creepjs.hashes.headless` | "9e8ce6c4f44d8545a7497b418145ace6d03e297c0f0d5fd4407d5a54b8f0bec0" | "b96a4bee2cd789f1daf7484c21a4fcb67bae6891bba219288bd480622af7da73" |
| `creepjs.hashes.navigator` | "e676fc2283410b82a6ca9eb4d3c3acf06f1f5282b8c20345f9db30f0c3847ca6" | "284974d79b7f302958d2ca99e236e72cf0479a6763ddafc11c846ea686c9e48a" |
| `creepjs.hashes.screen` | "01514f9ae61b59349f53aefddf677d812e8a51491e8d29baf03e211bb2841990" | "b57e72f6cf79dd54d64c70234693bbd060c695630103cb976e247ee6dbee3c76" |
| `creepjs.hashes.svg` | "92988e52ad8ffc64a84e4853addb37e679174faacbc813af04cbebe620d590d7" | "a414038acb289ec0ceeeb8175fb0d3ed4a3e28b94b5595a829e76b19346d4856" |
| `creepjs.hashes.trash` | "cc8fe7dc8aa60e3584c5058944ebfdc44a3432aef2e1635de6a7275bb2d642ca" | "1e322b56b3457db4170759c3cc1a1eca3bc5ffc4cbef8a668153382f8118ce19" |
| `creepjs.hashes.workerScope` | "57317665739145e38b32c48b057324aef9ca07808230450c270da9820fcd2b27" | "97b55929110d32edc9c0a798a805c305da71d1aa5da3d42dcf740d51e2709e8b" |
| `creepjs.headless.likeHeadless.hasVvpScreenRes` | true | false |
| `creepjs.headless.likeHeadless.noTaskbar` | true | false |
| `creepjs.headless.likeHeadlessRating` | 50 | 38 |
| `creepjs.screen.$hash` | "01514f9ae61b59349f53aefddf677d812e8a51491e8d29baf03e211bb2841990" | "b57e72f6cf79dd54d64c70234693bbd060c695630103cb976e247ee6dbee3c76" |
| `creepjs.screen.availHeight` | 1440 | 1410 |
| `creepjs.svg.svgrectSystemSum` | 0.02473778793334961 | 0.0278837077331543 |
| `creepjs.trash.count` | 3 | 4 |
| `creepjs.trash.items[1].name` | "AudioBuffer" | "WebGLRenderingContext.getParameter" |
| `creepjs.trash.items[1].value` | "5000 unique samples of 5000 is too high" | "suspicious capabilities" |
| `creepjs.trash.items[2].value` | "suspicious frequency data" | "5000 unique samples of 5000 is too high" |
| `creepjs.trash.items[3].name` | (absent) | "AudioBuffer" |
| `creepjs.trash.items[3].value` | (absent) | "suspicious frequency data" |
| `creepjs.webgl.gpu.compressedGPU` | "NV178" | "NVIDIA Corporation, NVIDIA GeForce RTX 3000s Laptop GPU/PCIe/SSE2, OpenGL 4.5.0 )" |
| `creepjs.webgl.gpu.confidence` | "low" | "high" |
| `creepjs.webgl.gpu.grade` | "F" | "A" |
| `creepjs.webgl.gpu.parts` | "" | "ANGLE, GeForce, NVIDIA, NVIDIA Corporation, OpenGL, PCIe, SSE2" |
| `creepjs.worker.gpu.compressedGPU` | "NV178" | "NVIDIA Corporation, NVIDIA GeForce RTX 3000s Laptop GPU/PCIe/SSE2, OpenGL 4.5.0 )" |
| `creepjs.worker.gpu.confidence` | "low" | "high" |
| `creepjs.worker.gpu.grade` | "F" | "A" |
| `creepjs.worker.gpu.parts` | "" | "ANGLE, GeForce, NVIDIA, NVIDIA Corporation, OpenGL, PCIe, SSE2" |
| `creepjs.worker.webglRenderer` | "NV178" | "ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 3060 Laptop GPU/PCIe/SSE2, OpenGL 4.5.0 NVIDIA 550.120)" |
| `creepjs.worker.webglVendor` | "Mesa" | "Google Inc. (NVIDIA Corporation)" |

## rebrowser (0)

No differences.
