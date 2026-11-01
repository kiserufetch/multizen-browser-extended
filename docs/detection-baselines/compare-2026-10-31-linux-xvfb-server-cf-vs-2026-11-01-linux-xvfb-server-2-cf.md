# linux-xvfb-server-cf vs linux-xvfb-server-2-cf

| | A | B |
| --- | --- | --- |
| label | "linux-xvfb-server-cf" | "linux-xvfb-server-2-cf" |
| date | "2026-10-31" | "2026-11-01" |
| engine | "camoufox" | "camoufox" |
| engineVersion | "152.0.4-beta.30" | "152.0.4-beta.30" |
| mode | "xvfb" | "xvfb" |
| displayMode | "xvfb" | "xvfb" |
| egress | "block-private" | "block-private" |
| seed | "mz-baseline-70" | "mz-baseline-70" |
| platform | "linux" | "linux" |
| persona | windows-desktop-nvidia | windows-desktop-nvidia |

## Thresholds

None fired: no `HeadlessChrome`, no `webdriver: true`, no `pointer: none`.

9 differences; left out: 17 by the noise rules, 126 that also differ between a setup and its own repeat.

## probe (3)

| path | A | B |
| --- | --- | --- |
| `probe.webgl.renderer` | "ANGLE (NVIDIA, NVIDIA GeForce GTX 980 Direct3D11 vs_5_0 ps_5_0), or similar" | "ANGLE (Intel, Intel(R) HD Graphics 400 Direct3D11 vs_5_0 ps_5_0), or similar" |
| `probe.webgl.unmaskedRenderer` | "ANGLE (NVIDIA, NVIDIA GeForce GTX 980 Direct3D11 vs_5_0 ps_5_0), or similar" | "ANGLE (Intel, Intel(R) HD Graphics 400 Direct3D11 vs_5_0 ps_5_0), or similar" |
| `probe.webgl.unmaskedVendor` | "Google Inc. (NVIDIA)" | "Google Inc. (Intel)" |

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

## creepjs (6)

| path | A | B |
| --- | --- | --- |
| `creepjs.webgl.gpu.compressedGPU` | "NVIDIA, NVIDIA GeForce GTX 900s" | "Intel, Intel(R) HD Graphics 400s" |
| `creepjs.webgl.gpu.parts` | "ANGLE, Direct3D, GeForce, NVIDIA" | "ANGLE, Direct3D, Graphics, Intel, Intel(R) HD Graphics" |
| `creepjs.worker.gpu.compressedGPU` | "NVIDIA, NVIDIA GeForce GTX 900s" | "Intel, Intel(R) HD Graphics 400s" |
| `creepjs.worker.gpu.parts` | "ANGLE, Direct3D, GeForce, NVIDIA" | "ANGLE, Direct3D, Graphics, Intel, Intel(R) HD Graphics" |
| `creepjs.worker.webglRenderer` | "ANGLE (NVIDIA, NVIDIA GeForce GTX 980 Direct3D11 vs_5_0 ps_5_0), or similar" | "ANGLE (Intel, Intel(R) HD Graphics 400 Direct3D11 vs_5_0 ps_5_0), or similar" |
| `creepjs.worker.webglVendor` | "Google Inc. (NVIDIA)" | "Google Inc. (Intel)" |

## rebrowser (0)

No differences.
