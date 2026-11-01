# win-headed-desktop-cf vs win-headed-occlusion-cf

| | A | B |
| --- | --- | --- |
| label | "win-headed-desktop-cf" | "win-headed-occlusion-cf" |
| date | "2026-10-31" | "2026-10-31" |
| engine | "camoufox" | "camoufox" |
| engineVersion | "152.0.4-beta.30" | "152.0.4-beta.30" |
| mode | "headed" | "headed" |
| displayMode | "headed" | "headed" |
| egress | "allow-all" | "allow-all" |
| seed | "mz-baseline-70" | "mz-baseline-70" |
| platform | "win32" | "win32" |
| persona | windows-desktop-nvidia | windows-desktop-nvidia |

## Thresholds

None fired: no `HeadlessChrome`, no `webdriver: true`, no `pointer: none`.

6 differences; left out: 21 by the noise rules, 129 that also differ between a setup and its own repeat.

## probe (2)

| path | A | B |
| --- | --- | --- |
| `probe.webgl.unmaskedVendor` | "Google Inc. (Intel)" | "Google Inc. (NVIDIA)" |
| `probe.window.historyLength` | 3 | 2 |

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

## creepjs (4)

| path | A | B |
| --- | --- | --- |
| `creepjs.audio.totalUniqueSamples` | 4736 | 4735 |
| `creepjs.webgl.gpu.parts` | "ANGLE, Direct3D, Graphics, Intel, Intel(R) HD Graphics" | "ANGLE, Direct3D, GeForce, NVIDIA" |
| `creepjs.worker.gpu.parts` | "ANGLE, Direct3D, Graphics, Intel, Intel(R) HD Graphics" | "ANGLE, Direct3D, GeForce, NVIDIA" |
| `creepjs.worker.webglVendor` | "Google Inc. (Intel)" | "Google Inc. (NVIDIA)" |

## rebrowser (0)

No differences.

## covered (0)

No differences.
