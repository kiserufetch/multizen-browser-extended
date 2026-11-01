import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  Agent as HttpAgent,
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
} from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { createServer as createNetServer } from "node:net";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ProfileManager } from "@multizen/profile-manager";
import type { Profile } from "@multizen/types";

import { connect as netConnect, type Socket } from "node:net";
import { ActivityLog } from "./ActivityLog.js";
import { AuthFailureLimiter } from "./auth/AuthFailureLimiter.js";
import { createPrincipal, type Principal } from "./auth/principal.js";
import {
  addressGroup,
  DEFAULT_MAX_REQUEST_BYTES,
  HttpTransport,
  type HttpRoute,
  type HttpTransportOptions,
  type RouteContext,
} from "./HttpTransport.js";
import { MockBrowserDriver } from "./MockBrowserDriver.js";
import { createMultizenMcpServer } from "./server.js";
import { createSharedMcpState, type SharedMcpState } from "./sharedState.js";

/** A minimal MCP server exposing a single tool — enough to exercise the
 *  initialize handshake + tools/list over any transport. */
function makeServer(): Server {
  const s = new Server({ name: "test", version: "0.0.0" }, { capabilities: { tools: {} } });
  s.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "ping", description: "ping", inputSchema: { type: "object", properties: {} } }],
  }));
  return s;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

function sseUrl(port: number): URL {
  return new URL(`http://127.0.0.1:${port}/sse`);
}

function mcpUrl(port: number): URL {
  return new URL(`http://127.0.0.1:${port}/mcp`);
}

test("legacy SSE: reconnect after close initialises a fresh session", async () => {
  await withTransport({}, async (port) => {
    const c1 = await connectSse(port);
    assert.equal((await c1.listTools()).tools.length, 1);
    await c1.close();

    // The reconnect is the regression: previously the late teardown of the
    // first connection could clobber the new session's server binding.
    const c2 = await connectSse(port);
    assert.equal((await c2.listTools()).tools.length, 1);
    await c2.close();
  });
});

test("legacy SSE: a second client does not break the first", async () => {
  await withTransport({}, async (port, t) => {
    const c1 = await connectSse(port);
    const c2 = await connectSse(port);
    assert.equal(t.status().sse, 2);

    // Closing c1 must not disturb c2 (each is bound to its own server).
    await c1.close();
    assert.equal((await c2.listTools()).tools.length, 1);
    await c2.close();
  });
});

test("stop() resolves promptly even with an open SSE connection", async () => {
  await withTransport({}, async (port, t) => {
    await connectSse(port);

    const started = Date.now();
    await t.stop();
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2000, `stop() took ${elapsed}ms with an open SSE stream`);
  });
});

test("streamable HTTP: initialise + listTools over /mcp", async () => {
  const port = await freePort();
  const t = new HttpTransport({ port, createServer: makeServer, heartbeatMs: 0 });
  await t.start();
  try {
    const c = new Client({ name: "c", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(mcpUrl(port)));
    assert.equal((await c.listTools()).tools.length, 1);
    await c.close();
  } finally {
    await t.stop();
  }
});

// ── S10: helpers ─────────────────────────────────────────────────────────────

interface RawReply {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
}

interface RawOptions {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string;
}

function rawRequest(port: number, opts: RawOptions = {}): Promise<RawReply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: opts.method ?? "GET",
        path: opts.path ?? "/mcp",
        headers: opts.headers ?? {},
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
      },
    );
    req.on("error", reject);
    req.end(opts.body);
  });
}

const MCP_HEADERS = { accept: "application/json, text/event-stream", "content-type": "application/json" };
const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "raw", version: "0" },
  },
});

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

/** Opens a Streamable session by hand and returns its id. */
async function openSession(port: number, token: string): Promise<string> {
  const reply = await rawRequest(port, {
    method: "POST",
    headers: { ...MCP_HEADERS, ...bearer(token) },
    body: INITIALIZE,
  });
  assert.equal(reply.status, 200, reply.text);
  const id = reply.headers["mcp-session-id"];
  assert.equal(typeof id, "string");
  return id as string;
}

/** An SSE response held open: resolves `sessionId` for /sse, `closed` when it ends. */
function openStream(
  port: number,
  path: string,
  headers: Record<string, string>,
): { status: Promise<number>; sessionId: Promise<string>; closed: Promise<void>; destroy(): void } {
  let setStatus = (_: number): void => {};
  let setSession = (_: string): void => {};
  let setClosed = (): void => {};
  const status = new Promise<number>((resolve) => (setStatus = resolve));
  const sessionId = new Promise<string>((resolve) => (setSession = resolve));
  const closed = new Promise<void>((resolve) => (setClosed = resolve));
  const req = httpRequest({ host: "127.0.0.1", port, path, headers }, (res) => {
    setStatus(res.statusCode ?? 0);
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      const match = /sessionId=([0-9a-f-]+)/.exec(chunk);
      if (match) setSession(match[1]!);
    });
    res.on("close", setClosed);
  });
  req.on("error", setClosed);
  req.end();
  return { status, sessionId, closed, destroy: () => req.destroy() };
}

