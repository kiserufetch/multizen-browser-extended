import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createNetServer } from "node:net";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { HttpTransport } from "./HttpTransport.js";

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
