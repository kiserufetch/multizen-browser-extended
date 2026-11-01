import { readFileSync } from "node:fs";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { acquireServerLock, assertNoLiveDesktop, ServerLockHeldError } from "@multizen/browser-runtime";
import { createMultizenMcpServer } from "@multizen/mcp-server";
import { dataDirPathWarning, type StdioConfig } from "../config.ts";
import { errorFields, log, protocolStdout } from "../log.ts";
import { DEFAULT_KEEPALIVE_MS, RelayKeepAlive, whySessionGone } from "../relayKeepAlive.ts";
import {
  buildRuntime,
  enginesInUse,
  RUNTIME_CLOSE_BUDGET_MS,
  SERVER_VERSION,
  takeOverFromPreviousRun,
} from "../runtime.ts";
import { preflightProcess, preflightUserNamespaces } from "../sandboxPreflight.ts";
import type { ShutdownManager } from "../shutdown.ts";

/** The holder's mode decides the advice: only a `serve` can be proxied to. */
export function stdioLockHint(e: ServerLockHeldError, dataDir: string): string {
  const { mode, url, tokenFile } = e.holder;
  if (mode !== "serve" || !url) {
    return `Stop that process, or point this one at another --data-dir (${dataDir} is taken).`;
  }
  const tokenArg = tokenFile ? ` --token-file "${tokenFile}"` : "";
  return `A running serve can be used over stdio instead: multizen-server stdio --connect ${url}${tokenArg}`;
}

function onStdinEnd(handler: () => void): void {
  process.stdin.once("end", handler);
  process.stdin.once("close", handler);
}

async function runLocal(
  config: Extract<StdioConfig, { kind: "local" }>,
  shutdown: ShutdownManager,
): Promise<void> {
  const pathWarning = dataDirPathWarning(config.dataDir, process.platform);
  if (pathWarning) log.warn(pathWarning, { dataDir: config.dataDir });
  preflightProcess(config.dataDir);

  let lock;
  try {
    lock = await acquireServerLock(config.dataDir, { mode: "stdio" });
  } catch (e) {
    if (e instanceof ServerLockHeldError) {
      e.message = `${e.message} ${stdioLockHint(e, config.dataDir)}`;
    }
    throw e;
  }
  shutdown.add("lock", () => lock.release());
  await assertNoLiveDesktop(config.dataDir);

  const runtime = await buildRuntime(config, await takeOverFromPreviousRun(config.dataDir));
  // A stdio client that exits gives its child about two seconds before killing
  // it (the MCP SDK's client does), and on Windows that kill can't be caught.
  // So an EOF takes the short path, the same one the desktop's quit uses.
  let clientGone = false;
  shutdown.add(
    "runtime",
    () => runtime.close(clientGone ? { gracefulMs: 1500, reap: false } : {}),
    RUNTIME_CLOSE_BUDGET_MS,
  );
  preflightUserNamespaces(enginesInUse(runtime));

  const { server } = createMultizenMcpServer({
    profileManager: runtime.profileManager,
    browserDriver: runtime.driver,
    activityLog: runtime.activityLog,
    shared: runtime.shared,
    serverVersion: SERVER_VERSION,
    getDefaultEngine: runtime.getDefaultEngine,
    uploadsRoot: config.uploadsRoot,
    egress: runtime.egress,
  });
  const transport = new StdioServerTransport(process.stdin, protocolStdout);
  transport.onclose = () => void shutdown.run("transport-closed", 0);
  onStdinEnd(() => {
    clientGone = true;
    void shutdown.run("stdin-eof", 0);
  });
  await server.connect(transport);
  runtime.startEngineBootstrap();

  log.info("stdio ready", {
    dataDir: config.dataDir,
    defaultEngine: runtime.getDefaultEngine(),
    displayMode: config.headless ? "headless (forced)" : config.displayMode,
    egressPolicy: config.egressPolicy,
    egressAllow: config.egressAllow,
    version: SERVER_VERSION,
  });
}