async function until(check: () => boolean, what: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function principal(id: string, overrides: Partial<Parameters<typeof createPrincipal>[0]> = {}): Principal {
  return createPrincipal({
    id,
    name: id,
    full: false,
    tools: { groups: ["read", "act"], names: [] },
    profiles: "*",
    ...overrides,
  });
}

/** Tokens named by their principal's id: `Bearer a` is principal a. */
function tokensFor(...principals: Principal[]): (req: IncomingMessage) => Principal | null {
  return (req) =>
    principals.find((p) => req.headers.authorization === `Bearer ${p.id}`) ?? null;
}

function barrier(): { wait: Promise<void>; open: () => void } {
  let open = (): void => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/** `makeServer`, plus a tool that answers once the gate opens. */
function serverWithTool(gate: Promise<unknown> = Promise.resolve()): () => Server {
  return () => {
    const s = makeServer();
    s.setRequestHandler(CallToolRequestSchema, async (req) => {
      await gate;
      return { content: [{ type: "text", text: JSON.stringify(req.params.arguments ?? {}) }] };
    });
    return s;
  };
}

async function withTransport(
  opts: Partial<HttpTransportOptions>,
  run: (port: number, t: HttpTransport) => Promise<void>,
): Promise<void> {
  const port = await freePort();
  const t = new HttpTransport({ port, createServer: makeServer, heartbeatMs: 0, ...opts });
  await t.start();
  try {
    await run(port, t);
  } finally {
    await t.stop();
  }
}

async function connectStreamable(port: number, token?: string): Promise<Client> {
  const c = new Client({ name: "c", version: "0" });
  await c.connect(
    new StreamableHTTPClientTransport(
      mcpUrl(port),
      token ? { requestInit: { headers: bearer(token) } } : {},
    ),
  );
  return c;
}

/**
 * An EventSource left open retries forever, and that alone keeps this file's process alive.
 * So a failed connect closes its transport, and any test's client is closed when it ends,
 * whether or not the test got as far as doing that itself.
 */
const sseClients = new Set<Client>();
afterEach(async () => {
  await Promise.all([...sseClients].map((c) => c.close().catch(() => {})));
  sseClients.clear();
});

async function connectSse(port: number, token?: string): Promise<Client> {
  const headers = token ? bearer(token) : {};
  const c = new Client({ name: "c", version: "0" });
  const transport = new SSEClientTransport(sseUrl(port), {
    eventSourceInit: { fetch: (url, init) => fetch(url, { ...init, headers: { ...init?.headers, ...headers } }) },
    requestInit: { headers },
  });
  await c.connect(transport).catch(async (e: unknown) => {
    await transport.close();
    throw e;
  });
  sseClients.add(c);
  return c;
}

// ── who may connect ──────────────────────────────────────────────────────────

test("a foreign Host or Origin gets 403, from the same list the desktop has always had", async () => {
  await withTransport({ authToken: "secret" }, async (port) => {
    const status = async (headers: Record<string, string>): Promise<number> =>
      (await rawRequest(port, { headers: { ...bearer("secret"), ...headers } })).status;

    // 400: past the gate, a GET with no session.
    assert.equal(await status({}), 400);
    assert.equal(await status({ host: `localhost:${port}` }), 400);
    assert.equal(await status({ origin: `http://127.0.0.1:${port}` }), 400);
    assert.equal(await status({ origin: `https://localhost:${port}` }), 400);

    assert.equal(await status({ host: `evil.test:${port}` }), 403);
    assert.equal(await status({ host: "localhost" }), 403, "no port: exact unless configured");
    assert.equal(await status({ host: "localhost:1" }), 403);
    assert.equal(await status({ origin: "http://evil.test" }), 403);
    assert.equal(await status({ origin: "http://localhost:3000" }), 403, "another local page");
    assert.equal(await status({ origin: "null" }), 403);
  });
});

test("an allowed host without a port takes any port or none; with one, only that", async () => {
  await withTransport(
    { allowedHosts: ["example.test", "pinned.test:8443"], allowedOrigins: ["https://app.test"] },
    async (port) => {
      const status = async (headers: Record<string, string>): Promise<number> =>
        (await rawRequest(port, { headers })).status;

      for (const host of ["example.test", "example.test:8443", "EXAMPLE.test", "example.test."]) {
        assert.equal(await status({ host }), 400, host);
      }
      assert.equal(await status({ host: "pinned.test:8443" }), 400);
      assert.equal(await status({ host: "pinned.test:9000" }), 403);
      assert.equal(await status({ host: "pinned.test" }), 403);
      assert.equal(await status({ host: "example.test.evil.test" }), 403, "rebinding's own name");
      assert.equal(await status({ host: "other.test" }), 403);
      assert.equal(await status({ host: `127.0.0.1:${port}` }), 400, "loopback stays");

      assert.equal(await status({ origin: "https://example.test" }), 400);
      assert.equal(await status({ origin: "https://app.test" }), 400);
      assert.equal(await status({ origin: "https://other.test" }), 403);
      assert.equal(await status({ origin: "ftp://example.test" }), 403);
    },
  );
});

test("a mapped port: naming the loopback host takes any port for it", async () => {
  await withTransport({ allowedHosts: ["127.0.0.1", "[::1]"] }, async (port) => {
    const status = async (host: string): Promise<number> =>
      (await rawRequest(port, { headers: { host } })).status;
    assert.equal(await status("127.0.0.1:8080"), 400, "docker run -p 8080:<port>");
    assert.equal(await status("[::1]:8080"), 400);
    assert.equal(await status("localhost:8080"), 403, "only what was named");
  });
});

test("an allowed host's request is served, by a real client through a Host-rewriting hop", async () => {
  await withTransport({ allowedHosts: ["example.test"], authToken: "secret" }, async (port) => {
    // What a reverse proxy does: another Host, the same socket.
    const hop = createHttpServer((req, res) => {
      const upstream = httpRequest(
        {
          host: "127.0.0.1",
          port,
          method: req.method,
          path: req.url,
          headers: { ...req.headers, host: "example.test" },
        },
        (reply) => {
          res.writeHead(reply.statusCode ?? 502, reply.headers);
          reply.pipe(res);
        },
      );
      req.pipe(upstream);
    });
    await new Promise<void>((resolve) => hop.listen(0, "127.0.0.1", resolve));
    const hopPort = (hop.address() as { port: number }).port;
    try {
      const c = await connectStreamable(hopPort, "secret");
      assert.equal((await c.listTools()).tools.length, 1);
      await c.close();
    } finally {
      hop.closeAllConnections();
      await new Promise((resolve) => hop.close(resolve));
    }
  });
});

test("the constructor refuses an allowed host it couldn't ever match", () => {
  assert.throws(
    () =>
      new HttpTransport({
        port: 1,
        createServer: makeServer,
        allowedHosts: ["https://example.test/"],
      }),
    /Not a host/,
  );
});

// ── sessions belong to whoever opened them ───────────────────────────────────

test("a session is bound to its principal: POST, GET, DELETE and /messages give 403", async () => {
  const a = principal("a");
  const b = principal("b");
  await withTransport({ authenticate: tokensFor(a, b) }, async (port) => {
    const sid = await openSession(port, "a");
    const session = { "mcp-session-id": sid, "mcp-protocol-version": "2025-03-26", ...MCP_HEADERS };
    const list = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" });

    for (const [method, body] of [["POST", list], ["GET", undefined], ["DELETE", undefined]] as const) {
      const reply = await rawRequest(port, {
        method,
        headers: { ...session, ...bearer("b") },
        ...(body ? { body } : {}),
      });
      assert.equal(reply.status, 403, `${method}: ${reply.text}`);
    }
    assert.equal(
      (await rawRequest(port, { method: "POST", headers: { ...session, ...bearer("a") }, body: list })).status,
      200,
      "still there for its owner",
    );

    const sse = openStream(port, "/sse", bearer("a"));
    const sseId = await sse.sessionId;
    const messages = `/messages?sessionId=${sseId}`;
    assert.equal(
      (await rawRequest(port, {
        method: "POST",
        path: messages,
        headers: { ...MCP_HEADERS, ...bearer("b") },
        body: list,
      })).status,
      403,
    );
    assert.equal(
      (await rawRequest(port, {
        method: "POST",
        path: messages,
        headers: { ...MCP_HEADERS, ...bearer("a") },
        body: list,
      })).status,
      202,
    );
    sse.destroy();
  });
});

test("closeSessionsFor ends one principal's sessions, on both transports, and no one else's", async () => {
  const a = principal("a");
  const b = principal("b");
  const closed: string[] = [];
  await withTransport(
    { authenticate: tokensFor(a, b), onSessionClosed: (key) => closed.push(key) },
    async (port, t) => {
      const streamable = await openSession(port, "a");
      const sse = openStream(port, "/sse", bearer("a"));
      const sseId = await sse.sessionId;
      const other = await connectStreamable(port, "b");
      assert.deepEqual(t.status(), { sse: 1, streamable: 2 });

      await t.closeSessionsFor("a");
      await sse.closed;
      assert.deepEqual(t.status(), { sse: 0, streamable: 1 });
      assert.deepEqual(closed.sort(), [streamable, sseId].sort());
      assert.equal((await other.listTools()).tools.length, 1);
      await other.close();
    },
  );
});

// ── idle sessions and how many ───────────────────────────────────────────────

test("an idle session expires on both transports; its id then gets 404", async () => {
  const closed: string[] = [];
  await withTransport(
    { sessionPolicy: { idleTtlMs: 60 }, onSessionClosed: (key) => closed.push(key) },
    async (port, t) => {
      const sid = await openSession(port, "unused");
      const sse = openStream(port, "/sse", {});
      await sse.sessionId;
      await until(() => t.status().streamable === 0 && t.status().sse === 0, "both to expire");
      await sse.closed;
      assert.equal(closed.length, 2);
      const reply = await rawRequest(port, {
        method: "POST",
        headers: { ...MCP_HEADERS, "mcp-session-id": sid },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      });
      assert.equal(reply.status, 404);
    },
  );
});

/** Well past what connecting and starting a call can take on a loaded machine. */
const IDLE_TTL_MS = 1_000;

for (const [name, connect] of [
  ["streamable", connectStreamable],
  ["legacy SSE", connectSse],
] as const) {
  test(`${name}: a call in flight isn't idle, however long it takes; after it, the clock starts`, async () => {
    const gate = barrier();
    await withTransport(
      { sessionPolicy: { idleTtlMs: IDLE_TTL_MS }, createServer: serverWithTool(gate.wait) },
      async (port, t) => {
        const c = await connect(port);
        const open = (): number => t.status().streamable + t.status().sse;
        const call = c.callTool({ name: "slow", arguments: { at: "start" } });
        await new Promise((resolve) => setTimeout(resolve, 2 * IDLE_TTL_MS));
        assert.equal(open(), 1, "expired with a call in flight");

        gate.open();
        const result = (await call) as { content: Array<{ text: string }> };
        assert.equal(result.content[0]?.text, JSON.stringify({ at: "start" }));
        await until(() => open() === 0, "the session to expire after its call");
        await c.close();
      },
    );
  });
}

test("a cancelled call stops counting as in flight", async () => {
  const gate = barrier();
  await withTransport(
    { sessionPolicy: { idleTtlMs: IDLE_TTL_MS }, createServer: serverWithTool(gate.wait) },
    async (port, t) => {
      const c = await connectStreamable(port);
      const cancel = new AbortController();
      const call = c.callTool({ name: "slow" }, undefined, { signal: cancel.signal });
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(t.status().streamable, 1);
      cancel.abort();
      await assert.rejects(call);
      await until(() => t.status().streamable === 0, "the session to expire");
      gate.open();
      await c.close();
    },
  );
});

test("the session limit answers SESSION_LIMIT, on both transports, and frees up", async () => {
  await withTransport({ sessionPolicy: { maxSessions: 1 } }, async (port) => {
    const first = new StreamableHTTPClientTransport(mcpUrl(port));
    const c = new Client({ name: "first", version: "0" });
    await c.connect(first);

    const refused = await rawRequest(port, { method: "POST", headers: MCP_HEADERS, body: INITIALIZE });
    assert.equal(refused.status, 503);
    const error = (JSON.parse(refused.text) as { error: { data: { code: string; retryable: boolean } } }).error;
    assert.equal(error.data.code, "SESSION_LIMIT");
    assert.equal(error.data.retryable, true);
    await assert.rejects(connectStreamable(port), /SESSION_LIMIT/);
    assert.equal((await rawRequest(port, { path: "/sse" })).status, 503);

    await first.terminateSession();
    await c.close();
    await (await connectStreamable(port)).close();
  });
});

test("the limit also holds for a burst of initializations", async () => {
  const gate = barrier();
  await withTransport(
    { sessionPolicy: { maxSessions: 3 }, createServer: serverWithTool(gate.wait) },
    async (port, t) => {
      const replies = await Promise.all(
        Array.from({ length: 8 }, () =>
          rawRequest(port, { method: "POST", headers: MCP_HEADERS, body: INITIALIZE }),
        ),
      );
      assert.equal(replies.filter((r) => r.status === 200).length, 3);
      assert.equal(replies.filter((r) => r.status === 503).length, 5);
      assert.equal(t.status().streamable, 3);
      gate.open();
    },
  );
});

test("without a session policy nothing expires and nothing is limited: the desktop", async () => {
  await withTransport({}, async (port, t) => {
    const clients = await Promise.all(Array.from({ length: 70 }, () => connectStreamable(port)));
    assert.equal(t.status().streamable, 70);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(t.status().streamable, 70);
    await Promise.all(clients.map((c) => c.close()));
  });
});

// ── failed credentials ───────────────────────────────────────────────────────

test("past its limit an address gets 429 with Retry-After, while a right token still works", async () => {
  await withTransport(
    {
      authenticate: tokensFor(principal("good")),
      authFailureLimiter: new AuthFailureLimiter({ limit: 3, windowMs: 40_000 }),
    },
    async (port) => {
      for (let i = 0; i < 3; i++) {
        assert.equal((await rawRequest(port, { headers: bearer("bad") })).status, 401);
      }
      const limited = await rawRequest(port, { headers: bearer("bad") });
      assert.equal(limited.status, 429);
      const retryAfter = Number(limited.headers["retry-after"]);
      assert.ok(retryAfter > 0 && retryAfter <= 40, String(limited.headers["retry-after"]));
      const body = JSON.parse(limited.text) as { code: string; details: { retry_after_ms: number } };
      assert.equal(body.code, "RATE_LIMITED");
      assert.ok(body.details.retry_after_ms > 0);

      assert.equal((await rawRequest(port)).status, 429, "no credentials at all count too");
      assert.equal(
        (await rawRequest(port, { headers: bearer("good") })).status,
        400,
        "someone sharing the address can't lock out a valid token",
      );
    },
  );
});

test("the window ends and the address may try again", async () => {
  let now = 0;
  await withTransport(
    {
      authenticate: tokensFor(),
      authFailureLimiter: new AuthFailureLimiter({ limit: 1, windowMs: 50, now: () => now }),
    },
    async (port) => {
      assert.equal((await rawRequest(port)).status, 401);
      assert.equal((await rawRequest(port)).status, 429);
      now = 51;
      assert.equal((await rawRequest(port)).status, 401);
    },
  );
});

test("X-Forwarded-For only counts under trustProxy, and only its rightmost hop", async () => {
  const limiter = (): AuthFailureLimiter => new AuthFailureLimiter({ limit: 1, windowMs: 60_000 });
  const attempt = async (port: number, xff: string): Promise<number> =>
    (await rawRequest(port, { headers: { "x-forwarded-for": xff } })).status;

  await withTransport(
    { authenticate: tokensFor(), authFailureLimiter: limiter() },
    async (port) => {
      assert.equal(await attempt(port, "203.0.113.1"), 401);
      assert.equal(await attempt(port, "203.0.113.2"), 429, "all one socket address");
    },
  );
  await withTransport(
    { authenticate: tokensFor(), authFailureLimiter: limiter(), trustProxy: true },
    async (port) => {
      assert.equal(await attempt(port, "203.0.113.1"), 401);
      assert.equal(await attempt(port, "203.0.113.1"), 429);
      assert.equal(await attempt(port, "203.0.113.2"), 401, "another client behind the proxy");
      assert.equal(
        await attempt(port, "198.51.100.9, 203.0.113.1"),
        429,
        "what a client forges goes on the left",
      );
      assert.equal(await attempt(port, "not-an-address"), 401, "falls back to the socket");
      assert.equal(await attempt(port, "still-not"), 429);
    },
  );
});

// ── body limit ───────────────────────────────────────────────────────────────

test("a body over the limit gets 413 FILE_TOO_LARGE on both transports", async () => {
  await withTransport({ maxRequestBytes: 1_000, createServer: serverWithTool() }, async (port) => {
    const assertTooLarge = (reply: RawReply): void => {
      assert.equal(reply.status, 413, reply.text);
      const error = (JSON.parse(reply.text) as { error: { message: string; data: { code: string; details: { max_bytes: number } } } }).error;
      assert.equal(error.data.code, "FILE_TOO_LARGE");
      assert.equal(error.data.details.max_bytes, 1_000);
      assert.match(error.message, /FILE_TOO_LARGE/);
    };
    const big = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { x: "y".repeat(2_000) } });

    // No session yet, the initialize path.
    assertTooLarge(await rawRequest(port, { method: "POST", headers: MCP_HEADERS, body: big }));

    const sid = await openSession(port, "unused");
    assertTooLarge(
      await rawRequest(port, {
        method: "POST",
        headers: { ...MCP_HEADERS, "mcp-session-id": sid, "mcp-protocol-version": "2025-03-26" },
        body: big,
      }),
    );

    const sse = openStream(port, "/sse", {});
    assertTooLarge(
      await rawRequest(port, {
        method: "POST",
        path: `/messages?sessionId=${await sse.sessionId}`,
        headers: MCP_HEADERS,
        body: big,
      }),
    );
    sse.destroy();
  });
});

