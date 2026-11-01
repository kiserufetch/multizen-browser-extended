# linux-xvfb-server-cf vs linux-xvfb-server-2-cf

| | A | B |
| --- | --- | --- |
| label | "linux-xvfb-server-cf" | "linux-xvfb-server-2-cf" |
| date | "2026-11-01" | "2026-11-01" |
| engine | "camoufox" | "camoufox" |
| engineVersion | "152.0.4-beta.30" | "152.0.4-beta.30" |
| mode | "xvfb" | "xvfb" |
| displayMode | "xvfb" | "xvfb" |
| egress | "block-private" | "block-private" |
| seed | "mz-baseline-70" | "mz-baseline-70" |
| platform | "linux" | "linux" |
| persona | windows-desktop-nvidia | windows-desktop-nvidia |

## Thresholds

None fired: no `HeadlessChrome`, no `webdriver: true`, no `pointer: none`.

62 differences; left out: 15 by the noise rules.

## probe (16)

| path | A | B |
| --- | --- | --- |
| `probe.audio.canvasLikeSum` | 75.80299832197488 | 75.78084133510129 |
| `probe.canvasHash` | 1631877678 | 493080419 |
| `probe.hardwareConcurrency` | 16 | 12 |
| `probe.screen.availHeight` | 1032 | 900 |
| `probe.screen.availLeft` | 0 | 2560 |
| `probe.screen.availTop` | 0 | 532 |
| `probe.screen.availWidth` | 3840 | 1600 |
| `probe.webgl.canvasHash` | 1039652471 | -710114799 |
| `probe.webgl.renderer` | "ANGLE (NVIDIA, NVIDIA GeForce GTX 980 Direct3D11 vs_5_0 ps_5_0), or similar" | "ANGLE (Intel, Intel(R) HD Graphics 400 Direct3D11 vs_5_0 ps_5_0), or similar" |
| `probe.webgl.unmaskedRenderer` | "ANGLE (NVIDIA, NVIDIA GeForce GTX 980 Direct3D11 vs_5_0 ps_5_0), or similar" | "ANGLE (Intel, Intel(R) HD Graphics 400 Direct3D11 vs_5_0 ps_5_0), or similar" |
| `probe.webgl.unmaskedVendor` | "Google Inc. (NVIDIA)" | "Google Inc. (Intel)" |
| `probe.window.historyLength` | 4 | 2 |
| `probe.window.outerHeight` | 1040 | 916 |
| `probe.window.outerWidth` | 1280 | 1616 |
| `probe.window.screenX` | 0 | 2552 |
| `probe.window.screenY` | 0 | -13 |

## headers (0)

No differences.

## fonts (14)

| path | A | B |
| --- | --- | --- |
| `fonts.emoji.canvasHash` | 1499141355 | 258327315 |
| `fonts.widths.Bahnschrift` | 873.183349609375 | 873.1500244140625 |
| `fonts.widths.Calibri` | 838.4500122070312 | 838.433349609375 |
| `fonts.widths.Candara` | 850.8499755859375 | 850.8333129882812 |
| `fonts.widths.Constantia` | 897.0166625976562 | 897 |
| `fonts.widths.Corbel` | 869.6666870117188 | 869.6500244140625 |
| `fonts.widths.Georgia` | 919.2333374023438 | 919.2166748046875 |
| `fonts.widths.Microsoft JhengHei` | 971 | 970.8333129882812 |
| `fonts.widths.Microsoft YaHei` | 981.7166748046875 | 981.7000122070312 |
| `fonts.widths.Segoe Script` | 1061 | 1060.9832763671875 |
| `fonts.widths.Tahoma` | 876.0999755859375 | 876.066650390625 |
| `fonts.widths.Trebuchet MS` | 865.0499877929688 | 865.0333251953125 |
| `fonts.widths.Verdana` | 1006.4000244140625 | 1006.3333129882812 |
| `fonts.widths.Yu Gothic` | 898.4500122070312 | 898.433349609375 |

## input (1)

| path | A | B |
| --- | --- | --- |
| `input.click.sequence` | pointerover, pointerenter, mouseover, mouseenter, pointerout, pointerover, pointerenter, mouseout, mouseover, mouseenter, pointerout, pointerleave, pointerover, pointerenter, pointermove+, mouseout, mouseleave, mouseover, mouseenter, mousemove+, pointerdown, mousedown, focus, focusin, pointerup, poi... (other order) | pointerover, pointerenter, mouseover, mouseenter, pointerout, pointerleave, pointerover, pointerenter, pointermove+, mouseout, mouseleave, mouseover, mouseenter, mousemove+, pointerdown, mousedown, focus, focusin, pointerup, pointerout, pointerleave, mouseup, click |

## tls (0)

No differences.

## h2 (0)

No differences.

## webrtc (0)

No differences.

## creepjs (31)

