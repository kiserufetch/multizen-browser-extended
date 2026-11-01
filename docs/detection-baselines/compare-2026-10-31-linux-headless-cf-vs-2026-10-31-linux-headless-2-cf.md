# linux-headless-cf vs linux-headless-2-cf

| | A | B |
| --- | --- | --- |
| label | "linux-headless-cf" | "linux-headless-2-cf" |
| date | "2026-10-31" | "2026-10-31" |
| engine | "camoufox" | "camoufox" |
| engineVersion | "152.0.4-beta.30" | "152.0.4-beta.30" |
| mode | "headless" | "headless" |
| displayMode | "headless" | "headless" |
| egress | "allow-all" | "allow-all" |
| seed | "mz-baseline-70" | "mz-baseline-70" |
| platform | "linux" | "linux" |
| persona | windows-desktop-nvidia | windows-desktop-nvidia |

## Thresholds

None fired: no `HeadlessChrome`, no `webdriver: true`, no `pointer: none`.

126 differences; left out: 17 by the noise rules.

## probe (12)

| path | A | B |
| --- | --- | --- |
| `probe.audio.canvasLikeSum` | 75.81153067308333 | 75.8286156149552 |
| `probe.canvasHash` | 447297092 | 1705213526 |
| `probe.hardwareConcurrency` | 12 | 16 |
| `probe.screen.availHeight` | 1400 | 745 |
| `probe.screen.availLeft` | 0 | 21 |
| `probe.screen.availTop` | 0 | 29 |
| `probe.screen.availWidth` | 5120 | 1355 |
| `probe.window.historyLength` | 4 | 5 |
| `probe.window.outerHeight` | 1407 | 749 |
| `probe.window.outerWidth` | 1664 | 1352 |
| `probe.window.screenX` | 1707 | 15 |
| `probe.window.screenY` | -6 | 15 |

## headers (0)

No differences.

## fonts (89)