test("the limit holds with no Content-Length, and the client gets its answer", async () => {
  await withTransport({ maxRequestBytes: 1_000 }, async (port) => {
    const reply = await new Promise<RawReply>((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port, method: "POST", path: "/mcp", headers: MCP_HEADERS },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => (text += chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
        },
      );
      req.on("error", reject);
      for (let i = 0; i < 20; i++) req.write("x".repeat(500));
      req.end();
    });
    assert.equal(reply.status, 413);
    assert.match(reply.text, /FILE_TOO_LARGE/);
  });
});

test("a real client sees FILE_TOO_LARGE and its session goes on working", async () => {
  await withTransport({ maxRequestBytes: 4_000, createServer: serverWithTool() }, async (port) => {
    const c = await connectStreamable(port);
    await assert.rejects(
      c.callTool({ name: "t", arguments: { data: "x".repeat(10_000) } }),
      /FILE_TOO_LARGE/,
    );
    assert.equal((await c.listTools()).tools.length, 1);
    await c.close();
  });
});

test("legacy SSE takes what the SDK's own 4 MB cap would have refused", async () => {
  await withTransport({ createServer: serverWithTool() }, async (port) => {
    const c = await connectSse(port);
    const data = "x".repeat(5 * 1024 * 1024);
    const result = (await c.callTool({ name: "t", arguments: { data } })) as {
      content: Array<{ text: string }>;
    };
    assert.equal(JSON.parse(result.content[0]!.text).data.length, data.length);
    await c.close();
  });
});

