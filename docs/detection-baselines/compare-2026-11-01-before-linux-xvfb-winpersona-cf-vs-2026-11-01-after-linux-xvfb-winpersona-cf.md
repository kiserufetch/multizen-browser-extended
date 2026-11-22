# before-linux-xvfb-winpersona-cf vs after-linux-xvfb-winpersona-cf

| | A | B |
| --- | --- | --- |
| label | "before-linux-xvfb-winpersona-cf" | "after-linux-xvfb-winpersona-cf" |
| date | "2026-11-01" | "2026-11-01" |
| engine | "camoufox" | "camoufox" |
| engineVersion | "152.0.4-beta.30" | "152.0.4-beta.30" |
| mode | "xvfb" | "xvfb" |
| displayMode | "xvfb" | "xvfb" |
| egress | "allow-all" | "allow-all" |
| seed | "mz-baseline-70" | "mz-baseline-70" |
| platform | "linux" | "linux" |
| persona | windows-desktop-nvidia | windows-desktop-nvidia |

## Thresholds

None fired: no `HeadlessChrome`, no `webdriver: true`, no `pointer: none`.

130 differences; left out: 15 by the noise rules, 8 that also differ between a setup and its own repeat.

## probe (13)

| path | A | B |
| --- | --- | --- |
| `probe.audio.canvasLikeSum` | 75.78586850187276 | 75.81088914720749 |
| `probe.hardwareConcurrency` | 12 | 8 |
| `probe.screen.availHeight` | 1680 | 1040 |
| `probe.screen.availWidth` | 3072 | 1920 |
| `probe.webgl.renderer` | "ANGLE (NVIDIA, NVIDIA GeForce GTX 980 Direct3D11 vs_5_0 ps_5_0), or similar" | "ANGLE (NVIDIA, NVIDIA GeForce GTX 480 Direct3D11 vs_5_0 ps_5_0), or similar" |
| `probe.webgl.unmaskedRenderer` | "ANGLE (NVIDIA, NVIDIA GeForce GTX 980 Direct3D11 vs_5_0 ps_5_0), or similar" | "ANGLE (NVIDIA, NVIDIA GeForce GTX 480 Direct3D11 vs_5_0 ps_5_0), or similar" |
| `probe.window.innerHeight` | 720 | 961 |
| `probe.window.innerWidth` | 1280 | 1920 |
| `probe.window.outerHeight` | 1311 | 1056 |
| `probe.window.outerWidth` | 1786 | 1936 |
| `probe.window.screenX` | 645 | -8 |
| `probe.window.screenY` | 154 | -8 |
| `probe.window.visualViewport` | 1280, 720, 1 | 1920, 961, 1 |

## headers (0)

No differences.

## fonts (88)

