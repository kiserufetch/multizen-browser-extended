# multizen-server

The same MCP server and the same browser drivers as the MultiZen desktop app, with no Electron and no GUI. Run it on a Linux box, in Docker, or on Windows, and point your agents at it over HTTP or stdio. CloakBrowser and Camoufox both work, in a window, under Xvfb, or headless.

What you get on top of the desktop's tool set:

- **Display modes.** `headed`, `xvfb` and `headless`, per server, per profile or per launch.
- **Handoff over the network.** When an agent hits a CAPTCHA or a 2FA prompt, a person takes over in a web panel served by the same port, and the agent's page actions wait.
- **Named tokens with permissions.** Each token carries tool groups and a list of profiles. Revoking one stops it within a second.
- **An egress policy.** Browsers stay off private addresses, this machine's ports and cloud metadata, down to the connection level.
- **Encrypted proxy passwords**, a browser limit, session limits, a crash reaper, and a Docker image that runs as non-root with the Chromium sandbox on and no way to turn it off.

The desktop app is unchanged by all of this. See [Acceptable use](../../README.md#acceptable-use) and [the licence note](#engine-licences) before you run it for anyone but yourself.

## Quickstart

### From source

Needs Node 22 or newer and Corepack.

```sh
git clone https://github.com/kiserufetch/multizen-browser-extended
cd multizen-browser-extended
corepack yarn install
corepack yarn workspace @multizen/server build
node apps/server/bin/multizen-server.js serve --headless
```

The first start downloads CloakBrowser into the data directory (`engine status` lines in the log show the progress) and writes the owner token. It listens on `http://127.0.0.1:7777/mcp`. In another shell, read the token:

```sh
# Windows (PowerShell)
Get-Content "$env:LOCALAPPDATA\mzs\owner-token"
# Linux
cat ~/.local/share/multizen-server/owner-token
# macOS
cat ~/.multizen-server/owner-token
```

Then connect any MCP client with it, as in the [root README](../../README.md#connect-an-agent-codex-cursor-claude-desktop):

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
node apps/server/bin/multizen-server.js stdio --connect http://127.0.0.1:7777/mcp --token-file <path to owner-token>
```

Without `--headless` you get a real window on Windows and macOS, and on Linux whatever [`auto`](#display-modes) picks.

### Docker

```sh
docker compose up -d
docker compose logs -f multizen    # wait for "listening"; the engine downloads into the volume
docker compose exec multizen cat /data/owner-token
```

The compose file builds `multizen-server:local` and publishes port 7777 on the host's loopback only (`MULTIZEN_HOST_PORT` picks another host port). It runs as user `node` with every capability dropped, applies `docker/seccomp-chromium.json`, and keeps everything in the `multizen-data` volume. The image holds no browser engine: see [Engine licences](#engine-licences).

To load local pages for a test, add exceptions to the policy in the service's `environment`:

```yaml
MULTIZEN_EGRESS_ALLOW: "127.0.0.1,localhost"
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

Leave out the seccomp option and every CloakBrowser launch fails with `SANDBOX_UNAVAILABLE`, by design.

## Commands

Everything below is `multizen-server <command>`: from source that is `node apps/server/bin/multizen-server.js`, in the container `docker compose exec multizen node /app/dist/cli.js`. Exit codes: 0 for a clean stop, 1 for a failed start, 2 for bad flags. Logs are JSON lines on stdout, and on stderr for `stdio` and `token`, whose stdout is their result.

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
| `--trust-proxy` | `MULTIZEN_TRUST_PROXY` | off | Failed logins count against `X-Forwarded-For`'s rightmost hop. |
| `--session-idle-ttl-ms` | `MULTIZEN_SESSION_IDLE_TTL_MS` | `1800000` | An MCP session with no request and no call in flight for this long is closed. |
| `--max-sessions` | `MULTIZEN_MAX_SESSIONS` | `64` | Past this a new session gets `SESSION_LIMIT`. |
| `--egress-policy` | `MULTIZEN_EGRESS_POLICY` | `block-private` | `block-private` or `allow-all`. See [Egress policy](#egress-policy). |
| `--egress-allow` | `MULTIZEN_EGRESS_ALLOW` | | Exceptions, comma-separated: an IP, a CIDR, a name or `*.suffix`, each with an optional `:port`. |
| `--uploads-root` | `MULTIZEN_UPLOADS_ROOT` | | A directory `upload_file` may read from, besides each profile's own. |
| `--download-quota-bytes` | `MULTIZEN_DOWNLOAD_QUOTA_BYTES` | 2 GiB | What one profile's downloads may take. |
| `--handoff-webhook` | `MULTIZEN_HANDOFF_WEBHOOK` | | Your endpoint, told about each new handoff. |
| `--handoff-webhook-secret` | `MULTIZEN_HANDOFF_WEBHOOK_SECRET` | | Signs its body. Prefer the variable: a command line is readable by others. |
| `--handoff-ttl-ms` | `MULTIZEN_HANDOFF_TTL_MS` | `900000` | How long a handoff waits for a person. |

`MULTIZEN_DEBUG=1` adds the driver's own log lines.

### `stdio`

```sh
multizen-server stdio [--data-dir <dir>] [--default-engine ...] [--uploads-root <dir>]
                      [--max-browsers <n>] [--browser-queue-timeout-ms <ms>]
                      [--display-mode ...] [--headless] [--egress-policy ...] [--egress-allow ...]
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

The same encrypted `.mzar` archive the desktop app uses, which is how a profile moves between the two. The passphrase comes from a file or `MULTIZEN_ARCHIVE_PASSPHRASE`, never a flag. Both hold the data directory's lock, so stop the server first. Extensions in an imported profile load. There is no other extension management on a server, and the desktop's companion extension isn't loaded.

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

On Linux, prefer `xvfb`: the measurements in `docs/detection-baselines/README.md` show headless there to be worse, with another WebGL extension set and extra CreepJS flags on CloakBrowser, and no WebGL at all on Camoufox. On Windows the two are nearly the same, and a covered window is handled: Chromium's and Firefox's occlusion tracking are off, so a page under another window keeps painting and taking input.

## Tokens and tool groups

`serve` won't start with no usable token. The first start creates the owner's, with every group, in `<data-dir>/owner-token` (mode 0600), and logs only its path. Tokens look like `mz_t_<id>_<secret>`. Only their hashes are stored, in `<data-dir>/tokens.json`.

`token create` gives `read` and `act` unless `--tools` says otherwise, and `--tools` takes groups, single tool names, or both.

| Group | Tools |
| --- | --- |
| `read` | `list_profiles`, `extract`, `screenshot`, `list_tabs`, `get_human_status`, `list_downloads`, `list_dialogs`, `list_fingerprint_options`, `probe_fingerprint` |
| `act` | `navigate`, `click`, `type`, `click_ref`, `type_ref`, `press_key`, `hover`, `select_option`, `scroll`, `upload_file`, `get_download`, `handle_dialog`, `set_dialog_policy`, `evaluate_js`, `wait_for_selector`, `wait_for_navigation`, `wait_for_load`, `get_cookies`, `set_cookies`, `new_tab`, `activate_tab`, `close_tab`, `launch_profile`, `close_profile`, `request_human`, `wait_for_human`, `acquire_profile`, `renew_profile`, `release_profile` |
| `profile-admin` | `create_profile`, `update_profile`, `delete_profile` |
| `raw` | `cdp_send`, `cdp_send_no_safety` |
| `operator` | `resume_human`, the handoff panel, and force-releasing another token's lease |

- `tools/list` shows a token what it may use, and anything else is `FORBIDDEN`. A tool in no group is refused for everyone.
- `--profiles` limits a token to those ids: `list_profiles` shows only them, and a call on any other is `FORBIDDEN`. Such a token can't `create_profile`, whose result no list could already name.
- `--panel` is short for adding `operator`.
- Without `raw`, `launch_profile` leaves out `cdpEndpoint` and `pid`.
- `raw` defeats the egress policy and the upload rules. Think of it as the keys to the machine's network. See [Egress policy](#egress-policy).
- A revoke from another process takes effect within a second: the next request is refused, the token's sessions and streams close, and its queued calls and leases go.
- A session belongs to the token that opened it. Another token on it gets 403, on `/mcp` and on `/messages`.
- Ten failed logins a minute from one address get 429 with `Retry-After`.
- The activity log and the logs carry the token's name, and never the arguments, page contents or cookies of a call.

Agents share a profile by default. Tool calls on a profile run one at a time in arrival order, across sessions. For exclusive use, `acquire_profile` gives a lease: others can still read but get `PROFILE_LEASED` on anything that changes the profile. A lease survives a dropped connection until its TTL (reattach with its `lease_id`).

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

`--trust-proxy` is only for a proxy of yours that sets that header: anyone reaching the port directly could otherwise fake their address and dodge the login limit. The live check here used a plain HTTP hop of the same shape, not nginx itself.

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

`--egress-policy allow-all` turns the policy off, with a warning in the log, and browsers then run with no bridge.

What it doesn't do:

- **The `raw` group defeats it.** `cdp_send` and `cdp_send_no_safety` aren't gated: `Target.createBrowserContext` with `proxyServer: "direct://"` was measured reaching a private address on CloakBrowser through both tools. `token create` doesn't give `raw` unless asked, so don't ask for anything you are using this policy against.
- **A proxy's own network is out of scope.** A proxied profile's names resolve at the proxy, and what it can reach from there is its business.
- **`new_tab` checks the URL it was given.** A redirect after that shows as an error page in the tab, not as an error from the tool. `navigate` does report it.
- **A QUIC connection from `Alt-Svc` wasn't exercised**, because it needs a trusted certificate. WebTransport was, and browsers on the bridge don't use QUIC.

What it costs in detectability is measured in `docs/detection-baselines/README.md`: on the bridge, CloakBrowser reports `connection.rtt` 0 and `downlink` 10, as every proxied profile on the desktop already does, and Camoufox has no `RTCPeerConnection` at all.

## Secret key

Proxy passwords are stored encrypted with AES-256-GCM. The key is `MULTIZEN_SECRET_KEY` (32 bytes, hex or base64), or else `<data-dir>/secret.key`, which is created if neither exists and nothing is encrypted yet.

- At start, any plaintext passwords get encrypted, and the old bytes are purged from the WAL and free pages.
- Encrypted passwords with no key to open them refuse the start, with a message that says so.
- The variable is removed from the environment once read, so browsers don't inherit it.
- A key file on the same volume as the database means a copy of that volume holds both. The log warns about it. Keep the key elsewhere with the variable, or by making the file a link to another volume.

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

The panel lists pending handoffs and, for the one selected, shows the active tab live at up to 5 frames a second. It passes on mouse, wheel and keyboard, has a text box for pasted and composed text, and switches tabs (a popup is one more tab). It answers JavaScript dialogs and file pickers. Resume or Abort ends the handoff, and records who did it.

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

That route answers with `attachment`, `nosniff` and a sandbox CSP, and takes only a bearer token with `get_download` and that profile in scope. Past `--download-quota-bytes` a download is stopped and deleted.

**Uploads** through `upload_file` are either base64 in the call (16 MiB in total) or a `file_name` relative to `<profile>/uploads` or `--uploads-root`. Any other host path gets `FILE_NOT_ALLOWED`. So do symlinks leading out and, on Windows, UNC paths, alternate data streams and reserved names. Too much base64 gets `FILE_TOO_LARGE`.

Both directories stay out of `.mzar` archives.

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
| Failed logins | 10 a minute per address | 429 with `Retry-After` |
| Request body | 22 MiB | 413 `FILE_TOO_LARGE` |
| Inline upload and download | 16 MiB | `FILE_TOO_LARGE` |
| Downloads per profile | 2 GiB, `--download-quota-bytes` | Stopped and deleted |
| Panel frames | 5 a second, shared between viewers | Reuses the last frame |
| Webhook | 5 s, no redirects, once per handoff | A log line |

`close_profile` goes past the queue, and whoever waited gets `PROFILE_NOT_RUNNING` at once. A client that cancels or disconnects loses its place in line. Retryable errors say so in their `retryable` field, and those with a known wait carry `details.retry_after_ms`.

## Data layout

Default data directory: `%LOCALAPPDATA%\mzs` on Windows, `~/.local/share/multizen-server` on Linux, `~/.multizen-server` on macOS, `/data` in the container.

```
<data-dir>/
  server.lock            who holds this directory; a second serve or stdio refuses it
  owner-token            the owner's token (0600)
  tokens.json            token hashes and permissions (0600)
  secret.key             the proxy password key, unless MULTIZEN_SECRET_KEY is set
  profiles.db            profiles, in SQLite
  settings.json          optional, yours to write: browserEngine, defaultDisplayMode
  profiles/<id>/
    engines/<engine>/    the browser's own state, per engine
    downloads/           what it downloaded
    uploads/             files upload_file may name
  extension-store/       extensions of imported profiles
  chromium/cloakbrowser/ the engine; safe to delete, it downloads again
  camoufox/              the same, for Camoufox
  run/                   a journal of running browsers and X servers
```

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

## Troubleshooting

**`SANDBOX_UNAVAILABLE`.** Chromium's namespace sandbox couldn't start, and a server never falls back to `--no-sandbox`. In order of likelihood:

1. In Docker, the seccomp profile is missing: Docker's default blocks the user namespaces the sandbox needs. Use `docker-compose.yml`, or `--security-opt seccomp=docker/seccomp-chromium.json`. `seccomp=unconfined` also works, and is weaker.
2. Running as root. Chromium refuses to start its sandbox as root, so this server refuses to start at all. The image runs as `node`.
3. **AppArmor** on the host (Ubuntu 23.10 and later) restricts unprivileged user namespaces. Run `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`, or install a per-binary AppArmor profile for the engine binary. These steps come from the kernel's and Ubuntu's documentation, and have not been tried on such a host.
4. Other kernels: `sudo sysctl -w kernel.unprivileged_userns_clone=1`.

At start the server probes for this and warns, since a per-binary AppArmor profile can let the engine through while the probe stays denied. The error's own hint names what applies to this host. Camoufox needs none of this.

**`ENGINE_NOT_READY`.** The engine is still downloading, in the background from the first start. It is retryable, and `details.retry_after_ms` says when: `engine status` lines in the log and `/readyz` show the progress. Camoufox downloads when a profile first asks for it, unless it is the default. A download that keeps failing shows as `status: error` in the same log lines, usually a network or GitHub rate-limit problem.

**The browser never answers at launch, or `LAUNCH_FAILED` with nothing useful.** On Windows, look for the long-path warning in the log first. Chromium with a long `--user-data-dir` fails silently: the process runs and the debugging port never opens. A profile's browser directory adds 67 characters to the data directory's path, and 120 in total is known to be safe. Use a short `--data-dir`, as the default is on purpose. On Linux, a missing library shows in the error, from the browser's stderr.

**Local connections time out by themselves on Windows.** A launch fails with `CDP /json/version not ready`, or a client with `ETIMEDOUT` on `127.0.0.1`. One machine here did this with a TUN VPN and a busy torrent client running: a plain Node client and listener, with nothing of ours involved, failed about 1% of connects, and some ports stayed unreachable for seconds. The cause wasn't established. A retry gets another port, so launch again.

**Windows Firewall asks about Node** the first time you bind beyond loopback. Windows does this for any program listening on a network address. Until someone answers, the bind works and connections from elsewhere don't. An unattended machine needs an inbound rule for that port. Loopback never asks.

**Ctrl+C does nothing in Git Bash.** A process started from Git Bash inherits Ctrl+C disabled on Windows, and nothing below it can undo that. Start the server from PowerShell or cmd, where Ctrl+C and Ctrl+Break both stop it cleanly. If it is already running, `taskkill /PID <pid> /T /F` works from any shell, and the next start cleans up.

**`EGRESS_BLOCKED` on a page you meant to load.** That is the policy, and retrying won't change it. Add the host with `--egress-allow`, as you need to for any test page on this machine.

**`HUMAN_IN_CONTROL` and nobody knows why.** A handoff is pending: see the panel. It expires by itself after 15 minutes.

**`INPUT_NOT_DELIVERED`.** The page dropped the input, which a page that is hidden and has never painted does. `activate_tab` it, or raise the window. On a server this should only come from a background tab, because occlusion tracking is off. Camoufox has no such check, and a `TIMEOUT` says the same there.

**`DISPLAY_UNAVAILABLE`.** `headed` with no display, or `xvfb` off Linux or without Xvfb installed. Use `headless`.

**"The data directory is in use by another MultiZen server".** A second `serve`, or a `stdio` on the same directory. The message names the holder. For `stdio`, it gives the `--connect` line to use.

**"can't run programs".** The data volume is mounted `noexec`. The engines live there, so remount it without, or point `--data-dir` elsewhere.

**Tokens are readable on Windows.** File modes don't apply there, so `owner-token`, `tokens.json` and `secret.key` rely on the directory's ACL. The log warns. The default under `%LOCALAPPDATA%` is per-user. A directory you choose elsewhere may not be.

## Engine licences

CloakBrowser is CloakHQ's, and their licence forbids redistributing the binary and needs an OEM or SaaS licence for anything offered to third parties. So the image holds no engine, and each install downloads it from CloakHQ's official channel. Use this server for your own agents on your own infrastructure. Camoufox is downloaded the same way, at a pinned version verified by SHA-256.
