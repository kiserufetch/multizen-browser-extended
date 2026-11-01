# after-linux-xvfb-nvidia-cf vs after-linux-xvfb-nvidia-2-cf

| | A | B |
| --- | --- | --- |
| label | "after-linux-xvfb-nvidia-cf" | "after-linux-xvfb-nvidia-2-cf" |
| date | "2026-11-01" | "2026-11-01" |
| engine | "camoufox" | "camoufox" |
| engineVersion | "152.0.4-beta.30" | "152.0.4-beta.30" |
| mode | "xvfb" | "xvfb" |
| displayMode | "xvfb" | "xvfb" |
| egress | "allow-all" | "allow-all" |
| seed | "mz-baseline-70" | "mz-baseline-70" |
| platform | "linux" | "linux" |
| persona | linux-desktop-nvidia | linux-desktop-nvidia |

## Thresholds

None fired: no `HeadlessChrome`, no `webdriver: true`, no `pointer: none`.

12 differences; left out: 13 by the noise rules.

## probe (3)

| path | A | B |
| --- | --- | --- |
| `probe.canvasHash` | 1154877130 | -1569776490 |
| `probe.webgl.canvasHash` | -1233508237 | -550882991 |
| `probe.window.historyLength` | 2 | 5 |

## headers (0)

No differences.

## fonts (1)

| path | A | B |
| --- | --- | --- |
| `fonts.emoji.canvasHash` | 84573407 | 569764186 |

## input (0)

No differences.

## tls (0)

No differences.

## h2 (0)

No differences.

## webrtc (0)

No differences.

## creepjs (8)

| path | A | B |
| --- | --- | --- |
| `creepjs.canvas.mods.pixelImage` | "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAYAAACM/rhtAAAAR0lEQVRYR+3QMQ0AMAzAsJU/6A6Enx4xgiizu/sOmwJRB1UHVQdVB1UHVQdVB1UHVQdVB1UHVQdVB1UHVQdVB1UHVQfV+YMfyAWfiSN598oAAAAQZGVCRzk4MjhGODUxNDUzMDJGQURVqgjlAAAAAElFTkSuQmCC" | "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAYAAACM/rhtAAAAR0lEQVRYR+3QMQ0AMAzAsJU/6A6Enx4xgiizu/sOmwJRB1UHVQdVB1UHVQdVB1UHVQdVB1UHVQdVB1UHVQdVB1UHVQfV+YMfyAWfiSN598oAAAAQZGVCR0IzOUIxMkM3MzhEMUIzRjSdVDqWAAAAAElFTkSuQmCC" |
| `creepjs.fingerprintId` | "FP ID: ea5acad6b39edc730df4eda546b490d299b328570f457fcfd6ca8d0bbeaf0cd8" | "FP ID: 768c370ead9f9e747d36bcb44a9ba4281ad399b495930b79133619cd6b962fdb" |
| `creepjs.fonts.$hash` | "69acb0b849f0a36d7ebfaca940f5cd688d9430d70162f8a58fa122da8bf6df1b" | "0bb83853a3ab6a7c5e175db4d04d6f639a3e840aa9bf05c362a105e4532c859e" |
| `creepjs.fonts.emojiSet` | only here (1 of 30): ✂ | only here (1 of 30): ☝ |
| `creepjs.fonts.pixelSizeSystemSum` | 0.16292925600000002 | 0.162929256 |
| `creepjs.hashes.canvas2d` | "10dafc66bbbfec5763d0aaf26b10bbac8a01b4bd4b69390c93c232b0a24fe57c" | "74123208bd59e9d7efda170b0bfe4f9aa13fc0c8725405107906d5932c43a3c0" |
| `creepjs.hashes.canvasWebgl` | "c015a201a86fe14c5062a1cce39a176dfb436af59f5616d7773ee7c581309685" | "72fb68fd4885ea848eaa4c8992b63887585977d70a9c560ab378d21e1ef386bb" |
| `creepjs.hashes.fonts` | "69acb0b849f0a36d7ebfaca940f5cd688d9430d70162f8a58fa122da8bf6df1b" | "0bb83853a3ab6a7c5e175db4d04d6f639a3e840aa9bf05c362a105e4532c859e" |

## rebrowser (0)

No differences.