| path | A | B |
| --- | --- | --- |
| `creepjs.audio.floatFrequencyDataSum` | 167704.39246749878 | 167702.8916015625 |
| `creepjs.audio.floatTimeDomainDataSum` | 148.41428066941808 | 148.42038142422098 |
| `creepjs.audio.sampleSum` | 35.73720329560456 | 35.72679038360002 |
| `creepjs.audio.totalUniqueSamples` | 4734 | 4736 |
| `creepjs.canvas.mods.pixelImage` | "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAYAAACM/rhtAAAAR0lEQVRYR+3QMQ0AMAzAsJU/6A6Enx4xgiizu/sOmwJRB1UHVQdVB1UHVQdVB1UHVQdVB1UHVQdVB1UHVQdVB1UHVQfV+YMfyAWfiSN598oAAAAQZGVCRzhEQkUxMUM0QkM1QTY4NUKx0j9DAAAAAElFTkSuQmCC" | "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAYAAACM/rhtAAAAR0lEQVRYR+3QMQ0AMAzAsJU/6A6Enx4xgiizu/sOmwJRB1UHVQdVB1UHVQdVB1UHVQdVB1UHVQdVB1UHVQdVB1UHVQfV+YMfyAWfiSN598oAAAAQZGVCR0IyMTAwRTQ0QjQ3MkIzMEN2sluWAAAAAElFTkSuQmCC" |
| `creepjs.canvas.textMetricsSystemSum` | 0.04328900002002716 | 0.04328833335399628 |
| `creepjs.clientRects.domrectSystemSum` | 0.11566283355712892 | 0.11566216629028321 |
| `creepjs.fingerprintId` | "FP ID: 157693046ffccf2f0fd44b7b0b189ffb368c54a682c51e7e37dff0b4eda4d6a2" | "FP ID: b2c21b5d57e05cc46a52861bef81d1dc560a0ce31c52b0604fbadcdc02a7e969" |
| `creepjs.fonts.$hash` | "9bfe439855fb88a50f08cb396a330bc90b4a41da08ff82829e72e8e53d650afb" | "dfeea954fcb77904ba523dc365f3512479143d51a69055fcb8091e3b21ae46cf" |
| `creepjs.fonts.pixelSizeSystemSum` | 0.11554701000000002 | 0.11554634000000003 |
| `creepjs.hashes.canvas2d` | "4132d6067732cda1c7842ad405486411e3b2e80df3964906ced28311926ef6e3" | "8874f3868a97844363dc7bd916063297ed0c4f9b296afcd6538bd479cfb4be52" |
| `creepjs.hashes.canvasWebgl` | "ed17043be20af3cfef71e75f373fc28385c9198f547dac5b626726522c84126c" | "7febe92dc76f7b8b0e125dcf2a76b8828bb041dafd090b13b4718dfe5d983bcd" |
| `creepjs.hashes.clientRects` | "3645c2f6fa13f0e60d9bba0dc4b3c830f64debe4049952e7d7399f9849c9fab1" | "4e623b81db8ddb81f87c90827b3ca009c963efce6e4482d5e01ebc039512a74c" |
| `creepjs.hashes.fonts` | "9bfe439855fb88a50f08cb396a330bc90b4a41da08ff82829e72e8e53d650afb" | "dfeea954fcb77904ba523dc365f3512479143d51a69055fcb8091e3b21ae46cf" |
| `creepjs.hashes.navigator` | "9debb49fa617787194c7ed742cb98d3302069e7cb3b493f265ae759af8071108" | "5c80439364a405c29edc72d5c025186551f58c38d1ba6444d89abd7b4abcdc9c" |
| `creepjs.hashes.offlineAudioContext` | "56be3c9eb26d9190800034d1daacebe23617b95e124a182a8f4f486c4825b868" | "9a7a302f32a777eebceb7c2521f5b4826e71f57cdd26ec1f089e61b5a0f15100" |
| `creepjs.hashes.screen` | "de61910f3a1e8e84513fa0d1aeba3226c8c5178eb8ce6f92667247d3e99ee9e7" | "b7b973fc949731f892504ad805c3ab3d9415aa224f36706bb1da7b13170ac336" |
| `creepjs.hashes.svg` | "9f52d63678ef2c36af0cd318de6e58f63a4415f1d7fc7174401fff82f1a8e75b" | "7d1c43dc88f01f71fa6b7a97dfc5a252ba524b733fe63dc9ef0b1a610b2f5a37" |
| `creepjs.hashes.workerScope` | "943d99adc6c596455b70cdada8db3112f80bdedeb1b4a02db0e1980ec1dad01c" | "f493390df9444cd761c926882490f470b442d2503a34bea97f47fd991fbcd389" |
| `creepjs.navigator.hardwareConcurrency` | 16 | 12 |
| `creepjs.screen.$hash` | "de61910f3a1e8e84513fa0d1aeba3226c8c5178eb8ce6f92667247d3e99ee9e7" | "b7b973fc949731f892504ad805c3ab3d9415aa224f36706bb1da7b13170ac336" |
| `creepjs.screen.availHeight` | 1032 | 900 |
| `creepjs.screen.availWidth` | 3840 | 1600 |
| `creepjs.svg.svgrectSystemSum` | 0.0550369995880127 | 0.05503633308410645 |
| `creepjs.webgl.gpu.compressedGPU` | "NVIDIA, NVIDIA GeForce GTX 900s" | "Intel, Intel(R) HD Graphics 400s" |
| `creepjs.webgl.gpu.parts` | "ANGLE, Direct3D, GeForce, NVIDIA" | "ANGLE, Direct3D, Graphics, Intel, Intel(R) HD Graphics" |
| `creepjs.worker.gpu.compressedGPU` | "NVIDIA, NVIDIA GeForce GTX 900s" | "Intel, Intel(R) HD Graphics 400s" |
| `creepjs.worker.gpu.parts` | "ANGLE, Direct3D, GeForce, NVIDIA" | "ANGLE, Direct3D, Graphics, Intel, Intel(R) HD Graphics" |
| `creepjs.worker.hardwareConcurrency` | 16 | 12 |
| `creepjs.worker.webglRenderer` | "ANGLE (NVIDIA, NVIDIA GeForce GTX 980 Direct3D11 vs_5_0 ps_5_0), or similar" | "ANGLE (Intel, Intel(R) HD Graphics 400 Direct3D11 vs_5_0 ps_5_0), or similar" |
| `creepjs.worker.webglVendor` | "Google Inc. (NVIDIA)" | "Google Inc. (Intel)" |

## rebrowser (0)

No differences.
