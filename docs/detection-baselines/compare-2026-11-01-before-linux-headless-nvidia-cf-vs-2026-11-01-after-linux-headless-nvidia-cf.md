# before-linux-headless-nvidia-cf vs after-linux-headless-nvidia-cf

| | A | B |
| --- | --- | --- |
| label | "before-linux-headless-nvidia-cf" | "after-linux-headless-nvidia-cf" |
| date | "2026-11-01" | "2026-11-01" |
| engine | "camoufox" | "camoufox" |
| engineVersion | "152.0.4-beta.30" | "152.0.4-beta.30" |
| mode | "headless" | "headless" |
| displayMode | "headless" | "headless" |
| egress | "allow-all" | "allow-all" |
| seed | "mz-baseline-70" | "mz-baseline-70" |
| platform | "linux" | "linux" |
| persona | linux-desktop-nvidia | linux-desktop-nvidia |

## Thresholds

None fired: no `HeadlessChrome`, no `webdriver: true`, no `pointer: none`.

125 differences; left out: 15 by the noise rules.

## probe (7)

| path | A | B |
| --- | --- | --- |
| `probe.audio.canvasLikeSum` | 75.79257826052344 | 75.81088914720749 |
| `probe.canvasHash` | -349768504 | 1892592128 |
| `probe.screen.availHeight` | 1080 | 1050 |
| `probe.window.innerHeight` | 720 | 965 |
| `probe.window.innerWidth` | 1280 | 1920 |
| `probe.window.outerHeight` | 1080 | 1050 |
| `probe.window.visualViewport` | 1280, 720, 1 | 1920, 965, 1 |

## headers (0)

No differences.

## fonts (89)

