import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isIPv6 } from "node:net";
import { acquireServerLock } from "@multizen/browser-runtime";
import {
  AuthFailureLimiter,
  createMultizenMcpServer,
  HttpTransport,
  TokenStore,
  TOOL_GROUPS,
} from "@multizen/mcp-server";
import { dataDirPathWarning, dataPaths, isWildcardHost, type ServerConfig } from "../config.ts";
import { log } from "../log.ts";
import { buildRuntime, enginesInUse, SERVER_VERSION } from "../runtime.ts";
import { preflightProcess, preflightUserNamespaces } from "../sandboxPreflight.ts";
import { ensurePrivateFile } from "../secretKey.ts";
import type { ShutdownManager } from "../shutdown.ts";

/** HTTP stop closes sessions and sockets; it has no slow path of its own. */
const HTTP_STOP_BUDGET_MS = 3_000;
/** Covers closeAll's own budget, the bridges and the database. */
const RUNTIME_CLOSE_BUDGET_MS = 12_000;

/** No usable token and no `--no-auth`: the server must not start. */
export class NoOwnerTokenError extends Error {}

/**
 * Readies a data dir for authenticated use. A fresh one gets its owner token, with every
 * group, written 0600 and only ever named by path in the logs. An `owner-token` file
 * with an empty store is an operator's doing and refuses the start, rather than silently
 * minting a new secret that every configured client then fails against. So does a store
 * whose tokens have all ended: nobody could connect.
 */
export function ensureUsableToken(store: TokenStore, ownerTokenPath: string): void {
  if (store.isEmpty) {
    if (existsSync(ownerTokenPath)) {
      throw new NoOwnerTokenError(
        `${ownerTokenPath} holds no valid token. Delete it to generate a new one, or pass --no-auth on loopback.`,
      );
    }
    const { token } = store.create({ name: "owner", groups: [...TOOL_GROUPS], profiles: "*" });
    writeFileSync(ownerTokenPath, token, { encoding: "utf8", mode: 0o600 });
    log.info("owner token created", { path: ownerTokenPath });
  }
  if (store.activeCount() === 0) {
    throw new NoOwnerTokenError(
      "Every token here is revoked or expired. Run `multizen-server token create --name <name>`, " +
        "or pass --no-auth on loopback.",
    );
  }
  if (existsSync(ownerTokenPath)) ensurePrivateFile(ownerTokenPath, "owner token");
}

/** Where this machine reaches the server. A wildcard bind can't be connected to as such. */
function localUrl(config: ServerConfig): string {
  const host = isWildcardHost(config.host) ? "127.0.0.1" : config.host;
  const name = isIPv6(host) ? `[${host}]` : host;
  return `${config.tls ? "https" : "http"}://${name}:${config.port}/mcp`;
}

export async function runServe(config: ServerConfig, shutdown: ShutdownManager): Promise<void> {
  const pathWarning = dataDirPathWarning(config.dataDir, process.platform);
  if (pathWarning) log.warn(pathWarning, { dataDir: config.dataDir });
  preflightProcess(config.dataDir);

  const { ownerTokenPath, tokensPath } = dataPaths(config.dataDir);
  const url = localUrl(config);
  const lock = await acquireServerLock(config.dataDir, {
    mode: "serve",
    url,
    tokenFile: config.noAuth ? undefined : ownerTokenPath,
  });
  shutdown.add("lock", () => lock.release());

  let tokens: TokenStore | undefined;
  if (!config.noAuth) {
    const store = new TokenStore(tokensPath, { warn: (message) => log.warn(message) });
    ensureUsableToken(store, ownerTokenPath);
    shutdown.add("tokens", () => store.close());
    tokens = store;
    log.info("token store in use", { path: tokensPath, ownerToken: ownerTokenPath });
  }
  if (config.tls === undefined && !config.loopback) {
    log.warn("serving plain HTTP beyond loopback: tokens and tool calls cross the network readable", {
      host: config.host,
    });
  }

  const runtime = await buildRuntime(config);
  shutdown.add("runtime", () => runtime.close(), RUNTIME_CLOSE_BUDGET_MS);
  preflightUserNamespaces(enginesInUse(runtime));

  const http = new HttpTransport({
    host: config.host,
    port: config.port,
    ...(tokens
      ? { authenticate: (req) => tokens.authenticateHeader(req.headers.authorization) }
      : {}),
    allowedHosts: config.allowedHosts,
    allowedOrigins: config.allowedOrigins,
    ...(config.tls
      ? { tls: { cert: readFileSync(config.tls.certPath), key: readFileSync(config.tls.keyPath) } }
      : {}),
    sessionPolicy: { idleTtlMs: config.sessionIdleTtlMs, maxSessions: config.maxSessions },
    publicHealthz: true,
    authFailureLimiter: new AuthFailureLimiter(),
    trustProxy: config.trustProxy,
    readyState: () => {
      const engine = runtime.getDefaultEngine();
      const status = runtime.engineRegistry.getStatus(engine);
      return {
        ready: status.kind === "ready" || status.kind === "dev-system",
        engine,
        engineStatus: status.kind,
        ...("version" in status ? { engineVersion: status.version } : {}),
      };
    },
    createServer: () =>
      createMultizenMcpServer({
        profileManager: runtime.profileManager,
        browserDriver: runtime.driver,
        activityLog: runtime.activityLog,
        shared: runtime.shared,
        serverVersion: SERVER_VERSION,
        getDefaultEngine: runtime.getDefaultEngine,
        uploadsRoot: config.uploadsRoot,
      }).server,
  });
  await http.start();
  shutdown.add("http", () => http.stop(), HTTP_STOP_BUDGET_MS);

  if (tokens) {
    // What a token held ends with it. Anything else tied to a token listens here too.
    tokens.onInvalidated((id) => {
      runtime.shared.leases.dropPrincipal(id);
      void http.closeSessionsFor(id).then(() => log.info("token ended, sessions closed", { token: id }));
    });
    tokens.watch();
  }
  runtime.startEngineBootstrap();

  log.info("listening", {
    url,
    dataDir: config.dataDir,
    auth: tokens ? "tokens" : "none",
    ...(config.publicUrl !== undefined ? { publicUrl: config.publicUrl } : {}),
    defaultEngine: runtime.getDefaultEngine(),
    displayMode: config.headless ? "headless (forced)" : config.displayMode,
    maxBrowsers: config.maxBrowsers,
    version: SERVER_VERSION,
  });
}
