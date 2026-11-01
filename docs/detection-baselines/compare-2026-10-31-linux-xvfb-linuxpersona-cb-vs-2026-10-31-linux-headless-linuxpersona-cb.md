# linux-xvfb-linuxpersona-cb vs linux-headless-linuxpersona-cb

| | A | B |
| --- | --- | --- |
| label | "linux-xvfb-linuxpersona-cb" | "linux-headless-linuxpersona-cb" |
| date | "2026-10-31" | "2026-10-31" |
| engine | "cloakbrowser" | "cloakbrowser" |
| engineVersion | "146.0.7680.177.5" | "146.0.7680.177.5" |
| mode | "xvfb" | "headless" |
| displayMode | "xvfb" | "headless" |
| egress | "block-private" | "block-private" |
| seed | "mz-baseline-70" | "mz-baseline-70" |
| platform | "linux" | "linux" |
| persona | linux-laptop-nvidia | linux-laptop-nvidia |

## Thresholds

None fired: no `HeadlessChrome`, no `webdriver: true`, no `pointer: none`.

14 differences; left out: 19 by the noise rules, 2 that also differ between a setup and its own repeat.

## probe (4)

| path | A | B |
| --- | --- | --- |
| `probe.canvasHash` | 325818622 | -1880325330 |
| `probe.webgl.canvasHash` | 2131711150 | -37762976 |
| `probe.webgl.extensionCount` | 35 | 33 |
| `probe.webgl.extensionsHash` | -826598732 | -101185691 |

## headers (0)

No differences.

## fonts (1)

| path | A | B |
| --- | --- | --- |
| `fonts.emoji.canvasHash` | -2109959406 | 2009971888 |

## input (0)

No differences.

## tls (0)

No differences.

## h2 (0)

No differences.

## webrtc (0)

No differences.

## creepjs (9)

| path | A | B |
| --- | --- | --- |
| `creepjs.hashes.canvas2d` | "985a672b99777d52e3cc6354ae57683de3701413c5d7a18354009619986524db" | "91e3084bbc320f6b8a9251820e7f93d9069669aac7d7fba976fcb26bcf3bfd5c" |
| `creepjs.hashes.canvasWebgl` | "c47ed215a3c62475feaff723953cf697dcdb0b0a8112af2fcab17d62262d7c83" | "20ba26888886580d907a45948d33b2ec8717ff9ba4940103bdc5f69d3357b3d9" |
| `creepjs.hashes.trash` | "cc8fe7dc8aa60e3584c5058944ebfdc44a3432aef2e1635de6a7275bb2d642ca" | "1e322b56b3457db4170759c3cc1a1eca3bc5ffc4cbef8a668153382f8118ce19" |
| `creepjs.trash.count` | 3 | 4 |
| `creepjs.trash.items[1].name` | "AudioBuffer" | "WebGLRenderingContext.getParameter" |
| `creepjs.trash.items[1].value` | "5000 unique samples of 5000 is too high" | "suspicious capabilities" |
| `creepjs.trash.items[2].value` | "suspicious frequency data" | "5000 unique samples of 5000 is too high" |
| `creepjs.trash.items[3].name` | (absent) | "AudioBuffer" |
| `creepjs.trash.items[3].value` | (absent) | "suspicious frequency data" |

## rebrowser (0)

No differences.
