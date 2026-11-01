import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { createServer as createNetServer } from "node:net";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ProfileManager } from "@multizen/profile-manager";
import type { Profile } from "@multizen/types";

import { ActivityLog } from "./ActivityLog.js";
import { AuthFailureLimiter } from "./auth/AuthFailureLimiter.js";
import { createPrincipal, type Principal } from "./auth/principal.js";
import {
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
  const port = await freePort();
  const t = new HttpTransport({ port, createServer: makeServer, heartbeatMs: 0 });
  await t.start();
  try {
    const c1 = new Client({ name: "c1", version: "0" });
    await c1.connect(new SSEClientTransport(sseUrl(port)));
    assert.equal((await c1.listTools()).tools.length, 1);
    await c1.close();

    // The reconnect is the regression: previously the late teardown of the
    // first connection could clobber the new session's server binding.
    const c2 = new Client({ name: "c2", version: "0" });
    await c2.connect(new SSEClientTransport(sseUrl(port)));
    assert.equal((await c2.listTools()).tools.length, 1);
    await c2.close();
  } finally {
    await t.stop();
  }
});

test("legacy SSE: a second client does not break the first", async () => {
  const port = await freePort();
  const t = new HttpTransport({ port, createServer: makeServer, heartbeatMs: 0 });
  await t.start();
  try {
    const c1 = new Client({ name: "c1", version: "0" });
    await c1.connect(new SSEClientTransport(sseUrl(port)));
    const c2 = new Client({ name: "c2", version: "0" });
    await c2.connect(new SSEClientTransport(sseUrl(port)));
    assert.equal(t.status().sse, 2);

    // Closing c1 must not disturb c2 (each is bound to its own server).
    await c1.close();
    assert.equal((await c2.listTools()).tools.length, 1);
    await c2.close();
  } finally {
    await t.stop();
  }
});

test("stop() resolves promptly even with an open SSE connection", async () => {
  const port = await freePort();
  const t = new HttpTransport({ port, createServer: makeServer, heartbeatMs: 0 });
  await t.start();
  const c = new Client({ name: "c", version: "0" });
  await c.connect(new SSEClientTransport(sseUrl(port)));

  const started = Date.now();
  await t.stop();
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `stop() took ${elapsed}ms with an open SSE stream`);

  await c.close().catch(() => {});
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

async function connectSse(port: number, token?: string): Promise<Client> {
  const headers = token ? bearer(token) : {};
  const c = new Client({ name: "c", version: "0" });
  await c.connect(
    new SSEClientTransport(sseUrl(port), {
      eventSourceInit: { fetch: (url, init) => fetch(url, { ...init, headers: { ...init?.headers, ...headers } }) },
      requestInit: { headers },
    }),
  );
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

for (const [name, connect] of [
  ["streamable", connectStreamable],
  ["legacy SSE", connectSse],
] as const) {
  test(`${name}: a call in flight isn't idle, however long it takes; after it, the clock starts`, async () => {
    const gate = barrier();
    await withTransport(
      { sessionPolicy: { idleTtlMs: 60 }, createServer: serverWithTool(gate.wait) },
      async (port, t) => {
        const c = await connect(port);
        const open = (): number => t.status().streamable + t.status().sse;
        const call = c.callTool({ name: "slow", arguments: { at: "start" } });
        await new Promise((resolve) => setTimeout(resolve, 300));
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
    { sessionPolicy: { idleTtlMs: 60 }, createServer: serverWithTool(gate.wait) },
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
  await withTransport(
    {
      authenticate: tokensFor(),
      authFailureLimiter: new AuthFailureLimiter({ limit: 1, windowMs: 50 }),
    },
    async (port) => {
      assert.equal((await rawRequest(port)).status, 401);
      assert.equal((await rawRequest(port)).status, 429);
      await new Promise((resolve) => setTimeout(resolve, 80));
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
