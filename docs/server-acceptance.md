# Acceptance matrix: server mode

Final regression, 2026-11-01. Windows 11, Docker Desktop (WSL2 kernel). Tree: `feat/server-mode` over base `8f0c1f5`, uncommitted. Every row is from this run on this tree, and nothing older is cited.

Results are `pass`, `fail`, `tests only` or `not run`. `manual, not reproducible` is added where the script that did it isn't in the repo.

No product code changed during this run. Three live scripts and one test did, see [New findings](#new-findings), so what ran before those edits ran the same product. `/app/dist` of the image AC4 ran on and of the final `multizen-server:local` hash the same.

**Scripts.** `e2e.ts`, `egress-live.ts`, `security-live.ts` and `acceptance/*` are in `apps/server/scripts/`. `ac2.mjs`, `ac4.mjs`, the two AC10 scripts and the merge simulation were throwaway, which is what `manual, not reproducible` means below. The logs were in a scratchpad that didn't outlive the run (finding 8): what this file quotes is the record.

**Everything on Windows ran on a machine whose loopback fails by itself.** A plain client and listener, nothing of ours: `ETIMEDOUT` at about 310 ms in bursts, `::1` always `EACCES`, and the stall of finding 1. A prober with its own listener saw 1,655 `ETIMEDOUT` on about 61,000 connects over two hours. Several VPN tunnel adapters were up. Whether they are the cause wasn't established, since none was turned off to find out. Docker runs are inside the VM and don't see it, except from the host through a published port. So a Linux container is the gate that counts, and on Windows only a try lost to that was retried, each one listed under [AC5 to AC8](#ac5-to-ac8-what-ran-where), with the one that can't be proven to be it marked as such.

## What is still fail, tests only, not run

**Fail**

- `corepack yarn test:unit` as one chain on Windows, from this machine's loopback: `apps/server` lost 2 of 271 to `connect ETIMEDOUT`, which ended the chain at 1458 tests with `detection-baseline` not reached. The same tests pass in a Linux container, and file by file here. To tell, turn the VPNs off and run it again.

**Tests only**

- An all-`unavailable` baseline run failing: `baseline.test.ts`.
- Two clicks on a CDP log: `concurrency.test.ts`. Live, the page's own event order shows the same.
- The metadata address class at page level, `fetch` and the like: `egressPolicy.test.ts`. Live, private listeners stood in for it.
- The token compare on the desktop, `timingSafeEqual`: its test and the packaged build, where a wrong token gets 401. Timing wasn't measured.
- Name lookups starving on Windows: the semaphore's tests. Live only on Linux.
- A launch reusing a record whose browser just died, and a close during a forced kill: their unit tests. The live rounds were in a script lost with the scratchpad, see finding 8.
- `request_human` raising a minimized Camoufox window: `bring_to_front`'s test. The live check was in the same lost script. On this tree Camoufox's banner and handoff ran live in AC2, with the window up.

**Not run**

- The Windows CI job in `.github/workflows/ci.yml`: added, and it can't be run from here.
- AppArmor-restricted hosts (Ubuntu 23.10+): no such host. The instructions come from documentation.
- Permission prompts in the panel, and a chooser in an OOPIF through the panel: documented limits. `upload_file`'s refusal is checked.
- QUIC from `Alt-Svc`: needs a trusted certificate.
- WebRTC on CloakBrowser against the policy: its engine gathers no candidates at all, so there is nothing to show.
- Non-1 DPR on Camoufox: no CDP, no path sets one.
- nginx itself: the reverse proxy shape ran with a plain hop.
- TLS as the README writes it, with `10.0.0.5`: `e2e.ts` ran it on a real local address.
- The Windows Firewall prompt: none appeared here, so the README's text on it is unobserved. Git Bash's Ctrl+C.
- macOS: nothing, anywhere. linux-arm64: nothing, and CloakBrowser refuses to install there by design.
- A real upstream merge after the file moves: a simulated one on a throwaway clone, below in AC10.
- `SHA256SUMS.sig` of the pinned releases: the sums matched, the signature wasn't checked.
- A locked screen, a disconnected RDP session and a minimized window, for the occlusion finding.
- The other 43 baseline runs, and the screen-covering and `--raise` modes: the subset below is what was repeated, as asked.
- The control run of `security-live.ts --only bodies,sockets` against a build from before those fixes: no such image on this tree. That the attacks bite was shown once, on the build they were fixed on, and isn't re-shown here.

## New findings

1. **This machine's loopback has a second way of failing.** Besides `ETIMEDOUT` at about 310 ms, a connection can stall for about 19 s and then end in `read ECONNRESET`, with no code of ours involved. Measured with a plain client and a plain Node listener in another process, side by side with the real server, over 5 minutes on fresh connections: plain listener 10,520 requests, 152 `ETIMEDOUT`, 11 `ECONNRESET`; real server 13,170 requests, 150 `ETIMEDOUT`, 7 `ECONNRESET`, and 3 answered 408 with an empty body. The 408 is the same stall seen from the other side: the request's bytes didn't arrive within the server's 10 s headers timeout (N2's), and it answers rather than waiting. Rates are the same on both, so this isn't the server, but a client on such a machine can see a bare 408 from `initialize`. A prober with its own listener saw 1,655 `ETIMEDOUT` on about 61,000 connects over two hours.
2. **A test raced the server's start.** `TLS through the bundle` asked `/readyz` straight after `listening`, and failed with `engineStatus: "missing"`, 503, when the container was busy. The server was right: it listens before it has looked at its engine, and says so. Fixed in `integration.test.ts`: it waits for that answer to change. The regression test is that test.
3. **`e2e.ts` hung after a failed `stdio` flow.** The stdio child wasn't in the list that gets killed on failure, so the script waited on it for good. Fixed: it's in the list now. Script only.
4. **`security-live.ts` couldn't retry its `N1 revoked mid-body` row.** A try lost to loopback left the token `n1-gone` on file, and the retry failed on `A token named "n1-gone" already exists`, reading as a real failure. Fixed: a name per try. Script only.
5. **`ac5-ui.mjs` ignored `navigate`'s result.** A navigation lost to loopback showed up as `Cannot read properties of undefined`. It now says what happened. Script only.
6. **Camoufox on Windows still leaves an empty `NVIDIA Corporation` in the server's working directory.** Harmless, gitignored, and removed after this run. A server's CloakBrowser no longer does it. Not changed: no fix is small and this one does nothing.
7. **`docker compose build` after a script edit retags the image with the same `/app`.** Nothing to fix: named so nobody reads the image id as a code change.
8. **The session's scratchpad was wiped from outside during this run,** at about 22:01 local, with `%TEMP%\mzfb` and the logs and throwaway scripts in it. Nothing of this run did it. What ran before that is recorded here from the logs as they stood, and the logs themselves are gone: what this file says is the record. `ac2.mjs`, `ac4.mjs`, the saved `better_sqlite3.electron.node` and the Windows Camoufox install went with it. The Electron binary was saved again from `apps/desktop`, byte for byte (`b66a0400…`), before anything could disturb it.

## AC1. Gate and test lists

| Bullet | Result | Evidence |
| --- | --- | --- |
| Full gate in a fresh Linux container, Node 22 | pass | `gate-linux.mjs`: `yarn install --immutable`, `typecheck`, `test:unit`: 13, 168, 354, 36, 616, 271, 60 = **1518 tests, 0 fail, 0 cancelled, 0 skipped**. This is the one that counts. An earlier run, with other containers busy, failed 1 of 1458 and stopped its chain: finding 7, fixed before this one |
| The same tests, file by file, on Windows | pass | With reruns. `gate-by-file.mjs`, Node 24.10.0: **1518 tests, 1505 passed first time, 13 rerun by name, 0 left failing, 0 skipped**. All `connect ETIMEDOUT`, `fetch failed` or `EACCES ::1`: `downloadRoute.test.ts` 6, `panelRoutes.test.ts` 2, `integration.test.ts` 2, `tlsSite.test.ts` 2, `HttpTransport.test.ts` 1. One rerun of `integration.test.ts` lost its temp dir's removal to `EPERM`, and passed on the next |
| `corepack yarn test:unit` as one chain on Windows | **fail, from this machine's loopback** | Right after that pass: 13, 168, 354, 36, 616 whole, then `apps/server` 269 of 271: `TLS through the bundle` and `a proxy password through MCP`, each `connect ETIMEDOUT`, the first passing alone straight after. 1458 tests run, exit 1 |
| `corepack yarn typecheck` on Windows | pass | exit 0, 34 s, tests and `apps/server/scripts/**/*.ts` included. The `.mjs` and `.cjs` in `scripts/acceptance` are outside it by extension |
| Server build, desktop `electron-vite build` | pass | `rm -rf apps/server/dist apps/desktop/out`, then both exit 0 |
| Test-list check | pass | `testLists.test.ts`, in that gate: every `*.test.ts` runs from `test:unit`, every listed file exists, CI and release run it |
| ABI | pass | Desktop's better-sqlite3 is the saved Electron binary (`NODE_MODULE_VERSION` 130, `b66a0400…`), and refuses Node. The copies in `apps/server`, `packages/browser-runtime` and `packages/profile-manager` load under Node 137. `corepack yarn install --immutable` was run after the packaged build, and changed no tracked file |
| Grep gate | pass | No `TODO`, `FIXME`, `test.skip`, `.only(` in the 221 changed code files |

## AC2. Desktop, packaged build

`electron-vite build`, `strip-workspace-symlinks.cjs`, `electron-builder --dir --publish never`, `CSC_IDENTITY_AUTO_DISCOVERY=false`: nothing signed or published, `release\win-unpacked\MultiZen.exe`, 395 MB. Base `8f0c1f5`'s desktop was a `git archive` copy under `%TEMP%`, with its own `yarn install --immutable` and `electron-vite build`, run first on the same `--user-data-dir`. Each phase on a short temp dir with its own `mcpHttpPort`, `engineAutoUpdate:false`, `autoUpdate:false`, except the one that checks the default port. The engines come through junctions. All manual, not reproducible: `ac2.mjs` was throwaway.

| Bullet | Result | Evidence |
| --- | --- | --- |
| Default port | pass; manual, not reproducible | Empty dir, no port in settings: serves on `127.0.0.1:7777`, bound to `127.0.0.1` only, `settings.json` untouched |
| Token | pass; manual, not reproducible | 64-char token generated on a fresh dir. The base's `mcp-token` still opens the packaged app. No token 401, wrong token 401, `/healthz` stays gated on the desktop |
| Tool names superset | pass; manual, not reproducible | 30 old, 45 now, every old name present, every old input schema a subset. Added: `press_key`, `hover`, `select_option`, `scroll`, `upload_file`, `list_downloads`, `get_download`, `delete_download`, `set_dialog_policy`, `list_dialogs`, `handle_dialog`, `acquire_profile`, `renew_profile`, `release_profile`, `get_human_status` |
| DB from base code migrated | pass; manual, not reproducible | Written by the real base app through MCP: 3 profiles (CloakBrowser with notes, tags, seed; Camoufox; proxied with a password). Every row and column identical afterwards, only `display_mode` added. Proxy password still plain, as the desktop stores it. `list_profiles`: same values, plus `runningDisplayMode` |
| Both engines | pass; manual, not reproducible | CloakBrowser, Camoufox and the proxied profile each launch from the packaged build on the base's dir, its cookies intact. Fresh dir: both launch too |
| Default headed | pass; manual, not reproducible | `displayMode: headed`, no `--headless`, real `MainWindowHandle` on both engines |
| argv against base | pass; manual, not reproducible | Relaunch against the base's first launch: CloakBrowser only-old `["about:blank"]`, only-new `[]`; proxied the same; Camoufox `[]`, `[]`. A first launch against the base's, persona flags aside: `[]`, `[]`. `about:blank` is what both versions add on a first launch alone. No exception was needed |
| Dialogs per A1 | pass; manual, not reproducible | 25 checks, native dialog seen in a shot. Root tab: confirm dismissed, alert accepted by the policy. `window.open` from a real click, `Target.createTarget` and a popup asking on load: wait for the person, `list_dialogs` empty, Enter answers. A person's open dialog goes to the policy once an agent targets that tab. Agent-targeted tab: default, `auto` with accept, `manual` with `handle_dialog`. The person's popup stays the person's afterwards. `new_tab`'s tab: the policy. Camoufox: the policy answers |
| `server.lock` of a dead server ignored | pass; manual, not reproducible | Server killed by PID, on the user data dir and on `data/` under it: its lock stays, the packaged app starts and serves, with `desktop.lock` written |
| A live `server.lock` refuses | pass; manual, not reproducible | Live server on either dir: dialog "MultiZen can't use this data directory" naming the server's pid, no app window, exit 0 once closed, no `desktop.lock`, no MCP, the server still running |
| `desktop.lock` | pass; manual, not reproducible | Fields `hostname,pid,startTime,cmdlineSha256,acquiredAt`: a 64-hex hash, no command line. Mode 0600 doesn't apply on Windows, where it reads 666: the write and `desktopLock.test.ts` hold it. With the app up, `serve` on the user data dir and on `data/` is refused. Gone after quit |
| Handoff banner, Resume and Abort | pass; manual, not reproducible | Both engines: profile and reason as text, Resume releases `wait_for_human` as `resumed` with `settled_by: desktop`, Abort gives `aborted`, `resumed: false`, the banner goes each time |
| Gate off on desktop | pass; manual, not reproducible | During a `2fa` handoff `click` isn't refused, and with the window raised it lands, title `clicked`. First try: `INPUT_NOT_DELIVERED`, as the window was behind others and the page hidden, which is that code's case and not the gate's |
| Panel window for a headless profile, by one-time code | pass; manual, not reproducible | 30 checks, both engines, 3 runs of 3 once the script waited for the page and read the address after its redirect. Opens by itself at `/panel/login?code=…`, settles at `/panel#<id>` signed in with the handoff selected, the same code doesn't sign in twice, a live frame, no bridge to the app, a click in the panel reaches the headless page, Resume releases the agent and closes the window, it opens again, Open panel in the banner, Abort closes it |
| A5 message | pass; manual, not reproducible | A stopped server's dir with a sealed password: dialog "… its proxy passwords are encrypted, and the app has no key for them", no app window, exit 0, `desktop.lock` gone |
| Quit clean | pass; manual, not reproducible | `CloseMainWindow` in every phase, exit 0, no process left on the data dir |

One try of the panel phase lost a read of the app's debugging port to `fetch failed` with no cause recorded, and 3 further runs didn't repeat it. That read is the rig's, not the product's.

## AC3. Windows, real SDK client

`ac3.mjs` on an empty `%TEMP%\mzt14c`, CloakBrowser cold, Camoufox through a junction: `pass`, 47 checks, first try, 108 s.

| Bullet | Result | Evidence |
| --- | --- | --- |
| Cold engine cache | pass | `ENGINE_NOT_READY` 7 times over 36 s, then ready |
| `--headless` full flow, both engines | pass | create, launch, navigate, extract, `click_ref` (page handler ran), screenshot, file downloaded and read back, close, relaunch |
| `headed` full flow, both engines | pass | same, with real windows |
| Relaunch: cookie | pass | Every mode and engine: the fixture got the cookie back from disk |
| Relaunch: tab restore | pass | CloakBrowser, both modes. Camoufox has none, by design: `about:blank` |
| `probe_fingerprint.ok` | pass | `ok: true`, `drift: []` in all four |
| Headed to headless on one data dir | pass | Saved `headed` runs headless under `serve --headless`, `displayMode: headed`, `runningDisplayMode: headless`, cookie kept, naming `headed` or `xvfb` is `INVALID_INPUT` |
| Nothing left | pass | No process names the data dir after each stop; the dir is removed |

## AC4. Docker, rebuilt image, fresh volume, full compose

`docker compose -p mz-ac4 build --no-cache` (104 s), then `up -d` on the repo's compose file with `MULTIZEN_EGRESS_ALLOW` added by an override for the local fixture, a fresh volume, driven from the host by a real SDK client. 106 checks, all pass. Manual, not reproducible: `ac4.mjs` was throwaway. Two earlier tries of the script failed on its own mistakes, each corrected before the run counted: a name pattern matching `chrome-remote-interface.js`, the pin for the host's platform not the container's, a log tail cut before it was read, tabs compared with the wrong list.

| Bullet | Result | Evidence |
| --- | --- | --- |
| Image holds no engine | pass; manual, not reproducible | Files over 30 MB in it: `libLLVM-15.so.1`, `/usr/local/bin/node`. No `chrome` or `camoufox-bin` |
| Non-root, Node 22 | pass; manual, not reproducible | user `node`, `v22.23.4`. `/data` 700, `owner-token` 600 |
| Pinned engine installs and verifies on first start | pass; manual, not reproducible | CloakBrowser downloads into the volume with progress in the log, `current.json` holds `146.0.7680.177.5` and `4a12bcde…`, the pin's hash for linux-x64. A corrupted download fails with `checksum mismatch`: `security-live.ts`, below. Camoufox `152.0.4-beta.30` on first use |
| No `--no-sandbox` anywhere | pass; manual, not reproducible | Every process's command line, xvfb, headless and `MULTIZEN_HEADLESS=1`, 11 browser processes each. Without seccomp, the process list and the log |
| Renderer seccomp and namespaces | pass; manual, not reproducible | Renderers `Seccomp: 2`, `NSpid` three levels deep (`547 12 1`), user namespace `4026532541` against the server's `4026531837`, their own net namespace. `NoNewPrivs: 1` on the server |
| Full flow, xvfb and headless, both engines | pass; manual, not reproducible | As in AC3. `create_profile` picks a `linux-*` persona here |
| `probe_fingerprint` with no GPU | pass; manual, not reproducible | `ok: true`, `drift: []` on all |
| SIGTERM | pass; manual, not reproducible | `compose stop` with both engines running: exit 0 in 1.3 s, `shutdown complete`, against `stop_grace_period` 30 s. Idle: 0.9 s |
| `compose down && up` with profiles running | pass; manual, not reproducible | Volume kept, both read stopped, 0 zombies, tabs back on CloakBrowser, cookies kept on both |
| SIGKILL of the container | pass; manual, not reproducible | Exit 137. Same container started again: `previous run reaped`, 0 zombies, tabs and cookies back. New container on the volume: `stale profile locks removed`, the same |
| Zero zombies | pass; manual, not reproducible | 0 zombies, no browser or Xvfb after each close, mode and restart |
| `MULTIZEN_HEADLESS=1` | pass; manual, not reproducible | Headless with no argument, `xvfb` is `INVALID_INPUT`, sandbox as above |
| Without the seccomp profile | pass; manual, not reproducible | Warning at start, `SANDBOX_UNAVAILABLE` with its hint, nothing ran with `--no-sandbox`, Camoufox runs fine |
| AppArmor hosts | not run | No such host here. Stated in the docs as untested |

## AC5 to AC8: what ran where

Docker runs are one try each unless they say otherwise, in a fresh container sandboxed as compose runs it. Engines come from read-only seed volumes, except `ac5-run.mjs --docker`, where the server is a fresh container of the rebuilt image on a fresh volume and downloads them. On Windows the counts are of the passing try.

| Run | Docker `xvfb` | Docker `headless` | Windows `--headless` |
| --- | --- | --- | --- |
| `e2e.ts`, all flows, CloakBrowser | pass: 174 checks, 0 zombies | pass: 136, 0 zombies, `display` in the other column because it decides per server | pass after retries: `http,sigint` 22, `stdio` 3, `tabs` 55, `concurrency` 22, `auth` 17, `reaper` 14, `relay` 3; `display` (no `--headless`, by its design) 30 |
| `e2e.ts`, all flows, Camoufox | pass: 161, 0 zombies | pass: 125, 0 zombies | pass after retries: `http,sigint` 22, `stdio` 3, `tabs` 49, `concurrency` 19, `auth` 16, `reaper` 13, `relay` 3, `display` 28 |
| `e2e.ts`, `http,tabs`, a real window, CloakBrowser | | | pass: 73, first try, 42 s |
| `egress-live.ts`, CloakBrowser | pass: 47 rows: 45 enforced, 2 documented holes, 0 not enforced | | pass on the third try: the same rows |
| `egress-live.ts`, Camoufox | pass: 45 rows: 39 enforced, 6 not applicable, 0 not enforced | | pass, first try: the same rows |
| `security-live.ts` | pass: 27 rows each engine | | pass: 24 rows each, CloakBrowser first try, Camoufox second. Windows leaves out `dns` and the 20 addresses, and sends 400 sockets, not 1500 |
| `security-live.ts --only dns` | pass, each engine, under a resolver that hears and never answers | | |
| `ac5-run.mjs --scenario core` | pass: 36 each | | pass: 36 each, first try |
| `ac5-run.mjs --scenario expiry` | pass: 14 each, Camoufox second try | | pass: 14 each, first try |
| `ac5-run.mjs --scenario ui` | pass: 12 each, page in a browser on the host | | pass: 12 each, CloakBrowser first try, Camoufox second |
| `ac67-extra.mjs` | pass: 13 each | | pass: 13 each, CloakBrowser second try |

**Windows tries lost, and to what.** Only these were retried:

| Item | Tries lost | What each failed on |
| --- | --- | --- |
| `e2e` CloakBrowser `stdio` | 1, plus 1 to a typo in this run's own fix to `e2e.ts` | `CDP /json/version not ready`: `fetch failed` |
| `e2e` CloakBrowser `concurrency` | 1 | `read ECONNRESET` |
| `e2e` CloakBrowser `auth` | 1 | `connect ETIMEDOUT` |
| `e2e` CloakBrowser `display` | 9 over two rounds, then pass | `CDP /json/version not ready` 3, `connect ETIMEDOUT` to the fixture 4, `read ECONNRESET` 1, `Request timed out` 1 |
| `e2e` Camoufox `http,sigint` | 1 | `read ECONNRESET` |
| `e2e` Camoufox `tabs` | 2 | `"Nested button" never appeared` once, with a frame that hadn't loaded and no connect error in the log, so **not established as loopback**; `NS_ERROR_NET_TIMEOUT` once. Docker: 0 of 2 |
| `e2e` Camoufox `relay` | 1 | exit 1 after 8 s, on a line the queue's rule read as a lost connect. The line itself went with the logs, finding 8 |
| `e2e` Camoufox `auth` | 4 | `connect ETIMEDOUT` 2, `NS_ERROR_NET_TIMEOUT` through a local SOCKS proxy 1, the SDK's `Request timed out` 1 |
| `ac67` CloakBrowser | 1 | `connect ETIMEDOUT` to the fixture |
| `egress` CloakBrowser | 2 | `connect ETIMEDOUT` to the allowed fixture, then `ERR_CONNECTION_RESET` on it: each a control that never loaded, and no blocked address reached |
| `security` Camoufox | 1 | the `n1-gone` defect above, after a lost connect |
| `ac5-ui` Camoufox | 1 | `navigate`'s result unread, the defect above; cause not in the log |
| `ac5 --docker` Camoufox `expiry` | 1 | `read ECONNRESET` on the rig's own control port, a plain Node listener |
| The baseline's `win-headless-server-cb` | 1 | `connect ETIMEDOUT` on the debugging port: every section `unavailable`, exit 1, as it should |

## AC5. Handoff

| Bullet | Result | Evidence |
| --- | --- | --- |
| Agent's request, panel lists it, shows a frame | pass | `request_human` returns at once with an id, panel lists it, JPEG frame of real size, both engines, both platforms |
| Real page: sign in, frame, click, text, Resume | pass | Bare headless browser on `/panel` over CDP: no script error under its CSP, cookie not readable from script, a real click on the frame reaches the page as `isTrusted`, the text box reaches the field, the Resume button releases the agent. Docker: a fresh container, the page in a bare browser on the host, both engines. Windows: both engines |
| Agent's actions during it: `HUMAN_IN_CONTROL` | pass | `click` refused, `extract` passes for `captcha`, `extract`, `screenshot`, `get_cookies` refused for `2fa`, `resume_human` is `FORBIDDEN` without `operator` |
| Input in a cross-origin iframe | pass | Keys reach the OOPIF, reported by its own handler |
| Non-ASCII text, Enter, Tab | pass | `abMZMARKER Привет 日本語 🎉` reaches the page; Tab then Enter presses the button |
| A popup | pass | In the panel's tab list, activated, gives a frame |
| Dialogs and file chooser through the panel | pass | Frame 423 with the dialog, agent's read gets `DIALOG_OPEN` in 4 ms, the panel's answer reaches the page. File picked by name, including a non-ASCII one, reaches the page |
| Agent polling `get_human_status` | pass | 33 polls through one handoff: `pending` then `resumed`, none blocked |
| Resume | pass | `wait_for_human` gives `resumed`, `settled_by` records the operator, input after it is 409 |
| Abort | pass | `aborted`, `resumed: false` |
| Expiry | pass | TTL 6 s: polling sees `pending`, `expired`. `wait_for_human` says `expired`, input and Resume after it are 409, agent's actions work again |
| Browser crash | pass | `kill -9` of the browser: `aborted`, `settled_by: browser exited` |
| Webhook arrives | pass | Once, with the id, no token in it |
| Unreachable webhook | pass | `request_human` returns at once. One `handoff webhook failed` log line, with no URL in it |
| Logs prove no input or frames | pass | Grep of the server's logs: no `MZMARKER`, no `Привет`, no JPEG base64 marker |
| Permission prompts, OOPIF file chooser on CloakBrowser | not run | Documented limits, stated in the panel and in `docs/server-mode.md`. OOPIF chooser refusal by `upload_file` is checked in `e2e.ts` |
| Desktop's panel window for a headless profile | pass; manual, not reproducible | AC2 |
| `evaluate_js` before a handoff reads what a person types | pass | A documented hole, measured on both engines and platforms: a listener left before the handoff read `abTabEnter`. The answer for a login flow is a token without it |

## AC6. Parallelism

| Bullet | Result | Evidence |
| --- | --- | --- |
| Two clicks don't interleave | pass | `e2e.ts`: page logs event order across two clients, `LRLRLRLRLRLR`, 11 calls in flight. A click can't cut into typing: `kkkkkkkkkkmmmmm` |
| Two launches at once: one process | pass | Extras, both engines and platforms: same pid, one root browser process |
| Third profile waits at limit 2 | pass | `e2e.ts`: 2 up, the third waits, starts within 624 ms of a close |
| Queue for a slot times out | pass | `BROWSER_LIMIT_REACHED`, retryable, after 12 s (`--browser-queue-timeout-ms`) |
| `close` during launch | pass | Extras: nothing running after it, no process, a relaunch works |
| Killed browser frees a slot | pass | `e2e.ts`: noticed in 111 ms |
| Queue timeout on a profile | pass | Extras: a queued click gets retryable `TIMEOUT` at 30.0 s and never fires. Past depth 16: refused at once |
| Client disconnect drops its queued click | pass | `e2e.ts`: cancelled call, session end, client gone without DELETE, dropped SSE client |
| Wedged call preempted by close | pass | `e2e.ts`: waiter failed in 4 ms, holder in 5 ms, closed in 134 ms on CloakBrowser. Camoufox spinning on Windows: closed in 15.5 s, no process left. Camoufox frozen with SIGSTOP on Linux: 15.0 s, no process left, slot free, relaunch works |
| Both engines count together | pass | `e2e.ts`: one limit, slot passes between engines in 1084 ms |
| Lease blocks another session | pass | `e2e.ts`: `PROFILE_LEASED` on a click, reads pass, a reconnect reattaches, `operator` force-releases |
| Lease on session close | pass | `e2e.ts concurrency`: `keep` keeps it, `release` frees it, both engines and platforms |
| Shutdown during a launch | pass | `e2e.ts`: exit 0, 0 left |

## AC7. Remote access and egress

| Bullet | Result | Evidence |
| --- | --- | --- |
| Foreign Host and Origin | pass | Extras: 403 even with a good token. `e2e.ts` over TLS on a LAN address too |
| Limited token neither sees nor calls | pass | `e2e.ts`: no `click` in `tools/list`, `FORBIDDEN`; scoped token sees only its profile |
| Revoke from the CLI process | pass | `e2e.ts`: next request refused, stream closed in 2 ms, queued call and lease dropped |
| `/messages` with a foreign token | pass | Extras: 403, its own 202 |
| `/mcp` POST, GET, DELETE with a foreign token | pass | Extras: 403 each |
| Failed logins | pass | Extras: 429 with `Retry-After: 60` on the 11th |
| `http://169.254.169.254` by `navigate`, `new_tab` | pass | `EGRESS_BLOCKED`, both engines, Windows and Docker |
| Decimal, hex and mapped forms | pass | `2852039166`, `0x7f.1`, `[::ffff:169.254.169.254]`, as navigation and as redirect targets |
| Redirect to a private address | pass | 302 from the allowed fixture: `EGRESS_BLOCKED`, listener saw 0 |
| `fetch`, iframe, image, `ws://` | pass | Listeners on private and loopback addresses saw 0, with an allow-all control of 30. Not aimed at 169.254.169.254 itself, where nothing listens to count: `tests only` for that address class |
| WebRTC, Camoufox | pass | Responder got 0 datagrams, control 6 |
| WebRTC, CloakBrowser | not run | Nothing to demonstrate: it gathers none with or without the policy, so 0 proves nothing about the policy. Its control is the bare binary with the policy opened by a flag, 5 datagrams. An open item in `docs/server-mode.md` |
| WebTransport | pass | 0 datagrams, control 4 |
| DNS rebinding | pass | With the server's resolver stubbed: the bridge asked 2 more times, the new address's listener saw 0, the fetch rejected |
| Proxy host at metadata | pass | At `create_profile`, `update_profile`, launch, and by a name resolving there |
| Allowed exception works | pass | IP, CIDR with port, name with port load; `127.0.0.3` stays blocked |
| `raw` | pass | A documented hole. `Target.createBrowserContext{proxyServer:"direct://"}` reached the private listener through `cdp_send` and `cdp_send_no_safety`, Windows and Docker. Not gated, by decision |
| QUIC from `Alt-Svc` | not run | Needs a trusted certificate. Documented |
| A hostile page, token or file | pass | `security-live.ts`: a 100,000-character download name leaves `list_profiles` answering in 8 ms at worst; `169.254.169.254:80/#` is `EGRESS_BLOCKED`; a hostile `.mzar` plants nothing and `owner-token` survives; a cap of 3 sessions evicts the oldest; third upload `FILE_TOO_LARGE`; `delete_download` frees quota; `server.lock` hash only; no URL in the log; a corrupted engine download fails with `checksum mismatch` |
| 128 MiB of bodies, and 256 idle sockets | pass | `security-live.ts`: a read-only token's 6 POSTs declaring 128 MiB and sending nothing leave the owner answering in tens of ms, and get 408 at 30 s; 7 POSTs sending 128 MiB: 5 refused past its 32 MiB; a revoke closes a body in flight in under a second; 256 idle sockets from another address or the owner's own, and reopened as they close, leave the owner in every time |
| Name lookups nobody answers | pass | Linux, and on Windows tests only. With a page asking for 300 names under a black-hole resolver: another profile's navigate 47 and 89 ms, an upload 57 and 123 ms, the server at 71 and 77 threads |

## AC8. Refs

| Bullet | Result | Evidence |
| --- | --- | --- |
| Second tab | pass | `e2e.ts`: `click_ref`, `type_ref`, and a ref on a background tab activates it |
| Iframes, same-process, cross-origin, nested OOPIF | pass | Four frames, each frame's own handler fired, both engines |
| Scrolled page and scrolled frame | pass | There and back, OOPIF included |
| Non-1 DPR, CloakBrowser | pass | `devicePixelRatio 1.75` via CDP emulation, all four frames |
| Non-1 DPR, Camoufox | not run | It has no CDP, and no fingerprint path sets a scale factor |
| Old ref after re-extract | pass | Same element keeps its ref and still clicks it |
| Old ref after navigate, removed element, closed tab | pass | `STALE_REF`, same URL and cross-process, ids never reused |
| Ref across a relaunch | pass | Fails, reaches nothing |
| Two sessions | pass | Extras, both engines and platforms: same ref for both, each click fires the handler, after session B's navigate session A's ref is `STALE_REF` and clicks nothing |

## AC9. Detection baselines

| Bullet | Result | Evidence |
| --- | --- | --- |
| Subset on the final tree, saved as `2026-11-01-*` in `docs/detection-baselines` | pass | `win-headless-server-cb`, `linux-xvfb-server-cb`, `linux-headless-server-cb`, `linux-xvfb-server-cf` and its repeat `linux-xvfb-server-2-cf`, `win-headed-desktop-cb`. Same seed `mz-baseline-70`, device `windows-desktop-nvidia`, engines `146.0.7680.177.5` and `152.0.4-beta.30`. 9 sections each, none `unavailable`, 8 files each. `HeadlessChrome`, `webdriver: true`, `pointer: none`: none. One Windows try came back all `unavailable` from a lost CDP connect, as a run with nothing to read should, and was repeated |
| CloakBrowser server runs against the stored ones | pass | No drift. `compare.ts` with the stored `-2` as repeat: `win-headless-server-cb` 0 differences, `linux-xvfb-server-cb` 0, `linux-headless-server-cb` 0 |
| Camoufox against the stored one | pass | No drift. First run 2 differences: `input.click.sequence`, a pointer path over one more element, and CreepJS `audio.totalUniqueSamples` 4734 against 4735 and 4736. Both went back to stored values on the repeat, whose own 9 differences are the GPU it drew this launch (NVIDIA, then Intel). That is the per-launch fingerprint `docs/server-mode.md` already calls out |
| Desktop reference against the stored one | pass | Drift, explained, and not from code. 34 differences, all from this one being run without `--raise`, as asked: its window opened behind others and never painted. `visibilityState` `hidden`, no paint entries, no animation frames, `hasFocus` false, `outerWidth` and `outerHeight` 0, and `click` fails with `INPUT_NOT_DELIVERED` where the stored run has its events. Headers, fonts, TLS, HTTP/2, WebRTC, CreepJS and rebrowser: 0 differences. This is the occlusion row of `docs/server-mode.md`, seen at a window's birth |
| The verdict on the final tree | pass | The stored desktop against each new server run, the stored repeats as noise: `win-headless-server-cb` 11 differences, `linux-xvfb-server-cb` 110, `linux-headless-server-cb` 123, `linux-xvfb-server-cf` 53, each the same count as the stored comparison. **"No worse on a server than on the desktop" holds on Windows only, and does not hold on Linux in Docker for any engine or mode measured.** The table is in `docs/server-mode.md`. Rows with no run here, `win-headed-server`, Camoufox on Windows and the Linux personas, stand on the stored runs and the reading that nothing a page reads changed |
| An all-`unavailable` run must fail | tests only | `lib/baseline.test.ts`, and live once by accident: the try above exited 1 |

## AC10. Documentation

| Bullet | Result | Evidence |
| --- | --- | --- |
| Docs exist and describe use | pass | `apps/server/README.md`, `docs/server-mode.md`, root `README.md`, `CHANGELOG.md`, `docs/detection-baselines/README.md`, and this file. Root README: server mode section, the list of 45 tools. CHANGELOG: one Unreleased block, no version bump |
| Quickstart from source, Windows | pass; manual, not reproducible | `MULTIZEN_DATA_DIR` on a temp dir, a free port, `UV_THREADPOOL_SIZE=64`. `serve --headless` listens, `owner-token` is written, no token is logged, no thread pool warning, `/healthz` `{"ok":true}`, `/readyz` 401. `token create --name agent` prints the token alone. A real SDK client with it sees 39 tools, `create_profile` and `cdp_send` are `FORBIDDEN`. `--tools read,act,profile-admin`: 42 tools, creates a profile, launches `headless` after the engine downloads (`ENGINE_NOT_READY` 18 times over 91 s), `navigate` to this machine is `EGRESS_BLOCKED`. `owner-token`: 45 tools. `corepack yarn install` wasn't repeated on the host, to keep the ABI state; the build was. One try lost a `launch_profile` to the bare 408 of finding 1, and two more were my script's, which left out the panel login's `Origin` |
| `stdio --connect` line | pass; manual, not reproducible | A real stdio client through `stdio --connect --token-file` sees that token's 39 tools |
| `token create`, `list`, `revoke` | pass; manual, not reproducible | Token alone on stdout, default 39 tools, `--panel` signs in, one without `operator` gets 403, a revoke stops a client in 3 ms |
| `profile export`, `import`, `secrets rotate` | pass; manual, not reproducible | Passphrase from a file, none is exit 2, the import works, the key file changes |
| Remote access refusals | pass; manual, not reproducible | `--host 10.0.0.5`, then with `--allow-remote`, then a wildcard with both flags: each message as the README gives it, exit 2 |
| Reverse proxy and egress examples | pass; manual, not reproducible | The `--public-url`, `--trust-proxy`, `--egress-allow` lines start, the public host is accepted, another gets 403. nginx itself: not run |
| TLS example as written | not run | No such address here. `e2e.ts auth` runs `--allow-remote` with TLS on a real address, and `integration.test.ts` the same bundle |
| Quickstart, Docker | pass; manual, not reproducible | The image from this tree, default project, port 7777: `up -d`, `logs`, `exec … token create --name agent` with `-T` for want of a terminal. SDK client: 39 tools, `create_profile` and `cdp_send` `FORBIDDEN`. `owner-token`: 45. `--tools read,act,profile-admin`: 42, creates a profile and launches it under Xvfb after the engine downloads (`ENGINE_NOT_READY` 10 times over 54 s), the policy is on. User `node`, `/data` 700, `pids_limit` 4096, json-file log at 10 MB and 3 files, `UV_THREADPOOL_SIZE` 64, no token in the log. 30 checks. Two tries lost first, each a connection through the published port from the host: a bare 408 on `launch_profile`, and `fetch failed` |
| Upgrade and backup, Docker | pass; manual, not reproducible | `stop`, the README's `tar` line, `start`, healthy: the archive holds `profiles.db`, `tokens.json`, `owner-token`, `secret.key`, no engine. `build`, `up -d`, healthy. `down -v` leaves nothing |
| Plain `docker run` example | pass; manual, not reproducible | As written, on a throwaway volume: listens, answers with 45 tools |
| Every flag and env var documented; tool list and group table match the code | pass | `apps/server/src/docs.test.ts`, in the Linux gate: both ways, 45 tools, the group table equal to `toolPolicy.ts` |
| A merge past the moved files | pass; manual, not reproducible | A throwaway clone of this tree, upstream's edit to the three files below 50 % in their old paths: `FirefoxBrowserDriver.ts` 15 %, `engineRouter.ts` 32 %, `launchGeo.test.ts` 39 %. A plain `git merge`: three modify/delete. `git merge -X find-renames=15`: the edits land in the new paths, one clean and two as ordinary content conflicts. Not a real upstream merge |
| Windows Firewall prompt, Git Bash Ctrl+C, AppArmor steps | not run | Firewall: `169.254.182.1` here gave no prompt, the rule may already exist. Ctrl+C from Git Bash is the reason `e2e.ts` runs from PowerShell. AppArmor: no such host |

## Documented holes, by decision

`raw` defeats the egress policy, and `cdp_send_no_safety` stays unrestricted. `evaluate_js` before a handoff reads what a person types after it. WebRTC gathering nothing on CloakBrowser and Camoufox's fingerprint changing at each launch are open items in `docs/server-mode.md`.
