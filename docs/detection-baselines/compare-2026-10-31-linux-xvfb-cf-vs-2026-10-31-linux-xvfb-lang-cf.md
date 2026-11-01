# linux-xvfb-cf vs linux-xvfb-lang-cf

| | A | B |
| --- | --- | --- |
| label | "linux-xvfb-cf" | "linux-xvfb-lang-cf" |
| date | "2026-10-31" | "2026-10-31" |
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

1 differences; left out: 15 by the noise rules, 124 that also differ between a setup and its own repeat.

## probe (0)

No differences.

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

## creepjs (1)

| path | A | B |
| --- | --- | --- |
| `creepjs.fonts.emojiSet` | only here (1 of 23): 🧑‍🤝‍🧑 | only here (0 of 22):  |

## rebrowser (0)

No differences.
