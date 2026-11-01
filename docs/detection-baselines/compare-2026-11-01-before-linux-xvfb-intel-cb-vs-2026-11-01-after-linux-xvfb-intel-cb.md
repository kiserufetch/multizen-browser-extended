# before-linux-xvfb-intel-cb vs after-linux-xvfb-intel-cb

| | A | B |
| --- | --- | --- |
| label | "before-linux-xvfb-intel-cb" | "after-linux-xvfb-intel-cb" |
| date | "2026-11-01" | "2026-11-01" |
| engine | "cloakbrowser" | "cloakbrowser" |
| engineVersion | "146.0.7680.177.5" | "146.0.7680.177.5" |
| mode | "xvfb" | "xvfb" |
| displayMode | "xvfb" | "xvfb" |
| egress | "allow-all" | "allow-all" |
| seed | "mz-baseline-70" | "mz-baseline-70" |
| platform | "linux" | "linux" |
| persona | linux-laptop-intel | linux-laptop-intel |

## Thresholds

None fired: no `HeadlessChrome`, no `webdriver: true`, no `pointer: none`.

22 differences; left out: 20 by the noise rules.

## probe (2)

| path | A | B |
| --- | --- | --- |
| `probe.webgl.unmaskedRenderer` | "Mesa Intel(R) Iris(R) Xe Graphics (TGL GT2)" | "ANGLE (Intel, Mesa Intel(R) Iris(R) Xe Graphics (TGL GT2), OpenGL 4.6 (Core Profile) Mesa 24.0.9)" |
| `probe.webgl.unmaskedVendor` | "Mesa" | "Google Inc. (Intel)" |

## headers (0)

No differences.

## fonts (0)

No differences.

## input (0)

No differences.

## tls (0)

No differences.

## h2 (0)

No differences.

## webrtc (9)

| path | A | B |
| --- | --- | --- |
| `webrtc.candidates` |  | (absent) |
| `webrtc.candidates[0].kind` | (absent) | "ipv4" |
| `webrtc.candidates[0].protocol` | (absent) | "udp" |
| `webrtc.candidates[0].sameAsStun` | (absent) | true |
| `webrtc.candidates[0].type` | (absent) | "srflx" |
| `webrtc.gatheringState` | "complete" | "gathering" |
| `webrtc.sdpHasCandidateLines` | false | true |
| `webrtc.srflx` | 0 | 1 |
| `webrtc.stunRequestsSeen` | 0 | 1 |

## creepjs (11)

| path | A | B |
| --- | --- | --- |
| `creepjs.audio.noise` | 995.0990227335009 | 985.6697949686526 |
| `creepjs.fingerprintId` | "FP ID: cf5ef77a1df13e70a9fef7ff69ce1b3531b71b40659708c1306e44ebbb794a9d" | "FP ID: 40939acd4b6e9df5abf008070ea48b3f3c2d9949b8f2b92592e19974130a70b5" |
| `creepjs.hashes.canvasWebgl` | "2c1b35150d181af377b3abcbae64ffa71fc79bab53a3019b5cb6ca24f10c74a9" | "a505a322b60f5006ccfe657b222fc7b7845d6e3e4202da7680241d25870a761e" |
| `creepjs.hashes.offlineAudioContext` | "df6d40165f129e7bd492a63671f1c142d43fec22f78ce1de0ffb60220289fb70" | "bb022e20fdbbd0ba878df10129cc229acb75cd2c76b0b043d6db5665b8e1bbf3" |
| `creepjs.hashes.workerScope` | "1e14b2aaf2032b97fceb2fb6a721f7aab63f12e7af5cd73f80b810248f389cfe" | "4f86884b38837c260d25ce052e63a730c1d5d560bac500c767f409ce58dd8558" |
| `creepjs.webgl.gpu.compressedGPU` | "" | "Intel," |
| `creepjs.webgl.gpu.parts` | "Graphics, Intel, Iris, Mesa, Xe Graphics" | "ANGLE, Graphics, Intel, Iris, Mesa, OpenGL, Xe Graphics" |
| `creepjs.worker.gpu.compressedGPU` | "" | "Intel," |
| `creepjs.worker.gpu.parts` | "Graphics, Intel, Iris, Mesa, Xe Graphics" | "ANGLE, Graphics, Intel, Iris, Mesa, OpenGL, Xe Graphics" |
| `creepjs.worker.webglRenderer` | "Mesa Intel(R) Iris(R) Xe Graphics (TGL GT2)" | "ANGLE (Intel, Mesa Intel(R) Iris(R) Xe Graphics (TGL GT2), OpenGL 4.6 (Core Profile) Mesa 24.0.9)" |
| `creepjs.worker.webglVendor` | "Mesa" | "Google Inc. (Intel)" |

## rebrowser (0)

No differences.
