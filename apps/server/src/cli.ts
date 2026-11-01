import { errorFields, installLogging, log } from "./log.ts";

const USAGE = `multizen-server: MultiZen's MCP server with real browsers, no desktop app.

Usage:
  multizen-server serve [--host 127.0.0.1] [--port 7777] [--data-dir <dir>]
                        [--default-engine cloakbrowser|camoufox] [--no-auth] [--uploads-root <dir>]
                        [--max-browsers <n>] [--browser-queue-timeout-ms <ms>]
  multizen-server stdio [--data-dir <dir>] [--default-engine cloakbrowser|camoufox]
                        [--uploads-root <dir>] [--max-browsers <n>] [--browser-queue-timeout-ms <ms>]
  multizen-server stdio --connect <url> [--token-file <path>]
  multizen-server profile export <profile-id> [--out <file.mzar>] [--passphrase-file <path>] [--data-dir <dir>]
  multizen-server profile import <file.mzar> [--passphrase-file <path>] [--data-dir <dir>]
                        [--default-engine cloakbrowser|camoufox]

Environment: MULTIZEN_DATA_DIR, MULTIZEN_HOST, MULTIZEN_PORT, MULTIZEN_DEFAULT_ENGINE,
MULTIZEN_NO_AUTH=1, MULTIZEN_UPLOADS_ROOT, MULTIZEN_MAX_BROWSERS,
MULTIZEN_BROWSER_QUEUE_TIMEOUT_MS, MULTIZEN_ARCHIVE_PASSPHRASE.

--max-browsers counts both engines and defaults to what the machine's memory allows.

Logs are JSON lines on stdout (on stderr for stdio, whose stdout carries the protocol).
serve keeps its bearer token in <data-dir>/owner-token.
`;

const EXIT_USAGE = 2;

const [command, ...args] = process.argv.slice(2);

if (command === undefined || command === "--help" || command === "-h") {
  process.stdout.write(USAGE);
  process.exitCode = command === undefined ? EXIT_USAGE : 0;
} else {
  // Before anything else loads: everything below is imported dynamically so the
  // rebinding is in place by the time their module bodies run.
  installLogging(command === "stdio" ? "stderr" : "stdout");
  await main(command, args);
}

async function main(name: string, rest: string[]): Promise<void> {
  const { ShutdownManager } = await import("./shutdown.ts");
  const shutdown = new ShutdownManager();
  shutdown.installProcessHandlers();

  const { parseProfileCommand, parseServeConfig, parseStdioConfig, UsageError } = await import(
    "./config.ts"
  );
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
