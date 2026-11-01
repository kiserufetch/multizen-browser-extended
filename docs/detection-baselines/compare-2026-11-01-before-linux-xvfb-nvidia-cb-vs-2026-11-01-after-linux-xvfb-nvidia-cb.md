# before-linux-xvfb-nvidia-cb vs after-linux-xvfb-nvidia-cb

| | A | B |
| --- | --- | --- |
| label | "before-linux-xvfb-nvidia-cb" | "after-linux-xvfb-nvidia-cb" |
| date | "2026-11-01" | "2026-11-01" |
| engine | "cloakbrowser" | "cloakbrowser" |
| engineVersion | "146.0.7680.177.5" | "146.0.7680.177.5" |
| mode | "xvfb" | "xvfb" |
| displayMode | "xvfb" | "xvfb" |
| egress | "allow-all" | "allow-all" |
| seed | "mz-baseline-70" | "mz-baseline-70" |
| platform | "linux" | "linux" |
| persona | linux-desktop-nvidia | linux-desktop-nvidia |

## Thresholds

None fired: no `HeadlessChrome`, no `webdriver: true`, no `pointer: none`.

26 differences; left out: 20 by the noise rules.

## probe (2)

| path | A | B |
| --- | --- | --- |
| `probe.webgl.unmaskedRenderer` | "ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 4070/PCIe/SSE2/PCIe/SSE2, OpenGL 4.5.0 NVIDIA 565.77)" | "ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 4070/PCIe/SSE2, OpenGL 4.5.0 NVIDIA 565.77)" |
| `probe.webgl.unmaskedVendor` | "NVIDIA Corporation" | "Google Inc. (NVIDIA Corporation)" |

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

## creepjs (15)

| path | A | B |
| --- | --- | --- |
| `creepjs.audio.noise` | 1004.9546644065131 | 989.0899663003926 |
| `creepjs.fingerprintId` | "FP ID: 0ee84fce2e1ef40a5c77e921d7c0dc237cbcb2d7616e295330c0cfec35239c12" | "FP ID: bd1d67911d36130b34e99e289c88a202f24fff9e2676f2bd49f9d689d742de10" |
| `creepjs.hashes.canvasWebgl` | "ff5029ba0bcbd051422d62f8bddeaea35bc876aeffbfe73023d4a9a7a85dc48e" | "8b8c50029a5bc4912c63fe4cbbe37371c5f602bd17ffe8271151354f8dd009b4" |
| `creepjs.hashes.offlineAudioContext` | "0e12d65384e1d03fb68728f63919c738b2ad44060d0de6cb28668ceacea6ed05" | "28111d8f43101306d320de5e1e1a355bf107dc065c5915d52f6100fc427044a5" |
| `creepjs.hashes.workerScope` | "4811dd7995ff3afbc690da75c2e38795b5ba4db5bb6f742345e98a78d5ef3077" | "03be34e52618b66b4874031c35d57b29f01e24d4109857fbe4174c5c381a6dda" |
| `creepjs.webgl.gpu.compressedGPU` | "NVIDIA Corporation, NVIDIA GeForce RTX 4000s/PCIe/SSE2/PCIe/SSE2, OpenGL 4.5.0 )" | "NVIDIA Corporation, NVIDIA GeForce RTX 4000s/PCIe/SSE2, OpenGL 4.5.0 )" |
| `creepjs.webgl.gpu.confidence` | "moderate" | "high" |
| `creepjs.webgl.gpu.gibbers` | "PCIe, PCIe" | "" |
| `creepjs.webgl.gpu.grade` | "C" | "A" |
| `creepjs.worker.gpu.compressedGPU` | "NVIDIA Corporation, NVIDIA GeForce RTX 4000s/PCIe/SSE2/PCIe/SSE2, OpenGL 4.5.0 )" | "NVIDIA Corporation, NVIDIA GeForce RTX 4000s/PCIe/SSE2, OpenGL 4.5.0 )" |
| `creepjs.worker.gpu.confidence` | "moderate" | "high" |
| `creepjs.worker.gpu.gibbers` | "PCIe, PCIe" | "" |
| `creepjs.worker.gpu.grade` | "C" | "A" |
| `creepjs.worker.webglRenderer` | "ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 4070/PCIe/SSE2/PCIe/SSE2, OpenGL 4.5.0 NVIDIA 565.77)" | "ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 4070/PCIe/SSE2, OpenGL 4.5.0 NVIDIA 565.77)" |
| `creepjs.worker.webglVendor` | "NVIDIA Corporation" | "Google Inc. (NVIDIA Corporation)" |

## rebrowser (0)

No differences.
