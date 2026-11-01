# linux-xvfb-intelpersona-session-cb vs linux-xvfb-amdpersona-session-cb

| | A | B |
| --- | --- | --- |
| label | "linux-xvfb-intelpersona-session-cb" | "linux-xvfb-amdpersona-session-cb" |
| date | "2026-11-01" | "2026-11-01" |
| engine | "cloakbrowser" | "cloakbrowser" |
| engineVersion | "146.0.7680.177.5" | "146.0.7680.177.5" |
| mode | "xvfb" | "xvfb" |
| displayMode | "xvfb" | "xvfb" |
| egress | "block-private" | "block-private" |
| seed | "mz-baseline-70" | "mz-baseline-70" |
| platform | "linux" | "linux" |
| persona | linux-laptop-intel | linux-laptop-amd |

## Thresholds

None fired: no `HeadlessChrome`, no `webdriver: true`, no `pointer: none`.

29 differences; left out: 18 by the noise rules.

## probe (5)

| path | A | B |
| --- | --- | --- |
| `probe.hardwareConcurrency` | 4 | 6 |
| `probe.webgl.params.MAX_RENDERBUFFER_SIZE` | 16384 | 32768 |
| `probe.webgl.params.MAX_TEXTURE_SIZE` | 16384 | 32768 |
| `probe.webgl.unmaskedRenderer` | "ANGLE (Intel, Mesa Intel(R) Xe Graphics (TGL GT2), OpenGL 4.6 (Core Profile) Mesa 24.0.9-0ubuntu0.1)" | "ANGLE (AMD, AMD Radeon Graphics (radeonsi, rembrandt, LLVM 17.0.6, DRM 3.57, 6.8.0-45-generic), OpenGL 4.6 (Core Profile) Mesa 24.0.9-0ubuntu0.1)" |
| `probe.webgl.unmaskedVendor` | "Google Inc. (Intel)" | "Google Inc. (AMD)" |

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

## webrtc (0)

No differences.

## creepjs (24)

| path | A | B |
| --- | --- | --- |
| `creepjs.audio.noise` | 979.9095189123702 | 1002.2596944068246 |
| `creepjs.fingerprintId` | "FP ID: e172f511b3830e4a92afff6a662c28523047b2e7df1896a7c1179fc15e894bba" | "FP ID: 38658c80a0d007fb4cab337ad84116a80d0f867df3e25f54851ba742ac3cce1a" |
| `creepjs.hashes.canvasWebgl` | "ac12e8c903affcb6cc286d6285082024394f7e9c4ddea1a008b5d16b4e5efe56" | "bbe38a24c862ffad3a82392d9e42697fa062ba2300c4bf4db59b8d4b3ec938c3" |
| `creepjs.hashes.navigator` | "4d31abc7d4b750ee79f1ef71c6645fc28281f3f1bb56e21b8c5415dd55acbadb" | "21c247f8a88ba42e3c0ce59d084c0e3b11dbba48a3d464280bbbe2af914d4101" |
| `creepjs.hashes.offlineAudioContext` | "4a6e2075b48d41900261ef57a6e07d5a26a53ff28757af396e3c3f0b1d2504f7" | "8d68cecac5f47fec9ae09669d3f7fa3598698770a4e50f7439d46db7dd71b6b3" |
| `creepjs.hashes.trash` | "1affd279445bca932557cbc04d48a5280483c9a4a51d0db3bc6f497279e60651" | "1e322b56b3457db4170759c3cc1a1eca3bc5ffc4cbef8a668153382f8118ce19" |
| `creepjs.hashes.workerScope` | "66c6f472adc9b78313282b959fab3ee13138abef910530453227daf3a65dbaad" | "9614430ae57c9f404e0576656802a8f6afbbe2310a9082e8490b85421e019751" |
| `creepjs.navigator.hardwareConcurrency` | 4 | 6 |
| `creepjs.trash.count` | 2 | 4 |
| `creepjs.trash.items[0].name` | "AudioBuffer" | "WebGLRenderingContext.getParameter" |
| `creepjs.trash.items[0].value` | "5000 unique samples of 5000 is too high" | "suspicious gpu" |
| `creepjs.trash.items[1].name` | "AudioBuffer" | "WebGLRenderingContext.getParameter" |
| `creepjs.trash.items[1].value` | "suspicious frequency data" | "suspicious capabilities" |
| `creepjs.trash.items[2].name` | (absent) | "AudioBuffer" |
| `creepjs.trash.items[2].value` | (absent) | "5000 unique samples of 5000 is too high" |
| `creepjs.trash.items[3].name` | (absent) | "AudioBuffer" |
| `creepjs.trash.items[3].value` | (absent) | "suspicious frequency data" |
| `creepjs.webgl.gpu.compressedGPU` | "Intel," | "AMD, AMD Radeon Graphics (radeonsi, rembrandt, LLVM 17.0.6, DRM 3.57, 6.8.0-45-generic), OpenGL 4.6 (Core Profile)" |
| `creepjs.webgl.gpu.parts` | "ANGLE, Graphics, Intel, Mesa, OpenGL, Xe Graphics" | "AMD, ANGLE, Graphics, Mesa, OpenGL, Radeon" |
| `creepjs.worker.gpu.compressedGPU` | "Intel," | "AMD, AMD Radeon Graphics (radeonsi, rembrandt, LLVM 17.0.6, DRM 3.57, 6.8.0-45-generic), OpenGL 4.6 (Core Profile)" |
| `creepjs.worker.gpu.parts` | "ANGLE, Graphics, Intel, Mesa, OpenGL, Xe Graphics" | "AMD, ANGLE, Graphics, Mesa, OpenGL, Radeon" |
| `creepjs.worker.hardwareConcurrency` | 4 | 6 |
| `creepjs.worker.webglRenderer` | "ANGLE (Intel, Mesa Intel(R) Xe Graphics (TGL GT2), OpenGL 4.6 (Core Profile) Mesa 24.0.9-0ubuntu0.1)" | "ANGLE (AMD, AMD Radeon Graphics (radeonsi, rembrandt, LLVM 17.0.6, DRM 3.57, 6.8.0-45-generic), OpenGL 4.6 (Core Profile) Mesa 24.0.9-0ubuntu0.1)" |
| `creepjs.worker.webglVendor` | "Google Inc. (Intel)" | "Google Inc. (AMD)" |

## rebrowser (0)

No differences.
