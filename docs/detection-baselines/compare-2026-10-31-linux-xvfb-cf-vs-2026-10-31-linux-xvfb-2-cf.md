# linux-xvfb-cf vs linux-xvfb-2-cf

| | A | B |
| --- | --- | --- |
| label | "linux-xvfb-cf" | "linux-xvfb-2-cf" |
| date | "2026-10-31" | "2026-10-31" |
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

126 differences; left out: 12 by the noise rules.

## probe (11)

| path | A | B |
| --- | --- | --- |
| `probe.audio.canvasLikeSum` | 75.81965536386997 | 75.82655223054462 |
| `probe.canvasHash` | -843091992 | 33902564 |
| `probe.hardwareConcurrency` | 32 | 2 |
| `probe.screen.availHeight` | 1032 | 1680 |
| `probe.screen.availWidth` | 3840 | 3072 |
| `probe.webgl.canvasHash` | -1305463234 | -709847269 |
| `probe.window.historyLength` | 5 | 1 |
| `probe.window.outerHeight` | 1040 | 1292 |
| `probe.window.outerWidth` | 1280 | 1652 |
| `probe.window.screenX` | 0 | 697 |
| `probe.window.screenY` | 0 | 184 |

## headers (0)

No differences.

## fonts (91)

| path | A | B |
| --- | --- | --- |
| `fonts.baseWidths.monospace` | 885.25 | 886.433349609375 |
| `fonts.baseWidths.sans-serif` | 885.25 | 886.433349609375 |
| `fonts.baseWidths.serif` | 885.25 | 886.433349609375 |
| `fonts.counts.windows` | 57 | 58 |
| `fonts.emoji.canvasHash` | 58907699 | 1220720687 |
| `fonts.emoji.width` | 24.016666412353516 | 24.100000381469727 |
| `fonts.present.windows` | only here (0 of 57):  | only here (1 of 58): Segoe MDL2 Assets |
| `fonts.widths.Apple Color Emoji` | 885.25 | 886.433349609375 |
| `fonts.widths.Arial` | 885.25 | 886.433349609375 |
| `fonts.widths.Arial Black` | 1025.550048828125 | 1026.88330078125 |
| `fonts.widths.Avenir` | 885.25 | 886.433349609375 |
| `fonts.widths.Bahnschrift` | 872.3833618164062 | 873.7166748046875 |
| `fonts.widths.Calibri` | 837.6666870117188 | 839 |
| `fonts.widths.Cambria` | 874.1666870117188 | 875.3666381835938 |
| `fonts.widths.Cambria Math` | 874.1666870117188 | 875.3666381835938 |
| `fonts.widths.Candara` | 850.2333374023438 | 851.4000244140625 |
| `fonts.widths.Cantarell` | 885.25 | 886.433349609375 |
| `fonts.widths.Comic Sans MS` | 856.7000122070312 | 858.0499877929688 |
| `fonts.widths.Consolas` | 673.4833374023438 | 674.6166381835938 |
| `fonts.widths.Constantia` | 896.2166748046875 | 897.566650390625 |
| `fonts.widths.Corbel` | 868.8499755859375 | 870.0333251953125 |
| `fonts.widths.Courier New` | 734.9666748046875 | 736.0999755859375 |
| `fonts.widths.DejaVu Sans` | 885.25 | 886.433349609375 |
| `fonts.widths.DejaVu Sans Mono` | 885.25 | 886.433349609375 |
| `fonts.widths.DejaVu Serif` | 885.25 | 886.433349609375 |
| `fonts.widths.Droid Sans` | 885.25 | 886.433349609375 |
| `fonts.widths.Ebrima` | 901.933349609375 | 903.2833251953125 |
| `fonts.widths.Franklin Gothic Medium` | 883.4666748046875 | 884.8499755859375 |
| `fonts.widths.FreeSans` | 885.25 | 886.433349609375 |
| `fonts.widths.Gabriola` | 642.2666625976562 | 643.5999755859375 |
| `fonts.widths.Gadugi` | 901.933349609375 | 903.2833251953125 |
| `fonts.widths.Geneva` | 885.25 | 886.433349609375 |
| `fonts.widths.Georgia` | 918.5999755859375 | 919.7833251953125 |
| `fonts.widths.Helvetica` | 885.25 | 886.433349609375 |
| `fonts.widths.Helvetica Neue` | 885.25 | 886.433349609375 |
| `fonts.widths.HoloLens MDL2 Assets` | 885.25 | 1292 |
| `fonts.widths.Impact` | 795.8833618164062 | 797.183349609375 |
| `fonts.widths.Ink Free` | 789.6166381835938 | 791.0166625976562 |
| `fonts.widths.Javanese Text` | 870.7666625976562 | 872.0999755859375 |
| `fonts.widths.Leelawadee UI` | 901.933349609375 | 903.2833251953125 |
| `fonts.widths.Liberation Mono` | 885.25 | 886.433349609375 |
| `fonts.widths.Liberation Sans` | 885.25 | 886.433349609375 |
| `fonts.widths.Liberation Serif` | 885.25 | 886.433349609375 |
| `fonts.widths.Lucida Console` | 737.7999877929688 | 739.2166748046875 |
| `fonts.widths.Lucida Grande` | 885.25 | 886.433349609375 |
| `fonts.widths.Lucida Sans Unicode` | 959.9500122070312 | 961.183349609375 |
| `fonts.widths.Malgun Gothic` | 921.7166748046875 | 922.8499755859375 |
| `fonts.widths.Marlett` | 1209.4000244140625 | 1225.5 |
| `fonts.widths.Menlo` | 885.25 | 886.433349609375 |
| `fonts.widths.Microsoft Himalaya` | 564.5999755859375 | 565.9833374023438 |
| `fonts.widths.Microsoft JhengHei` | 970.1666870117188 | 971.4000244140625 |
| `fonts.widths.Microsoft New Tai Lue` | 901.933349609375 | 903.2833251953125 |
| `fonts.widths.Microsoft PhagsPa` | 901.933349609375 | 903.2833251953125 |
| `fonts.widths.Microsoft Sans Serif` | 886.5 | 887.683349609375 |
| `fonts.widths.Microsoft Tai Le` | 901.933349609375 | 903.2833251953125 |
| `fonts.widths.Microsoft YaHei` | 980.8833618164062 | 982.2166748046875 |
| `fonts.widths.Microsoft Yi Baiti` | 669.2000122070312 | 670.4000244140625 |
| `fonts.widths.MingLiU-ExtB` | 612.2833251953125 | 613.7000122070312 |
| `fonts.widths.Monaco` | 885.25 | 886.433349609375 |
| `fonts.widths.Mongolian Baiti` | 842.7833251953125 | 843.9500122070312 |
| `fonts.widths.MS Gothic` | 612.2833251953125 | 613.7000122070312 |
| `fonts.widths.MV Boli` | 883.0333251953125 | 884.2166748046875 |
| `fonts.widths.Myanmar Text` | 901.933349609375 | 903.2833251953125 |
| `fonts.widths.Nirmala UI` | 901.933349609375 | 903.2833251953125 |
| `fonts.widths.Noto Color Emoji` | 885.25 | 886.433349609375 |
| `fonts.widths.Noto Sans` | 885.25 | 886.433349609375 |
| `fonts.widths.Noto Sans CJK SC` | 885.25 | 886.433349609375 |
| `fonts.widths.Noto Serif` | 885.25 | 886.433349609375 |
| `fonts.widths.Palatino Linotype` | 912.6500244140625 | 914 |
| `fonts.widths.Roboto` | 885.25 | 886.433349609375 |
| `fonts.widths.San Francisco` | 885.25 | 886.433349609375 |
| `fonts.widths.Segoe MDL2 Assets` | 885.25 | 1258 |
| `fonts.widths.Segoe Print` | 1045.566650390625 | 1046.75 |
| `fonts.widths.Segoe Script` | 1060.2166748046875 | 1061.550048828125 |
| `fonts.widths.Segoe UI` | 901.933349609375 | 903.2833251953125 |
| `fonts.widths.Segoe UI Emoji` | 901.933349609375 | 903.2833251953125 |
| `fonts.widths.Segoe UI Historic` | 901.933349609375 | 903.2833251953125 |
| `fonts.widths.Segoe UI Symbol` | 901.933349609375 | 903.2833251953125 |
| `fonts.widths.SF Pro Text` | 885.25 | 886.433349609375 |
| `fonts.widths.SimSun` | 612.2833251953125 | 613.7000122070312 |
| `fonts.widths.Sitka Text` | 940.75 | 941.9500122070312 |
| `fonts.widths.Sylfaen` | 878.9666748046875 | 880.2999877929688 |
| `fonts.widths.Symbol` | 702.0333251953125 | 703.4500122070312 |
| `fonts.widths.Tahoma` | 875.4500122070312 | 876.6333618164062 |
| `fonts.widths.Times New Roman` | 842.7833251953125 | 843.9500122070312 |
| `fonts.widths.Trebuchet MS` | 864.2166748046875 | 865.5833129882812 |
| `fonts.widths.Ubuntu` | 885.25 | 886.433349609375 |
| `fonts.widths.Verdana` | 1005.5833129882812 | 1006.9000244140625 |
| `fonts.widths.Webdings` | 873.2999877929688 | 874.5333251953125 |
| `fonts.widths.Wingdings` | 1128.1666259765625 | 1129.38330078125 |
| `fonts.widths.Yu Gothic` | 897.5999755859375 | 898.9833374023438 |

