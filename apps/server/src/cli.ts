import { errorFields, installLogging, log } from "./log.ts";

// Everything under a data dir is private to this user, browsers' files included: tokens, keys,
// cookies. Before anything can create a file. A no-op on Windows, which has the directory's ACL.
process.umask(0o077);

const USAGE = `multizen-server: MultiZen's MCP server with real browsers, no desktop app.

Usage:
  multizen-server serve [--host 127.0.0.1] [--port 7777] [--data-dir <dir>]
                        [--default-engine cloakbrowser|camoufox] [--no-auth] [--uploads-root <dir>]
                        [--max-browsers <n>] [--browser-queue-timeout-ms <ms>]
                        [--display-mode auto|headed|xvfb|headless] [--headless]
                        [--allow-remote] [--allow-insecure-remote] [--tls-cert <file> --tls-key <file>]
                        [--allowed-hosts <name[:port],...>] [--allowed-origins <origin,...>]
                        [--public-url <url>] [--trust-proxy]
                        [--session-idle-ttl-ms <ms>] [--max-sessions <n>] [--max-sessions-per-token <n>]
                        [--lease-on-session-close keep|release]
                        [--egress-policy block-private|allow-all] [--egress-allow <entry,...>]
                        [--handoff-webhook <url>] [--handoff-webhook-secret <secret>]
                        [--handoff-ttl-ms <ms>] [--download-quota-bytes <n>] [--upload-inbox-quota-bytes <n>]
  multizen-server stdio [--data-dir <dir>] [--default-engine cloakbrowser|camoufox]
                        [--uploads-root <dir>] [--max-browsers <n>] [--browser-queue-timeout-ms <ms>]
                        [--display-mode auto|headed|xvfb|headless] [--headless]
                        [--egress-policy block-private|allow-all] [--egress-allow <entry,...>]
  multizen-server stdio --connect <url> [--token-file <path>] [--keepalive-ms <ms>]
  multizen-server profile export <profile-id> [--out <file.mzar>] [--passphrase-file <path>] [--data-dir <dir>]
  multizen-server profile import <file.mzar> [--passphrase-file <path>] [--data-dir <dir>]
                        [--default-engine cloakbrowser|camoufox]
  multizen-server token create --name <name> [--tools <groups or tool names>] [--profiles <ids|*>]
                        [--panel] [--expires <30d|12h|date>] [--data-dir <dir>]
  multizen-server token list [--data-dir <dir>]
  multizen-server token revoke <id or name> [--data-dir <dir>]
  multizen-server secrets rotate [--data-dir <dir>]

Environment: MULTIZEN_DATA_DIR, MULTIZEN_HOST, MULTIZEN_PORT, MULTIZEN_DEFAULT_ENGINE,
MULTIZEN_NO_AUTH=1, MULTIZEN_UPLOADS_ROOT, MULTIZEN_MAX_BROWSERS,
MULTIZEN_BROWSER_QUEUE_TIMEOUT_MS, MULTIZEN_DISPLAY_MODE, MULTIZEN_HEADLESS=1,
MULTIZEN_ARCHIVE_PASSPHRASE, MULTIZEN_ALLOW_REMOTE=1,
MULTIZEN_ALLOW_INSECURE_REMOTE=1, MULTIZEN_TLS_CERT, MULTIZEN_TLS_KEY, MULTIZEN_ALLOWED_HOSTS,
MULTIZEN_ALLOWED_ORIGINS, MULTIZEN_PUBLIC_URL, MULTIZEN_TRUST_PROXY=1,
MULTIZEN_SESSION_IDLE_TTL_MS, MULTIZEN_MAX_SESSIONS, MULTIZEN_MAX_SESSIONS_PER_TOKEN,
MULTIZEN_LEASE_ON_SESSION_CLOSE, MULTIZEN_UPLOAD_INBOX_QUOTA_BYTES,
MULTIZEN_LOG_LEVEL (debug, info, warn, error; default info), MULTIZEN_SECRET_KEY,
MULTIZEN_SECRET_KEY_NEW (secrets rotate only), MULTIZEN_EGRESS_POLICY, MULTIZEN_EGRESS_ALLOW,
MULTIZEN_HANDOFF_WEBHOOK, MULTIZEN_HANDOFF_WEBHOOK_SECRET, MULTIZEN_HANDOFF_TTL_MS,
MULTIZEN_DOWNLOAD_QUOTA_BYTES.

--max-browsers counts both engines and defaults to what the machine's memory allows.

--lease-on-session-close keep, the default, lets a lease run on its TTL when its session ends, so a
client coming back reattaches with its lease_id. release drops the session's leases with it.

--display-mode is the mode when a launch and its profile name none: auto takes xvfb on Linux with no
DISPLAY if Xvfb is installed, headless if not, and headed elsewhere. --headless allows no windows at
all: a profile saved as headed runs headless, and naming another mode is INVALID_INPUT.

Full documentation: apps/server/README.md.

stdio --connect pings the server every --keepalive-ms (30000), which keeps its session from idling
out. Below a server's --session-idle-ttl-ms is what it takes. When the session is gone anyway, because
the server restarted or the token was revoked, it says so on stderr and exits 1: restart it.

--max-sessions-per-token (32) keeps one token from taking all of --max-sessions (64): past it, that
token's own oldest idle session is closed for the new one.

--host beyond loopback needs --allow-remote, and TLS or --allow-insecure-remote. Behind a
reverse proxy, stay on loopback and name the proxy's host with --allowed-hosts or --public-url.
Without --no-auth (loopback only) serve needs a token: the first start creates the owner's in
<data-dir>/owner-token, which can do everything, so it isn't for agents: connect those with one from
token create, whose default tools are read and act, and --panel adds operator.

--egress-policy block-private, the default, keeps browsers off private, loopback, link-local and
metadata addresses, at their network level and with EGRESS_BLOCKED from navigate, new_tab and a proxy
pointing at one. --egress-allow names exceptions: an IP, a CIDR, a name or *.suffix, each with an
optional :port. A token with the raw group can defeat this policy: cdp_send can open a browser
context with its own proxy. Don't give raw to anything you are using this policy against.

When an agent calls request_human, a person takes over at <server>/panel, signing in with a token
that holds the operator group: they see the page, type into it and answer its dialogs, then press
Resume or Abort. Until then the agent's page actions get HUMAN_IN_CONTROL. A handoff expires after
15 minutes unless --handoff-ttl-ms says otherwise. --handoff-webhook is told about each new one, by a
POST of JSON, with an HMAC of the body in X-MultiZen-Signature if a secret is set (prefer
MULTIZEN_HANDOFF_WEBHOOK_SECRET: the command line is readable by others). A failure only costs a log
line. A profile's downloads may take 2 GB unless --download-quota-bytes says otherwise; past that the
download is stopped and deleted, and delete_download gives back what one took. One too large for
get_download is at the path its error names, with the same token. Base64 uploads stay until the
profile closes and may take 1 GB unless --upload-inbox-quota-bytes says otherwise.

Proxy passwords are encrypted with MULTIZEN_SECRET_KEY (hex or base64, 32 bytes) or
<data-dir>/secret.key, which is created if neither exists.

Logs are JSON lines on stdout (on stderr for stdio, whose stdout carries the protocol, and for
token, whose stdout is its result).
`;

