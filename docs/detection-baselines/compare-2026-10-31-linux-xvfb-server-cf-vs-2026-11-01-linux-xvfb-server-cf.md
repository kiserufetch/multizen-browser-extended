# linux-xvfb-server-cf vs linux-xvfb-server-cf

| | A | B |
| --- | --- | --- |
| label | "linux-xvfb-server-cf" | "linux-xvfb-server-cf" |
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

2 differences; left out: 15 by the noise rules, 121 that also differ between a setup and its own repeat.

## probe (0)

No differences.

## headers (0)

No differences.

## fonts (0)

No differences.

## input (1)

| path | A | B |
| --- | --- | --- |
| `input.click.sequence` | pointerover, pointerenter, mouseover, mouseenter, pointerout, pointerleave, pointerover, pointerenter, pointermove+, mouseout, mouseleave, mouseover, mouseenter, mousemove+, pointerdown, mousedown, focus, focusin, pointerup, pointerout, pointerleave, mouseup, click (other order) | pointerover, pointerenter, mouseover, mouseenter, pointerout, pointerover, pointerenter, mouseout, mouseover, mouseenter, pointerout, pointerleave, pointerover, pointerenter, pointermove+, mouseout, mouseleave, mouseover, mouseenter, mousemove+, pointerdown, mousedown, focus, focusin, pointerup, poi... |

## tls (0)

No differences.

## h2 (0)

No differences.

## webrtc (0)

No differences.

## creepjs (1)

| path | A | B |
| --- | --- | --- |
| `creepjs.audio.totalUniqueSamples` | 4736 | 4734 |

## rebrowser (0)

No differences.
