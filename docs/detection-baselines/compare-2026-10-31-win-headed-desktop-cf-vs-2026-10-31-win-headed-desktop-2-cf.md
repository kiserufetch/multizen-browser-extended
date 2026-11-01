# win-headed-desktop-cf vs win-headed-desktop-2-cf

| | A | B |
| --- | --- | --- |
| label | "win-headed-desktop-cf" | "win-headed-desktop-2-cf" |
| date | "2026-10-31" | "2026-10-31" |
| engine | "camoufox" | "camoufox" |
| engineVersion | "152.0.4-beta.30" | "152.0.4-beta.30" |
| mode | "headed" | "headed" |
| displayMode | "headed" | "headed" |
| egress | "allow-all" | "allow-all" |
| seed | "mz-baseline-70" | "mz-baseline-70" |
| platform | "win32" | "win32" |
| persona | windows-desktop-nvidia | windows-desktop-nvidia |

## Thresholds

None fired: no `HeadlessChrome`, no `webdriver: true`, no `pointer: none`.

150 differences; left out: 19 by the noise rules.

## probe (13)

| path | A | B |
| --- | --- | --- |
| `probe.audio.canvasLikeSum` | 75.80605880259827 | 75.81142122648453 |
| `probe.canvasHash` | -1529483879 | 1766641439 |
| `probe.hardwareConcurrency` | 16 | 8 |
| `probe.screen.availHeight` | 1032 | 1176 |
| `probe.screen.availLeft` | 0 | 2176 |
| `probe.screen.availWidth` | 3840 | 2176 |
| `probe.webgl.canvasHash` | -27177636 | 651605987 |
| `probe.webgl.renderer` | "ANGLE (Intel, Intel(R) HD Graphics Direct3D11 vs_5_0 ps_5_0), or similar" | "ANGLE (Intel, Intel(R) HD Graphics 400 Direct3D11 vs_5_0 ps_5_0), or similar" |
| `probe.webgl.unmaskedRenderer` | "ANGLE (Intel, Intel(R) HD Graphics Direct3D11 vs_5_0 ps_5_0), or similar" | "ANGLE (Intel, Intel(R) HD Graphics 400 Direct3D11 vs_5_0 ps_5_0), or similar" |
| `probe.window.outerHeight` | 1040 | 1190 |
| `probe.window.outerWidth` | 1280 | 2190 |
| `probe.window.screenX` | 0 | 2169 |
| `probe.window.screenY` | 0 | -2 |

## headers (0)

No differences.

## fonts (89)

