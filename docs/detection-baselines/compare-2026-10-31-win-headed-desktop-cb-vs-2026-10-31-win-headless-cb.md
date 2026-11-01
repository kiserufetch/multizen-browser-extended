# win-headed-desktop-cb vs win-headless-cb

| | A | B |
| --- | --- | --- |
| label | "win-headed-desktop-cb" | "win-headless-cb" |
| date | "2026-10-31" | "2026-10-31" |
| engine | "cloakbrowser" | "cloakbrowser" |
| engineVersion | "146.0.7680.177.5" | "146.0.7680.177.5" |
| mode | "headed" | "headless" |
| displayMode | "headed" | "headless" |
| egress | "allow-all" | "allow-all" |
| seed | "mz-baseline-70" | "mz-baseline-70" |
| platform | "win32" | "win32" |
| persona | windows-desktop-nvidia | windows-desktop-nvidia |

## Thresholds

None fired: no `HeadlessChrome`, no `webdriver: true`, no `pointer: none`.

10 differences; left out: 24 by the noise rules, 23 that also differ between a setup and its own repeat.

## probe (3)

| path | A | B |
| --- | --- | --- |
| `probe.media.(any-pointer: coarse)` | true | false |
| `probe.screen.colorDepth` | 32 | 24 |
| `probe.screen.pixelDepth` | 32 | 24 |

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

## creepjs (7)

| path | A | B |
| --- | --- | --- |
| `creepjs.cssMedia.any-pointer` | "coarse" | "fine" |
| `creepjs.fingerprintId` | "FP ID: ac4dafdcd8c07f9411ee30469be1dea31ec061f5827053ba68a6e563b0e598ce" | "FP ID: 173cc503158b97a133832942c01a8268f8c25f44324fca96f792e6a28e545f5b" |
| `creepjs.hashes.cssMedia` | "79c151b7062beb905a4d21b1fbbb850f86f3f6af8f323fd0667ebd210c705278" | "ae736555a19a31fe80f22138ff4aa9630102f48f19c95f83cf4fc336479b528e" |
| `creepjs.hashes.screen` | "32aa7017a937e599c711ff15e0cfde7334946a5003b640d62f37d52056669908" | "9d83f24afdec28df7ee8211ac5e5c909f6d47bd00bc27aa23fc4be7b604d4c9e" |
| `creepjs.screen.$hash` | "32aa7017a937e599c711ff15e0cfde7334946a5003b640d62f37d52056669908" | "9d83f24afdec28df7ee8211ac5e5c909f6d47bd00bc27aa23fc4be7b604d4c9e" |
| `creepjs.screen.colorDepth` | 32 | 24 |
| `creepjs.screen.pixelDepth` | 32 | 24 |

## rebrowser (0)

No differences.

## covered (0)

No differences.
