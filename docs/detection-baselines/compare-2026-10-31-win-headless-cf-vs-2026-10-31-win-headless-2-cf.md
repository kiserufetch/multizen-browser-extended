# win-headless-cf vs win-headless-2-cf

| | A | B |
| --- | --- | --- |
| label | "win-headless-cf" | "win-headless-2-cf" |
| date | "2026-10-31" | "2026-10-31" |
| engine | "camoufox" | "camoufox" |
| engineVersion | "152.0.4-beta.30" | "152.0.4-beta.30" |
| mode | "headless" | "headless" |
| displayMode | "headless" | "headless" |
| egress | "allow-all" | "allow-all" |
| seed | "mz-baseline-70" | "mz-baseline-70" |
| platform | "win32" | "win32" |
| persona | windows-desktop-nvidia | windows-desktop-nvidia |

## Thresholds

None fired: no `HeadlessChrome`, no `webdriver: true`, no `pointer: none`.

49 differences; left out: 15 by the noise rules.

## probe (15)

| path | A | B |
| --- | --- | --- |
| `probe.audio.canvasLikeSum` | 75.79472181376332 | 75.82026901735662 |
| `probe.canvasHash` | 1200784745 | 1505026568 |
| `probe.screen.availHeight` | 1440 | 745 |
| `probe.screen.availLeft` | 0 | 21 |
| `probe.screen.availTop` | 0 | 29 |
| `probe.screen.availWidth` | 2560 | 1355 |
| `probe.webgl.canvasHash` | 1094851586 | -92287190 |
| `probe.webgl.renderer` | "ANGLE (AMD, Radeon HD 3200 Graphics Direct3D11 vs_5_0 ps_5_0), or similar" | "ANGLE (Intel, Intel(R) HD Graphics 400 Direct3D11 vs_5_0 ps_5_0), or similar" |
| `probe.webgl.unmaskedRenderer` | "ANGLE (AMD, Radeon HD 3200 Graphics Direct3D11 vs_5_0 ps_5_0), or similar" | "ANGLE (Intel, Intel(R) HD Graphics 400 Direct3D11 vs_5_0 ps_5_0), or similar" |
| `probe.webgl.unmaskedVendor` | "Google Inc. (AMD)" | "Google Inc. (Intel)" |
| `probe.window.historyLength` | 4 | 2 |
| `probe.window.outerHeight` | 1055 | 749 |
| `probe.window.outerWidth` | 1920 | 1352 |
| `probe.window.screenX` | 250 | 15 |
| `probe.window.screenY` | 35 | 15 |

## headers (0)

No differences.

## fonts (15)

| path | A | B |
| --- | --- | --- |
| `fonts.emoji.canvasHash` | 1793452960 | -1048601479 |
| `fonts.widths.Cambria` | 874.4833374023438 | 874.4500122070312 |
| `fonts.widths.Cambria Math` | 874.4833374023438 | 874.4500122070312 |
| `fonts.widths.Comic Sans MS` | 857.1500244140625 | 856.9833374023438 |
| `fonts.widths.Constantia` | 896.6666870117188 | 896.5 |
| `fonts.widths.Gabriola` | 642.566650390625 | 642.5499877929688 |
| `fonts.widths.Georgia` | 918.9000244140625 | 918.8833618164062 |
| `fonts.widths.Lucida Sans Unicode` | 960.25 | 960.2333374023438 |
| `fonts.widths.Microsoft Himalaya` | 564.9000244140625 | 564.8833618164062 |
| `fonts.widths.Microsoft Yi Baiti` | 669.5333251953125 | 669.4833374023438 |
| `fonts.widths.Palatino Linotype` | 912.9500122070312 | 912.933349609375 |
| `fonts.widths.Segoe Script` | 1060.5167236328125 | 1060.5 |
| `fonts.widths.Sitka Text` | 801.0499877929688 | 800.8666381835938 |
| `fonts.widths.Tahoma` | 875.75 | 875.7333374023438 |
| `fonts.widths.Trebuchet MS` | 864.5333251953125 | 864.5 |

## input (0)

No differences.

## tls (0)

No differences.

## h2 (0)

No differences.

## webrtc (0)

No differences.

## creepjs (19)