test("the default limit fits the largest upload_file: 16 MiB in base64, in its JSON", () => {
  const base64 = Math.ceil((16 * 1024 * 1024) / 3) * 4;
  assert.ok(DEFAULT_MAX_REQUEST_BYTES > base64 + 64 * 1024);
});

test("a body that isn't JSON is a parse error, not a hang", async () => {
  await withTransport({}, async (port) => {
    const sid = await openSession(port, "unused");
    const sse = openStream(port, "/sse", {});
    const messages = `/messages?sessionId=${await sse.sessionId}`;
    for (const body of ["{not json", ""]) {
      const reply = await rawRequest(port, {
        method: "POST",
        headers: { ...MCP_HEADERS, "mcp-session-id": sid },
        body,
      });
      assert.equal(reply.status, 400, reply.text);
      assert.match(reply.text, /Parse error/);
      const legacy = await rawRequest(port, { method: "POST", path: messages, headers: MCP_HEADERS, body });
      assert.equal(legacy.status, 400, legacy.text);
    }
    const nothing = await rawRequest(port, {
      method: "POST",
      path: messages,
      headers: MCP_HEADERS,
      body: "null",
    });
    assert.equal(nothing.status, 400);
    sse.destroy();
  });
});

// ── routes ───────────────────────────────────────────────────────────────────

test("route seams run in order: public, auth, /healthz and /readyz, authed, MCP", async () => {
  const seen: string[] = [];
  const route =
    (name: string, handles: string): HttpRoute =>
    async (_req, res, url, ctx) => {
      seen.push(`${name} ${url.pathname} ${ctx.principal?.id ?? "nobody"}`);
      if (url.pathname !== handles) return false;
      res.writeHead(200).end(name);
      return true;
    };
  await withTransport(
    {
      authenticate: tokensFor(principal("a")),
      publicRoutes: [route("pub1", "/open"), route("pub2", "/open2")],
      authedRoutes: [route("auth1", "/private"), route("auth2", "/mcp-shadow")],
    },
    async (port) => {
      assert.equal((await rawRequest(port, { path: "/open" })).text, "pub1");
      assert.deepEqual(seen.splice(0), ["pub1 /open nobody"], "stops at the first that answers");

      assert.equal((await rawRequest(port, { path: "/open2" })).text, "pub2");
      assert.deepEqual(seen.splice(0), ["pub1 /open2 nobody", "pub2 /open2 nobody"]);

      assert.equal((await rawRequest(port, { path: "/private" })).status, 401, "nothing past auth");
      assert.deepEqual(seen.splice(0), ["pub1 /private nobody", "pub2 /private nobody"]);

      const authed = await rawRequest(port, { path: "/private", headers: bearer("a") });
      assert.equal(authed.text, "auth1");
      assert.deepEqual(seen.splice(0), [
        "pub1 /private nobody",
        "pub2 /private nobody",
        "auth1 /private a",
      ]);

      await rawRequest(port, { path: "/healthz", headers: bearer("a") });
      assert.deepEqual(seen.splice(0), ["pub1 /healthz nobody", "pub2 /healthz nobody"], "before authed");

      const mcp = await rawRequest(port, { path: "/mcp", headers: bearer("a") });
      assert.equal(mcp.status, 400, "authed routes pass on, then MCP");
      assert.deepEqual(seen.splice(0), [
        "pub1 /mcp nobody",
        "pub2 /mcp nobody",
        "auth1 /mcp a",
        "auth2 /mcp a",
      ]);

      // A foreign Host reaches no route at all; a foreign Origin reaches no authed one.
      const foreignHost = { host: "evil.test" };
      assert.equal((await rawRequest(port, { path: "/open", headers: foreignHost })).status, 401);
      assert.deepEqual(seen.splice(0), []);
      const foreignOrigin = { ...bearer("a"), origin: "http://evil.test" };
      assert.equal((await rawRequest(port, { path: "/private", headers: foreignOrigin })).status, 404);
      assert.deepEqual(seen.splice(0), ["pub1 /private nobody", "pub2 /private nobody"]);
    },
  );
});

test("a public route is told about the Origin and the client's address, and decides for itself", async () => {
  const seen: RouteContext[] = [];
  await withTransport(
    {
      trustProxy: true,
      publicRoutes: [
        async (_req, res, _url, ctx) => {
          seen.push(ctx);
          res.writeHead(200).end();
          return true;
        },
      ],
    },
    async (port) => {
      const reach = (headers: Record<string, string>) => rawRequest(port, { path: "/x", headers });
      await reach({});
      await reach({ origin: `http://127.0.0.1:${port}` });
      await reach({ origin: "http://evil.test", "x-forwarded-for": "203.0.113.7" });
      assert.deepEqual(
        seen.map((c) => [c.principal, c.originAllowed]),
        [[null, true], [null, true], [null, false]],
      );
      assert.equal(seen[2]?.clientAddress, "203.0.113.7");
      assert.equal(seen[0]?.clientAddress, "127.0.0.1");
    },
  );
});

test("a request target that can't be parsed is a 400 for anyone, not a 500", async () => {
  await withTransport({ authToken: "secret" }, async (port) => {
    assert.equal((await rawRequest(port, { path: "//" })).status, 400);
  });
});

test("public /healthz says only ok, to anyone; /readyz is behind auth and reports state", async () => {
  let ready = false;
  await withTransport(
    {
      authenticate: tokensFor(principal("a")),
      publicHealthz: true,
      readyState: () => ({ ready, engine: "cloakbrowser", engineStatus: ready ? "ready" : "downloading" }),
    },
    async (port) => {
      for (const headers of [{}, { host: "evil.test" }, bearer("a")]) {
        const health = await rawRequest(port, { path: "/healthz", headers });
        assert.equal(health.status, 200);
        assert.deepEqual(JSON.parse(health.text), { ok: true });
      }
      assert.equal((await rawRequest(port, { path: "/readyz" })).status, 401);
      const waiting = await rawRequest(port, { path: "/readyz", headers: bearer("a") });
      assert.equal(waiting.status, 503);
      assert.deepEqual(JSON.parse(waiting.text), {
        ready: false,
        engine: "cloakbrowser",
        engineStatus: "downloading",
        sessions: { sse: 0, streamable: 0 },
      });
      ready = true;
      assert.equal((await rawRequest(port, { path: "/readyz", headers: bearer("a") })).status, 200);
    },
  );
});

test("TLS: the same transport over https", async () => {
  const cert = readFileSync(new URL("./testdata/tls-test-only.crt", import.meta.url));
  const key = readFileSync(new URL("./testdata/tls-test-only.key", import.meta.url));
  await withTransport({ tls: { cert, key }, publicHealthz: true }, async (port) => {
    const reply = await new Promise<RawReply>((resolve, reject) => {
      const req = httpsRequest(
        {
          host: "127.0.0.1",
          port,
          method: "POST",
          path: "/mcp",
          headers: MCP_HEADERS,
          ca: cert,
        },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => (text += chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
        },
      );
      req.on("error", reject);
      req.end(INITIALIZE);
    });
    assert.equal(reply.status, 200, reply.text);
    assert.ok(reply.headers["mcp-session-id"]);
    await assert.rejects(rawRequest(port, { path: "/healthz" }), "plain HTTP doesn't get through");
  });
});

// ── a client that vanishes ───────────────────────────────────────────────────

class RecordingDriver extends MockBrowserDriver {
  readonly log: string[] = [];
  barrier: Promise<void> | null = null;

  override async click(_id: string, selector: string): Promise<{ ok: true }> {
    this.log.push(`click ${selector}`);
    await this.barrier;
    return { ok: true };
  }
}

const PROFILE_ROWS = ["p", "q"].map((id) => ({ id, name: id, tags: [], isRunning: false }));
const profiles = {
  get: (id: string) => (PROFILE_ROWS.some((p) => p.id === id) ? ({ id, dataDir: "unused" } as Profile) : null),
  list: () => PROFILE_ROWS,
  create: (input: { name: string }) => ({ id: "new", fingerprint: {}, ...input }),
} as unknown as ProfileManager;