## input (0)

No differences.

## tls (0)

No differences.

## h2 (0)

No differences.

## webrtc (0)

No differences.

## creepjs (24)

| path | A | B |
| --- | --- | --- |
| `creepjs.audio.floatFrequencyDataSum` | 167702.7854232788 | 167704.01205825806 |
| `creepjs.audio.floatTimeDomainDataSum` | 148.42334289419887 | 148.41597777628704 |
| `creepjs.audio.sampleSum` | 35.74507798660488 | 35.748315309163445 |
| `creepjs.canvas.mods.pixelImage` | "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAYAAACM/rhtAAAAR0lEQVRYR+3QMQ0AMAzAsJU/6A6Enx4xgiizu/sOmwJRB1UHVQdVB1UHVQdVB1UHVQdVB1UHVQdVB1UHVQdVB1UHVQfV+YMfyAWfiSN598oAAAAQZGVCR0Y5NDdCMDEyQzBBN0VDMDkDGAckAAAAAElFTkSuQmCC" | "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAYAAACM/rhtAAAAR0lEQVRYR+3QMQ0AMAzAsJU/6A6Enx4xgiizu/sOmwJRB1UHVQdVB1UHVQdVB1UHVQdVB1UHVQdVB1UHVQdVB1UHVQfV+YMfyAWfiSN598oAAAAQZGVCRzFGRUEwRkRFNTJFRDZDNTGWA+E6AAAAAElFTkSuQmCC" |
| `creepjs.canvas.textMetricsSystemSum` | 0.04326766664473217 | 0.04330299997997285 |
| `creepjs.clientRects.domrectSystemSum` | 0.1156506657409668 | 0.11567083328247071 |
| `creepjs.fingerprintId` | "FP ID: d0f29fded86d62f7f1a728638c159484e24ee107f59db7d32c1d4738e1c72a6e" | "FP ID: a112a86cea196ff9f885d90c7d295aa84b8019521134ecc9033e0fed25ce4278" |
| `creepjs.fonts.$hash` | "62dcbdff91362360c934c44a5bd1148a0e5bdb66d961391e6df31635317f5992" | "a4c1a4b925cb09b9be4b8318bf9d9c35af8e95935d71a14a0ca48cce9e61ebef" |
| `creepjs.fonts.pixelSizeSystemSum` | 0.11553484000000001 | 0.11555498999999998 |
| `creepjs.hashes.canvas2d` | "09c029e766e62eb0bad08be2958749622d4caa1eb6bc1e7d1a123a7f88d58d93" | "a972d18e3669b651cbf4bece4b5677574e7c23660d364c8c0bd3721bc54b52a8" |
| `creepjs.hashes.canvasWebgl` | "9d88c7fa2df249745cbee2c920cbb41d30d24bedefce2e13454e1f728503dad5" | "f69556da9d4c8fecfd0b5edf2d9ed12aae97146b38a768dfec8c31e46650669b" |
| `creepjs.hashes.clientRects` | "6e3c706d9b200d637dec3692468ca325e0bb90b470bacb2877a1e34121c77674" | "6d1ae38b63dfa628e010ce78baab950a0956f7b2357df824a09f867c2f2e6550" |
| `creepjs.hashes.fonts` | "62dcbdff91362360c934c44a5bd1148a0e5bdb66d961391e6df31635317f5992" | "a4c1a4b925cb09b9be4b8318bf9d9c35af8e95935d71a14a0ca48cce9e61ebef" |
| `creepjs.hashes.navigator` | "0d6e10685e94e1dd4d9072e4cd8635f3451107a3203998d3de8e154c14c593b9" | "d49d3a6356469cd00d83b8a16bd67245c6ba4287c730d1579c49a413324d48ff" |
| `creepjs.hashes.offlineAudioContext` | "53901d72b67fb8efbd38282059dde9d2c05d4fee11cf5dce95824fa9543adddd" | "1097ec184d207499509ccf10533018c1fbc05c0e61b949d91c6920bee696e7cb" |
| `creepjs.hashes.screen` | "de61910f3a1e8e84513fa0d1aeba3226c8c5178eb8ce6f92667247d3e99ee9e7" | "4acd35d7a605a649ddc6e1f6dda922de759b9f7a7284cf5e108b8fd0240a6b4a" |
| `creepjs.hashes.svg` | "f7c1e102659e6bd7e3e9214641fe725575f2d246de329170a6fdeb0c87c842d9" | "7b91d56dd8fba50d3502bdd29beb81523def9a27c40b072853f5cc40d3156b38" |
| `creepjs.hashes.workerScope` | "84208eb8150dc599c28d598b7926cb0ffb98e28c9f724ed06440ff4014624430" | "9b21a8d6da45231ee52d869531b0612c3c7f17c3123447580d74547959cb1e89" |
| `creepjs.navigator.hardwareConcurrency` | 32 | 2 |
| `creepjs.screen.$hash` | "de61910f3a1e8e84513fa0d1aeba3226c8c5178eb8ce6f92667247d3e99ee9e7" | "4acd35d7a605a649ddc6e1f6dda922de759b9f7a7284cf5e108b8fd0240a6b4a" |
| `creepjs.screen.availHeight` | 1032 | 1680 |
| `creepjs.screen.availWidth` | 3840 | 3072 |
| `creepjs.svg.svgrectSystemSum` | 0.055024833831787114 | 0.05504499969482422 |
| `creepjs.worker.hardwareConcurrency` | 32 | 2 |

## rebrowser (0)

No differences.