| path | A | B |
| --- | --- | --- |
| `fonts.baseWidths.monospace` | 884.9666748046875 | 886.1500244140625 |
| `fonts.baseWidths.sans-serif` | 884.9666748046875 | 886.1500244140625 |
| `fonts.baseWidths.serif` | 884.9666748046875 | 886.1500244140625 |
| `fonts.emoji.canvasHash` | -1744478018 | 543238977 |
| `fonts.emoji.width` | 24.016666412353516 | 24.08333396911621 |
| `fonts.widths.Apple Color Emoji` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Arial` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Arial Black` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Avenir` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Bahnschrift` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Calibri` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Cambria` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Cambria Math` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Candara` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Cantarell` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Comic Sans MS` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Consolas` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Constantia` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Corbel` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Courier New` | 734.683349609375 | 735.816650390625 |
| `fonts.widths.DejaVu Sans` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.DejaVu Sans Mono` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.DejaVu Serif` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Droid Sans` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Ebrima` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Franklin Gothic Medium` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.FreeSans` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Gabriola` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Gadugi` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Geneva` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Georgia` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Helvetica` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Helvetica Neue` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.HoloLens MDL2 Assets` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Impact` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Ink Free` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Javanese Text` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Leelawadee UI` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Liberation Mono` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Liberation Sans` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Liberation Serif` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Lucida Console` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Lucida Grande` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Lucida Sans Unicode` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Malgun Gothic` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Marlett` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Menlo` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Microsoft Himalaya` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Microsoft JhengHei` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Microsoft New Tai Lue` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Microsoft PhagsPa` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Microsoft Sans Serif` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Microsoft Tai Le` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Microsoft YaHei` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Microsoft Yi Baiti` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.MingLiU-ExtB` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Monaco` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Mongolian Baiti` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.MS Gothic` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.MV Boli` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Myanmar Text` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Nirmala UI` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Noto Color Emoji` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Noto Sans` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Noto Sans CJK SC` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Noto Serif` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Palatino Linotype` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Roboto` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.San Francisco` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Segoe MDL2 Assets` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Segoe Print` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Segoe Script` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Segoe UI` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Segoe UI Emoji` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Segoe UI Historic` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Segoe UI Symbol` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.SF Pro Text` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.SimSun` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Sitka Text` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Sylfaen` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Symbol` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Tahoma` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Times New Roman` | 842.5166625976562 | 843.6666870117188 |
| `fonts.widths.Trebuchet MS` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Ubuntu` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Verdana` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Webdings` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Wingdings` | 884.9666748046875 | 886.1500244140625 |
| `fonts.widths.Yu Gothic` | 884.9666748046875 | 886.1500244140625 |

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
| `creepjs.audio.floatFrequencyDataSum` | 167702.583278656 | 167702.76976394653 |
| `creepjs.audio.floatTimeDomainDataSum` | 148.41090358006113 | 148.43191979678159 |
| `creepjs.audio.sampleSum` | 35.73228843379184 | 35.7409669655317 |
| `creepjs.audio.totalUniqueSamples` | 4735 | 4736 |
| `creepjs.canvas.mods.pixelImage` | "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAYAAACM/rhtAAAAR0lEQVRYR+3QMQ0AMAzAsJU/6A6Enx4xgiizu/sOmwJRB1UHVQdVB1UHVQdVB1UHVQdVB1UHVQdVB1UHVQdVB1UHVQfV+YMfyAWfiSN598oAAAAQZGVCRzBBMEFENEQ5QUREOTYwNTL4McnyAAAAAElFTkSuQmCC" | "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAYAAACM/rhtAAAAR0lEQVRYR+3QMQ0AMAzAsJU/6A6Enx4xgiizu/sOmwJRB1UHVQdVB1UHVQdVB1UHVQdVB1UHVQdVB1UHVQdVB1UHVQfV+YMfyAWfiSN598oAAAAQZGVCR0E3RkIzMDlCOTZENTBGRjNUBM57AAAAAElFTkSuQmCC" |
| `creepjs.canvas.textMetricsSystemSum` | 0.027590697884559635 | 0.027643364577293397 |
| `creepjs.clientRects.domrectSystemSum` | 0.31496733413696293 | 0.15815833084106445 |
| `creepjs.fingerprintId` | "FP ID: 2ebea318ad41c0aa056c6d73bb196da7ebe534f6255f408531f43c608cc29e7b" | "FP ID: a1af2d1b91b146c9e5f5607697a2413f493fb865282c4b611a794521922418e2" |
| `creepjs.fonts.$hash` | "c30ffc5607aa933bfecf1d3162f5f7bd2e9f65d13a5f15a13767182e624202b2" | "d32e5ada4f8962e821f884f8e08201cc146617e51be78bc43dd8b45ee85f6fc7" |
| `creepjs.fonts.emojiSet` | only here (1 of 30): ✂ | only here (0 of 29):  |
| `creepjs.fonts.pixelSizeSystemSum` | 0.162910084 | 0.157998426 |
| `creepjs.hashes.canvas2d` | "ae547f4844589d8d37799823188124cdd583a334e750de22ed9f3d847f315dad" | "9562392b0fe4ffa94c509a037e2ce470da1fae7792603e9a6a564c96b4d5ee48" |
| `creepjs.hashes.clientRects` | "4a8e506291c878bf4f4fc6c3998bdc0bcfe3f73a46c78fb49c1c1e060a9c0649" | "60055b837bf313243939ea62ec02a81d6bfb2154d612a49cd3a828d9c2562732" |
| `creepjs.hashes.fonts` | "c30ffc5607aa933bfecf1d3162f5f7bd2e9f65d13a5f15a13767182e624202b2" | "d32e5ada4f8962e821f884f8e08201cc146617e51be78bc43dd8b45ee85f6fc7" |
| `creepjs.hashes.headless` | "27032a5bd1913257ddb6093eb7bb2c0d345f7a8c865d3d44239412532a53318e" | "dfaf67bd420c3b551958d7e82c82ba86a1e13bba310d14c5e14dd82d3ba044a3" |
| `creepjs.hashes.offlineAudioContext` | "0ff5d62628d99775e414754b61ad17f7ea58b38a550f1b9de855130fa2460bab" | "eb59560d12d863c66ec6b6531c91817439b3820d1000952c0b640c3bab56a9b1" |
| `creepjs.hashes.screen` | "5ccbceb608522b5b5f702ca3ff96bb2a755ca5b9b939d8e6e1f0fef5df2b6506" | "c1e8bbadf34ac1d7de9cef0b7dfb2205eabc8949353de8667eddfa81a66ed17f" |
| `creepjs.hashes.svg` | "55cc3eeac1eb2de8d47a76565812589d6f358bbdbeae0f53a95856e778c14908" | "04fe495d7e554727782c8fcb73de70e71163f51f4b0e2ba9f42ab9f372e86690" |
| `creepjs.headless.likeHeadless.noTaskbar` | true | false |
| `creepjs.headless.likeHeadlessRating` | 13 | 6 |
| `creepjs.screen.$hash` | "5ccbceb608522b5b5f702ca3ff96bb2a755ca5b9b939d8e6e1f0fef5df2b6506" | "c1e8bbadf34ac1d7de9cef0b7dfb2205eabc8949353de8667eddfa81a66ed17f" |
| `creepjs.screen.availHeight` | 1080 | 1050 |
| `creepjs.svg.svgrectSystemSum` | 0.09516216590881349 | 0.04583766632080079 |

## rebrowser (6)

| path | A | B |
| --- | --- | --- |
| `rebrowser.afterAgentCalls.green` | only here (0 of 10):  | only here (1 of 11): viewport |
| `rebrowser.afterAgentCalls.notes.viewport` | "Viewport has default Playwright values. Use viewport: null in options." | (absent) |
| `rebrowser.afterAgentCalls.yellow` | popupBlocking, viewport | popupBlocking |
| `rebrowser.passive.green` | only here (0 of 10):  | only here (1 of 11): viewport |
| `rebrowser.passive.notes.viewport` | "Viewport has default Playwright values. Use viewport: null in options." | (absent) |
| `rebrowser.passive.yellow` | popupBlocking, viewport | popupBlocking |
