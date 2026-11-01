# win-headed-desktop-cb vs win-headed-desktop-2-cb

| | A | B |
| --- | --- | --- |
| label | "win-headed-desktop-cb" | "win-headed-desktop-2-cb" |
| date | "2026-10-31" | "2026-10-31" |
| engine | "cloakbrowser" | "cloakbrowser" |
| engineVersion | "146.0.7680.177.5" | "146.0.7680.177.5" |
| mode | "headed" | "headed" |
| displayMode | "headed" | "headed" |
| egress | "allow-all" | "allow-all" |
| seed | "mz-baseline-70" | "mz-baseline-70" |
| platform | "win32" | "win32" |
| persona | windows-desktop-nvidia | windows-desktop-nvidia |

## Thresholds

None fired: no `HeadlessChrome`, no `webdriver: true`, no `pointer: none`.

23 differences; left out: 25 by the noise rules.

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

## creepjs (2)

| path | A | B |
| --- | --- | --- |
| `creepjs.audio.noise` | 998.5615752539284 | 988.0928509217503 |
| `creepjs.hashes.offlineAudioContext` | "fd3724fc1c4854c2f5523d62ea8f80ce4efa9d180bd809fec4c2c429bf77702c" | "cdf619e82bfb21b83db6a6449d535c8e3f59e57b5f88687ac26f1720b468073e" |

## rebrowser (0)

No differences.

## covered (21)

| path | A | B |
| --- | --- | --- |
| `covered.after.changes` | hidden, visible | (absent) |
| `covered.after.gettingFrames` | true | (absent) |
| `covered.after.hasFocus` | true | (absent) |
| `covered.after.paints` | 2 | (absent) |
| `covered.after.visibility` | "visible" | (absent) |
| `covered.before.changes` |  | (absent) |
| `covered.before.gettingFrames` | true | (absent) |
| `covered.before.hasFocus` | true | (absent) |
| `covered.before.paints` | 2 | (absent) |
| `covered.before.visibility` | "visible" | (absent) |
| `covered.clickWhileCovered` | "delivered" | (absent) |
| `covered.covered1.changes` | hidden | (absent) |
| `covered.covered1.gettingFrames` | true | (absent) |
| `covered.covered1.hasFocus` | false | (absent) |
| `covered.covered1.paints` | 2 | (absent) |
| `covered.covered1.visibility` | "hidden" | (absent) |
| `covered.covered2.changes` | hidden | (absent) |
| `covered.covered2.gettingFrames` | false | (absent) |
| `covered.covered2.hasFocus` | false | (absent) |
| `covered.covered2.paints` | 2 | (absent) |
| `covered.covered2.visibility` | "hidden" | (absent) |
