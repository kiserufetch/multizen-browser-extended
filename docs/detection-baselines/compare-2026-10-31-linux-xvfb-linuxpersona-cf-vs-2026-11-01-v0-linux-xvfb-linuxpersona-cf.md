# linux-xvfb-linuxpersona-cf vs v0-linux-xvfb-linuxpersona-cf

| | A | B |
| --- | --- | --- |
| label | "linux-xvfb-linuxpersona-cf" | "v0-linux-xvfb-linuxpersona-cf" |
| date | "2026-10-31" | "2026-11-01" |
| engine | "camoufox" | "camoufox" |
| engineVersion | "152.0.4-beta.30" | "152.0.4-beta.30" |
| mode | "xvfb" | "xvfb" |
| displayMode | "xvfb" | "xvfb" |
| egress | "block-private" | "block-private" |
| seed | "mz-baseline-70" | "mz-baseline-70" |
| platform | "linux" | "linux" |
| persona | linux-laptop-nvidia | linux-laptop-nvidia |

## Thresholds

None fired: no `HeadlessChrome`, no `webdriver: true`, no `pointer: none`.

11 differences; left out: 15 by the noise rules, 140 that also differ between a setup and its own repeat.

## probe (2)

| path | A | B |
| --- | --- | --- |
| `probe.appVersion` | "5.0 (X11)" | "5.0 (X11; Ubuntu)" |
| `probe.userAgent` | "Mozilla/5.0 (X11; Linux x86_64; rv:152.0) Gecko/20100101 Firefox/152.0" | "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:152.0) Gecko/20100101 Firefox/152.0" |

## headers (2)

| path | A | B |
| --- | --- | --- |
| `headers.navigation.values.user-agent` | "Mozilla/5.0 (X11; Linux x86_64; rv:152.0) Gecko/20100101 Firefox/152.0" | "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:152.0) Gecko/20100101 Firefox/152.0" |
| `headers.subresourceAfterAcceptCh.values.user-agent` | "Mozilla/5.0 (X11; Linux x86_64; rv:152.0) Gecko/20100101 Firefox/152.0" | "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:152.0) Gecko/20100101 Firefox/152.0" |

## fonts (1)

| path | A | B |
| --- | --- | --- |
| `fonts.emoji.width` | 24.016666412353516 | 24.100000381469727 |

## input (0)

No differences.

## tls (0)

No differences.

## h2 (1)

| path | A | B |
| --- | --- | --- |
| `h2.headerValues.user-agent` | "Mozilla/5.0 (X11; Linux x86_64; rv:152.0) Gecko/20100101 Firefox/152.0" | "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:152.0) Gecko/20100101 Firefox/152.0" |

## webrtc (0)

No differences.

## creepjs (5)

| path | A | B |
| --- | --- | --- |
| `creepjs.fonts.emojiSet` | only here (0 of 30):  | only here (2 of 32): ☑, ✴ |
| `creepjs.navigator.device` | "Linux x86_64" | "Ubuntu Linux x86_64" |
| `creepjs.navigator.userAgent` | "Mozilla/5.0 (X11; Linux x86_64; rv:152.0) Gecko/20100101 Firefox/152.0" | "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:152.0) Gecko/20100101 Firefox/152.0" |
| `creepjs.worker.device` | "Linux x86_64" | "Ubuntu Linux x86_64" |
| `creepjs.worker.userAgent` | "Mozilla/5.0 (X11; Linux x86_64; rv:152.0) Gecko/20100101 Firefox/152.0" | "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:152.0) Gecko/20100101 Firefox/152.0" |

## rebrowser (0)

No differences.