const EXIT_USAGE = 2;

const [command, ...args] = process.argv.slice(2);

if (command === undefined || command === "--help" || command === "-h") {
  process.stdout.write(USAGE);
  process.exitCode = command === undefined ? EXIT_USAGE : 0;
} else {
  // Before anything else loads: everything below is imported dynamically so the
  // rebinding is in place by the time their module bodies run.
  installLogging(command === "stdio" || command === "token" ? "stderr" : "stdout");
  await main(command, args);
}

async function main(name: string, rest: string[]): Promise<void> {
  const { ShutdownManager } = await import("./shutdown.ts");
  const shutdown = new ShutdownManager();
  shutdown.installProcessHandlers();

  const {
    parseProfileCommand,
    parseSecretsCommand,
    parseServeConfig,
    parseStdioConfig,
    parseTokenCommand,
    UsageError,
  } = await import("./config.ts");
  try {
    if (name === "serve") {
      const { runServe } = await import("./commands/serve.ts");
      await runServe(parseServeConfig(rest), shutdown);
    } else if (name === "stdio") {
      const { runStdio } = await import("./commands/stdio.ts");
      await runStdio(parseStdioConfig(rest), shutdown);
    } else if (name === "profile") {
      const { runProfile } = await import("./commands/profile.ts");
      await runProfile(parseProfileCommand(rest), shutdown);
      await shutdown.run("done", 0);
    } else if (name === "token") {
      const { runToken } = await import("./commands/token.ts");
      runToken(parseTokenCommand(rest));
      await shutdown.run("done", 0);
    } else if (name === "secrets") {
      const { runSecrets } = await import("./commands/secrets.ts");
      await runSecrets(parseSecretsCommand(rest), shutdown);
      await shutdown.run("done", 0);
    } else {
      throw new UsageError(`Unknown command "${name}". Run multizen-server --help.`);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      log.error(e.message);
      await shutdown.run("bad-usage", EXIT_USAGE);
      return;
    }
    log.error(e instanceof Error ? e.message : String(e), errorFields(e));
    await shutdown.run("start-failed", 1);
  }
}
