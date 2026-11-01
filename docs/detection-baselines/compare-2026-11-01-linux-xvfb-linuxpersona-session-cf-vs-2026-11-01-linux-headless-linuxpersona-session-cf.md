# linux-xvfb-linuxpersona-session-cf vs linux-headless-linuxpersona-session-cf

| | A | B |
| --- | --- | --- |
| label | "linux-xvfb-linuxpersona-session-cf" | "linux-headless-linuxpersona-session-cf" |
| date | "2026-11-01" | "2026-11-01" |
| engine | "camoufox" | "camoufox" |
| engineVersion | "152.0.4-beta.30" | "152.0.4-beta.30" |
| mode | "xvfb" | "headless" |
| displayMode | "xvfb" | "headless" |
| egress | "block-private" | "block-private" |
| seed | "mz-baseline-70" | "mz-baseline-70" |
| platform | "linux" | "linux" |
| persona | linux-laptop-nvidia | linux-laptop-nvidia |

## Thresholds

None fired: no `HeadlessChrome`, no `webdriver: true`, no `pointer: none`.

29 differences; left out: 15 by the noise rules, 130 that also differ between a setup and its own repeat.

## probe (14)

| path | A | B |
| --- | --- | --- |
| `probe.webgl` | (absent) | null |
| `probe.webgl.extensionCount` | 29 | (absent) |
| `probe.webgl.extensionsHash` | -1712155958 | (absent) |
| `probe.webgl.params.ALIASED_LINE_WIDTH_RANGE` | 1, 7.375 | (absent) |
| `probe.webgl.params.MAX_COMBINED_TEXTURE_IMAGE_UNITS` | 192 | (absent) |
| `probe.webgl.params.MAX_RENDERBUFFER_SIZE` | 8192 | (absent) |
| `probe.webgl.params.MAX_TEXTURE_SIZE` | 8192 | (absent) |
| `probe.webgl.params.MAX_VERTEX_ATTRIBS` | 16 | (absent) |
| `probe.webgl.params.MAX_VIEWPORT_DIMS` | 16384, 16384 | (absent) |
| `probe.webgl.shading` | "WebGL GLSL ES 1.0" | (absent) |
| `probe.webgl.unmaskedVendor` | "Intel" | (absent) |
| `probe.webgl.vendor` | "Mozilla" | (absent) |
| `probe.webgl.version` | "WebGL 1.0" | (absent) |
| `probe.webgl.webgl2` | true | (absent) |

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

## creepjs (15)

| path | A | B |
| --- | --- | --- |
| `creepjs.audio.totalUniqueSamples` | 4735 | 4736 |
| `creepjs.headless.stealth.hasBadWebGL` | false | (absent) |
| `creepjs.webgl.gpu` | (absent) | null |
| `creepjs.webgl.gpu.confidence` | "high" | (absent) |
| `creepjs.webgl.gpu.gibbers` | "" | (absent) |
| `creepjs.webgl.gpu.grade` | "A" | (absent) |
| `creepjs.webgl.gpu.parts` | "Graphics, Intel, Intel(R) HD Graphics" | (absent) |
| `creepjs.webgl.gpu.warnings` |  | (absent) |
| `creepjs.webgl.lied` | false | null |
| `creepjs.worker.gpu.confidence` | "high" | (absent) |
| `creepjs.worker.gpu.gibbers` | "" | (absent) |
| `creepjs.worker.gpu.grade` | "A" | (absent) |
| `creepjs.worker.gpu.parts` | "Graphics, Intel, Intel(R) HD Graphics" | (absent) |
| `creepjs.worker.gpu.warnings` |  | (absent) |
| `creepjs.worker.webglVendor` | "Intel" | (absent) |

## rebrowser (0)

No differences.
