# linux-xvfb-linuxpersona-session-cb vs linux-headless-linuxpersona-session-cb

| | A | B |
| --- | --- | --- |
| label | "linux-xvfb-linuxpersona-session-cb" | "linux-headless-linuxpersona-session-cb" |
| date | "2026-11-01" | "2026-11-01" |
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

7 differences; left out: 19 by the noise rules, 2 that also differ between a setup and its own repeat.

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

## creepjs (2)

| path | A | B |
| --- | --- | --- |
| `creepjs.hashes.canvas2d` | "85eca175699c464fb2f30ff4db636be5fdaefda11ac1a306d492c261b5368bf5" | "424a27ce6549224c01c34756dcd7b9ab0b0129840391b435a40dceedc2fbef40" |
| `creepjs.hashes.canvasWebgl` | "112a4814ea1a70909ddd9ef0310ef181c1a211a2d3ce3160b64d1d55bfb32ef2" | "8fe506e8c88a1faaf41ba53198e3e5b469242368659d2eb17f2e74da9c936169" |

## rebrowser (0)

No differences.
