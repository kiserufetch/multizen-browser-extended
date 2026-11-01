# linux-xvfb-cf vs linux-headless-cf

| | A | B |
| --- | --- | --- |
| label | "linux-xvfb-cf" | "linux-headless-cf" |
| date | "2026-10-31" | "2026-10-31" |
| engine | "camoufox" | "camoufox" |
| engineVersion | "152.0.4-beta.30" | "152.0.4-beta.30" |
| mode | "xvfb" | "headless" |
| displayMode | "xvfb" | "headless" |
| egress | "allow-all" | "allow-all" |
| seed | "mz-baseline-70" | "mz-baseline-70" |
| platform | "linux" | "linux" |
| persona | windows-desktop-nvidia | windows-desktop-nvidia |

## Thresholds

None fired: no `HeadlessChrome`, no `webdriver: true`, no `pointer: none`.

36 differences; left out: 16 by the noise rules, 88 that also differ between a setup and its own repeat.

## probe (16)

| path | A | B |
| --- | --- | --- |
| `probe.webgl` | (absent) | null |
| `probe.webgl.extensionCount` | 27 | (absent) |
| `probe.webgl.extensionsHash` | -771883384 | (absent) |
| `probe.webgl.params.ALIASED_LINE_WIDTH_RANGE` | 1, 1 | (absent) |
| `probe.webgl.params.MAX_COMBINED_TEXTURE_IMAGE_UNITS` | 32 | (absent) |
| `probe.webgl.params.MAX_RENDERBUFFER_SIZE` | 16384 | (absent) |
| `probe.webgl.params.MAX_TEXTURE_SIZE` | 16384 | (absent) |
| `probe.webgl.params.MAX_VERTEX_ATTRIBS` | 16 | (absent) |
| `probe.webgl.params.MAX_VIEWPORT_DIMS` | 32767, 32767 | (absent) |
| `probe.webgl.renderer` | "ANGLE (NVIDIA, NVIDIA GeForce GTX 980 Direct3D11 vs_5_0 ps_5_0), or similar" | (absent) |
| `probe.webgl.shading` | "WebGL GLSL ES 1.0" | (absent) |
| `probe.webgl.unmaskedRenderer` | "ANGLE (NVIDIA, NVIDIA GeForce GTX 980 Direct3D11 vs_5_0 ps_5_0), or similar" | (absent) |
| `probe.webgl.unmaskedVendor` | "Google Inc. (NVIDIA)" | (absent) |
| `probe.webgl.vendor` | "Mozilla" | (absent) |
| `probe.webgl.version` | "WebGL 1.0" | (absent) |
| `probe.webgl.webgl2` | true | (absent) |

## headers (0)

No differences.

## fonts (0)

No differences.

## input (1)

| path | A | B |
| --- | --- | --- |
| `input.click.sequence` | only here (2 of 23): mouseout, mouseleave | only here (0 of 15):  |

## tls (0)

No differences.

## h2 (1)

| path | A | B |
| --- | --- | --- |
| `h2.frameOrder` | only here (0 of 7):  | only here (1 of 8): GOAWAY |

## webrtc (0)

No differences.

## creepjs (18)

| path | A | B |
| --- | --- | --- |
| `creepjs.hashes.headless` | "e9d45bc0188a9305257fa7ef153b8f240f3422135b55e04bae5d7ee1f8f19723" | "77d71583e8c4ee9b3a4f4dc7ddb53b827bf6c22a36ab6d6b7dfcaec0ce187085" |
| `creepjs.headless.stealth.hasBadWebGL` | false | (absent) |
| `creepjs.webgl.gpu` | (absent) | null |
| `creepjs.webgl.gpu.compressedGPU` | "NVIDIA, NVIDIA GeForce GTX 900s" | (absent) |
| `creepjs.webgl.gpu.confidence` | "high" | (absent) |
| `creepjs.webgl.gpu.gibbers` | "" | (absent) |
| `creepjs.webgl.gpu.grade` | "A" | (absent) |
| `creepjs.webgl.gpu.parts` | "ANGLE, Direct3D, GeForce, NVIDIA" | (absent) |
| `creepjs.webgl.gpu.warnings` |  | (absent) |
| `creepjs.webgl.lied` | false | null |
| `creepjs.worker.gpu.compressedGPU` | "NVIDIA, NVIDIA GeForce GTX 900s" | (absent) |
| `creepjs.worker.gpu.confidence` | "high" | (absent) |
| `creepjs.worker.gpu.gibbers` | "" | (absent) |
| `creepjs.worker.gpu.grade` | "A" | (absent) |
| `creepjs.worker.gpu.parts` | "ANGLE, Direct3D, GeForce, NVIDIA" | (absent) |
| `creepjs.worker.gpu.warnings` |  | (absent) |
| `creepjs.worker.webglRenderer` | "ANGLE (NVIDIA, NVIDIA GeForce GTX 980 Direct3D11 vs_5_0 ps_5_0), or similar" | (absent) |
| `creepjs.worker.webglVendor` | "Google Inc. (NVIDIA)" | (absent) |

## rebrowser (0)

No differences.