async function realMcp(
  opts: Partial<HttpTransportOptions>,
  run: (ctx: { port: number; t: HttpTransport; driver: RecordingDriver; shared: SharedMcpState }) => Promise<void>,
): Promise<void> {
  const driver = new RecordingDriver();
  const shared = createSharedMcpState();
  await withTransport(
    {
      createServer: () =>
        createMultizenMcpServer({ profileManager: profiles, browserDriver: driver, shared }).server,
      ...opts,
    },
    (port, t) => run({ port, t, driver, shared }),
  );
}

test("a Streamable client that vanishes without DELETE leaves no queued call behind", async () => {
  await realMcp({}, async ({ port, driver, shared }) => {
    await driver.launch("p");
    const gate = barrier();
    driver.barrier = gate.wait;
    const holder = await connectStreamable(port);
    const leaver = await connectStreamable(port);

    const held = holder.callTool({ name: "click", arguments: { profile_id: "p", selector: "#held" } });
    await until(() => driver.log.includes("click #held"), "the first click to run");
    const queued = leaver.callTool({ name: "click", arguments: { profile_id: "p", selector: "#queued" } });
    await until(() => shared.mutex.queued("p") === 1, "the second click to queue");

    // Client.close aborts its requests and sends no DELETE: a process that died looks the same.
    await leaver.close();
    await assert.rejects(queued);
    await until(() => shared.mutex.queued("p") === 0, "the queue to drop it");

    gate.open();
    await held;
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(driver.log, ["click #held"]);
    await holder.close();
  });
});

test("a call answered in full doesn't count as its client having gone", async () => {
  await realMcp({}, async ({ port, driver, shared }) => {
    await driver.launch("p");
    const c = await connectStreamable(port);
    for (const selector of ["#1", "#2", "#3"]) {
      await c.callTool({ name: "click", arguments: { profile_id: "p", selector } });
    }
    assert.deepEqual(driver.log, ["click #1", "click #2", "click #3"]);
    assert.equal(shared.mutex.isHeld("p"), false);
    await c.close();
  });
});

test("closing a principal's sessions drops what they had queued", async () => {
  const a = principal("a");
  const b = principal("b");
  await realMcp({ authenticate: tokensFor(a, b) }, async ({ port, t, driver, shared }) => {
    await driver.launch("p");
    const gate = barrier();
    driver.barrier = gate.wait;
    const holder = await connectStreamable(port, "b");
    const revoked = await connectStreamable(port, "a");

    const held = holder.callTool({ name: "click", arguments: { profile_id: "p", selector: "#b" } });
    await until(() => driver.log.includes("click #b"), "b's click to run");
    const queued = revoked.callTool({ name: "click", arguments: { profile_id: "p", selector: "#a" } });
    await until(() => shared.mutex.queued("p") === 1, "a's click to queue");

    await t.closeSessionsFor("a");
    await until(() => shared.mutex.queued("p") === 0, "the queue to drop it");
    gate.open();
    await held;
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(driver.log, ["click #b"]);
    await holder.close();
    // The stream ended with no answer: nothing more reaches this client, and it stops waiting here.
    await revoked.close();
    await assert.rejects(queued);
  });
});

// ── permissions, over the wire ───────────────────────────────────────────────

function toolJson(result: unknown): Record<string, any> {
  return JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text) as Record<string, any>;
}

test("a token sees only its tools, and FORBIDDEN on the others", async () => {
  const reader = principal("reader", { tools: { groups: ["read"], names: [] } });
  const named = principal("named", { tools: { groups: [], names: ["click", "list_profiles"] } });
  await realMcp({ authenticate: tokensFor(reader, named) }, async ({ port, driver }) => {
    await driver.launch("p");
    const c = await connectStreamable(port, "reader");
    const names = (await c.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes("extract"));
    for (const hidden of ["click", "cdp_send", "cdp_send_no_safety", "create_profile", "resume_human"]) {
      assert.ok(!names.includes(hidden), hidden);
    }
    const refused = await c.callTool({ name: "click", arguments: { profile_id: "p", selector: "#x" } });
    assert.equal((refused as { isError?: boolean }).isError, true);
    assert.equal(toolJson(refused).error.code, "FORBIDDEN");
    assert.deepEqual(driver.log, []);
    await c.close();

    const n = await connectStreamable(port, "named");
    assert.deepEqual((await n.listTools()).tools.map((t) => t.name).sort(), ["click", "list_profiles"]);
    await n.callTool({ name: "click", arguments: { profile_id: "p", selector: "#x" } });
    assert.deepEqual(driver.log, ["click #x"]);
    await n.close();
  });
});

test("a scoped token sees and reaches only its profiles, and can't create one", async () => {
  const scoped = principal("scoped", {
    profiles: ["p"],
    tools: { groups: ["read", "act", "profile-admin"], names: [] },
  });
  const admin = principal("admin", { tools: { groups: ["read", "profile-admin"], names: [] } });
  await realMcp({ authenticate: tokensFor(scoped, admin) }, async ({ port, driver }) => {
    await driver.launch("p");
    await driver.launch("q");
    const c = await connectStreamable(port, "scoped");
    const listed = toolJson(await c.callTool({ name: "list_profiles", arguments: {} }));
    assert.deepEqual((listed.profiles as Array<{ id: string }>).map((p) => p.id), ["p"]);

    const other = await c.callTool({ name: "click", arguments: { profile_id: "q", selector: "#x" } });
    assert.equal(toolJson(other).error.code, "FORBIDDEN");
    const own = await c.callTool({ name: "click", arguments: { profile_id: "p", selector: "#x" } });
    assert.notEqual((own as { isError?: boolean }).isError, true);

    const create = await c.callTool({ name: "create_profile", arguments: { name: "n" } });
    assert.equal(toolJson(create).error.code, "FORBIDDEN");
    assert.match(toolJson(create).error.message, /limited to some profiles/);
    await c.close();

    const a = await connectStreamable(port, "admin");
    const created = await a.callTool({ name: "create_profile", arguments: { name: "n" } });
    assert.notEqual((created as { isError?: boolean }).isError, true, JSON.stringify(created));
    const all = toolJson(await a.callTool({ name: "list_profiles", arguments: {} }));
    assert.equal((all.profiles as unknown[]).length, 2);
    await a.close();
  });
});

test("launch_profile keeps the way into the browser from a token without raw", async () => {
  const plain = principal("plain");
  const grouped = principal("grouped", { tools: { groups: ["act", "raw"], names: [] } });
  const named = principal("named", { tools: { groups: ["act"], names: ["cdp_send"] } });
  await realMcp({ authenticate: tokensFor(plain, grouped, named) }, async ({ port }) => {
    const launch = async (token: string): Promise<Record<string, any>> => {
      const c = await connectStreamable(port, token);
      const result = toolJson(await c.callTool({ name: "launch_profile", arguments: { profile_id: "p" } }));
      await c.close();
      return result;
    };
    const stripped = await launch("plain");
    assert.equal(stripped.id, "p");
    assert.equal(typeof stripped.startedAt, "string");
    assert.equal("cdpEndpoint" in stripped, false);
    assert.equal("pid" in stripped, false);

    for (const token of ["grouped", "named"]) {
      const whole = await launch(token);
      assert.equal(typeof whole.cdpEndpoint, "string", token);
      assert.equal(typeof whole.pid, "number", token);
    }
  });
});

test("the activity log names the token behind each call", async () => {
  const log = new ActivityLog();
  const driver = new RecordingDriver();
  await driver.launch("p");
  const shared = createSharedMcpState();
  await withTransport(
    {
      authenticate: tokensFor(principal("ci-agent")),
      createServer: () =>
        createMultizenMcpServer({
          profileManager: profiles,
          browserDriver: driver,
          shared,
          activityLog: log,
        }).server,
    },
    async (port) => {
      const c = await connectStreamable(port, "ci-agent");
      await c.callTool({ name: "click", arguments: { profile_id: "p", selector: "#x" } });
      await c.close();
    },
  );
  assert.equal(log.recent().at(-1)?.tool, "click");
  assert.equal(log.recent().at(-1)?.actor, "ci-agent");
});

// ── the desktop's path, unchanged ────────────────────────────────────────────

