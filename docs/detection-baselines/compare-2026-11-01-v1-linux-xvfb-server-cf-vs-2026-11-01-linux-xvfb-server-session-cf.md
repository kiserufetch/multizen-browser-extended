# v1-linux-xvfb-server-cf vs linux-xvfb-server-session-cf

| | A | B |
| --- | --- | --- |
| label | "v1-linux-xvfb-server-cf" | "linux-xvfb-server-session-cf" |
| date | "2026-11-01" | "2026-11-01" |
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

10 differences; left out: 14 by the noise rules, 114 that also differ between a setup and its own repeat.

## probe (3)

| path | A | B |
| --- | --- | --- |
| `probe.webgl.renderer` | "ANGLE (NVIDIA, NVIDIA GeForce GTX 980 Direct3D11 vs_5_0 ps_5_0), or similar" | "ANGLE (AMD, Radeon HD 3200 Graphics Direct3D11 vs_5_0 ps_5_0), or similar" |
| `probe.webgl.unmaskedRenderer` | "ANGLE (NVIDIA, NVIDIA GeForce GTX 980 Direct3D11 vs_5_0 ps_5_0), or similar" | "ANGLE (AMD, Radeon HD 3200 Graphics Direct3D11 vs_5_0 ps_5_0), or similar" |
| `probe.webgl.unmaskedVendor` | "Google Inc. (NVIDIA)" | "Google Inc. (AMD)" |

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

## creepjs (7)

| path | A | B |
| --- | --- | --- |
| `creepjs.hashes.media` | "b395e83d4853a5d3a02d2ba81f6b761e830c8adbea21722ae21bab34990cb41a" | "5cee837b6a8c8ce55cd43c70b0cf2ddbe4ad3869a28bb791ea33f5b34d3d7aa8" |
| `creepjs.webgl.gpu.compressedGPU` | "NVIDIA, NVIDIA GeForce GTX 900s" | "AMD, Radeon HD 3000s Graphics" |
| `creepjs.webgl.gpu.parts` | "ANGLE, Direct3D, GeForce, NVIDIA" | "AMD, ANGLE, Direct3D, Graphics, Radeon" |
| `creepjs.worker.gpu.compressedGPU` | "NVIDIA, NVIDIA GeForce GTX 900s" | "AMD, Radeon HD 3000s Graphics" |
| `creepjs.worker.gpu.parts` | "ANGLE, Direct3D, GeForce, NVIDIA" | "AMD, ANGLE, Direct3D, Graphics, Radeon" |
| `creepjs.worker.webglRenderer` | "ANGLE (NVIDIA, NVIDIA GeForce GTX 980 Direct3D11 vs_5_0 ps_5_0), or similar" | "ANGLE (AMD, Radeon HD 3200 Graphics Direct3D11 vs_5_0 ps_5_0), or similar" |
| `creepjs.worker.webglVendor` | "Google Inc. (NVIDIA)" | "Google Inc. (AMD)" |

## rebrowser (0)

No differences.