| path | A | B |
| --- | --- | --- |
| `fonts.baseWidths.monospace` | 674.0499877929688 | 673.4833374023438 |
| `fonts.baseWidths.sans-serif` | 885.816650390625 | 885.5333251953125 |
| `fonts.baseWidths.serif` | 843.3499755859375 | 843.066650390625 |
| `fonts.emoji.canvasHash` | 798022253 | -1004833097 |
| `fonts.emoji.width` | 33.016666412353516 | 33 |
| `fonts.widths.Apple Color Emoji` | 885.816650390625 | 885.5333251953125 |
| `fonts.widths.Arial` | 885.816650390625 | 885.5333251953125 |
| `fonts.widths.Arial Black` | 885.816650390625 | 885.5333251953125 |
| `fonts.widths.Avenir` | 885.816650390625 | 885.5333251953125 |
| `fonts.widths.Bahnschrift` | 872.9500122070312 | 872.6666870117188 |
| `fonts.widths.Calibri` | 838.2333374023438 | 837.9500122070312 |
| `fonts.widths.Cambria` | 874.7333374023438 | 874.4500122070312 |
| `fonts.widths.Cambria Math` | 874.7333374023438 | 874.4500122070312 |
| `fonts.widths.Candara` | 850.7999877929688 | 850.5166625976562 |
| `fonts.widths.Cantarell` | 885.816650390625 | 885.5333251953125 |
| `fonts.widths.Comic Sans MS` | 857.2666625976562 | 856.9833374023438 |
| `fonts.widths.Consolas` | 674.0499877929688 | 673.4833374023438 |
| `fonts.widths.Constantia` | 896.75 | 896.4666748046875 |
| `fonts.widths.Corbel` | 869.4166870117188 | 869.1333618164062 |
| `fonts.widths.Courier New` | 735.5333251953125 | 735.25 |
| `fonts.widths.DejaVu Sans` | 885.816650390625 | 885.5333251953125 |
| `fonts.widths.DejaVu Sans Mono` | 885.816650390625 | 885.5333251953125 |
| `fonts.widths.DejaVu Serif` | 885.816650390625 | 885.5333251953125 |
| `fonts.widths.Droid Sans` | 885.816650390625 | 885.5333251953125 |
| `fonts.widths.Ebrima` | 902.5 | 902.2166748046875 |
| `fonts.widths.Franklin Gothic Medium` | 885.816650390625 | 885.5333251953125 |
| `fonts.widths.FreeSans` | 885.816650390625 | 885.5333251953125 |
| `fonts.widths.Gabriola` | 642.8333129882812 | 642.5499877929688 |
| `fonts.widths.Gadugi` | 902.5 | 902.2166748046875 |
| `fonts.widths.Geneva` | 885.816650390625 | 885.5333251953125 |
| `fonts.widths.Georgia` | 919.1333618164062 | 918.8499755859375 |
| `fonts.widths.Helvetica` | 885.816650390625 | 885.5333251953125 |
| `fonts.widths.Helvetica Neue` | 885.816650390625 | 885.5333251953125 |
| `fonts.widths.HoloLens MDL2 Assets` | 885.816650390625 | 885.5333251953125 |
| `fonts.widths.Impact` | 796.4500122070312 | 796.1666870117188 |
| `fonts.widths.Ink Free` | 790.183349609375 | 789.9000244140625 |
| `fonts.widths.Javanese Text` | 871.2999877929688 | 871.0166625976562 |
| `fonts.widths.Leelawadee UI` | 902.5 | 902.2166748046875 |
| `fonts.widths.Liberation Mono` | 885.816650390625 | 885.5333251953125 |
| `fonts.widths.Liberation Sans` | 885.816650390625 | 885.5333251953125 |
| `fonts.widths.Liberation Serif` | 885.816650390625 | 885.5333251953125 |
| `fonts.widths.Lucida Console` | 738.3666381835938 | 738.0833129882812 |
| `fonts.widths.Lucida Grande` | 885.816650390625 | 885.5333251953125 |
| `fonts.widths.Lucida Sans Unicode` | 960.3499755859375 | 960.066650390625 |
| `fonts.widths.Malgun Gothic` | 922.066650390625 | 921.7833251953125 |
| `fonts.widths.Marlett` | 1209.9666748046875 | 1209.683349609375 |
| `fonts.widths.Menlo` | 885.816650390625 | 885.5333251953125 |
| `fonts.widths.Microsoft Himalaya` | 565.1666870117188 | 564.8833618164062 |
| `fonts.widths.Microsoft JhengHei` | 970.7333374023438 | 970.4500122070312 |
| `fonts.widths.Microsoft New Tai Lue` | 902.5 | 902.2166748046875 |
| `fonts.widths.Microsoft PhagsPa` | 902.5 | 902.2166748046875 |
| `fonts.widths.Microsoft Sans Serif` | 887.066650390625 | 886.7833251953125 |
| `fonts.widths.Microsoft Tai Le` | 902.5 | 902.2166748046875 |
| `fonts.widths.Microsoft YaHei` | 981.4500122070312 | 981.1666870117188 |
| `fonts.widths.Microsoft Yi Baiti` | 669.7666625976562 | 669.4833374023438 |
| `fonts.widths.MingLiU-ExtB` | 612.8499755859375 | 612.566650390625 |
| `fonts.widths.Monaco` | 885.816650390625 | 885.5333251953125 |
| `fonts.widths.Mongolian Baiti` | 843.3499755859375 | 843.066650390625 |
| `fonts.widths.MS Gothic` | 612.8499755859375 | 612.566650390625 |
| `fonts.widths.MV Boli` | 883.5999755859375 | 883.2999877929688 |
| `fonts.widths.Myanmar Text` | 902.5 | 902.2166748046875 |
| `fonts.widths.Nirmala UI` | 902.5 | 902.2166748046875 |
| `fonts.widths.Noto Color Emoji` | 885.816650390625 | 885.5333251953125 |
| `fonts.widths.Noto Sans` | 885.816650390625 | 885.5333251953125 |
| `fonts.widths.Noto Sans CJK SC` | 885.816650390625 | 885.5333251953125 |
| `fonts.widths.Noto Serif` | 885.816650390625 | 885.5333251953125 |
| `fonts.widths.Palatino Linotype` | 913.2000122070312 | 912.9166870117188 |
| `fonts.widths.Roboto` | 885.816650390625 | 885.5333251953125 |
| `fonts.widths.San Francisco` | 885.816650390625 | 885.5333251953125 |
| `fonts.widths.Segoe MDL2 Assets` | 885.816650390625 | 885.5333251953125 |
| `fonts.widths.Segoe Print` | 1046.0999755859375 | 1045.816650390625 |
| `fonts.widths.Segoe Script` | 1060.7833251953125 | 1060.5 |
| `fonts.widths.Segoe UI` | 902.5 | 902.2166748046875 |
| `fonts.widths.Segoe UI Emoji` | 902.5 | 902.2166748046875 |
| `fonts.widths.Segoe UI Historic` | 902.5 | 902.2166748046875 |
| `fonts.widths.Segoe UI Symbol` | 902.5 | 902.2166748046875 |
| `fonts.widths.SF Pro Text` | 885.816650390625 | 885.5333251953125 |
| `fonts.widths.SimSun` | 612.8499755859375 | 612.566650390625 |
| `fonts.widths.Sitka Text` | 801.1500244140625 | 800.8666381835938 |
| `fonts.widths.Sylfaen` | 879.4833374023438 | 879.2000122070312 |
| `fonts.widths.Symbol` | 881.7666625976562 | 881.4833374023438 |
| `fonts.widths.Tahoma` | 875.8499755859375 | 875.566650390625 |
| `fonts.widths.Times New Roman` | 843.3499755859375 | 843.066650390625 |
| `fonts.widths.Trebuchet MS` | 864.7833251953125 | 864.5 |
| `fonts.widths.Ubuntu` | 885.816650390625 | 885.5333251953125 |
| `fonts.widths.Verdana` | 1006.1500244140625 | 1005.8666381835938 |
| `fonts.widths.Webdings` | 873.7000122070312 | 873.4166870117188 |
| `fonts.widths.Wingdings` | 1128.7332763671875 | 1128.449951171875 |
| `fonts.widths.Yu Gothic` | 898.1666870117188 | 897.8833618164062 |