| path | A | B |
| --- | --- | --- |
| `fonts.baseWidths.monospace` | 885.2333374023438 | 886.1500244140625 |
| `fonts.baseWidths.sans-serif` | 885.2333374023438 | 886.1500244140625 |
| `fonts.baseWidths.serif` | 885.2333374023438 | 886.1500244140625 |
| `fonts.emoji.width` | 24.016666412353516 | 24.08333396911621 |
| `fonts.widths.Apple Color Emoji` | 885.2333374023438 | 886.1500244140625 |
| `fonts.widths.Arial` | 885.2333374023438 | 886.1500244140625 |
| `fonts.widths.Arial Black` | 1025.550048828125 | 1026.5999755859375 |
| `fonts.widths.Avenir` | 885.2333374023438 | 886.1500244140625 |
| `fonts.widths.Bahnschrift` | 872.3499755859375 | 873.433349609375 |
| `fonts.widths.Calibri` | 837.6500244140625 | 838.7166748046875 |
| `fonts.widths.Cambria` | 874.1500244140625 | 875.0833129882812 |
| `fonts.widths.Cambria Math` | 874.1500244140625 | 875.0833129882812 |
| `fonts.widths.Candara` | 850.2333374023438 | 851.1166381835938 |
| `fonts.widths.Cantarell` | 885.2333374023438 | 886.1500244140625 |
| `fonts.widths.Comic Sans MS` | 856.7000122070312 | 857.7666625976562 |
| `fonts.widths.Consolas` | 673.2000122070312 | 674.3333129882812 |
| `fonts.widths.Constantia` | 896.183349609375 | 897.2833251953125 |
| `fonts.widths.Corbel` | 868.8499755859375 | 869.75 |
| `fonts.widths.Courier New` | 734.9666748046875 | 735.816650390625 |
| `fonts.widths.DejaVu Sans` | 885.2333374023438 | 886.1500244140625 |
| `fonts.widths.DejaVu Sans Mono` | 885.2333374023438 | 886.1500244140625 |
| `fonts.widths.DejaVu Serif` | 885.2333374023438 | 886.1500244140625 |
| `fonts.widths.Droid Sans` | 885.2333374023438 | 886.1500244140625 |
| `fonts.widths.Ebrima` | 901.8666381835938 | 903 |
| `fonts.widths.Franklin Gothic Medium` | 883.4500122070312 | 884.566650390625 |
| `fonts.widths.FreeSans` | 885.2333374023438 | 886.1500244140625 |
| `fonts.widths.Gabriola` | 642.2333374023438 | 643.1500244140625 |
| `fonts.widths.Gadugi` | 901.8666381835938 | 903 |
| `fonts.widths.Geneva` | 885.2333374023438 | 886.1500244140625 |
| `fonts.widths.Georgia` | 918.5499877929688 | 919.4833374023438 |
| `fonts.widths.Helvetica` | 885.2333374023438 | 886.1500244140625 |
| `fonts.widths.Helvetica Neue` | 885.2333374023438 | 886.1500244140625 |
| `fonts.widths.HoloLens MDL2 Assets` | 789.6166381835938 | 886.1500244140625 |
| `fonts.widths.Impact` | 795.8833618164062 | 796.9000244140625 |
| `fonts.widths.Ink Free` | 789.6166381835938 | 790.7333374023438 |
| `fonts.widths.Javanese Text` | 870.7333374023438 | 871.816650390625 |
| `fonts.widths.Leelawadee UI` | 901.8666381835938 | 903 |
| `fonts.widths.Liberation Mono` | 885.2333374023438 | 886.1500244140625 |
| `fonts.widths.Liberation Sans` | 885.2333374023438 | 886.1500244140625 |
| `fonts.widths.Liberation Serif` | 885.2333374023438 | 886.1500244140625 |
| `fonts.widths.Lucida Console` | 737.7999877929688 | 738.933349609375 |
| `fonts.widths.Lucida Grande` | 885.2333374023438 | 886.1500244140625 |
| `fonts.widths.Lucida Sans Unicode` | 959.7666625976562 | 960.8666381835938 |
| `fonts.widths.Malgun Gothic` | 921.4833374023438 | 922.566650390625 |
| `fonts.widths.Marlett` | 1209.38330078125 | 1210.5 |
| `fonts.widths.Menlo` | 885.2333374023438 | 886.1500244140625 |
| `fonts.widths.Microsoft Himalaya` | 564.5833129882812 | 565.683349609375 |
| `fonts.widths.Microsoft JhengHei` | 970.1666870117188 | 971.1166381835938 |
| `fonts.widths.Microsoft New Tai Lue` | 901.8666381835938 | 903 |
| `fonts.widths.Microsoft PhagsPa` | 901.8666381835938 | 903 |
| `fonts.widths.Microsoft Sans Serif` | 886.4833374023438 | 887.4000244140625 |
| `fonts.widths.Microsoft Tai Le` | 901.8666381835938 | 903 |
| `fonts.widths.Microsoft YaHei` | 980.8833618164062 | 981.933349609375 |
| `fonts.widths.Microsoft Yi Baiti` | 669.2000122070312 | 670.1166381835938 |
| `fonts.widths.MingLiU-ExtB` | 612.2833251953125 | 613.4166870117188 |
| `fonts.widths.Monaco` | 885.2333374023438 | 886.1500244140625 |
| `fonts.widths.Mongolian Baiti` | 842.5499877929688 | 843.6666870117188 |
| `fonts.widths.MS Gothic` | 612.2833251953125 | 613.4166870117188 |
| `fonts.widths.MV Boli` | 883.0166625976562 | 883.9166870117188 |
| `fonts.widths.Myanmar Text` | 901.8666381835938 | 903 |
| `fonts.widths.Nirmala UI` | 901.8666381835938 | 903 |
| `fonts.widths.Noto Color Emoji` | 885.2333374023438 | 886.1500244140625 |
| `fonts.widths.Noto Sans` | 885.2333374023438 | 886.1500244140625 |
| `fonts.widths.Noto Sans CJK SC` | 885.2333374023438 | 886.1500244140625 |
| `fonts.widths.Noto Serif` | 885.2333374023438 | 886.1500244140625 |
| `fonts.widths.Palatino Linotype` | 912.5833129882812 | 913.7166748046875 |
| `fonts.widths.Roboto` | 885.2333374023438 | 886.1500244140625 |
| `fonts.widths.San Francisco` | 885.2333374023438 | 886.1500244140625 |
| `fonts.widths.Segoe MDL2 Assets` | 885.2333374023438 | 886.1500244140625 |
| `fonts.widths.Segoe Print` | 1045.3499755859375 | 1046.449951171875 |
| `fonts.widths.Segoe Script` | 1060.199951171875 | 1061.2332763671875 |
| `fonts.widths.Segoe UI` | 901.8666381835938 | 903 |
| `fonts.widths.Segoe UI Emoji` | 901.8666381835938 | 903 |
| `fonts.widths.Segoe UI Historic` | 901.8666381835938 | 903 |
| `fonts.widths.Segoe UI Symbol` | 901.8666381835938 | 903 |
| `fonts.widths.SF Pro Text` | 885.2333374023438 | 886.1500244140625 |
| `fonts.widths.SimSun` | 612.2833251953125 | 613.4166870117188 |
| `fonts.widths.Sitka Text` | 940.7166748046875 | 941.6666870117188 |
| `fonts.widths.Sylfaen` | 878.9166870117188 | 880.0166625976562 |
| `fonts.widths.Symbol` | 702.0333251953125 | 703.1666870117188 |
| `fonts.widths.Tahoma` | 875.2666625976562 | 876.316650390625 |
| `fonts.widths.Times New Roman` | 842.5499877929688 | 843.6666870117188 |
| `fonts.widths.Trebuchet MS` | 864.2166748046875 | 865.2999877929688 |
| `fonts.widths.Ubuntu` | 885.2333374023438 | 886.1500244140625 |
| `fonts.widths.Verdana` | 1005.5833129882812 | 1006.6166381835938 |
| `fonts.widths.Webdings` | 873.1333618164062 | 874.25 |
| `fonts.widths.Wingdings` | 1128.13330078125 | 1129.0999755859375 |
| `fonts.widths.Yu Gothic` | 897.5999755859375 | 898.7000122070312 |