| path | A | B |
| --- | --- | --- |
| `fonts.baseWidths.monospace` | 885.25 | 886.3499755859375 |
| `fonts.baseWidths.sans-serif` | 885.25 | 886.3499755859375 |
| `fonts.baseWidths.serif` | 885.25 | 886.3499755859375 |
| `fonts.emoji.canvasHash` | 426408883 | -878486752 |
| `fonts.emoji.width` | 24.03333282470703 | 24.08333396911621 |
| `fonts.widths.Apple Color Emoji` | 885.25 | 886.3499755859375 |
| `fonts.widths.Arial` | 885.25 | 886.3499755859375 |
| `fonts.widths.Arial Black` | 1025.7332763671875 | 1026.683349609375 |
| `fonts.widths.Avenir` | 885.25 | 886.3499755859375 |
| `fonts.widths.Bahnschrift` | 872.3833618164062 | 873.4666748046875 |
| `fonts.widths.Calibri` | 837.8499755859375 | 838.7833251953125 |
| `fonts.widths.Cambria` | 874.2000122070312 | 875.0833129882812 |
| `fonts.widths.Cambria Math` | 874.2000122070312 | 875.0833129882812 |
| `fonts.widths.Candara` | 850.25 | 851.316650390625 |
| `fonts.widths.Cantarell` | 885.25 | 886.3499755859375 |
| `fonts.widths.Comic Sans MS` | 856.8666381835938 | 857.7833251953125 |
| `fonts.widths.Consolas` | 673.4833374023438 | 674.3333129882812 |
| `fonts.widths.Constantia` | 896.433349609375 | 897.316650390625 |
| `fonts.widths.Corbel` | 868.9000244140625 | 869.9833374023438 |
| `fonts.widths.Courier New` | 734.9666748046875 | 736.0999755859375 |
| `fonts.widths.DejaVu Sans` | 885.25 | 886.3499755859375 |
| `fonts.widths.DejaVu Sans Mono` | 885.25 | 886.3499755859375 |
| `fonts.widths.DejaVu Serif` | 885.25 | 886.3499755859375 |
| `fonts.widths.Droid Sans` | 885.25 | 886.3499755859375 |
| `fonts.widths.Ebrima` | 902.1333618164062 | 903 |
| `fonts.widths.Franklin Gothic Medium` | 883.6333618164062 | 884.566650390625 |
| `fonts.widths.FreeSans` | 885.25 | 886.3499755859375 |
| `fonts.widths.Gabriola` | 642.2833251953125 | 643.3333129882812 |
| `fonts.widths.Gadugi` | 902.1333618164062 | 903 |
| `fonts.widths.Geneva` | 885.25 | 886.3499755859375 |
| `fonts.widths.Georgia` | 918.6166381835938 | 919.5166625976562 |
| `fonts.widths.Helvetica` | 885.25 | 886.3499755859375 |
| `fonts.widths.Helvetica Neue` | 885.25 | 886.3499755859375 |
| `fonts.widths.HoloLens MDL2 Assets` | 885.25 | 886.3499755859375 |
| `fonts.widths.Impact` | 795.8833618164062 | 796.933349609375 |
| `fonts.widths.Ink Free` | 789.683349609375 | 790.75 |
| `fonts.widths.Javanese Text` | 870.7833251953125 | 871.8666381835938 |
| `fonts.widths.Leelawadee UI` | 902.1333618164062 | 903 |
| `fonts.widths.Liberation Mono` | 885.25 | 886.3499755859375 |
| `fonts.widths.Liberation Sans` | 885.25 | 886.3499755859375 |
| `fonts.widths.Liberation Serif` | 885.25 | 886.3499755859375 |
| `fonts.widths.Lucida Console` | 738.0833129882812 | 738.933349609375 |
| `fonts.widths.Lucida Grande` | 885.25 | 886.3499755859375 |
| `fonts.widths.Lucida Sans Unicode` | 959.9666748046875 | 960.9000244140625 |
| `fonts.widths.Malgun Gothic` | 921.7166748046875 | 922.5999755859375 |
| `fonts.widths.Marlett` | 1209.6500244140625 | 1210.5 |
| `fonts.widths.Menlo` | 885.25 | 886.3499755859375 |
| `fonts.widths.Microsoft Himalaya` | 564.6166381835938 | 565.7000122070312 |
| `fonts.widths.Microsoft JhengHei` | 970.25 | 971.2833251953125 |
| `fonts.widths.Microsoft New Tai Lue` | 902.1333618164062 | 903 |
| `fonts.widths.Microsoft PhagsPa` | 902.1333618164062 | 903 |
| `fonts.widths.Microsoft Sans Serif` | 886.5499877929688 | 887.5999755859375 |
| `fonts.widths.Microsoft Tai Le` | 902.1333618164062 | 903 |
| `fonts.widths.Microsoft YaHei` | 981.0833129882812 | 982 |
| `fonts.widths.Microsoft Yi Baiti` | 669.25 | 670.1333618164062 |
| `fonts.widths.MingLiU-ExtB` | 612.566650390625 | 613.4166870117188 |
| `fonts.widths.Monaco` | 885.25 | 886.3499755859375 |
| `fonts.widths.Mongolian Baiti` | 842.7999877929688 | 843.683349609375 |
| `fonts.widths.MS Gothic` | 612.566650390625 | 613.4166870117188 |
| `fonts.widths.MV Boli` | 883.0499877929688 | 883.9833374023438 |
| `fonts.widths.Myanmar Text` | 902.1333618164062 | 903 |
| `fonts.widths.Nirmala UI` | 902.1333618164062 | 903 |
| `fonts.widths.Noto Color Emoji` | 885.25 | 886.3499755859375 |
| `fonts.widths.Noto Sans` | 885.25 | 886.3499755859375 |
| `fonts.widths.Noto Sans CJK SC` | 885.25 | 886.3499755859375 |
| `fonts.widths.Noto Serif` | 885.25 | 886.3499755859375 |
| `fonts.widths.Palatino Linotype` | 912.7000122070312 | 913.7166748046875 |
| `fonts.widths.Roboto` | 885.25 | 886.3499755859375 |
| `fonts.widths.San Francisco` | 885.25 | 886.3499755859375 |
| `fonts.widths.Segoe MDL2 Assets` | 885.25 | 886.3499755859375 |
| `fonts.widths.Segoe Print` | 1045.566650390625 | 1046.4832763671875 |
| `fonts.widths.Segoe Script` | 1060.36669921875 | 1061.300048828125 |
| `fonts.widths.Segoe UI` | 902.1333618164062 | 903 |
| `fonts.widths.Segoe UI Emoji` | 902.1333618164062 | 903 |
| `fonts.widths.Segoe UI Historic` | 902.1333618164062 | 903 |
| `fonts.widths.Segoe UI Symbol` | 902.1333618164062 | 903 |
| `fonts.widths.SF Pro Text` | 885.25 | 886.3499755859375 |
| `fonts.widths.SimSun` | 612.566650390625 | 613.4166870117188 |
| `fonts.widths.Sitka Text` | 940.7833251953125 | 941.8499755859375 |
| `fonts.widths.Sylfaen` | 879 | 880.0166625976562 |
| `fonts.widths.Symbol` | 702.2999877929688 | 703.1666870117188 |
| `fonts.widths.Tahoma` | 875.4666748046875 | 876.3833618164062 |
| `fonts.widths.Times New Roman` | 842.7999877929688 | 843.683349609375 |
| `fonts.widths.Trebuchet MS` | 864.433349609375 | 865.3333129882812 |
| `fonts.widths.Ubuntu` | 885.25 | 886.3499755859375 |
| `fonts.widths.Verdana` | 1005.7666625976562 | 1006.7000122070312 |
| `fonts.widths.Webdings` | 873.4000244140625 | 874.25 |
| `fonts.widths.Wingdings` | 1128.2166748046875 | 1129.0999755859375 |
| `fonts.widths.Yu Gothic` | 897.6333618164062 | 898.7333374023438 |

## input (0)

No differences.

## tls (0)

No differences.

## h2 (0)

No differences.

## webrtc (0)

No differences.

## creepjs (25)

