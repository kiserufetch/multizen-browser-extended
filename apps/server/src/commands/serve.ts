import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { acquireServerLock } from "@multizen/browser-runtime";
import { createMultizenMcpServer, HttpTransport } from "@multizen/mcp-server";
import { dataDirPathWarning, dataPaths, type ServerConfig } from "../config.ts";
import { log } from "../log.ts";
import { buildRuntime, SERVER_VERSION } from "../runtime.ts";
import type { ShutdownManager } from "../shutdown.ts";

const OWNER_TOKEN_RE = /^[0-9a-f]{64}$/;
/** HTTP stop closes sessions and sockets; it has no slow path of its own. */
const HTTP_STOP_BUDGET_MS = 3_000;
/** Covers closeAll's own budget, the bridges and the database. */
const RUNTIME_CLOSE_BUDGET_MS = 12_000;

/** No usable token and no `--no-auth`: the server must not start. */
export class NoOwnerTokenError extends Error {}

/**
 * The bearer token for this data dir: created on first start, 0600, and only ever
 * named by path in the logs. A file that exists but holds no valid token is an
 * operator's doing and refuses the start, rather than silently minting a new
 * secret that every configured client then fails against.
 */
export function loadOrCreateOwnerToken(path: string): string {
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8").trim();
    if (!OWNER_TOKEN_RE.test(existing)) {
      throw new NoOwnerTokenError(
        `${path} holds no valid token. Delete it to generate a new one, or pass --no-auth on loopback.`,
      );
    }
    if (process.platform !== "win32" && (statSync(path).mode & 0o077) !== 0) {
      chmodSync(path, 0o600);
      log.warn("owner token was readable by others; restricted to 0600", { path });
    }
    return existing;
  }
  const token = randomBytes(32).toString("hex");
  writeFileSync(path, token, { encoding: "utf8", mode: 0o600 });
  log.info("owner token created", { path });
  if (process.platform === "win32") {
    log.warn("file modes don't apply on Windows: the owner token relies on the directory's ACL", {
      path,
    });
  }
  return token;
}

export async function runServe(config: ServerConfig, shutdown: ShutdownManager): Promise<void> {
  const pathWarning = dataDirPathWarning(config.dataDir, process.platform);
  if (pathWarning) log.warn(pathWarning, { dataDir: config.dataDir });

  const { ownerTokenPath } = dataPaths(config.dataDir);
  const url = `http://${config.host}:${config.port}/mcp`;
  const lock = await acquireServerLock(config.dataDir, {
    mode: "serve",
    url,
    tokenFile: config.noAuth ? undefined : ownerTokenPath,
  });
  shutdown.add("lock", () => lock.release());

  const authToken = config.noAuth ? undefined : loadOrCreateOwnerToken(ownerTokenPath);
  if (authToken) log.info("owner token in use", { path: ownerTokenPath });

  const runtime = await buildRuntime(config);
  shutdown.add("runtime", () => runtime.close(), RUNTIME_CLOSE_BUDGET_MS);

  const http = new HttpTransport({
    host: config.host,
    port: config.port,
    authToken,
    createServer: () =>
      createMultizenMcpServer({
        profileManager: runtime.profileManager,
        browserDriver: runtime.driver,
        activityLog: runtime.activityLog,
        handoff: runtime.shared.handoff,
        serverVersion: SERVER_VERSION,
        getDefaultEngine: runtime.getDefaultEngine,
        uploadsRoot: config.uploadsRoot,
      }).server,
  });
  await http.start();
  shutdown.add("http", () => http.stop(), HTTP_STOP_BUDGET_MS);
  runtime.startEngineBootstrap();

  log.info("listening", {
    url,
    dataDir: config.dataDir,
    auth: authToken ? "owner-token" : "none",
    defaultEngine: runtime.getDefaultEngine(),
    version: SERVER_VERSION,
  });
}
