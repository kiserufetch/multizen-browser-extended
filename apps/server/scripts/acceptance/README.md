# Acceptance scripts

What `docs/server-acceptance.md` cites and `e2e.ts`, `egress-live.ts` and `security-live.ts` don't cover. They run real browsers on the built server, so they aren't in `test:unit`, and they are plain JavaScript, so they are outside `tsconfig.json`'s `scripts/**/*.ts`. Fixtures are local.

```sh
corepack yarn workspace @multizen/server build
corepack yarn workspace @multizen/server exec tsx scripts/acceptance/<script> <flags>
```

| Script | Row | Runs on |
| --- | --- | --- |
| `ac3.mjs` | AC3: a cold engine, the full flow in `--headless` and `headed`, one data dir across modes | Windows. Downloads the engine, and opens real windows for about 15 s |
| `ac5-run.mjs --scenario core` | AC5: handoff through the panel's API, input, dialogs, chooser, popup, crash, logs | Windows, Docker with `--docker xvfb` |
| `ac5-run.mjs --scenario expiry` | AC5: a handoff nobody answers, a webhook nobody hears | Windows, Docker |
| `ac5-run.mjs --scenario ui` | AC5: the panel's real page, in a browser of its own | Windows, Docker (the page in a browser on the host) |
| `ac67-extra.mjs` | AC6, AC7 and AC8: what `e2e.ts` doesn't: one browser from two launches, close during launch, the queue, foreign tokens and hosts, failed logins, one ref across two sessions | Windows, Linux with the sandbox |
| `gate-linux.mjs` | AC1: the gate in a fresh Linux container | Any host with Docker. Run with plain `node` |
| `gate-by-file.mjs` | AC1: the gate's tests file by file, rerunning a failure by name, for a machine whose loopback fails by itself | Any. Run with plain `node` |

Each has its flags at the top. `--engine-version-dir` and `--camoufox-install` link installed engines into a temp data dir instead of downloading them: the first must be the pinned CloakBrowser, the second the pinned Camoufox, since a server downloads over anything else, and over the link too. `harness.mjs`, `flow.mjs`, `ac-fixture.cjs` and `handoff-fixture.cjs` are what they share.

ALL PASS and exit 0 mean every check held. On a machine that loses loopback connects, a try can fail by itself on a launch or the first request. Run it again, and read what failed: only a connect that timed out is retried for you.