| path | A | B |
| --- | --- | --- |
| `creepjs.audio.floatFrequencyDataSum` | 167703.42273712158 | 167702.44033813477 |
| `creepjs.audio.floatTimeDomainDataSum` | 148.41824418963006 | 148.43280973363653 |
| `creepjs.audio.sampleSum` | 35.73331750896614 | 35.745383047709765 |
| `creepjs.canvas.mods.pixelImage` | "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAYAAACM/rhtAAAAR0lEQVRYR+3QMQ0AMAzAsJU/6A6Enx4xgiizu/sOmwJRB1UHVQdVB1UHVQdVB1UHVQdVB1UHVQdVB1UHVQdVB1UHVQfV+YMfyAWfiSN598oAAAAQZGVCRzREQzlCQTNBNDM4N0VEQTdJPCP9AAAAAElFTkSuQmCC" | "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAYAAACM/rhtAAAAR0lEQVRYR+3QMQ0AMAzAsJU/6A6Enx4xgiizu/sOmwJRB1UHVQdVB1UHVQdVB1UHVQdVB1UHVQdVB1UHVQdVB1UHVQfV+YMfyAWfiSN598oAAAAQZGVCR0IxRTZFRkMxODNDNDIwRDk63qqTAAAAAElFTkSuQmCC" |
| `creepjs.fingerprintId` | "FP ID: 58a9e7e65a467dc6b4d8ae09a459026bb3e590027d46eb0f37def00ec3d09b58" | "FP ID: c901e359465162665133e7a927f357db9456f6195ae4c8fe20cc03ac1186190f" |
| `creepjs.hashes.canvas2d` | "a99abf3d66c82d3d40fa6b7a3fd56a355f8eaec7d48b4db12426db5dba7c3da3" | "b2c313b4fad40c232ab8c7f6d6e7fd4309b24ccd7791dd26da689b8b08a58ca4" |
| `creepjs.hashes.canvasWebgl` | "eb491bfdf94c7d7272905f488260839cf148cdac1b9d9a765a3024099793060d" | "7bf53d1ed3da320ebd70e8b4af8a15e8df67612950eb7d607d450d92c3688fbe" |
| `creepjs.hashes.offlineAudioContext` | "ecde52662a3eeecedc0db4e242803505bda33bde8f0d902b3d4122de27ca7936" | "68246924bedecb79faaec1a531ea7ba8128b3775d395d9f00e0c3a0523ddee3d" |
| `creepjs.hashes.screen` | "56ad3332050bd11cf5de70a5c34dca433e3c359c6193cbc0b923afde69d1f5bf" | "9c2206325dc4eca33750f77dfd756a9b314af3c582801ff1452cc6865109335d" |
| `creepjs.hashes.workerScope` | "373117f1e9fefd5ddf205780639233cefb82aa01822247f87a605fbcbd3b9c13" | "572a220fc2e9901d2a3f3ec2ec29f064750f4c088bce2bdebc0cd3dc69d47f1c" |
| `creepjs.screen.$hash` | "56ad3332050bd11cf5de70a5c34dca433e3c359c6193cbc0b923afde69d1f5bf" | "9c2206325dc4eca33750f77dfd756a9b314af3c582801ff1452cc6865109335d" |
| `creepjs.screen.availHeight` | 1440 | 745 |
| `creepjs.screen.availWidth` | 2560 | 1355 |
| `creepjs.webgl.gpu.compressedGPU` | "AMD, Radeon HD 3000s Graphics" | "Intel, Intel(R) HD Graphics 400s" |
| `creepjs.webgl.gpu.parts` | "AMD, ANGLE, Direct3D, Graphics, Radeon" | "ANGLE, Direct3D, Graphics, Intel, Intel(R) HD Graphics" |
| `creepjs.worker.gpu.compressedGPU` | "AMD, Radeon HD 3000s Graphics" | "Intel, Intel(R) HD Graphics 400s" |
| `creepjs.worker.gpu.parts` | "AMD, ANGLE, Direct3D, Graphics, Radeon" | "ANGLE, Direct3D, Graphics, Intel, Intel(R) HD Graphics" |
| `creepjs.worker.webglRenderer` | "ANGLE (AMD, Radeon HD 3200 Graphics Direct3D11 vs_5_0 ps_5_0), or similar" | "ANGLE (Intel, Intel(R) HD Graphics 400 Direct3D11 vs_5_0 ps_5_0), or similar" |
| `creepjs.worker.webglVendor` | "Google Inc. (AMD)" | "Google Inc. (Intel)" |

## rebrowser (0)

No differences.