## input (0)

No differences.

## tls (0)

No differences.

## h2 (0)

No differences.

## webrtc (0)

No differences.

## creepjs (27)

| path | A | B |
| --- | --- | --- |
| `creepjs.audio.floatFrequencyDataSum` | 167703.60290145874 | 167702.83625030518 |
| `creepjs.audio.floatTimeDomainDataSum` | 148.42733637981655 | 148.44089752493164 |
| `creepjs.audio.sampleSum` | 35.738699748722865 | 35.74116016186963 |
| `creepjs.canvas.mods.pixelImage` | "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAYAAACM/rhtAAAAR0lEQVRYR+3QMQ0AMAzAsJU/6A6Enx4xgiizu/sOmwJRB1UHVQdVB1UHVQdVB1UHVQdVB1UHVQdVB1UHVQdVB1UHVQfV+YMfyAWfiSN598oAAAAQZGVCR0MxNTQ5RENBRUMzM0M4RjBjT0KxAAAAAElFTkSuQmCC" | "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAYAAACM/rhtAAAAR0lEQVRYR+3QMQ0AMAzAsJU/6A6Enx4xgiizu/sOmwJRB1UHVQdVB1UHVQdVB1UHVQdVB1UHVQdVB1UHVQdVB1UHVQfV+YMfyAWfiSN598oAAAAQZGVCRzA3RjU2RTNENjgzMDBDMEEHHiG+AAAAAElFTkSuQmCC" |
| `creepjs.canvas.textMetricsSystemSum` | 0.020432301754315697 | 0.020423801442782084 |
| `creepjs.clientRects.domrectSystemSum` | 0.024241666412353518 | 0.02424066650390625 |
| `creepjs.fingerprintId` | "FP ID: 9a570e7fc84361f082b9a3dddcab68119f051ce9a654d506b49ef39dec925048" | "FP ID: 8899eea64d9baad299bf96978062de3bfec9767b097b0b62eed2094b78e45add" |
| `creepjs.fonts.$hash` | "f2d9d729ace224c940f0ef6075e7132120a921dc01f8184c3cdefc0a7f2d2cda" | "56f78bd3f0ba3f1cfe5ff1f6292d22524c22f61465f9c8d436fabc3f40cc4c9c" |
| `creepjs.fonts.pixelSizeSystemSum` | 0.024217839999999997 | 0.02421683 |
| `creepjs.hashes.canvas2d` | "c5979a9af4e65d89d03240a87278cadcd52737c918d48f20c646434e2bc8a4c9" | "1d781aed8f642c39d27fe71fd27744662122ac5e14cf1bef20d469db8ec6286a" |
| `creepjs.hashes.canvasWebgl` | "52540528d21c07432dc2f03979bda87d746b273b78b2bf7e4b6dcc342c787560" | "830d986085856ac87e67be859cc44c1a42ec3f4e4dae1c31c569b1f6bf0a7171" |
| `creepjs.hashes.clientRects` | "fe33b66559415c82d89eed9551c27d2dfb44cc7a9aacb0d828d963c32c10ce2d" | "191c7b752b5215a76982ae002edaa85c7da747ecf82d3d77307e3c89c87dc6a3" |
| `creepjs.hashes.fonts` | "f2d9d729ace224c940f0ef6075e7132120a921dc01f8184c3cdefc0a7f2d2cda" | "56f78bd3f0ba3f1cfe5ff1f6292d22524c22f61465f9c8d436fabc3f40cc4c9c" |
| `creepjs.hashes.navigator` | "bc743099ddc327c8e1758ca7161360da8057d26f848a418211ca2c71ee192e02" | "65137c72cc58d8fdaff94440721446ab7afa9cbbcc4a8556d30b7ad61f0b2c20" |
| `creepjs.hashes.offlineAudioContext` | "dc42b89901edd95bf6a86f6dab8fc73cb9280d57c455f5a6c9668460387564d2" | "4c08ef948207dd844fad56696e062e82f503f9ecc94b200660205e566358c787" |
| `creepjs.hashes.screen` | "de61910f3a1e8e84513fa0d1aeba3226c8c5178eb8ce6f92667247d3e99ee9e7" | "c6e9518139fd7440bd78f7858e2d4d67243c7a14ba2bf95ae02ce696ac9a4769" |
| `creepjs.hashes.svg` | "f9644582a60a5a533e5288629207529338e0a8a8a491da22fc8481ea79dbbae7" | "e772dc322cc80e9ef9c13288b048def46a78eb02f8a1a5a8e79099a336f499c9" |
| `creepjs.hashes.workerScope` | "a88714f344f512967aaabd293b1169b755c8a1a805c6e112f3cc91a092dfb699" | "785d0e5209cb77cdc24ada917246c066cc291d6df9338da62f3c793bf7cc21ab" |
| `creepjs.navigator.hardwareConcurrency` | 16 | 8 |
| `creepjs.screen.$hash` | "de61910f3a1e8e84513fa0d1aeba3226c8c5178eb8ce6f92667247d3e99ee9e7" | "c6e9518139fd7440bd78f7858e2d4d67243c7a14ba2bf95ae02ce696ac9a4769" |
| `creepjs.screen.availHeight` | 1032 | 1176 |
| `creepjs.screen.availWidth` | 3840 | 2176 |
| `creepjs.svg.svgrectSystemSum` | 0.010397833099365235 | 0.01039683334350586 |
| `creepjs.webgl.gpu.compressedGPU` | "Intel, Intel(R) HD Graphics" | "Intel, Intel(R) HD Graphics 400s" |
| `creepjs.worker.gpu.compressedGPU` | "Intel, Intel(R) HD Graphics" | "Intel, Intel(R) HD Graphics 400s" |
| `creepjs.worker.hardwareConcurrency` | 16 | 8 |
| `creepjs.worker.webglRenderer` | "ANGLE (Intel, Intel(R) HD Graphics Direct3D11 vs_5_0 ps_5_0), or similar" | "ANGLE (Intel, Intel(R) HD Graphics 400 Direct3D11 vs_5_0 ps_5_0), or similar" |