test("desktop: authToken is the full principal, /healthz gated and rich, no /readyz", async () => {
  await realMcp({ authToken: "secret" }, async ({ port, driver }) => {
    await driver.launch("p");
    const refused = await rawRequest(port, { path: "/mcp" });
    assert.equal(refused.status, 401);
    assert.match(refused.text, /MultiZen → Settings → MCP/);
    assert.equal((await rawRequest(port, { path: "/healthz" })).status, 401);
    assert.equal((await rawRequest(port, { path: "/healthz", headers: bearer("wrong") })).status, 401);

    const health = await rawRequest(port, {
      path: "/healthz",
      headers: { ...bearer("secret"), host: "any.test" },
    });
    assert.deepEqual(JSON.parse(health.text), {
      ok: true,
      name: "multizen-mcp",
      sessions: { sse: 0, streamable: 0 },
      connected: false,
    });
    assert.equal((await rawRequest(port, { path: "/readyz", headers: bearer("secret") })).status, 404);

    const c = await connectStreamable(port, "secret");
    const names = (await c.listTools()).tools.map((t) => t.name);
    for (const tool of ["cdp_send_no_safety", "cdp_send", "resume_human", "create_profile", "click"]) {
      assert.ok(names.includes(tool), tool);
    }
    const launched = toolJson(await c.callTool({ name: "launch_profile", arguments: { profile_id: "q" } }));
    assert.equal(typeof launched.cdpEndpoint, "string");
    assert.equal(typeof launched.pid, "number");
    const listed = toolJson(await c.callTool({ name: "list_profiles", arguments: {} }));
    assert.equal((listed.profiles as unknown[]).length, 2);
    await c.close();
  });
});

test("desktop: ten bad tokens stay 401, as no limiter is configured", async () => {
  await withTransport({ authToken: "secret" }, async (port) => {
    for (let i = 0; i < 12; i++) {
      assert.equal((await rawRequest(port, { headers: bearer("wrong") })).status, 401);
    }
  });
});

// ── per-token limits ─────────────────────────────────────────────────────────

const READER = principal("reader");
const OWNER = principal("owner");
/** Opening one at a time, each older than the next. */
async function sessionsOf(port: number, token: string, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    ids.push(await openSession(port, token));
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  return ids;
}

function sessionAlive(port: number, id: string, token: string): Promise<boolean> {
  return rawRequest(port, {
    method: "POST",
    headers: { ...MCP_HEADERS, ...bearer(token), "mcp-session-id": id },
    body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
  }).then((reply) => reply.status !== 404);
}

test("past its cap a token loses its own oldest idle session, and nobody else's", async () => {
  await withTransport(
    {
      authenticate: tokensFor(READER, OWNER),
      sessionPolicy: { maxSessions: 8, maxSessionsPerPrincipal: 3 },
    },
    async (port, t) => {
      const owners = await sessionsOf(port, "owner", 2);
      const [oldest, second, third] = await sessionsOf(port, "reader", 3);
      assert.equal(t.status().streamable, 5);

      const newest = await openSession(port, "reader");
      assert.equal(t.status().streamable, 5, "one in, one out");
      assert.equal(await sessionAlive(port, oldest!, "reader"), false);
      for (const id of [second!, third!, newest]) assert.equal(await sessionAlive(port, id, "reader"), true);
      for (const id of owners) assert.equal(await sessionAlive(port, id, "owner"), true);

      for (let i = 0; i < 20; i++) await openSession(port, "reader");
      assert.equal(t.status().streamable, 5, "however many it opens");
      await openSession(port, "owner");
      assert.equal(t.status().streamable, 6, "the owner still gets in");
    },
  );
});

test("a session with a call in flight isn't evicted; with none idle the new one gets SESSION_LIMIT", async () => {
  const gate = barrier();
  await withTransport(
    {
      authenticate: tokensFor(READER, OWNER),
      sessionPolicy: { maxSessionsPerPrincipal: 1 },
      createServer: serverWithTool(gate.wait),
    },
    async (port, t) => {
      const busy = await connectStreamable(port, "reader");
      const call = busy.callTool({ name: "slow" });
      await until(() => t.status().streamable === 1, "the session");
      await new Promise((resolve) => setTimeout(resolve, 50));

      const refused = await rawRequest(port, {
        method: "POST",
        headers: { ...MCP_HEADERS, ...bearer("reader") },
        body: INITIALIZE,
      });
      assert.equal(refused.status, 503);
      const { error } = JSON.parse(refused.text) as { error: { data: { code: string; retryable: boolean } } };
      assert.equal(error.data.code, "SESSION_LIMIT");
      assert.equal(error.data.retryable, true);
      assert.equal(t.status().streamable, 1);
      await openSession(port, "owner");

      gate.open();
      await call;
      await busy.close();
    },
  );
});

test("legacy SSE counts against the same cap, and its oldest idle stream goes the same way", async () => {
  await withTransport(
    { authenticate: tokensFor(READER), sessionPolicy: { maxSessionsPerPrincipal: 2 } },
    async (port, t) => {
      const first = await connectSse(port, "reader");
      await connectSse(port, "reader");
      assert.equal(t.status().sse, 2);
      await connectStreamable(port, "reader");
      assert.equal(t.status().sse + t.status().streamable, 2);
      void first;
    },
  );
});

interface HeldPost {
  /** Its answer, or null when the socket closed with none. */
  reply: Promise<RawReply | null>;
  closed: Promise<void>;
  destroy: () => void;
}

/** A POST that declares its size, sends `sent` of it and then stalls, as a slow client's would. */
function stalledPost(port: number, bytes: number, token: string, sent = "{"): HeldPost {
  let setClosed = (): void => {};
  const closed = new Promise<void>((resolve) => (setClosed = resolve));
  let setReply = (_: RawReply | null): void => {};
  const reply = new Promise<RawReply | null>((resolve) => (setReply = resolve));
  const req = httpRequest(
    {
      host: "127.0.0.1",
      port,
      method: "POST",
      path: "/mcp",
      // A socket of its own, as what is on hold shouldn't be reused for what comes next, and one
      // kept alive, or an answer would end it whatever the server's limits.
      agent: false,
      headers: { ...MCP_HEADERS, ...bearer(token), connection: "keep-alive", "content-length": String(bytes) },
    },
    (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (text += chunk));
      res.on("end", () => setReply({ status: res.statusCode ?? 0, headers: res.headers, text }));
      res.on("error", () => setReply(null));
    },
  );
  req.on("error", () => setReply(null));
  req.on("close", () => {
    setReply(null);
    setClosed();
  });
  if (sent) req.write(sent);
  else req.flushHeaders();
  return { reply, closed, destroy: () => req.destroy() };
}

function bodyBytesInFlight(t: HttpTransport): number {
  return (t as unknown as { bodyBytesInFlight: number }).bodyBytesInFlight;
}

/** The transport's own count of requests seen, since nothing on the wire says one has arrived. */
function countingRequests(authenticate: (req: IncomingMessage) => Principal | null): {
  authenticate: (req: IncomingMessage) => Principal | null;
  seen: () => number;
} {
  let seen = 0;
  return {
    seen: () => seen,
    authenticate: (req) => {
      seen += 1;
      return authenticate(req);
    },
  };
}

const MIB = 1024 * 1024;

test("a declared length holds nothing: six POSTs saying 128 MiB, no body sent, leave everyone's answer", async () => {
  const counted = countingRequests(tokensFor(READER, OWNER));
  await withTransport(
    { authenticate: counted.authenticate, maxBodyBytesInFlight: 128 * MIB },
    async (port, t) => {
      const held = [
        ...Array.from({ length: 5 }, () => stalledPost(port, 22 * MIB, "reader", "")),
        stalledPost(port, 18 * MIB, "reader", ""),
      ];
      await until(() => counted.seen() >= held.length, "the server to see them");
      const least = 128 * MIB / 512;
      assert.equal(bodyBytesInFlight(t), held.length * least, "what they cost is what any request costs");
      for (const token of ["owner", "reader"]) {
        const answer = await rawRequest(port, {
          method: "POST",
          headers: { ...MCP_HEADERS, ...bearer(token) },
          body: INITIALIZE,
        });
        assert.equal(answer.status, 200, answer.text);
      }
      for (const post of held) post.destroy();
      await until(() => bodyBytesInFlight(t) === 0, "their charges to go");
    },
  );
});