## input (0)

No differences.

## tls (0)

No differences.

## h2 (0)

No differences.

## webrtc (0)

No differences.

## creepjs (23)

| path | A | B |
| --- | --- | --- |
| `creepjs.audio.floatFrequencyDataSum` | 167703.19235992432 | 167702.76976394653 |
| `creepjs.audio.floatTimeDomainDataSum` | 148.42028072737594 | 148.43191979678159 |
| `creepjs.audio.sampleSum` | 35.72918967047735 | 35.7409669655317 |
| `creepjs.canvas.textMetricsSystemSum` | 0.04548265622329712 | 0.0455144895515442 |
| `creepjs.clientRects.domrectSystemSum` | 0.11564999893188478 | 0.11566633331298828 |
| `creepjs.fonts.$hash` | "820b22be2dc64f13df44e8c273bd7ee4d067f183eefc8d22374ce9bd126ad4b5" | "24a8a371cb0249aa0fd4d137b4bec25dddaaa25b51fdb3789c7abf07447c9751" |
| `creepjs.fonts.pixelSizeSystemSum` | 0.11553417000000002 | 0.11555049000000002 |
| `creepjs.hashes.clientRects` | "834ed31ca9a176e4804199bfc561dd15b02b01924df3bf18b9a7a7329b798378" | "e9a704b9a1bb73aee24d65bd6025bf3dba0e137d8f196dba6549eefd057fd3cb" |
| `creepjs.hashes.fonts` | "820b22be2dc64f13df44e8c273bd7ee4d067f183eefc8d22374ce9bd126ad4b5" | "24a8a371cb0249aa0fd4d137b4bec25dddaaa25b51fdb3789c7abf07447c9751" |
| `creepjs.hashes.navigator` | "5c80439364a405c29edc72d5c025186551f58c38d1ba6444d89abd7b4abcdc9c" | "2eea5d3c73560765affe690b1d72d9b427dd12c35239bb7caf79340f8ad36784" |
| `creepjs.hashes.offlineAudioContext` | "a363ebf73d97c95eba9d2f9edfabae905f78c302f727463e818e39f03761effb" | "eb59560d12d863c66ec6b6531c91817439b3820d1000952c0b640c3bab56a9b1" |
| `creepjs.hashes.screen` | "4acd35d7a605a649ddc6e1f6dda922de759b9f7a7284cf5e108b8fd0240a6b4a" | "e21c7846b9f354a5d7d7db6ef1caccf04837a44ffa0495758645206183dd20ac" |
| `creepjs.hashes.svg` | "204d0aa81014e1d6777718ed52612af2887e7af4e53476d864a65d6e62ccd958" | "cf79ef75dddacb82c78777fb3ceeb8b5240a5081cc2e798f8df5e0bbf592142d" |
| `creepjs.hashes.workerScope` | "f781d5083ddd5bf5ea2ff08d6aecc216e064891ae4e277160a2f0a290398b6d5" | "d79510fb7e7f140a4b5aab2d9d40015f5c937c7b5c59902dc3675c1b2aa2687a" |
| `creepjs.navigator.hardwareConcurrency` | 12 | 8 |
| `creepjs.screen.$hash` | "4acd35d7a605a649ddc6e1f6dda922de759b9f7a7284cf5e108b8fd0240a6b4a" | "e21c7846b9f354a5d7d7db6ef1caccf04837a44ffa0495758645206183dd20ac" |
| `creepjs.screen.availHeight` | 1680 | 1040 |
| `creepjs.screen.availWidth` | 3072 | 1920 |
| `creepjs.svg.svgrectSystemSum` | 0.05502416725158692 | 0.05504049995422364 |
| `creepjs.webgl.gpu.compressedGPU` | "NVIDIA, NVIDIA GeForce GTX 900s" | "NVIDIA, NVIDIA GeForce GTX 400s" |
| `creepjs.worker.gpu.compressedGPU` | "NVIDIA, NVIDIA GeForce GTX 900s" | "NVIDIA, NVIDIA GeForce GTX 400s" |
| `creepjs.worker.hardwareConcurrency` | 12 | 8 |
| `creepjs.worker.webglRenderer` | "ANGLE (NVIDIA, NVIDIA GeForce GTX 980 Direct3D11 vs_5_0 ps_5_0), or similar" | "ANGLE (NVIDIA, NVIDIA GeForce GTX 480 Direct3D11 vs_5_0 ps_5_0), or similar" |

## rebrowser (6)

| path | A | B |
| --- | --- | --- |
| `rebrowser.afterAgentCalls.green` | only here (0 of 10):  | only here (1 of 11): viewport |
| `rebrowser.afterAgentCalls.notes.viewport` | "Viewport has default Playwright values. Use viewport: null in options." | (absent) |
| `rebrowser.afterAgentCalls.yellow` | popupBlocking, viewport | popupBlocking |
| `rebrowser.passive.green` | only here (0 of 10):  | only here (1 of 11): viewport |
| `rebrowser.passive.notes.viewport` | "Viewport has default Playwright values. Use viewport: null in options." | (absent) |
| `rebrowser.passive.yellow` | popupBlocking, viewport | popupBlocking |