## rebrowser (0)

No differences.

## covered (21)

| path | A | B |
| --- | --- | --- |
| `covered.after.changes` |  | (absent) |
| `covered.after.gettingFrames` | true | (absent) |
| `covered.after.hasFocus` | true | (absent) |
| `covered.after.paints` | 1 | (absent) |
| `covered.after.visibility` | "visible" | (absent) |
| `covered.before.changes` |  | (absent) |
| `covered.before.gettingFrames` | true | (absent) |
| `covered.before.hasFocus` | true | (absent) |
| `covered.before.paints` | 1 | (absent) |
| `covered.before.visibility` | "visible" | (absent) |
| `covered.clickWhileCovered` | "click did not finish within 7000 ms" | (absent) |
| `covered.covered1.changes` |  | (absent) |
| `covered.covered1.gettingFrames` | true | (absent) |
| `covered.covered1.hasFocus` | true | (absent) |
| `covered.covered1.paints` | 1 | (absent) |
| `covered.covered1.visibility` | "visible" | (absent) |
| `covered.covered2.changes` |  | (absent) |
| `covered.covered2.gettingFrames` | true | (absent) |
| `covered.covered2.hasFocus` | true | (absent) |
| `covered.covered2.paints` | 1 | (absent) |
| `covered.covered2.visibility` | "visible" | (absent) |