test("a token's bytes stop at its quarter of the budget: past it a typed refusal, and others go on", async () => {
  await withTransport(
    { authenticate: tokensFor(READER, OWNER), maxBodyBytesInFlight: 4_000, maxRequestBytes: 3_000 },
    async (port, t) => {
      const holding = stalledPost(port, 2_000, "reader", "x".repeat(900));
      await until(() => bodyBytesInFlight(t) >= 900, "those bytes to arrive");

      const refused = await rawRequest(port, {
        method: "POST",
        headers: { ...MCP_HEADERS, ...bearer("reader") },
        body: INITIALIZE.padEnd(200, " "),
      });
      assert.equal(refused.status, 503);
      assert.equal(refused.headers["retry-after"], "1");
      const { error } = JSON.parse(refused.text) as {
        error: { message: string; data: { code: string; retryable: boolean; details: { retry_after_ms: number } } };
      };
      assert.match(error.message, /This token's requests/);
      assert.equal(error.data.code, "RATE_LIMITED");
      assert.equal(error.data.retryable, true);
      assert.equal(error.data.details.retry_after_ms, 1_000);

      // Someone else's still fits, again and again, and each gives back what it took.
      for (let i = 0; i < 5; i++) {
        const ok = await rawRequest(port, {
          method: "POST",
          headers: { ...MCP_HEADERS, ...bearer("owner") },
          body: INITIALIZE.padEnd(800, " "),
        });
        assert.equal(ok.status, 200, ok.text);
      }

      holding.destroy();
      await until(() => bodyBytesInFlight(t) < 900, "the stalled one's charge to go");
      const after = await rawRequest(port, {
        method: "POST",
        headers: { ...MCP_HEADERS, ...bearer("reader") },
        body: INITIALIZE.padEnd(800, " "),
      });
      assert.equal(after.status, 200, "the stalled one gave its budget back");
    },
  );
});

test("the budget over all tokens holds too, however fair each one's share", async () => {
  const tokens = ["a", "b", "c", "d", "e"];
  await withTransport(
    {
      authenticate: tokensFor(...tokens.map((id) => principal(id))),
      maxBodyBytesInFlight: 1_000,
      maxRequestBytes: 800,
    },
    async (port, t) => {
      const held = tokens.slice(0, 4).map((token) => stalledPost(port, 500, token, "x".repeat(240)));
      await until(() => bodyBytesInFlight(t) >= 960, "their bytes to arrive");
      const refused = await rawRequest(port, {
        method: "POST",
        headers: { ...MCP_HEADERS, ...bearer("e") },
        body: "x".repeat(100),
      });
      assert.equal(refused.status, 503);
      assert.match(refused.text, /this server's 1000 bytes/);
      for (const post of held) post.destroy();
    },
  );
});

test("however many stalled bodies a token opens, each costs enough that they can't hold every socket", async () => {
  const counted = countingRequests(tokensFor(READER, OWNER));
  await withTransport(
    { authenticate: counted.authenticate, maxBodyBytesInFlight: 5_120 },
    async (port) => {
      const held = Array.from({ length: 129 }, () => stalledPost(port, 500, "reader", ""));
      await until(() => counted.seen() >= held.length, "the server to see them", 15_000);
      const replies = await Promise.race([
        Promise.any(held.map((post) => post.reply.then((reply) => reply ?? Promise.reject(new Error("closed"))))),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 3_000)),
      ]);
      assert.equal(replies?.status, 503, "the 129th is refused");
      const owner = await rawRequest(port, {
        method: "POST",
        headers: { ...MCP_HEADERS, ...bearer("owner") },
        body: INITIALIZE,
      });
      assert.equal(owner.status, 200);
      for (const post of held) post.destroy();
    },
  );
});

test("a body has a deadline: 408, the socket closes, and what it held comes back", async () => {
  await withTransport(
    { authenticate: tokensFor(READER), maxBodyBytesInFlight: 4_000, bodyReadTimeoutMs: 150 },
    async (port, t) => {
      const fine = await rawRequest(port, {
        method: "POST",
        headers: { ...MCP_HEADERS, ...bearer("reader") },
        body: INITIALIZE,
      });
      assert.equal(fine.status, 200, "one that arrives in time");

      const stalled = stalledPost(port, 500, "reader", "x".repeat(100));
      const reply = await stalled.reply;
      assert.equal(reply?.status, 408);
      const { error } = JSON.parse(reply!.text) as { error: { data: { code: string; retryable: boolean } } };
      assert.equal(error.data.code, "TIMEOUT");
      assert.equal(error.data.retryable, true);
      assert.equal(reply!.headers.connection, "close");
      await stalled.closed;
      await until(() => bodyBytesInFlight(t) === 0, "its charge to go");
    },
  );
});

test("a refused body whose client never finishes is cut at the deadline too", async () => {
  await withTransport(
    { authenticate: tokensFor(READER), maxBodyBytesInFlight: 400, bodyReadTimeoutMs: 150 },
    async (port) => {
      const started = performance.now();
      const refused = stalledPost(port, 500, "reader", "x".repeat(300));
      assert.equal((await refused.reply)?.status, 503);
      await refused.closed;
      assert.ok(performance.now() - started < 3_000, "sooner than the keep-alive's own 5 s would have");
    },
  );
});

test("the end of a token drops the bodies it was still sending, and no one else's", async () => {
  await withTransport(
    { authenticate: tokensFor(READER, OWNER), maxBodyBytesInFlight: 4_000 },
    async (port, t) => {
      const readers = [stalledPost(port, 500, "reader", "x".repeat(100)), stalledPost(port, 500, "reader", "x".repeat(100))];
      const owners = stalledPost(port, 500, "owner", "x".repeat(100));
      await until(() => bodyBytesInFlight(t) >= 300, "their bytes to arrive");

      await t.closeSessionsFor("reader");
      await Promise.all(readers.map((post) => post.closed));
      await until(() => bodyBytesInFlight(t) <= 100, "their charges to go");
      let ownersClosed = false;
      void owners.closed.then(() => (ownersClosed = true));
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(ownersClosed, false);
      owners.destroy();
    },
  );
});

test("a chunked body is charged as it arrives", async () => {
  await withTransport(
    { authenticate: tokensFor(OWNER), maxBodyBytesInFlight: 100 },
    async (port) => {
      const reply = await new Promise<RawReply>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port, method: "POST", path: "/mcp", headers: { ...MCP_HEADERS, ...bearer("owner") } },
          (res) => {
            let text = "";
            res.setEncoding("utf8");
            res.on("data", (chunk: string) => (text += chunk));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
          },
        );
        req.on("error", reject);
        req.write("x".repeat(60));
        setTimeout(() => req.end("x".repeat(60)), 20);
      });
      assert.equal(reply.status, 503);
      assert.match(reply.text, /RATE_LIMITED/);
    },
  );
});

