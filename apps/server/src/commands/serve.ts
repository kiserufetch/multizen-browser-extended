import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isIPv6 } from "node:net";
import { acquireServerLock, assertNoLiveDesktop } from "@multizen/browser-runtime";
import {
  AuthFailureLimiter,
  createDownloadRoute,
  createMultizenMcpServer,
  createPanelRoute,
  FULL_PRINCIPAL,
  HttpTransport,
  PanelSessions,
  TokenStore,
  TOOL_GROUPS,
} from "@multizen/mcp-server";
import { dataDirPathWarning, dataPaths, isWildcardHost, type ServerConfig } from "../config.ts";
import { startHandoffWebhook } from "../handoffWebhook.ts";
import { log } from "../log.ts";
import {
  buildRuntime,
  enginesInUse,
  RUNTIME_CLOSE_BUDGET_MS,
  SERVER_TOOL_LIMITS,
  SERVER_VERSION,
  takeOverFromPreviousRun,
} from "../runtime.ts";
import { preflightProcess, preflightUserNamespaces } from "../sandboxPreflight.ts";
import { ensurePrivateFile } from "../secretKey.ts";
import type { ShutdownManager } from "../shutdown.ts";

/** HTTP stop closes sessions and sockets; it has no slow path of its own. */
const HTTP_STOP_BUDGET_MS = 3_000;

/** Room for about six of the largest uploads at once. Past it, RATE_LIMITED. */
const MAX_BODY_BYTES_IN_FLIGHT = 128 * 1024 * 1024;
/** A session holds a stream and a POST or two. Past this, sockets are dropped: file descriptors aren't free. */
const CONNECTIONS_PER_SESSION = 4;
const MIN_MAX_CONNECTIONS = 256;

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
function localBaseUrl(config: ServerConfig): string {
  const host = isWildcardHost(config.host) ? "127.0.0.1" : config.host;
  const name = isIPv6(host) ? `[${host}]` : host;
  return `${config.tls ? "https" : "http"}://${name}:${config.port}`;
}

export async function runServe(config: ServerConfig, shutdown: ShutdownManager): Promise<void> {
  const pathWarning = dataDirPathWarning(config.dataDir, process.platform);
  if (pathWarning) log.warn(pathWarning, { dataDir: config.dataDir });
  preflightProcess(config.dataDir);

  const { ownerTokenPath, tokensPath } = dataPaths(config.dataDir);
  const base = localBaseUrl(config);
  const url = `${base}/mcp`;
  const lock = await acquireServerLock(config.dataDir, {
    mode: "serve",
    url,
    tokenFile: config.noAuth ? undefined : ownerTokenPath,
  });
  shutdown.add("lock", () => lock.release());
  await assertNoLiveDesktop(config.dataDir);

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

  const runtime = await buildRuntime(config, await takeOverFromPreviousRun(config.dataDir), true);
  shutdown.add("runtime", () => runtime.close(), RUNTIME_CLOSE_BUDGET_MS);
  preflightUserNamespaces(enginesInUse(runtime));

  const reachableAt = config.publicUrl ?? base;
  const limiter = new AuthFailureLimiter();
  const panelSessions = new PanelSessions();
  const panel = createPanelRoute({
    handoff: runtime.shared.handoff,
    driver: runtime.driver,
    mutex: runtime.shared.mutex,
    profiles: runtime.profileManager,
    sessions: panelSessions,
    authenticateToken: tokens ? (token) => tokens.authenticate(token) : () => FULL_PRINCIPAL,
    principalById: tokens ? (id) => tokens.principalById(id) : () => FULL_PRINCIPAL,
    limiter,
    secureCookie: config.tls !== undefined || reachableAt.startsWith("https:"),
    noLogin: config.noAuth,
    activityLog: runtime.activityLog,
    maxInboxBytes: config.uploadInboxQuotaBytes,
    onError: (route, code) => log.warn("panel request failed", { route, code }),
  });
  if (config.handoffWebhook) {
    startHandoffWebhook({
      handoff: runtime.shared.handoff,
      url: config.handoffWebhook,
      ...(config.handoffWebhookSecret ? { secret: config.handoffWebhookSecret } : {}),
      panelUrl: `${reachableAt}/panel`,
      profileName: (id) => runtime.profileManager.get(id)?.name,
    });
  }

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
    sessionPolicy: {
      idleTtlMs: config.sessionIdleTtlMs,
      maxSessions: config.maxSessions,
      maxSessionsPerPrincipal: config.maxSessionsPerToken,
    },
    maxBodyBytesInFlight: MAX_BODY_BYTES_IN_FLIGHT,
    maxConnections: Math.max(MIN_MAX_CONNECTIONS, config.maxSessions * CONNECTIONS_PER_SESSION),
    ...(config.leaseOnSessionClose === "release"
      ? { onSessionClosed: (sessionId: string) => runtime.shared.leases.dropSession(sessionId) }
      : {}),
    publicHealthz: true,
    publicRoutes: [panel],
    authedRoutes: [createDownloadRoute({ driver: runtime.driver, profiles: runtime.profileManager })],
    authFailureLimiter: limiter,
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
        egress: runtime.egress,
        handoffGate: true,
        downloadsBaseUrl: reachableAt,
        limits: SERVER_TOOL_LIMITS,
        maxInboxBytes: config.uploadInboxQuotaBytes,
      }).server,
  });
  await http.start();
  shutdown.add("http", () => http.stop(), HTTP_STOP_BUDGET_MS);

  if (tokens) {
    // What a token held ends with it. Anything else tied to a token listens here too.
    tokens.onInvalidated((id) => {
      runtime.shared.leases.dropPrincipal(id);
      panelSessions.dropPrincipal(id);
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
    panel: `${reachableAt}/panel`,
    handoffWebhook: Boolean(config.handoffWebhook),
    defaultEngine: runtime.getDefaultEngine(),
    displayMode: config.headless ? "headless (forced)" : config.displayMode,
    maxBrowsers: config.maxBrowsers,
    egressPolicy: config.egressPolicy,
    egressAllow: config.egressAllow,
    version: SERVER_VERSION,
  });
}
