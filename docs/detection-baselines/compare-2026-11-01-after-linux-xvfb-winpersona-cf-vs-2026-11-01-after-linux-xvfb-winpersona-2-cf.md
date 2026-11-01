# after-linux-xvfb-winpersona-cf vs after-linux-xvfb-winpersona-2-cf

| | A | B |
| --- | --- | --- |
| label | "after-linux-xvfb-winpersona-cf" | "after-linux-xvfb-winpersona-2-cf" |
| date | "2026-11-01" | "2026-11-01" |
| engine | "camoufox" | "camoufox" |
| engineVersion | "152.0.4-beta.30" | "152.0.4-beta.30" |
| mode | "xvfb" | "xvfb" |
| displayMode | "xvfb" | "xvfb" |
| egress | "allow-all" | "allow-all" |
| seed | "mz-baseline-70" | "mz-baseline-70" |
| platform | "linux" | "linux" |
| persona | windows-desktop-nvidia | windows-desktop-nvidia |

## Thresholds

None fired: no `HeadlessChrome`, no `webdriver: true`, no `pointer: none`.

8 differences; left out: 13 by the noise rules.

## probe (3)

| path | A | B |
| --- | --- | --- |
| `probe.canvasHash` | -1254346972 | -942229967 |
| `probe.webgl.canvasHash` | 744225201 | -1579911831 |
| `probe.window.historyLength` | 2 | 4 |

## headers (0)

No differences.

## fonts (1)

| path | A | B |
| --- | --- | --- |
| `fonts.emoji.canvasHash` | 1608658037 | -1285878167 |

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
| `creepjs.canvas.mods.pixelImage` | "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAYAAACM/rhtAAAAR0lEQVRYR+3QMQ0AMAzAsJU/6A6Enx4xgiizu/sOmwJRB1UHVQdVB1UHVQdVB1UHVQdVB1UHVQdVB1UHVQdVB1UHVQfV+YMfyAWfiSN598oAAAAQZGVCRzQzQzQ5MThDMjgyMUEyMDEES9fBAAAAAElFTkSuQmCC" | "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAYAAACM/rhtAAAAR0lEQVRYR+3QMQ0AMAzAsJU/6A6Enx4xgiizu/sOmwJRB1UHVQdVB1UHVQdVB1UHVQdVB1UHVQdVB1UHVQdVB1UHVQfV+YMfyAWfiSN598oAAAAQZGVCR0ZFM0E1RDJBNzkwRjRBODDbEZx1AAAAAElFTkSuQmCC" |
| `creepjs.fingerprintId` | "FP ID: 5e14faeb3cf14c3ea9be37efa7100d16471defe02c8552a5c124945d4b9014f0" | "FP ID: 1831b158074cefaedf40cce11124ebcc7ea8b48886da98b6367116db7fea65bf" |
| `creepjs.hashes.canvas2d` | "d2f291a8e3af817fbafdbf829f72e3cf365b47ae726448bc89b17c941a7d9630" | "59290e4630ede1f0ec9f876756f2d5272222ace03ae1515ae61b1b852aee30f3" |
| `creepjs.hashes.canvasWebgl` | "41f5bd4f2dfb4edd1040eadc089e4c00fff682d4a5d17d1f7dce6b1ae7f8feaf" | "b9235a0a48f50cb432930c9dbb9893ea2055dd1647b4d057c30d29f97637bc6a" |

## rebrowser (0)

No differences.
