# linux-xvfb-linuxpersona-cf vs linux-headless-linuxpersona-cf

| | A | B |
| --- | --- | --- |
| label | "linux-xvfb-linuxpersona-cf" | "linux-headless-linuxpersona-cf" |
| date | "2026-10-31" | "2026-10-31" |
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

19 differences; left out: 14 by the noise rules, 136 that also differ between a setup and its own repeat.

## probe (7)

| path | A | B |
| --- | --- | --- |
| `probe.webgl` | (absent) | null |
| `probe.webgl.params.MAX_COMBINED_TEXTURE_IMAGE_UNITS` | 192 | (absent) |
| `probe.webgl.params.MAX_VERTEX_ATTRIBS` | 16 | (absent) |
| `probe.webgl.shading` | "WebGL GLSL ES 1.0" | (absent) |
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

## creepjs (12)

| path | A | B |
| --- | --- | --- |
| `creepjs.hashes.headless` | "9e6ef6246fb4a6adfd76cd43cc26bc057d21771909ff42f3fea40422f9f57421" | "dfaf67bd420c3b551958d7e82c82ba86a1e13bba310d14c5e14dd82d3ba044a3" |
| `creepjs.headless.stealth.hasBadWebGL` | false | (absent) |
| `creepjs.webgl.gpu` | (absent) | null |
| `creepjs.webgl.gpu.confidence` | "high" | (absent) |
| `creepjs.webgl.gpu.gibbers` | "" | (absent) |
| `creepjs.webgl.gpu.grade` | "A" | (absent) |
| `creepjs.webgl.gpu.warnings` |  | (absent) |
| `creepjs.webgl.lied` | false | null |
| `creepjs.worker.gpu.confidence` | "high" | (absent) |
| `creepjs.worker.gpu.gibbers` | "" | (absent) |
| `creepjs.worker.gpu.grade` | "A" | (absent) |
| `creepjs.worker.gpu.warnings` |  | (absent) |

## rebrowser (0)

No differences.
