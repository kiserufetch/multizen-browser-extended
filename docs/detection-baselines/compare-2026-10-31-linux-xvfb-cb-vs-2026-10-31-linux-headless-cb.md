# linux-xvfb-cb vs linux-headless-cb

| | A | B |
| --- | --- | --- |
| label | "linux-xvfb-cb" | "linux-headless-cb" |
| date | "2026-10-31" | "2026-10-31" |
| engine | "cloakbrowser" | "cloakbrowser" |
| engineVersion | "146.0.7680.177.5" | "146.0.7680.177.5" |
| mode | "xvfb" | "headless" |
| displayMode | "xvfb" | "headless" |
| egress | "allow-all" | "allow-all" |
| seed | "mz-baseline-70" | "mz-baseline-70" |
| platform | "linux" | "linux" |
| persona | windows-desktop-nvidia | windows-desktop-nvidia |

## Thresholds

None fired: no `HeadlessChrome`, no `webdriver: true`, no `pointer: none`.

18 differences; left out: 20 by the noise rules, 2 that also differ between a setup and its own repeat.

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

## creepjs (13)

| path | A | B |
| --- | --- | --- |
| `creepjs.fingerprintId` | "FP ID: e4030172e342f7dc8f973040759010d79bd32c1a032d5008c7f2dcbae6a47f12" | "FP ID: 5be06df2b408ed9c85ea8283e04dd14aedf092f1db02130d8f51962b63376e59" |
| `creepjs.hashes.canvas2d` | "d91ac2aece6149d4ad75a0e953dde3fcde1bf8b673f4dfa147b94491425b8ebb" | "4097162d329300fd683032ef5ffe429a03ce72eeb7d3e37ae4f603afdd2b64a5" |
| `creepjs.hashes.canvasWebgl` | "b76eb868cf9d154028c4bdf5f12975770671ae0c0962d9ffba7e58305d2f1929" | "028ae783d743dfa0816510e0afb25271bc2fcd484bc80efda12aaeaa28fa48b8" |
| `creepjs.hashes.trash` | "1affd279445bca932557cbc04d48a5280483c9a4a51d0db3bc6f497279e60651" | "1e322b56b3457db4170759c3cc1a1eca3bc5ffc4cbef8a668153382f8118ce19" |
| `creepjs.trash.count` | 2 | 4 |
| `creepjs.trash.items[0].name` | "AudioBuffer" | "WebGLRenderingContext.getParameter" |
| `creepjs.trash.items[0].value` | "5000 unique samples of 5000 is too high" | "suspicious gpu" |
| `creepjs.trash.items[1].name` | "AudioBuffer" | "WebGLRenderingContext.getParameter" |
| `creepjs.trash.items[1].value` | "suspicious frequency data" | "suspicious capabilities" |
| `creepjs.trash.items[2].name` | (absent) | "AudioBuffer" |
| `creepjs.trash.items[2].value` | (absent) | "5000 unique samples of 5000 is too high" |
| `creepjs.trash.items[3].name` | (absent) | "AudioBuffer" |
| `creepjs.trash.items[3].value` | (absent) | "suspicious frequency data" |

## rebrowser (0)

No differences.
