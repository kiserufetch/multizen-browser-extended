import { errorFields, installLogging, log } from "./log.ts";

const USAGE = `multizen-server: MultiZen's MCP server with real browsers, no desktop app.

Usage:
  multizen-server serve [--host 127.0.0.1] [--port 7777] [--data-dir <dir>]
                        [--default-engine cloakbrowser|camoufox] [--no-auth] [--uploads-root <dir>]
                        [--max-browsers <n>] [--browser-queue-timeout-ms <ms>]
                        [--allow-remote] [--allow-insecure-remote] [--tls-cert <file> --tls-key <file>]
                        [--allowed-hosts <name[:port],...>] [--allowed-origins <origin,...>]
                        [--public-url <url>] [--trust-proxy]
                        [--session-idle-ttl-ms <ms>] [--max-sessions <n>]
  multizen-server stdio [--data-dir <dir>] [--default-engine cloakbrowser|camoufox]
                        [--uploads-root <dir>] [--max-browsers <n>] [--browser-queue-timeout-ms <ms>]
  multizen-server stdio --connect <url> [--token-file <path>]
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
MULTIZEN_BROWSER_QUEUE_TIMEOUT_MS, MULTIZEN_ARCHIVE_PASSPHRASE, MULTIZEN_ALLOW_REMOTE=1,
MULTIZEN_ALLOW_INSECURE_REMOTE=1, MULTIZEN_TLS_CERT, MULTIZEN_TLS_KEY, MULTIZEN_ALLOWED_HOSTS,
MULTIZEN_ALLOWED_ORIGINS, MULTIZEN_PUBLIC_URL, MULTIZEN_TRUST_PROXY=1,
MULTIZEN_SESSION_IDLE_TTL_MS, MULTIZEN_MAX_SESSIONS, MULTIZEN_SECRET_KEY,
MULTIZEN_SECRET_KEY_NEW (secrets rotate only).

--max-browsers counts both engines and defaults to what the machine's memory allows.

--host beyond loopback needs --allow-remote, and TLS or --allow-insecure-remote. Behind a
reverse proxy, stay on loopback and name the proxy's host with --allowed-hosts or --public-url.
Without --no-auth (loopback only) serve needs a token: the first start creates the owner's in
<data-dir>/owner-token. token create's default tools are read and act, and --panel adds operator.

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