| path | A | B |
| --- | --- | --- |
| `creepjs.audio.floatFrequencyDataSum` | 167702.15351104736 | 167703.82901763916 |
| `creepjs.audio.floatTimeDomainDataSum` | 148.43639408048693 | 148.39954418082925 |
| `creepjs.audio.sampleSum` | 35.741269493675645 | 35.7493477434582 |
| `creepjs.audio.totalUniqueSamples` | 4735 | 4736 |
| `creepjs.canvas.mods.pixelImage` | "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAYAAACM/rhtAAAAR0lEQVRYR+3QMQ0AMAzAsJU/6A6Enx4xgiizu/sOmwJRB1UHVQdVB1UHVQdVB1UHVQdVB1UHVQdVB1UHVQdVB1UHVQfV+YMfyAWfiSN598oAAAAQZGVCRzVDNUUxQUU3OURFNkYxRjdSVMM3AAAAAElFTkSuQmCC" | "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAYAAACM/rhtAAAAR0lEQVRYR+3QMQ0AMAzAsJU/6A6Enx4xgiizu/sOmwJRB1UHVQdVB1UHVQdVB1UHVQdVB1UHVQdVB1UHVQdVB1UHVQfV+YMfyAWfiSN598oAAAAQZGVCR0I5MDM3QkM3QUZBQkNGMzLPQDm9AAAAAElFTkSuQmCC" |
| `creepjs.canvas.textMetricsSystemSum` | 0.04372983332411448 | 0.04329649995899201 |
| `creepjs.clientRects.domrectSystemSum` | 0.11565166564941408 | 0.1104251663208008 |
| `creepjs.fingerprintId` | "FP ID: b4de192c57bc6e35b956d1046c1e3736e355a0a5418521f31a2ed78b747ab75c" | "FP ID: b3c86ab0f2e26e46b9fc296248330101e9f1261bd000e864c368294f83341900" |
| `creepjs.fonts.$hash` | "f17491e35f6d7c28da1b6a5cf82dad6ac69859a511c26944d997526070dff953" | "2e2ec8fab99da5c354dbbded2a4a23de0cb9add5790e8446a96bc40e2fe6860c" |
| `creepjs.fonts.emojiSet` | only here (1 of 23): 🧑‍🤝‍🧑 | only here (0 of 22):  |
| `creepjs.fonts.pixelSizeSystemSum` | 0.11553582000000003 | 0.11031466000000001 |
| `creepjs.hashes.canvas2d` | "942e5c4a9f6b7e4b0ecb70d1b662e56054dfe79373c4f57732006935c2db430c" | "4cb592fd67227366696f53129bc1d0dfda73406b44965e1f8b06c2aa9003724e" |
| `creepjs.hashes.clientRects` | "d1fa5a16ade0f3082a44ec43eea1feea42684f7a57cc9c6fa8595bc0932b94bd" | "b4edd68708061d70f5138ffca4d25da90d873b8e4251661f06a942faa4e85a1e" |
| `creepjs.hashes.fonts` | "f17491e35f6d7c28da1b6a5cf82dad6ac69859a511c26944d997526070dff953" | "2e2ec8fab99da5c354dbbded2a4a23de0cb9add5790e8446a96bc40e2fe6860c" |
| `creepjs.hashes.navigator` | "5c80439364a405c29edc72d5c025186551f58c38d1ba6444d89abd7b4abcdc9c" | "9debb49fa617787194c7ed742cb98d3302069e7cb3b493f265ae759af8071108" |
| `creepjs.hashes.offlineAudioContext` | "62c44e992aa6d29c926faca1efde8dd82c46e0a07e55f1c088d3bf970265ac0f" | "673f19f8729354336bf179581db023ac7b1f14728fdb1068d601d9209fa091ec" |
| `creepjs.hashes.screen` | "cd5cf704a24df488b448018ca79482fe5d75adf390e2f00cb869168b130e96f9" | "9c2206325dc4eca33750f77dfd756a9b314af3c582801ff1452cc6865109335d" |
| `creepjs.hashes.svg` | "59e5b155bae1287ed3bfaa484f46fd368b1c03c3ac32f89452da5185ca3a56ef" | "210ec605e18cc447c9df19bd14761be8a291d73c1a83f8992d9f66823e33249c" |
| `creepjs.hashes.workerScope` | "073de06dd83336aaa2b987994f67d6f6d807dca58954e385e3b7e15d8e085382" | "e3cd804a4d9d082bae74ea63941b8107e65db72997d1ea52185b3f1418aee390" |
| `creepjs.navigator.hardwareConcurrency` | 12 | 16 |
| `creepjs.screen.$hash` | "cd5cf704a24df488b448018ca79482fe5d75adf390e2f00cb869168b130e96f9" | "9c2206325dc4eca33750f77dfd756a9b314af3c582801ff1452cc6865109335d" |
| `creepjs.screen.availHeight` | 1400 | 745 |
| `creepjs.screen.availWidth` | 5120 | 1355 |
| `creepjs.svg.svgrectSystemSum` | 0.05502583358764649 | 0.05243466682434082 |
| `creepjs.worker.hardwareConcurrency` | 12 | 16 |

## rebrowser (0)

No differences.