test("sockets past maxConnections are dropped, and those within it work", async () => {
  await withTransport({ maxConnections: 2, authenticate: tokensFor(OWNER) }, async (port) => {
    const open: Socket[] = [];
    for (let i = 0; i < 2; i++) {
      const socket = netConnect(port, "127.0.0.1");
      socket.on("error", () => {});
      await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
      open.push(socket);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    const extra = netConnect(port, "127.0.0.1");
    extra.on("error", () => {});
    await new Promise<void>((resolve) => extra.once("close", () => resolve()));
    for (const socket of open) socket.destroy();
  });
});

/** Idle sockets: connected, and saying nothing. */
async function holdSockets(port: number, count: number, localAddress?: string): Promise<Socket[]> {
  const sockets: Socket[] = [];
  for (let i = 0; i < count; i++) {
    const socket = netConnect({ port, host: "127.0.0.1", ...(localAddress ? { localAddress } : {}) });
    socket.on("error", () => {});
    // Or what the server says last would sit unread, and this end would never see it close.
    socket.resume();
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    sockets.push(socket);
  }
  return sockets;
}

const stillOpen = (sockets: Socket[]): Socket[] => sockets.filter((socket) => !socket.destroyed && !socket.closed);

async function ownerGetsThrough(port: number): Promise<void> {
  const healthz = await rawRequest(port, { path: "/healthz" });
  assert.equal(healthz.status, 200);
  const answer = await rawRequest(port, {
    method: "POST",
    headers: { ...MCP_HEADERS, ...bearer("owner") },
    body: INITIALIZE,
  });
  assert.equal(answer.status, 200, answer.text);
}

test("idle sockets with no token can't keep out someone with one, even from the same address", async () => {
  await withTransport(
    {
      authenticate: tokensFor(OWNER),
      publicHealthz: true,
      maxConnections: 20,
      anonymousSockets: { perAddress: 4, total: 8 },
    },
    async (port) => {
      const idle = await holdSockets(port, 30);
      await until(() => stillOpen(idle).length <= 4, "the oldest to be closed");
      assert.deepEqual(stillOpen(idle), idle.slice(-4), "the newest stay, as one of those may be about to speak");
      await ownerGetsThrough(port);
      for (const socket of idle) socket.destroy();
    },
  );
});

test("one address's sockets don't cost another address its own", async () => {
  await withTransport(
    { authenticate: tokensFor(OWNER), publicHealthz: true, anonymousSockets: { perAddress: 3, total: 100 } },
    async (port) => {
      const mine = await holdSockets(port, 3, "127.0.0.1");
      const theirs = await holdSockets(port, 20, "127.0.0.2");
      await until(() => stillOpen(theirs).length <= 3, "their oldest to be closed");
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(stillOpen(mine).length, 3);
      for (const socket of [...mine, ...theirs]) socket.destroy();
    },
  );
});

test("many addresses are held to the overall limit, oldest first, and the owner still gets through", async () => {
  await withTransport(
    {
      authenticate: tokensFor(OWNER),
      publicHealthz: true,
      maxConnections: 30,
      anonymousSockets: { perAddress: 4, total: 10 },
    },
    async (port) => {
      const idle: Socket[] = [];
      for (const address of ["127.0.0.2", "127.0.0.3", "127.0.0.4", "127.0.0.5"]) {
        idle.push(...(await holdSockets(port, 4, address)));
      }
      await until(() => stillOpen(idle).length <= 10, "the oldest to be closed");
      assert.deepEqual(stillOpen(idle), idle.slice(-10));
      await ownerGetsThrough(port);
      for (const socket of idle) socket.destroy();
    },
  );
});

test("a valid token takes a socket out of the count, a /healthz or a wrong token doesn't", async () => {
  await withTransport(
    { authenticate: tokensFor(OWNER), publicHealthz: true, anonymousSockets: { perAddress: 2, total: 100 } },
    async (port) => {
      const agent = new HttpAgent({ keepAlive: true, maxSockets: 1 });
      const ask = (path: string, token: string): Promise<{ status: number; reused: boolean }> =>
        new Promise((resolve, reject) => {
          const req = httpRequest({ host: "127.0.0.1", port, path, agent, headers: bearer(token) }, (res) => {
            res.resume();
            res.on("end", () => resolve({ status: res.statusCode ?? 0, reused: req.reusedSocket }));
          });
          req.on("error", reject);
          req.end();
        });
      try {
        assert.equal((await ask("/nothing", "owner")).status, 404);

        const spoken = (head: string): Promise<Socket> =>
          holdSockets(port, 1).then(async ([socket]) => {
            const answered = new Promise((resolve) => socket!.once("data", resolve));
            socket!.write(head);
            await answered;
            return socket!;
          });
        const probing = await spoken("GET /healthz HTTP/1.1\r\nHost: x\r\n\r\n");
        const wrong = await spoken(`GET /nothing HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer nope\r\n\r\n`);
        const idle = await holdSockets(port, 6);
        await until(() => stillOpen(idle).length <= 2, "the oldest to be closed");
        assert.equal(probing.closed || probing.destroyed, true, "a probe proves nothing");
        assert.equal(wrong.closed || wrong.destroyed, true, "nor does a wrong token");

        const again = await ask("/nothing", "owner");
        assert.equal(again.reused, true, "the owner's own socket was left alone");
        for (const socket of idle) socket.destroy();
      } finally {
        agent.destroy();
      }
    },
  );
});

test("TLS: a token proves the socket under it, and an idle one is held to the handshake's time", async () => {
  const certs = {
    cert: readFileSync(new URL("./testdata/tls-test-only.crt", import.meta.url)),
    key: readFileSync(new URL("./testdata/tls-test-only.key", import.meta.url)),
  };
  await withTransport(
    {
      authenticate: tokensFor(OWNER),
      tls: certs,
      headersTimeoutMs: 200,
      anonymousSockets: { perAddress: 2, total: 100 },
    },
    async (port) => {
      const agent = new HttpsAgent({ keepAlive: true, maxSockets: 1, rejectUnauthorized: false });
      const ask = (): Promise<{ status: number; reused: boolean }> =>
        new Promise((resolve, reject) => {
          const req = httpsRequest(
            { host: "127.0.0.1", port, path: "/nothing", agent, headers: bearer("owner") },
            (res) => {
              res.resume();
              res.on("end", () => resolve({ status: res.statusCode ?? 0, reused: req.reusedSocket }));
            },
          );
          req.on("error", reject);
          req.end();
        });
      try {
        assert.equal((await ask()).status, 404);
        const idle = await holdSockets(port, 6);
        await until(() => stillOpen(idle).length <= 2, "the oldest to be closed");
        assert.equal((await ask()).reused, true, "the owner's own socket was left alone");
        await until(() => stillOpen(idle).length === 0, "the handshake's time to end them", 5_000);
      } finally {
        agent.destroy();
      }
    },
  );
});

test("a socket has this long to send its headers: none, or some of them", async () => {
  await withTransport({ authenticate: tokensFor(OWNER), headersTimeoutMs: 100 }, async (port) => {
    const [silent, partial] = await holdSockets(port, 2);
    partial!.write("GET /healthz HTTP/1.1\r\nHost:");
    const closedSoon = (socket: Socket): Promise<void> =>
      new Promise((resolve, reject) => {
        const giveUp = setTimeout(() => reject(new Error("still open")), 5_000);
        socket.once("close", () => {
          clearTimeout(giveUp);
          resolve();
        });
      });
    await Promise.all([closedSoon(silent!), closedSoon(partial!)]);
    const owner = await rawRequest(port, {
      method: "POST",
      headers: { ...MCP_HEADERS, ...bearer("owner") },
      body: INITIALIZE,
    });
    assert.equal(owner.status, 200, "one that does speak isn't held to it");
  });
});

test("a socket counts against its address, an IPv6 client's against its /64", () => {
  assert.equal(addressGroup("203.0.113.9"), "203.0.113.9");
  assert.equal(addressGroup("::ffff:203.0.113.9"), "203.0.113.9");
  assert.equal(addressGroup("2001:db8:1:2:a::1"), "2001:db8:1:2::/64");
  assert.equal(addressGroup("2001:0db8:1:2:b:c:d:e"), "2001:db8:1:2::/64");
  assert.notEqual(addressGroup("2001:db8:1:3::1"), addressGroup("2001:db8:1:2::1"));
  assert.equal(addressGroup("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(addressGroup("::1"), "0:0:0:0::/64");
  assert.equal(addressGroup("fe80::1%eth0"), "fe80:0:0:0::/64");
});

test("with none of these options, as on a desktop, one principal opens all it likes and nothing is charged", async () => {
  await withTransport({ authenticate: tokensFor(OWNER), maxRequestBytes: 800 }, async (port, t) => {
    for (let i = 0; i < 40; i++) await openSession(port, "owner");
    assert.equal(t.status().streamable, 40);
    const server = (t as unknown as { server: { maxConnections?: number; headersTimeout: number } }).server;
    assert.equal(server.maxConnections, undefined);
    assert.equal(server.headersTimeout, 60_000, "Node's own");
    const idle = await holdSockets(port, 30);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(stillOpen(idle).length, 30, "no socket is anyone's to close");
    assert.equal((t as unknown as { anonymousSockets: Map<string, unknown> }).anonymousSockets.size, 0);
    for (const socket of idle) socket.destroy();
    const stalled = stalledPost(port, 500, "owner", "x");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(bodyBytesInFlight(t), 0);
    stalled.destroy();
  });
});
