# linux-headless-linuxpersona-cf vs linux-headless-linuxpersona-session-cf

| | A | B |
| --- | --- | --- |
| label | "linux-headless-linuxpersona-cf" | "linux-headless-linuxpersona-session-cf" |
| date | "2026-10-31" | "2026-11-01" |
| engine | "camoufox" | "camoufox" |
| engineVersion | "152.0.4-beta.30" | "152.0.4-beta.30" |
| mode | "headless" | "headless" |
| displayMode | "headless" | "headless" |
| egress | "block-private" | "block-private" |
| seed | "mz-baseline-70" | "mz-baseline-70" |
| platform | "linux" | "linux" |
| persona | linux-laptop-nvidia | linux-laptop-nvidia |

## Thresholds

None fired: no `HeadlessChrome`, no `webdriver: true`, no `pointer: none`.

3 differences; left out: 17 by the noise rules, 30 that also differ between a setup and its own repeat.

## probe (3)

| path | A | B |
| --- | --- | --- |
| `probe.audio.live.maxChannelCount` | 0 | 2 |
| `probe.audio.live.sampleRate` | 44100 | 48000 |
| `probe.devices` |  | audioinput |

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

## creepjs (0)

No differences.

## rebrowser (0)

No differences.
