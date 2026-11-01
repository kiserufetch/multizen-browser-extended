import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { InMemoryHumanHandoff } from "@multizen/mcp-server";
import { startHandoffWebhook } from "./handoffWebhook.ts";

interface Received {
  headers: IncomingMessage["headers"];
  body: string;
  url: string;
}

async function listener(
  handle: (req: IncomingMessage, res: ServerResponse, body: string) => void = (_q, res) =>
    void res.writeHead(204).end(),
): Promise<{ url: string; received: Received[]; close: () => Promise<void> }> {
  const received: Received[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      received.push({ headers: req.headers, body, url: req.url ?? "" });
      handle(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // A test that fails before its close would otherwise hold the whole run open.
  server.unref();
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/hook`,
    received,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function capturingLogger(): { warn: (msg: string, fields?: Record<string, unknown>) => void; lines: string[] } {
  const lines: string[] = [];
  return { lines, warn: (msg, fields) => lines.push(JSON.stringify({ msg, ...fields })) };
}

const until = async (check: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

test("a new handoff is posted once, with no token, whatever happens to it next", async () => {
  const hook = await listener();
  const handoff = new InMemoryHumanHandoff();
  startHandoffWebhook({
    handoff,
    url: hook.url,
    panelUrl: "https://mz.example/panel",
    profileName: (id) => `name of ${id}`,
    logger: capturingLogger(),
  });
  const first = handoff.request("p", "solve it", { kind: "captcha" });
  handoff.request("p", "asked again");
  handoff.request("q", "another", { kind: "2fa" });
  await until(() => hook.received.length === 2, "two posts");
  handoff.resumeById(first.id);
  handoff.request("p", "a new one");
  await until(() => hook.received.length === 3, "the third");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(hook.received.length, 3, "one per handoff, not per change");

  const body = JSON.parse(hook.received[0]!.body) as Record<string, unknown>;
  assert.equal(body.id, first.id);
  assert.equal(body.profileId, "p");
  assert.equal(body.profileName, "name of p");
  assert.equal(body.kind, "captcha");
  assert.equal(body.reason, "solve it");
  assert.equal(body.panelUrl, `https://mz.example/panel#${first.id}`);
  assert.equal(typeof body.createdAt, "string");
  assert.equal(typeof body.expiresAt, "string");
  assert.doesNotMatch(hook.received[0]!.body, /token|cookie|bearer/i);
  assert.equal(hook.received[0]!.headers["x-multizen-signature"], undefined);
  await hook.close();
});

test("with a secret, the body is signed", async () => {
  const hook = await listener();
  const handoff = new InMemoryHumanHandoff();
  startHandoffWebhook({
    handoff,
    url: hook.url,
    secret: "shh",
    panelUrl: "http://x/panel",
    profileName: () => undefined,
    logger: capturingLogger(),
  });
  handoff.request("p", "x");
  await until(() => hook.received.length === 1, "the post");
  const [{ body, headers }] = hook.received as [Received];
  const expected = createHmac("sha256", "shh").update(body).digest("hex");
  assert.equal(headers["x-multizen-signature"], `sha256=${expected}`);
  assert.doesNotMatch(body, /shh/);
  await hook.close();
});

test("a redirect isn't followed, and is logged as what it is", async () => {
  const elsewhere = await listener();
  const hook = await listener((_q, res) => {
    res.writeHead(302, { location: elsewhere.url }).end();
  });
  const handoff = new InMemoryHumanHandoff();
  const logger = capturingLogger();
  startHandoffWebhook({ handoff, url: hook.url, panelUrl: "http://x/panel", profileName: () => undefined, logger });
  handoff.request("p", "x");
  await until(() => logger.lines.length === 1, "the log line");
  assert.equal(elsewhere.received.length, 0);
  assert.match(logger.lines[0]!, /"status":302/);
  await hook.close();
  await elsewhere.close();
});

test("an endpoint that's down, or refuses, costs a log line and nothing else", async () => {
  const hook = await listener((_q, res) => void res.writeHead(500).end("private detail"));
  const handoff = new InMemoryHumanHandoff();
  const logger = capturingLogger();
  startHandoffWebhook({ handoff, url: hook.url, panelUrl: "http://x/panel", profileName: () => undefined, logger });
  const { id } = handoff.request("p", "x");
  await until(() => logger.lines.length === 1, "the refusal");
  assert.match(logger.lines[0]!, /"status":500/);
  assert.equal(handoff.get(id)?.status, "pending", "the handoff carries on");
  await hook.close();

  const down = new InMemoryHumanHandoff();
  const downLog = capturingLogger();
  startHandoffWebhook({
    handoff: down,
    url: "http://user:s3cret@127.0.0.1:9/hook?key=s3cret",
    panelUrl: "http://x/panel",
    profileName: () => undefined,
    logger: downLog,
  });
  const started = Date.now();
  down.request("p", "SECRET-REASON");
  assert.ok(Date.now() - started < 50, "request_human doesn't wait for it");
  await until(() => downLog.lines.length === 1, "the failure");
  assert.doesNotMatch(downLog.lines[0]!, /s3cret/, "the URL may hold a credential");
  assert.doesNotMatch(downLog.lines[0]!, /SECRET-REASON/);
});

test("a hung endpoint is given up on at the timeout", async () => {
  const handoff = new InMemoryHumanHandoff();
  const logger = capturingLogger();
  const hook = await listener(() => {
    // Never answers.
  });
  startHandoffWebhook({
    handoff,
    url: hook.url,
    panelUrl: "http://x/panel",
    profileName: () => undefined,
    logger,
    timeoutMs: 50,
  });
  handoff.request("p", "x");
  await until(() => logger.lines.length === 1, "the timeout");
  assert.match(logger.lines[0]!, /TimeoutError/);
  await hook.close();
});
