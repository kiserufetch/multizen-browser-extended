# before-linux-xvfb-amd-cb vs after-linux-xvfb-amd-cb

| | A | B |
| --- | --- | --- |
| label | "before-linux-xvfb-amd-cb" | "after-linux-xvfb-amd-cb" |
| date | "2026-11-01" | "2026-11-01" |
| engine | "cloakbrowser" | "cloakbrowser" |
| engineVersion | "146.0.7680.177.5" | "146.0.7680.177.5" |
| mode | "xvfb" | "xvfb" |
| displayMode | "xvfb" | "xvfb" |
| egress | "allow-all" | "allow-all" |
| seed | "mz-baseline-70" | "mz-baseline-70" |
| platform | "linux" | "linux" |
| persona | linux-desktop-amd | linux-desktop-amd |

## Thresholds

None fired: no `HeadlessChrome`, no `webdriver: true`, no `pointer: none`.

22 differences; left out: 20 by the noise rules.

## probe (2)

| path | A | B |
| --- | --- | --- |
| `probe.webgl.unmaskedRenderer` | "AMD Radeon RX 7800 XT (radeonsi, navi32, LLVM 17.0.6, DRM 3.57, 6.6.0)" | "ANGLE (AMD, AMD Radeon RX 7800 XT (radeonsi, navi32, LLVM 17.0.6, DRM 3.57, 6.6.0), OpenGL 4.6 (Core Profile) Mesa 24.0.9)" |
| `probe.webgl.unmaskedVendor` | "Mesa" | "Google Inc. (AMD)" |

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
| `creepjs.audio.noise` | 1006.0915144935585 | 999.1644448521392 |
| `creepjs.fingerprintId` | "FP ID: ac339c12466963cc2350a8acb586199babf55dc657d92b2db27e6ce13750e8b2" | "FP ID: d6abbcc5cff6cb2ade8e0843fb64055eada064c675a6c62e7ec404e465b9140d" |
| `creepjs.hashes.canvasWebgl` | "db38beaccdc2f6a0e32a3f4e271d8d4e0a6cee8db4b961600083b2c24b23eff3" | "b323a0c9f11a34a255892dd98a69c8c104d37aeb46a45fbe4853a519a942dba9" |
| `creepjs.hashes.offlineAudioContext` | "4ded4ed70301a5716edea05d327727dbff335a03fee719a9a3880c390890d564" | "1731f03355e68705dd7b5283b63d341767e76f09fe431ac391395b5ba6ce919a" |
| `creepjs.hashes.workerScope` | "ea539f5eba22537eea8082645a443bf2bd5463b6f13cc15cd8952ea81ca1eff7" | "834860f457e5c97029f5e2338a63125c202a25cb12f49276dd07ed31cfee3ce5" |
| `creepjs.webgl.gpu.compressedGPU` | "AMD Radeon RX 7000s XT (radeonsi, navi32, LLVM 17.0.6, DRM 3.57, 6.6.0)" | "AMD, AMD Radeon RX 7000s XT (radeonsi, navi32, LLVM 17.0.6, DRM 3.57, 6.6.0), OpenGL 4.6 (Core Profile)" |
| `creepjs.webgl.gpu.parts` | "AMD, Radeon" | "AMD, ANGLE, Mesa, OpenGL, Radeon" |
| `creepjs.worker.gpu.compressedGPU` | "AMD Radeon RX 7000s XT (radeonsi, navi32, LLVM 17.0.6, DRM 3.57, 6.6.0)" | "AMD, AMD Radeon RX 7000s XT (radeonsi, navi32, LLVM 17.0.6, DRM 3.57, 6.6.0), OpenGL 4.6 (Core Profile)" |
| `creepjs.worker.gpu.parts` | "AMD, Radeon" | "AMD, ANGLE, Mesa, OpenGL, Radeon" |
| `creepjs.worker.webglRenderer` | "AMD Radeon RX 7800 XT (radeonsi, navi32, LLVM 17.0.6, DRM 3.57, 6.6.0)" | "ANGLE (AMD, AMD Radeon RX 7800 XT (radeonsi, navi32, LLVM 17.0.6, DRM 3.57, 6.6.0), OpenGL 4.6 (Core Profile) Mesa 24.0.9)" |
| `creepjs.worker.webglVendor` | "Mesa" | "Google Inc. (AMD)" |

## rebrowser (0)

No differences.