/** This relay's own requests. Their answers stop here: the client never asked. */
const KEEPALIVE_ID_PREFIX = "mz-relay-keepalive-";

function isKeepAliveAnswer(message: JSONRPCMessage): boolean {
  return "id" in message && typeof message.id === "string" && message.id.startsWith(KEEPALIVE_ID_PREFIX);
}

/** The JSON-RPC error a client gets when a request can't be delivered. */
function failedSendReply(message: JSONRPCMessage, e: unknown): JSONRPCMessage | null {
  if (!("id" in message) || !("method" in message)) return null;
  return {
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32000, message: `multizen-server request failed: ${(e as Error).message}` },
  };
}

/**
 * For clients that can only spawn a stdio server: relays their messages to a
 * running `serve`. Holds no lock and runs no browsers, those are the server's.
 */
async function runConnect(
  config: Extract<StdioConfig, { kind: "connect" }>,
  shutdown: ShutdownManager,
): Promise<void> {
  const token = config.tokenFile ? readFileSync(config.tokenFile, "utf8").trim() : undefined;
  const upstream = new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: token ? { headers: { authorization: `Bearer ${token}` } } : undefined,
  });
  const client = new StdioServerTransport(process.stdin, protocolStdout);
  const initializeIds = new Set<unknown>();

  // A client's session can't move to a new one under it, so this relay ends: its client
  // sees a server that went away, and whoever runs it reads why on stderr.
  let sessionGone = false;
  const endRelay = (why: string): void => {
    if (sessionGone) return;
    sessionGone = true;
    log.error(`stdio relay ending: ${why}`, { url: config.url });
    void shutdown.run("session-gone", 1);
  };
  let pings = 0;
  const keepAlive = new RelayKeepAlive({
    intervalMs: config.keepAliveMs ?? DEFAULT_KEEPALIVE_MS,
    ping: () => upstream.send({ jsonrpc: "2.0", id: `${KEEPALIVE_ID_PREFIX}${++pings}`, method: "ping" }),
    onGone: endRelay,
  });

  client.onmessage = (message) => {
    if ("method" in message && message.method === "initialize" && "id" in message) {
      initializeIds.add(message.id);
    }
    upstream.send(message).catch(async (e: unknown) => {
      log.error("upstream send failed", errorFields(e));
      const reply = failedSendReply(message, e);
      if (reply) await client.send(reply).catch(() => {});
      // Before there is a session this is only an answer to the client, which can try again.
      const gone = upstream.sessionId === undefined ? null : whySessionGone(e);
      if (gone) endRelay(gone);
    });
  };
  upstream.onmessage = (message) => {
    if (isKeepAliveAnswer(message)) return;
    // The SDK's Client does this for a direct connection; a relay has to.
    if ("id" in message && initializeIds.delete(message.id) && "result" in message) {
      const version = (message.result as { protocolVersion?: unknown }).protocolVersion;
      if (typeof version === "string") upstream.setProtocolVersion(version);
      keepAlive.start();
    }
    void client.send(message);
  };
  upstream.onerror = (e) => {
    log.warn("upstream error", errorFields(e));
    // A dropped stream is the first sign of a server gone. Before a session there is nothing to ping.
    if (upstream.sessionId !== undefined) keepAlive.checkNow();
  };
  client.onerror = (e) => log.warn("client stream error", errorFields(e));
  upstream.onclose = () => void shutdown.run("upstream-closed", 0);

  shutdown.add("upstream", async () => {
    keepAlive.stop();
    if (!sessionGone) await upstream.terminateSession().catch(() => {});
    await upstream.close();
  });

  await upstream.start();
  onStdinEnd(() => void shutdown.run("stdin-eof", 0));
  await client.start();
  log.info("stdio relay ready", { url: config.url });
}

export function runStdio(config: StdioConfig, shutdown: ShutdownManager): Promise<void> {
  return config.kind === "connect" ? runConnect(config, shutdown) : runLocal(config, shutdown);
}
