import { TokenStore, type TokenSummary } from "@multizen/mcp-server";
import { dataPaths, type TokenCommand } from "../config.ts";
import { log, protocolStdout } from "../log.ts";

/**
 * Manages `<data-dir>/tokens.json`. Needs no lock on the data dir: it is meant to run
 * beside a live server, which notices the file changing. Logs go to stderr here, so
 * stdout is just the result: `TOKEN=$(multizen-server token create --name ci)`.
 */
export function runToken(
  command: TokenCommand,
  print: (text: string) => unknown = (text) => protocolStdout.write(text),
): void {
  const store = new TokenStore(dataPaths(command.dataDir).tokensPath, {
    warn: (message) => log.warn(message),
  });
  if (command.action === "create") {
    const { token, record } = store.create(command.input);
    print(`${token}\n`);
    log.info("token created: this is the only time its value is shown", {
      id: record.id,
      name: record.name,
      tools: record.tools,
      profiles: record.profiles,
      expiresAt: record.expiresAt,
    });
    return;
  }
  if (command.action === "list") {
    for (const token of store.list()) print(`${JSON.stringify(token satisfies TokenSummary)}\n`);
    return;
  }
  const revoked = store.revoke(command.target);
  print(`${JSON.stringify({ id: revoked.id, name: revoked.name, revokedAt: revoked.revokedAt })}\n`);
  log.info("token revoked: a running server closes its sessions within a second", {
    id: revoked.id,
    name: revoked.name,
  });
}
