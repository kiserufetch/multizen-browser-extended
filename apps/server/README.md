# multizen-server

The same MCP server and the same browser drivers as the MultiZen desktop app, with no Electron and no GUI. Run it on a Linux box, in Docker, or on Windows, and point your agents at it over HTTP or stdio. CloakBrowser and Camoufox both work, in a window, under Xvfb, or headless.

What you get on top of the desktop's tool set:

- **Display modes.** `headed`, `xvfb` and `headless`, per server, per profile or per launch.
- **Handoff over the network.** When an agent hits a CAPTCHA or a 2FA prompt, a person takes over in a web panel served by the same port, and the agent's page actions wait.
- **Named tokens with permissions.** Each token carries tool groups and a list of profiles. Revoking one stops it within a second.
- **An egress policy.** Browsers stay off private addresses, this machine's ports and cloud metadata, down to the connection level.
- **Encrypted proxy passwords**, a browser limit, session limits, a crash reaper, and a Docker image that runs as non-root with the Chromium sandbox on and no way to turn it off.

The desktop app keeps its defaults: what did change on it is listed in [`docs/server-mode.md`](../../docs/server-mode.md#что-поменялось-на-десктопе). See [Acceptable use](../../README.md#acceptable-use) and [the licence note](#engine-licences) before you run it for anyone but yourself.

## Detection: read this first

**"A server is no worse than the desktop" holds on Windows. It does not hold on Linux, on either engine, in any mode.** JA4, HTTP/2, header order and input events are the same everywhere. What differs is what a page's scripts read from the system, and on Linux that isn't a desktop:

| Engine | Mode | No worse than the desktop? | What differs |
| --- | --- | --- | --- |
| CloakBrowser | Windows, window | Yes, with one caveat | `connection.rtt` 0 and `downlink` 10, from the bridge |
| CloakBrowser | Windows, headless | Yes, with caveats | The same, plus `colorDepth` 24 instead of 32, and no `any-pointer: coarse` at `maxTouchPoints` 10 |
| CloakBrowser | Linux, Xvfb, Windows persona | **No** | 54 of 57 Windows fonts missing, other emoji, other audio, plus `rtt` |
| CloakBrowser | Linux, Xvfb, Linux persona | **No** | CreepJS "like headless" 50 % against 19 %, a grade F GPU on this persona, plus `rtt` |
| CloakBrowser | Linux, headless | **No**, worse than Xvfb | All of Xvfb's, plus other canvas, 33 WebGL extensions instead of 35, `suspicious gpu` |
| Camoufox | Windows, window and headless | Yes, except WebRTC | No `RTCPeerConnection`, 22 fewer globals, from the block on the bridge |
| Camoufox | Linux, Xvfb | **No** | 0 voices, 0 devices, audio 44100 Hz with 0 channels, no `GPU*` or `Touch*` |
| Camoufox | Linux, headless | **No**, much worse than Xvfb | All of Xvfb's, and no WebGL at all |

**Which persona.** Run Windows personas on a Windows host, the only setup measured to match, fonts included. For everything else use a Linux persona, which is what `create_profile` picks on Linux when `fingerprint.device` isn't set: no contradiction between persona and OS, at the price of that CreepJS score. A Windows persona in Docker shows Windows without its fonts, which detectors check more than most things. On Linux prefer `xvfb`, and `headless` only where Xvfb can't be installed.

**What a Windows machine does shows in `headed`.** A server's browsers run with occlusion tracking off, so a window someone covers keeps working. With a window fully covered:

| | CloakBrowser, tracking on (desktop) | CloakBrowser, off (server) | Camoufox, on (desktop) | Camoufox, off (server) |
| --- | --- | --- | --- | --- |
| `visibilityState` | `hidden` | `visible` | `visible` | `visible` |
| Animation frames | stop | run | stop | run |
| A click | arrives, in 5.1 s | arrives, in 0.11 s | **doesn't arrive in 7 s** | arrives, in 0.1 s |

Uncovered, a page can't tell the two apart. Covered, on a server, it sees a window that seems to stay in front. The machine's theme and touch screen reach pages too (`prefers-color-scheme`, `maxTouchPoints`). A locked screen, a disconnected RDP session and a minimized window weren't measured.

One machine, local pages: real sites, a real proxy, macOS and a real GPU on Linux weren't measured. Everything, and how to repeat it, is in [`docs/detection-baselines/README.md`](../../docs/detection-baselines/README.md).

## Quickstart

### From source

Needs Node 22 or newer and Corepack.

```sh
git clone https://github.com/kiserufetch/multizen-browser-extended
cd multizen-browser-extended
corepack yarn install
corepack yarn workspace @multizen/server build
node apps/server/bin/multizen-server.cjs serve --headless
```

The first start downloads CloakBrowser into the data directory (`engine status` lines in the log show the progress) and writes the owner token. It listens on `http://127.0.0.1:7777/mcp`. In another shell, make a token for your agent. It is printed once:

```sh
node apps/server/bin/multizen-server.cjs token create --name agent
```

That token can use profiles but not create them, and a new server has none. For an agent that creates its own, add `--tools read,act,profile-admin`. Then connect any MCP client with that token, as in the [root README](../../README.md#connect-an-agent-codex-cursor-claude-desktop):

```json
{
  "mcpServers": {
    "multizen": {
      "url": "http://127.0.0.1:7777/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

A client that can only spawn a stdio server runs a relay to it:

```sh
node apps/server/bin/multizen-server.cjs stdio --connect http://127.0.0.1:7777/mcp --token-file <file holding that token>
```

**`owner-token` is not for agents.** It holds every group: `raw`, which [defeats the egress policy](#egress-policy), and `operator`, which ends handoffs. An agent gets `read` and `act` from `token create`, and no more unless you ask. The owner's token is in `owner-token` in the [data directory](#data-layout), for you.

Without `--headless` you get a real window on Windows and macOS, and on Linux whatever [`auto`](#display-modes) picks. On Windows, set `UV_THREADPOOL_SIZE=64` before starting Node: [Limits](#limits) says why, and `bin/` can only do it for you elsewhere.

### Docker

```sh
docker compose up -d
docker compose logs -f multizen    # wait for "listening", then Ctrl+C: the engine downloads into the volume
docker compose exec multizen node /app/dist/cli.js token create --name agent
```

Connect an MCP client to `http://127.0.0.1:7777/mcp` with the printed token as a Bearer token, as above, where `--tools read,act,profile-admin` is explained too. `/data/owner-token` holds the owner's, which is for you, not for an agent.

The compose file builds `multizen-server:local` and publishes port 7777 on the host's loopback only. It runs as user `node` with every capability dropped, applies `docker/seccomp-chromium.json`, keeps everything in the `multizen-data` volume, and rotates its log at 10 MB, three files. The image holds no browser engine: see [Engine licences](#engine-licences).

To load local pages for a test, add exceptions to the policy in the service's `environment`, each with its port (see [Egress policy](#egress-policy)):

```yaml
MULTIZEN_EGRESS_ALLOW: "127.0.0.1:8080,localhost:8080"
```

**Another port, or another machine.** `MULTIZEN_HOST_PORT` publishes another host port, and the compose file accepts that `Host`. The server inside still believes it is on 7777, and that is what its links say: the panel's in a webhook, and `details.url` in a `FILE_TOO_LARGE`. Whenever clients reach the server by anything but its own bind address and port (a remapped port, a reverse proxy, another machine), tell it with `--public-url`, here in the service's `environment`:

```yaml
MULTIZEN_PUBLIC_URL: "http://127.0.0.1:8080"
```

Plain `docker run` works if you bring the same options:

```sh
docker build -f docker/Dockerfile -t multizen-server:local .
docker run -d --name multizen --hostname multizen --shm-size 1g \
  --security-opt seccomp=docker/seccomp-chromium.json --security-opt no-new-privileges:true --cap-drop ALL \
  -p 127.0.0.1:7777:7777 \
  -e MULTIZEN_HOST=0.0.0.0 -e MULTIZEN_ALLOW_REMOTE=1 -e MULTIZEN_ALLOW_INSECURE_REMOTE=1 \
  -e MULTIZEN_ALLOWED_HOSTS=localhost:7777,127.0.0.1:7777 \
  -v multizen-data:/data multizen-server:local
```

Leave out the seccomp option and every CloakBrowser launch fails with `SANDBOX_UNAVAILABLE`, by design. Plain `docker run` has none of compose's limits: add `--pids-limit 4096` and `--log-opt max-size=10m --log-opt max-file=3` if you want them.

## Commands

Everything below is `multizen-server <command>`: from source that is `node apps/server/bin/multizen-server.cjs`, in the container `docker compose exec multizen node /app/dist/cli.js`. Exit codes: 0 for a clean stop, 1 for a failed start, 2 for bad flags. Logs are JSON lines on stdout, and on stderr for `stdio` and `token`, whose stdout is their result.

### `serve`

MCP over Streamable HTTP (`/mcp`) and legacy SSE (`/sse`), plus the panel (`/panel`), `/healthz` (public, answers only `{"ok":true}`) and `/readyz` (behind a token, reports the engine's state). Every flag has an environment variable, and the flag wins. A boolean variable takes `1`.

| Flag | Environment | Default | What it does |
| --- | --- | --- | --- |
| `--host` | `MULTIZEN_HOST` | `127.0.0.1` | Address to bind. Beyond loopback see [Remote access](#remote-access). |
| `--port` | `MULTIZEN_PORT` | `7777` | Port to bind. |
| `--data-dir` | `MULTIZEN_DATA_DIR` | see [Data layout](#data-layout) | Where everything lives. |
| `--default-engine` | `MULTIZEN_DEFAULT_ENGINE` | `cloakbrowser` | Engine for a profile that names none, fixed at creation. Also the one fetched at start. |
| `--display-mode` | `MULTIZEN_DISPLAY_MODE` | `auto` | `auto`, `headed`, `xvfb` or `headless`: the mode when nothing else names one. |
| `--headless` | `MULTIZEN_HEADLESS` | off | No windows at all. See [Display modes](#display-modes). |
| `--max-browsers` | `MULTIZEN_MAX_BROWSERS` | from memory | Browsers at once, over both engines. One per GiB after a reserve of 1 GiB, at least 1. |
| `--browser-queue-timeout-ms` | `MULTIZEN_BROWSER_QUEUE_TIMEOUT_MS` | `30000` | How long a launch waits for a slot before `BROWSER_LIMIT_REACHED`. |
| `--no-auth` | `MULTIZEN_NO_AUTH` | off | No tokens. Only on loopback with no extra hosts. |
| `--allow-remote` | `MULTIZEN_ALLOW_REMOTE` | off | Permits a `--host` beyond loopback. |
| `--allow-insecure-remote` | `MULTIZEN_ALLOW_INSECURE_REMOTE` | off | Permits that over plain HTTP. |
| `--tls-cert`, `--tls-key` | `MULTIZEN_TLS_CERT`, `MULTIZEN_TLS_KEY` | | PEM files. Only together. |
| `--allowed-hosts` | `MULTIZEN_ALLOWED_HOSTS` | | `Host` values to accept, comma-separated, each with an optional `:port`, besides the bind address and loopback. |
| `--allowed-origins` | `MULTIZEN_ALLOWED_ORIGINS` | | `Origin` values to accept besides those of the allowed hosts. |
| `--public-url` | `MULTIZEN_PUBLIC_URL` | | Where clients reach this server: an allowed host and origin, and the base of panel and download links. |
| `--trust-proxy` | `MULTIZEN_TRUST_PROXY` | off | Failed logins count against `X-Forwarded-For`'s rightmost hop, and sockets with no token aren't limited per address. See [Limits](#limits). |
| `--session-idle-ttl-ms` | `MULTIZEN_SESSION_IDLE_TTL_MS` | `1800000` | An MCP session with no request and no call in flight for this long is closed. |
| `--max-sessions` | `MULTIZEN_MAX_SESSIONS` | `64` | Past this a new session gets `SESSION_LIMIT`. Also sizes the socket limits: see [Limits](#limits). |
| `--max-sessions-per-token` | `MULTIZEN_MAX_SESSIONS_PER_TOKEN` | `16` | One token's share of them. Past it, that token's own oldest idle session is closed for the new one. With none idle, `SESSION_LIMIT`. |
| `--lease-on-session-close` | `MULTIZEN_LEASE_ON_SESSION_CLOSE` | `keep` | What a session's end does to its leases. `keep`: they run on until their TTL, for a client coming back with its `lease_id`. `release`: they go with it. |
| `--egress-policy` | `MULTIZEN_EGRESS_POLICY` | `block-private` | `block-private` or `allow-all`. See [Egress policy](#egress-policy). |
| `--egress-allow` | `MULTIZEN_EGRESS_ALLOW` | | Exceptions, comma-separated: an IP, a CIDR, a name or `*.suffix`, each with an optional `:port`. |
| `--uploads-root` | `MULTIZEN_UPLOADS_ROOT` | | A directory `upload_file` may read from, besides each profile's own. |
| `--download-quota-bytes` | `MULTIZEN_DOWNLOAD_QUOTA_BYTES` | 2 GiB | What one profile's downloads may take. |
| `--upload-inbox-quota-bytes` | `MULTIZEN_UPLOAD_INBOX_QUOTA_BYTES` | 1 GiB | What one profile's base64 uploads may take until it closes. Past it, `FILE_TOO_LARGE`. |
| `--handoff-webhook` | `MULTIZEN_HANDOFF_WEBHOOK` | | Your endpoint, told about each new handoff. |
| `--handoff-webhook-secret` | `MULTIZEN_HANDOFF_WEBHOOK_SECRET` | | Signs its body. Prefer the variable: a command line is readable by others. |
| `--handoff-ttl-ms` | `MULTIZEN_HANDOFF_TTL_MS` | `900000` | How long a handoff waits for a person. |

`MULTIZEN_LOG_LEVEL` is `debug`, `info`, `warn` or `error`, and nothing below it is written. The default, `info`, hides what browsers write to stderr: set `debug` to see it when a browser misbehaves. Anything else gets a warning and `info`.

`MULTIZEN_DEBUG=1` is not a log level. It makes CloakBrowser's driver read `navigator`, `Intl` and `RTCPeerConnection` in each page's main world and log that, which a page could notice. It is for debugging, not for production.

`UV_THREADPOOL_SIZE` is Node's, and matters here: see [Limits](#limits). `bin/multizen-server.cjs` and the image set it to 64.

### `stdio`

```sh
multizen-server stdio [--data-dir <dir>] [--default-engine ...] [--uploads-root <dir>]
                      [--max-browsers <n>] [--browser-queue-timeout-ms <ms>]
                      [--display-mode ...] [--headless] [--egress-policy ...] [--egress-allow ...]
                      [--upload-inbox-quota-bytes <n>]
multizen-server stdio --connect <url> [--token-file <path>] [--keepalive-ms <ms>]
```

The first form runs its own browsers for one client, with the same flags as `serve` where they apply. There is no panel in it, so nothing blocks an agent during a handoff. It holds the data directory's lock, so a `serve` on that directory refuses it and says how to use `--connect` instead. It stops when its stdin closes.

The second form runs no browsers. It relays to a running `serve` and pings it every `--keepalive-ms` (30000), which keeps its session from idling out as long as that is below the server's `--session-idle-ttl-ms`. If the session is gone anyway, because the server restarted or the token was revoked, it says so on stderr and exits 1. Restart it.

### `token`

```sh
multizen-server token create --name <name> [--tools <groups or tool names>] [--profiles <ids|*>]
                             [--panel] [--expires <30d|12h|45m|90s|date>] [--data-dir <dir>]
multizen-server token list [--data-dir <dir>]
multizen-server token revoke <id or name> [--data-dir <dir>]
```

These run beside a live server, with no lock. `create` prints the token once on stdout, so `TOKEN=$(multizen-server token create --name ci)` works. See [Tokens and tool groups](#tokens-and-tool-groups).

### `profile`

```sh
multizen-server profile export <profile-id> [--out <file.mzar>] [--passphrase-file <path>] [--data-dir <dir>]
multizen-server profile import <file.mzar> [--passphrase-file <path>] [--data-dir <dir>] [--default-engine ...]
```

The same encrypted `.mzar` archive the desktop app uses, which is how a profile moves between the two. The passphrase comes from a file or `MULTIZEN_ARCHIVE_PASSPHRASE`, never a flag. Both hold the data directory's lock, so stop the server first. There is no other extension management on a server, and the desktop's companion extension isn't loaded.

**A `.mzar` is code.** The extensions in an imported profile load, and run in that profile's browser with its cookies and pages. Import only an archive you would run. `downloads/` and `uploads/` in one are ignored on import, and a download's index that names anything but a plain file in its own directory is dropped, so a hostile archive can't read or delete other files through them. The extensions are still code.

### `secrets`

```sh
multizen-server secrets rotate [--data-dir <dir>]
```

See [Secret key](#secret-key).

## Display modes

| Mode | What it is | Where |
| --- | --- | --- |
| `headed` | A real window. | Needs a display: always there on Windows and macOS, `DISPLAY` or `WAYLAND_DISPLAY` on Linux. |
| `xvfb` | A real window on a private X server, one per profile, sized to the fingerprint's screen. | Linux with Xvfb installed. The image has it. |
| `headless` | The engine's own: `--headless=new` on CloakBrowser, `headless: true` on Camoufox. No CDP or JS tricks. | Everywhere. |

Asking for a mode this machine can't do gives `DISPLAY_UNAVAILABLE`.

A launch picks the first of these that says something: the `display_mode` argument of `launch_profile`, the profile's saved mode (`display_mode` on `create_profile`, `update_profile`), the `defaultDisplayMode` in `settings.json`, then `--display-mode`. `auto` means: Linux with no `DISPLAY` takes `xvfb` if it is installed and `headless` if not; everything else takes `headed`.

`--headless` sits above all of that and allows no windows. A profile saved as `headed` runs headless and keeps its saved value. A launch that names `headed` or `xvfb` by argument gets `INVALID_INPUT`.

A running profile keeps its mode. `launch_profile` with no argument stays idempotent, naming another mode gives `PROFILE_ALREADY_RUNNING`, and `update_profile` refuses a real change until `close_profile`. `list_profiles` shows the saved mode and the running one.

On Linux, prefer `xvfb`: headless there is worse, with another WebGL extension set and extra CreepJS flags on CloakBrowser, and no WebGL at all on Camoufox. On Windows the two are nearly the same, and a covered window is handled: Chromium's and Firefox's occlusion tracking are off, so a page under another window keeps painting and taking input. See [Detection](#detection-read-this-first).

## JavaScript dialogs

A dialog blocks its page until someone answers. `set_dialog_policy` says who: `auto`, the default, answers at once (`alert` and `beforeunload` accept, `confirm` and `prompt` dismiss, and each can be changed), and `manual` leaves it for `handle_dialog`, with calls on that tab saying `DIALOG_OPEN` meanwhile. During a handoff through the panel, dialogs wait for the person.

Which tabs the policy covers depends on who could answer otherwise:

| Where | Tabs it answers on |
| --- | --- |
| A server, in any mode, `headed` too | Every tab |
| A desktop profile with no window (`headless`, `xvfb`) | Every tab: nobody could see the dialog |
| A desktop profile in a window (`headed`) | The first tab, those from `new_tab`, and any tab an agent has acted on. Every other tab is a person's, and keeps its native dialogs |

A dialog a person left open on their own tab is answered by the policy once an agent targets that tab. That table is CloakBrowser's. Camoufox answers on every tab in every mode, as nothing else there can: Playwright never leaves a dialog for a person.

## Prerender

A page with `<script type="speculationrules">` was checked for losing its tab when a prerender activates. It doesn't reproduce. Chromium's preference for it is off on a fresh profile, and with it on, any attached session blocks prerender (`PrerenderingDisabledByDevTools`), so a click on such a page lands, the tab stays, and tools go on, on a server and on a desktop. A prerender started before the session attached activates under the same target, and that works too. The live check is in the `tabs` flow of `e2e.ts`. The cost is on the desktop: a person who turned Preload on gets no prerender on tabs in a profile, since every tab is attached. It only costs speed.

## Tokens and tool groups

`serve` won't start with no usable token. The first start creates the owner's, with every group, in `<data-dir>/owner-token` (mode 0600), and logs only its path. It is for you, not for an agent: connect agents with one from `token create`. Tokens look like `mz_t_<id>_<secret>`. Only their hashes are stored, in `<data-dir>/tokens.json`.

`token create` gives `read` and `act` unless `--tools` says otherwise, and `--tools` takes groups, single tool names, or both.

| Group | Tools |
| --- | --- |
| `read` | `list_profiles`, `extract`, `screenshot`, `list_tabs`, `get_human_status`, `list_downloads`, `list_dialogs`, `list_fingerprint_options`, `probe_fingerprint` |
| `act` | `navigate`, `click`, `type`, `click_ref`, `type_ref`, `press_key`, `hover`, `select_option`, `scroll`, `upload_file`, `get_download`, `delete_download`, `handle_dialog`, `set_dialog_policy`, `evaluate_js`, `wait_for_selector`, `wait_for_navigation`, `wait_for_load`, `get_cookies`, `set_cookies`, `new_tab`, `activate_tab`, `close_tab`, `launch_profile`, `close_profile`, `request_human`, `wait_for_human`, `acquire_profile`, `renew_profile`, `release_profile` |
| `profile-admin` | `create_profile`, `update_profile`, `delete_profile` |
| `raw` | `cdp_send`, `cdp_send_no_safety` |
| `operator` | `resume_human`, the handoff panel, and force-releasing another token's lease |

- `tools/list` shows a token what it may use, and anything else is `FORBIDDEN`. A tool in no group is refused for everyone.
- `--profiles` limits a token to those ids: `list_profiles` shows only them, and a call on any other is `FORBIDDEN`. Such a token can't `create_profile`, whose result no list could already name.
- `--panel` is short for adding `operator`.
- Without `raw`, `launch_profile` leaves out `cdpEndpoint` and `pid`.
- `raw` defeats the egress policy and the upload rules. Think of it as the keys to the machine's network. See [Egress policy](#egress-policy).
- A revoke from another process takes effect within a second: the next request is refused, the token's sessions and streams close, and its queued calls and leases go.
- If `tokens.json` stays unreadable for 5 s, every token is refused until it reads again, since it may hold a revocation. The log says so.
- Only the owner's token sees host paths in an unexpected error. For any other they read `<path>`, and the log keeps the original. `list_profiles` names no host path for anyone.
- A session belongs to the token that opened it. Another token on it gets 403, on `/mcp` and on `/messages`.
- Ten failed logins a minute from one address get 429 with `Retry-After`.
- The activity log and the logs carry the token's name, and never the arguments, page contents or cookies of a call.

Agents share a profile by default. Tool calls on a profile run one at a time in arrival order, across sessions. For exclusive use, `acquire_profile` gives a lease: others can still read but get `PROFILE_LEASED` on anything that changes the profile. A lease survives a dropped connection until its TTL (reattach with its `lease_id`), unless the session ended with `--lease-on-session-close release`.

### Login flows and `evaluate_js`

A handoff doesn't clean the page. What `evaluate_js` left in it before `request_human` keeps running while a person types: a `keydown` listener collects the password or the code, for the agent to read back with `evaluate_js` after Resume, or to send at once wherever the egress policy lets the page reach. The `login` and `2fa` kinds refuse the agent's own `extract`, `screenshot` and `get_cookies` during the handoff. They don't stop a script already there. If the agent isn't trusted with what a person types, give it a token without `evaluate_js`, which means naming tools, since `act` includes it:

```sh
multizen-server token create --name login-agent --tools read,navigate,click,type,click_ref,type_ref,press_key,wait_for_selector,wait_for_navigation,wait_for_load,launch_profile,close_profile,request_human,wait_for_human
```

Such an agent also has no `raw`, which reaches further still.

## Remote access

By default the server binds to loopback. Beyond it the rules are:

1. A token is required. `--no-auth` is refused.
2. `--host` needs `--allow-remote`.
3. It also needs `--tls-cert` with `--tls-key`, or `--allow-insecure-remote` if you really mean plain HTTP, which sends tokens readable across the network.
4. A wildcard (`0.0.0.0`, `::`) names no address a client could use, so it also needs `--allowed-hosts` or `--public-url`.

```sh
multizen-server serve --host 10.0.0.5 --allow-remote \
  --tls-cert /etc/multizen/cert.pem --tls-key /etc/multizen/key.pem
```

A request whose `Host` or `Origin` isn't on the list gets 403, which is what stops DNS rebinding. The list is the bind address, loopback, `--allowed-hosts`, `--allowed-origins` and `--public-url`. A wildcard `--allowed-hosts` is refused.

For remote use, or a port remapped in front of the server, also give `--public-url`: it is the base of the panel's link in a webhook and of `details.url` in a `FILE_TOO_LARGE`, which otherwise name this machine's bind address and port.

On `https://` the panel's cookie is `Secure`. Over plain HTTP it can't be.

### Reverse proxy

The cleanest way to reach it from elsewhere. Stay on loopback, where `--allowed-hosts` or `--public-url` is all it takes, and let the proxy hold the certificate:

```sh
multizen-server serve --public-url https://mz.example.com --trust-proxy
```

```nginx
location / {
    proxy_pass http://127.0.0.1:7777;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Connection "";
    # MCP streams its answers, and the longest calls take minutes.
    proxy_buffering off;
    proxy_read_timeout 600s;
    client_max_body_size 22m;
}
```

`--trust-proxy` is only for a proxy of yours that sets that header: anyone reaching the port directly could otherwise fake their address and dodge the login limit, and hold more sockets from one address than anyone else may: [Limits](#limits). The live check here used a plain HTTP hop of the same shape, not nginx itself.

## Egress policy

`--egress-policy block-private`, the default, keeps browsers off these, in any spelling (IPv4-mapped IPv6, NAT64, `2852039166`, `0x7f.1`):

- RFC 1918, loopback, link-local, CGNAT, unique local, multicast
- cloud metadata: `169.254.169.254`, `fd00:ec2::254`, `100.100.100.200`, `192.0.0.192`, and names like `metadata.google.internal`

It works at two levels:

- **At the tool.** `navigate`, `new_tab` and a proxy at such an address (at `create_profile`, `update_profile` and launch) give `EGRESS_BLOCKED`.
- **In the network.** Every profile runs through a local bridge that checks each connection the browser opens, so redirects, `fetch`, images, iframes, WebSockets and this machine's own ports (the MCP port, the CDP port) are covered. WebRTC and WebTransport are off the network on both engines.

A direct profile's names resolve in the bridge, and only the addresses checked are dialed, which closes DNS rebinding. A proxied profile resolves nothing locally: its literal addresses and loopback and metadata names are judged, and the name itself goes to the proxy.

Exceptions:

```sh
--egress-allow 10.1.2.3,10.20.0.0/16:8080,intranet.example.com,*.corp.example.com,[fd00::1]:443
```

**Give a port with a loopback exception.** `127.0.0.1` alone lets pages reach every port on this machine, this server's own and each browser's debugging port among them, and the server warns at start. `127.0.0.1:8080` lets them reach that one.

A proxy's host has to be an address or a plain name: `a-z`, `0-9`, `.`, `_`, `-`. Under the policy, on a server, a Unicode name is refused, so write it in punycode (`xn--...`). Something a URL could read another way, such as `169.254.169.254:80/#`, is refused with or without the policy, and on a server a profile whose stored proxy is such a thing doesn't launch.

A `navigate` error names the origin only, as messages reach the log and a URL can carry a token. `details.url` keeps the full URL for the caller, and isn't logged.

`--egress-policy allow-all` turns the policy off, with a warning in the log, and browsers then run with no bridge.

What it doesn't do:

- **The `raw` group defeats it.** `cdp_send` and `cdp_send_no_safety` aren't gated: `Target.createBrowserContext` with `proxyServer: "direct://"` was measured reaching a private address on CloakBrowser through both tools. `token create` doesn't give `raw` unless asked, so don't ask for anything you are using this policy against.
- **A proxy's own network is out of scope.** A proxied profile's names resolve at the proxy, and what it can reach from there is its business.
- **`new_tab` checks the URL it was given.** A redirect after that shows as an error page in the tab, not as an error from the tool. `navigate` does report it.
- **A QUIC connection from `Alt-Svc` wasn't exercised**, because it needs a trusted certificate. WebTransport was, and browsers on the bridge don't use QUIC.

What it costs in detectability is measured in [`docs/detection-baselines/README.md`](../../docs/detection-baselines/README.md): on the bridge, CloakBrowser reports `connection.rtt` 0 and `downlink` 10, as every proxied profile on the desktop already does, and Camoufox has no `RTCPeerConnection` at all.

## Secret key

Proxy passwords are stored encrypted with AES-256-GCM. The key is `MULTIZEN_SECRET_KEY` (32 bytes, hex or base64), or else `<data-dir>/secret.key`, which is created if neither exists and nothing is encrypted yet.

- At start, any plaintext passwords get encrypted, and the old bytes are purged from the WAL and free pages.
- Encrypted passwords with no key to open them refuse the start, with a message that says so.
- The variable is removed from the environment once read, so browsers don't inherit it. That doesn't reach `/proc/<pid>/environ` on Linux, which keeps what the server started with: anything running as that user can read the key there. Prefer a key file on another volume.
- A key file on the same volume as the database means a copy of that volume holds both. The log warns about it. Keep the key elsewhere, by making the file a link to another volume, or with the variable, given the line above.

To change the key, stop the server and run `secrets rotate`, which re-encrypts every password in one transaction and generates a new key file. If your key is in the variable, set `MULTIZEN_SECRET_KEY_NEW` too, run it, then change `MULTIZEN_SECRET_KEY` to that value.

The desktop app doesn't encrypt, and can't read a server's database once its passwords are encrypted. Move profiles between the two with `profile export` and `profile import`.

## Handoff panel and webhook

An agent that hits a CAPTCHA or a 2FA prompt calls `request_human` with a `reason` and a `kind`: `captcha`, `2fa`, `login`, `confirm` or `other`. That returns at once with a `handoff_id`. The agent then polls `get_human_status` or calls `wait_for_human` (at most 55 s per call, so call it again on `pending`). Only `resumed` means the step was done: `aborted` and `expired` mean it wasn't.

While a handoff is pending:

- `navigate`, `click`, `type`, `evaluate_js`, `cdp_*` and every other page action get `HUMAN_IN_CONTROL` (retryable).
- `extract`, `screenshot` and `get_cookies` keep working, unless the kind is `2fa` or `login`, where the page shows what the person types.
- `close_profile` is allowed and aborts the handoff. So does a browser that crashes. `delete_profile` is refused.
- Leases keep running, and can be renewed.

A person opens `<server>/panel` and signs in with a token holding the `operator` group (`token create --name me --tools read --panel`). That gives an `HttpOnly`, `SameSite=Strict` cookie good for the panel only: 30 idle minutes, 8 hours at most, gone with the token. It never reaches `/mcp` or downloads.

The panel lists pending handoffs and, for the one selected, shows the active tab live at up to 5 frames a second. It passes on mouse, wheel and keyboard, has a text box for pasted and composed text, and switches tabs (a popup is one more tab). It answers JavaScript dialogs and file pickers, and a file picker says which origin asked ("Asked by"). Resume or Abort ends the handoff, and records who did it.

A profile has one handoff at a time. Calling `request_human` again keeps its id, kind and expiry, and on a server its reason too, so what a person reads can't be rewritten under them.

One person at a time has the input. Frames stay in memory while someone is watching, and neither they nor anything typed reach a log.

Limits, all stated in the panel:

- A browser permission prompt (camera, location, notifications) belongs to the browser, not the page, and can't be answered from here.
- A `<select>`'s list may not appear in the frame. Click it anyway, then choose with the arrow keys and Enter.
- On CloakBrowser a file picker opened inside a cross-origin iframe can't be caught, in the panel or by `upload_file`.
- A handoff expires after `--handoff-ttl-ms` (15 minutes), and a person mid-input loses it. Records of ended handoffs stay for an hour, and none survive a restart: `HANDOFF_NOT_FOUND`.

`--handoff-webhook <url>` gets a POST about each new handoff, once:

```json
{
  "id": "…",
  "profileId": "…",
  "profileName": "shop-admin",
  "kind": "2fa",
  "reason": "enter the code",
  "panelUrl": "https://mz.example.com/panel#<id>",
  "createdAt": "2026-10-31T12:00:00.000Z",
  "expiresAt": "2026-10-31T12:15:00.000Z"
}
```

With `--handoff-webhook-secret`, the body's HMAC comes in `X-MultiZen-Signature: sha256=<hex>`. The link carries no token, and a person still signs in. The call has 5 seconds, follows no redirects, and a failure costs only a log line. `reason` and the profile's name come from an agent, so treat them as untrusted. The panel shows them as text.

## Downloads and uploads

**Downloads** land in `<profile>/downloads`, tracked from launch. `list_downloads` and `get_download` work on a stopped profile too. A completed file comes back as base64, up to 16 MiB. A larger one gives `FILE_TOO_LARGE`, whose `details.path` is where to fetch it with the same bearer token:

```sh
curl -H "Authorization: Bearer $TOKEN" -o file.bin http://127.0.0.1:7777/files/downloads/<profile-id>/<download-id>
```

That route answers with `attachment`, `nosniff` and a sandbox CSP, and takes only a bearer token with `get_download` and that profile in scope. Past `--download-quota-bytes` a download is stopped and deleted, and `delete_download` (group `act`) gives back what one took: it stops one under way, removes its file, and works on a stopped profile too. A profile keeps at most 1000 entries, with URLs recorded up to 2048 characters. At that cap a new download is refused, until `delete_download` makes room.

**Uploads** through `upload_file` are either base64 in the call (16 MiB in total) or a `file_name` relative to `<profile>/uploads` or `--uploads-root`. Any other host path gets `FILE_NOT_ALLOWED`. So do symlinks leading out and, on Windows, UNC paths, alternate data streams and reserved names. Too much base64 gets `FILE_TOO_LARGE`.

Base64 uploads, and files a person picks in the panel, wait in the profile's inbox, under `--upload-inbox-quota-bytes`. The inbox is cleared when the profile closes and at the next start of the server.

Both directories stay out of `.mzar` archives, and are ignored in one on import.

**Nothing bounds the disk as a whole.** The quotas are per profile, so what the server can take is `--download-quota-bytes` plus `--upload-inbox-quota-bytes`, times the number of profiles, plus the browsers' own data. Watch the disk of a server that takes profiles from others, or cap the volume.

## Limits

| What | Limit | Past it |
| --- | --- | --- |
| Browsers | `--max-browsers`, both engines | Wait up to 30 s in line, then `BROWSER_LIMIT_REACHED` |
| Calls on one profile | One at a time, 16 in line, 30 s wait | `TIMEOUT` (retryable) |
| One page tool call | 60 s, plus a little per key when typing | `TIMEOUT` (retryable) |
| `wait_for_human` | Default 50 s, at most 55 s | `status: pending`, call again |
| Handoff | 15 minutes, `--handoff-ttl-ms` | `status: expired` |
| Lease | 5 minutes by default, 1 hour at most | Lapses |
| MCP session | 30 idle minutes, 64 at once | Closed, `SESSION_LIMIT` |
| Sessions per token | 16, `--max-sessions-per-token` | That token's oldest idle one closes, or `SESSION_LIMIT` with none idle |
| Sockets with no valid token, per address | The larger of 256 and 4 × `--max-sessions`; an IPv6 /64 is one address; off with `--trust-proxy` | That address's oldest such socket closes |
| Sockets with no valid token, in all | 4 × that: 1024 | The oldest such socket closes |
| Sockets in all | 16 × that: 4096 | Dropped at accept |
| Sending the headers, or finishing a TLS handshake | 10 s | 408, and the socket closes |
| Failed logins | 10 a minute per address | 429 with `Retry-After` |
| Request body | 22 MiB | 413 `FILE_TOO_LARGE` |
| All request bodies in flight | 128 MiB as received, about six of the largest. One token: a quarter, 32 MiB. A body counts as at least 256 KiB | 503 `RATE_LIMITED`, with `Retry-After` and `details.retry_after_ms` |
| A request body's arrival | 30 s, which the largest makes in at about 6 Mbit/s | 408 `TIMEOUT` (retryable), and the socket closes |
| Inline upload and download | 16 MiB | `FILE_TOO_LARGE` |
| Downloads per profile | 2 GiB, `--download-quota-bytes` | Stopped and deleted |
| Download entries per profile | 1000, with URLs kept to 2048 characters | New downloads refused |
| Upload inbox per profile | 1 GiB, `--upload-inbox-quota-bytes` | `FILE_TOO_LARGE` |
| `timeout_ms` on any call | 120 s on a server | Lowered to that |
| URL given to `navigate`, `new_tab` | 8192 characters on a server | `INVALID_INPUT` |
| A browser's name lookup | 10 s, after up to 10 s waiting for its turn | The connection fails, and says so |
| A browser's connection through the bridge | 30 s to connect | The connection fails |
| Lines the bridge logs, refused connections among them | 20 per 30 s, each distinct line once per 30 s | Dropped, so a page naming a new host each time can't fill the log |
| Processes in the container | `pids_limit` 4096 in compose | Fork fails. A browser takes a few hundred threads |
| Panel frames | 5 a second, shared between viewers | Reuses the last frame |
| Webhook | 5 s, no redirects, once per handoff | A log line |

`close_profile` goes past the queue, and whoever waited gets `PROFILE_NOT_RUNNING` at once. A client that cancels or disconnects loses its place in line. Retryable errors say so in their `retryable` field, and those with a known wait carry `details.retry_after_ms`.

**Who can hold sockets.** Anyone who reaches the port can hold one with no token, so those are what's limited per address. Past the limit the oldest of them closes, never the new one, and one stops counting at its first valid token. So idle sockets can't keep out someone with a token, even from the same address, which is everyone's behind a NAT or a port Docker publishes on loopback. A client sends its request at once, so only a burst past the limit, from one address, in one moment, could lose its oldest. Behind a proxy all clients are the proxy's one address, so `--trust-proxy` leaves only the overall limit. Keep the port reachable only from that proxy. A token's holder is held to its share of bodies and its sessions, but a download it doesn't read keeps its socket open, up to the 4096: revoke the token.

**A token's bodies.** What counts is what has arrived, as a declared length costs nothing to send. Revoking a token drops what it was still sending. A client slower than about 6 Mbit/s can't get the largest upload through: put the file under `--uploads-root` and name it in `upload_file`, or send less at once.

**Name lookups and `UV_THREADPOOL_SIZE`.** A lookup holds one of Node's pool threads for as long as the resolver takes, and pages choose the names, so a page asking for names nobody answers could otherwise stall the server's file work. `bin/multizen-server.cjs` and the image set the pool to 64, which gives each bridge 8 lookups at a time. On Windows it can only be set before Node starts, so set `UV_THREADPOOL_SIZE=64` there yourself. Unset, the pool is 4, each browser gets two lookups at a time, and the server warns at start. The 10 s is past glibc's resolver retry at 5 s, so a name its second try answers still connects.

## Data layout

Default data directory: `%LOCALAPPDATA%\mzs` on Windows, `~/.local/share/multizen-server` on Linux, `~/.multizen-server` on macOS, `/data` in the container.

```
<data-dir>/
  server.lock            who holds this directory, with a hash of its command line (0600); a second serve or stdio refuses it
  owner-token            the owner's token (0600)
  tokens.json            token hashes and permissions (0600)
  secret.key             the proxy password key, unless MULTIZEN_SECRET_KEY is set
  profiles.db            profiles, in SQLite
  settings.json          optional, yours to write: browserEngine, defaultDisplayMode
  profiles/<id>/
    engines/<engine>/    the browser's own state, per engine
    downloads/           what it downloaded
    uploads/             files upload_file may name; .inbox/ in it holds what came as base64
  extension-store/       extensions of imported profiles
  chromium/cloakbrowser/ the engine; safe to delete, it downloads again
  camoufox/              the same, for Camoufox
  run/                   a journal of running browsers and X servers
```

On Linux and macOS everything under it is private to the server's user: the data directory is made 0700 and the server runs with umask 077, browsers' files included. A directory that already exists keeps its mode, with a warning at start, so run `chmod 700` on it. That goes for a Docker volume from an earlier version too, which stays 755: `docker compose exec multizen chmod 700 /data`. Keep a server to a host with one tenant: other users on it can still read its command lines and reach its loopback ports, each browser's debugging port among them, whatever the file modes say. On Windows modes don't apply: see [Tokens are readable on Windows](#troubleshooting).

`server.lock` holds a SHA-256 of the holder's command line, never the line, which can carry a webhook secret.

A server and a desktop app can't share a directory: each refuses one the other holds. If you move a data directory, rows pointing at the old place are rebased when their directory exists under the new one. Otherwise the start is refused with a list of them, since launching one would open an empty directory, logged out, with no error.

## Upgrade and backup

**Upgrade from source.**

```sh
git pull
corepack yarn install
corepack yarn workspace @multizen/server build
```

**Upgrade in Docker.**

```sh
docker compose build
docker compose up -d
```

Stopping lets the server close its browsers within compose's `stop_grace_period` of 30 s. Browsers it could not close are dealt with at the next start: it keeps a journal, kills only processes whose command line proves they are its own, and clears their locks. Nothing on disk goes. Database changes apply at start and only add. The engine's version is pinned while the server runs: it never updates itself mid-work, so a profile's user agent can't change under it.

**Back up.** Stop the server and copy the data directory, or at least `profiles.db`, `profiles/`, `tokens.json`, `owner-token`, any `settings.json`, and the key. Keep the key apart from the rest if you want the copy to protect the passwords. In Docker:

```sh
docker compose stop
docker compose run --rm -T --no-deps --entrypoint tar multizen czf - --exclude=./chromium --exclude=./camoufox -C /data . > multizen-data.tar.gz
docker compose start
```

To copy single profiles while keeping the server's other data, use `profile export`.

## Engine pins

A server installs only the CloakBrowser build pinned in `packages/browser-runtime/src/ChromiumBootstrap.ts`, with its SHA-256, and refuses anything else: 146.0.7680.177.5 on Windows x64 and Linux x64, 145.0.7632.109.2 on macOS. Each hash was computed from the asset itself and matched its release's `SHA256SUMS`, whose signature wasn't checked. A corrupted download fails with `checksum mismatch` and leaves nothing installed. An engine in the data directory that isn't the pin, such as one from a desktop's unpinned install, is downloaded over.

**linux-arm64 fails closed.** That release has no such asset, so there is no hash, and a server there refuses to install CloakBrowser, with a message that says so. Camoufox has a pin for that platform. Neither ran on arm64 here.

To bump a pin:

1. Download each platform's asset from the new tag's release, for real.
2. Compute each one's SHA-256, and compare it with that release's `SHA256SUMS`. Both must agree.
3. Change `CLOAKBROWSER_PINS` and `CLOAKBROWSER_PIN_SHA256` together, with the date and source in the comment above them.
4. Run `security-live.ts --only corrupt`, and `e2e.ts` on the new engine.

A bump changes every profile's user agent at its next launch, which is why a running server never does it by itself. Anything that links an engine in, as the scripts below do, has to write the pin's `sha256` to `current.json`, or the server downloads over the link. Camoufox has a pin of its own, in `CamoufoxBootstrap.ts`, with its conditions in the comment there.

## Checking it yourself

`corepack yarn typecheck && corepack yarn test:unit` is the gate. CI also has a Windows job for it, added with this work and never yet run: it can't be run from a working tree here, so its first run will be on a push.

The rest run real browsers, so they aren't in the gate. Build first (`corepack yarn workspace @multizen/server build`), then each is `corepack yarn workspace @multizen/server exec tsx scripts/<name>`, and its header gives its flags:

| Script | What it checks |
| --- | --- |
| `e2e.ts` | Everything an agent does, from a real SDK client, in flows: `http`, `sigint`, `stdio`, `tabs`, `concurrency`, `display`, `auth`, `reaper`, `relay` |
| `egress-live.ts` | The egress policy, against listeners that count who reaches them, each row with a control |
| `security-live.ts` | What keeps a hostile page, token or file from hurting the server: `downloads`, `uploads`, `navigate`, `modes`, `sessions`, `proxy`, `archive`, `warnings`, `corrupt`, and with no browser the attacks on the port, `bodies` and `sockets`. Its `dns` flow only runs when named, where `/etc/resolv.conf` points at a host that drops UDP port 53 |
| `acceptance/*` | The rest of the acceptance matrix: see [its README](scripts/acceptance/README.md) |

Results and what wasn't run: [`docs/server-acceptance.md`](../../docs/server-acceptance.md).

## Troubleshooting

**`SANDBOX_UNAVAILABLE`.** Chromium's namespace sandbox couldn't start, and a server never falls back to `--no-sandbox`. In order of likelihood:

1. In Docker, the seccomp profile is missing: Docker's default blocks the user namespaces the sandbox needs. Use `docker-compose.yml`, or `--security-opt seccomp=docker/seccomp-chromium.json`. `seccomp=unconfined` also works, and is weaker.
2. Running as root. Chromium refuses to start its sandbox as root, so this server refuses to start at all. The image runs as `node`.
3. **AppArmor** on the host (Ubuntu 23.10 and later) restricts unprivileged user namespaces. Run `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`, or install a per-binary AppArmor profile for the engine binary. These steps come from the kernel's and Ubuntu's documentation, and have not been tried on such a host.
4. Other kernels: `sudo sysctl -w kernel.unprivileged_userns_clone=1`.

At start the server probes for this and warns, since a per-binary AppArmor profile can let the engine through while the probe stays denied. The error's own hint names what applies to this host. Camoufox needs none of this.

**`ENGINE_NOT_READY`.** The engine is still downloading, in the background from the first start. It is retryable, and `details.retry_after_ms` says when: `engine status` lines in the log and `/readyz` show the progress. Camoufox downloads when a profile first asks for it, unless it is the default. A download that keeps failing shows as `status: error` in the same log lines, usually a network or GitHub rate-limit problem.

**The browser never answers at launch, or `LAUNCH_FAILED` with nothing useful.** On Windows, look for the long-path warning in the log first. Chromium with a long `--user-data-dir` fails silently: the process runs and the debugging port never opens. A profile's browser directory adds 67 characters to the data directory's path, and 120 in total is known to be safe. Use a short `--data-dir`, as the default is on purpose. On Linux, a missing library shows in the error, from the browser's stderr.

**Local connections time out by themselves on Windows.** A launch fails with `CDP /json/version not ready`, or a client with `ETIMEDOUT` on `127.0.0.1`. One machine did this with several VPN tunnel adapters up: a plain Node client and listener, with nothing of ours involved, got `ETIMEDOUT` at about 310 ms on 1% of connects and up to 94% in its worst burst, `::1` always gave `EACCES`, and some ports stayed unreachable for seconds. The cause wasn't established, since nothing was turned off to find it. A retry gets another port, so launch again. To tell it apart from a real failure, turn the VPNs off and run `corepack yarn test:unit` again.

**Windows Firewall asks about Node** the first time you bind beyond loopback. Windows does this for any program listening on a network address. Until someone answers, the bind works and connections from elsewhere don't. An unattended machine needs an inbound rule for that port. Loopback never asks.

**Ctrl+C does nothing in Git Bash.** A process started from Git Bash inherits Ctrl+C disabled on Windows, and nothing below it can undo that. Start the server from PowerShell or cmd, where Ctrl+C and Ctrl+Break both stop it cleanly. If it is already running, `taskkill /PID <pid> /T /F` works from any shell, and the next start cleans up.

**`EGRESS_BLOCKED` on a page you meant to load.** That is the policy, and retrying won't change it. Add the host with `--egress-allow`, as you need to for any test page on this machine, with its port for anything on loopback.

**`RATE_LIMITED`, 503.** Request bodies in flight have reached 128 MiB, or this token's 32 MiB, as they do with several large uploads at once. Wait for `Retry-After` and send it again. The 429 kind is failed logins.

**`TIMEOUT`, 408, on a large upload.** Its body didn't arrive within 30 s. On a slow link, put the file under `--uploads-root` and name it in `upload_file`, or send less at once.

**"UV_THREADPOOL_SIZE isn't set".** On Windows, set it to 64 before starting Node. Elsewhere you started `dist/cli.js` directly, not `bin/multizen-server.cjs`.

**A warning that the data directory is open to group or others.** It was made before this version, or by something else. Run `chmod 700` on it, in Docker on `/data`.

**`HUMAN_IN_CONTROL` and nobody knows why.** A handoff is pending: see the panel. It expires by itself after 15 minutes.

**`INPUT_NOT_DELIVERED`.** The page dropped the input, which a page that is hidden and has never painted does. `activate_tab` it, or raise the window. On a server this should only come from a background tab, because occlusion tracking is off. Camoufox has no such check, and a `TIMEOUT` says the same there.

**`DISPLAY_UNAVAILABLE`.** `headed` with no display, or `xvfb` off Linux or without Xvfb installed. Use `headless`.

**"The data directory is in use by another MultiZen server".** A second `serve`, or a `stdio` on the same directory. The message names the holder. For `stdio`, it gives the `--connect` line to use.

**"can't run programs".** The data volume is mounted `noexec`. The engines live there, so remount it without, or point `--data-dir` elsewhere.

**Tokens are readable on Windows.** File modes don't apply there, so `owner-token`, `tokens.json` and `secret.key` rely on the directory's ACL. The log warns. The default under `%LOCALAPPDATA%` is per-user. A directory you choose elsewhere may not be.

## Engine licences

CloakBrowser is CloakHQ's, and their licence forbids redistributing the binary and needs an OEM or SaaS licence for anything offered to third parties. So the image holds no engine, and each install downloads it from CloakHQ's official channel. Use this server for your own agents on your own infrastructure. Camoufox is downloaded the same way. Both install only a pinned version verified by SHA-256: see [Engine pins](#engine-pins).
