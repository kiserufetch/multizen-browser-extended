import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { HttpTransport } from "../HttpTransport.js";
import { TOOL_GROUPS } from "./principal.js";
import { TokenStore } from "./TokenStore.js";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function newPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "mz-tokens-"));
  dirs.push(dir);
  return join(dir, "tokens.json");
}

function newStore(opts: ConstructorParameters<typeof TokenStore>[1] = {}): {
  path: string;
  store: TokenStore;
} {
  const path = newPath();
  return { path, store: new TokenStore(path, { warn: () => {}, ...opts }) };
}

/** Does what a CLI in another process does to the file: rewrite it whole, by rename. */
const REVOKE_SCRIPT = `
const { readFileSync, renameSync, writeFileSync } = require("node:fs");
const [path, id] = process.argv.slice(1);
const file = JSON.parse(readFileSync(path, "utf8"));
for (const t of file.tokens) if (t.id === id) t.revokedAt = new Date().toISOString();
writeFileSync(path + ".other", JSON.stringify(file));
renameSync(path + ".other", path);
`;

function revokeFromAnotherProcess(path: string, id: string): void {
  const res = spawnSync(process.execPath, ["-e", REVOKE_SCRIPT, path, id], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
}

test("the file holds hashes only, and the token its documented shape", () => {
  const { path, store } = newStore();
  const { token, record } = store.create({ name: "ci", groups: ["read", "act"] });
  assert.match(token, /^mz_t_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);
  assert.ok(token.startsWith(`mz_${record.id}_`));

  const onDisk = readFileSync(path, "utf8");
  const secret = token.slice(`mz_${record.id}_`.length);
  assert.equal(onDisk.includes(token), false);
  assert.equal(onDisk.includes(secret), false);

  const file = JSON.parse(onDisk) as { version: number; tokens: Array<Record<string, unknown>> };
  assert.equal(file.version, 1);
  assert.match(String(file.tokens[0]?.hash), /^sha256:[0-9a-f]{64}$/);
  assert.equal("panel" in file.tokens[0]!, false, "panel comes from the operator group only");
  assert.deepEqual(file.tokens[0]?.tools, { groups: ["read", "act"], names: [] });
  assert.equal(file.tokens[0]?.profiles, "*");
  assert.equal(file.tokens[0]?.revokedAt, null);
  assert.equal(file.tokens[0]?.expiresAt, null);
  assert.deepEqual(
    store.list().map((t) => "hash" in t),
    [false],
  );
});

test("the file's mode: 0600 and tightened if loosened; on Windows, a warning once instead", () => {
  const warnings: string[] = [];
  const { path, store } = newStore({ warn: (m) => warnings.push(m) });
  store.create({ name: "a", groups: ["read"] });
  store.create({ name: "b", groups: ["read"] });
  if (process.platform === "win32") {
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /relies on the directory's ACL/);
    return;
  }
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(warnings, []);

  chmodSync(path, 0o644);
  new TokenStore(path, { warn: (m) => warnings.push(m) });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.match(warnings[0] ?? "", /restricted to 0600/);
});

test("only the exact token authenticates", () => {
  const { store } = newStore();
  const { token, record } = store.create({ name: "a", groups: ["read"] });
  assert.equal(store.authenticate(token)?.id, record.id);

  const wrongSecret = `mz_${record.id}_${"A".repeat(43)}`;
  assert.equal(store.authenticate(wrongSecret), null);
  assert.equal(store.authenticate(`mz_t_00000000_${"A".repeat(43)}`), null);
  assert.equal(store.authenticate("0".repeat(64)), null);
  assert.equal(store.authenticate(""), null);
  assert.equal(store.authenticate(`${token}x`), null);

  assert.equal(store.authenticateHeader(`Bearer ${token}`)?.id, record.id);
  assert.equal(store.authenticateHeader(`bearer ${token}`)?.id, record.id);
  assert.equal(store.authenticateHeader(undefined), null);
  assert.equal(store.authenticateHeader(token), null);
  assert.equal(store.authenticateHeader(`Basic ${token}`), null);
});

test("a secret containing the separator still parses: the id ends where the length says", () => {
  const { store } = newStore();
  for (let i = 0; i < 50; i++) {
    const { token, record } = store.create({ name: `n${i}`, groups: ["read"] });
    assert.equal(store.authenticate(token)?.id, record.id);
  }
});

test("the principal carries the token's rights; panel only through operator; full only with it all", () => {
  const { store } = newStore();
  const limited = store.create({
    name: "limited",
    groups: ["read"],
    names: ["click"],
    profiles: ["p1", "p2"],
  });
  const principal = store.authenticate(limited.token)!;
  assert.equal(principal.name, "limited");
  assert.deepEqual(principal.tools, { groups: ["read"], names: ["click"] });
  assert.deepEqual(principal.profiles, ["p1", "p2"]);
  assert.equal(principal.panel, false);
  assert.equal(principal.full, false);

  const operator = store.create({ name: "operator", groups: ["read", "operator"] });
  assert.equal(store.authenticate(operator.token)!.panel, true);

  const owner = store.create({ name: "owner", groups: [...TOOL_GROUPS] });
  assert.equal(store.authenticate(owner.token)!.full, true);
  const scopedOwner = store.create({ name: "scoped", groups: [...TOOL_GROUPS], profiles: ["p"] });
  assert.equal(store.authenticate(scopedOwner.token)!.full, false);

  assert.deepEqual(
    store.list().map((t) => [t.name, t.panel]),
    [["limited", false], ["operator", true], ["owner", true], ["scoped", true]],
  );
});

test("expiry applies mid-session, tells the listeners once, and shows in list", () => {
  let now = Date.parse("2026-01-01T00:00:00Z");
  const { store } = newStore({ now: () => now });
  const ended: string[] = [];
  store.onInvalidated((id) => ended.push(id));
  const { token, record } = store.create({
    name: "short",
    groups: ["read"],
    expiresAt: new Date(now + 1_000),
  });
  assert.equal(store.authenticate(token)?.id, record.id);
  assert.equal(store.list()[0]?.status, "active");
  assert.equal(store.activeCount(), 1);

  now += 1_000;
  assert.equal(store.authenticate(token), null);
  assert.equal(store.list()[0]?.status, "expired");
  assert.equal(store.activeCount(), 0);
  assert.equal(store.isEmpty, false);
  assert.deepEqual(ended, [record.id]);
  store.authenticate(token);
  assert.deepEqual(ended, [record.id]);
});

test("an expiry date nobody can read counts as past", () => {
  const { path, store } = newStore();
  const { token } = store.create({ name: "a", groups: ["read"] });
  const file = JSON.parse(readFileSync(path, "utf8")) as { tokens: Array<{ expiresAt: string }> };
  file.tokens[0]!.expiresAt = "whenever";
  writeFileSync(path, JSON.stringify(file));
  assert.equal(store.authenticate(token), null);
});

test("revoke by id or name; once only; and an unknown one is an error", () => {
  const { store } = newStore();
  const ended: string[] = [];
  store.onInvalidated((id) => ended.push(id));
  const a = store.create({ name: "a", groups: ["read"] });
  const b = store.create({ name: "b", groups: ["read"] });

  assert.equal(store.revoke(a.record.id).name, "a");
  assert.equal(store.authenticate(a.token), null);
  assert.equal(store.revoke("b").id, b.record.id);
  assert.equal(store.authenticate(b.token), null);
  assert.deepEqual(ended, [a.record.id, b.record.id]);

  const again = store.revoke(a.record.id);
  assert.equal(again.revokedAt, store.list()[0]?.revokedAt);
  assert.deepEqual(ended, [a.record.id, b.record.id]);
  assert.throws(() => store.revoke("nope"), /No token/);
  assert.throws(() => store.revoke("a"), /No token/, "by name only finds the live ones");
  assert.equal(store.activeCount(), 0);
});

test("a name can't be taken twice until the first is revoked", () => {
  const { store } = newStore();
  store.create({ name: "a", groups: ["read"] });
  assert.throws(() => store.create({ name: "a", groups: ["read"] }), /already exists/);
  store.revoke("a");
  store.create({ name: "a", groups: ["read"] });
  assert.equal(store.list().length, 2);
});

test("a change made by another store on the file applies at the very next authentication", () => {
  const { path, store } = newStore();
  const { token } = store.create({ name: "a", groups: ["read"] });
  assert.ok(store.authenticate(token));

  const cli = new TokenStore(path, { warn: () => {} });
  cli.revoke("a");
  assert.equal(store.authenticate(token), null);

  const later = cli.create({ name: "b", groups: ["read"] });
  assert.ok(store.authenticate(later.token), "and a new token needs no restart");
});

test("a revoke from another process: the very next request fails, listeners hear within a second", async () => {
  const { path, store } = newStore();
  const { token, record } = store.create({ name: "a", groups: ["read"] });
  store.watch();
  const ended = new Promise<number>((resolve) => {
    store.onInvalidated(() => resolve(Date.now()));
  });
  const started = Date.now();
  revokeFromAnotherProcess(path, record.id);
  assert.equal(store.authenticate(token), null);
  const at = await Promise.race([
    ended,
    new Promise<number>((_, reject) => setTimeout(() => reject(new Error("never heard")), 1_500)),
  ]);
  assert.ok(at - started < 1_500);
  store.close();
});

test("with no request at all, the watcher alone notices", async () => {
  const { path, store } = newStore();
  const { record } = store.create({ name: "a", groups: ["read"] });
  store.watch();
  const heard = new Promise<string>((resolve) => store.onInvalidated(resolve));
  revokeFromAnotherProcess(path, record.id);
  assert.equal(await heard, record.id);
  store.close();
});

test("an unreadable file fails closed, then recovers once fixed", () => {
  const warnings: string[] = [];
  const { path, store } = newStore({ warn: (m) => warnings.push(m) });
  const ended: string[] = [];
  store.onInvalidated((id) => ended.push(id));
  const { token, record } = store.create({ name: "a", groups: ["read"] });
  const good = readFileSync(path, "utf8");

  for (const broken of ["{not json", '{"version":2,"tokens":[]}', '{"version":1,"tokens":[{"id":1}]}']) {
    writeFileSync(path, broken);
    assert.equal(store.authenticate(token), null, broken);
  }
  assert.ok(warnings.some((w) => w.includes("Refusing every token") && w.includes(path)));
  assert.deepEqual(ended, [record.id]);
  assert.throws(() => store.create({ name: "b", groups: ["read"] }), "doesn't overwrite what it can't read");
  assert.throws(() => store.isEmpty, "and doesn't pass for a store that is merely new");

  writeFileSync(path, good);
  assert.ok(store.authenticate(token));
});

test("a removed file means no tokens at all", () => {
  const { path, store } = newStore();
  const { token } = store.create({ name: "a", groups: ["read"] });
  rmSync(path);
  assert.equal(store.authenticate(token), null);
  assert.equal(store.isEmpty, true);
});

test("a lock left by a crash doesn't block for good; a live one's file is cleaned up after", () => {
  const { path, store } = newStore();
  const lock = `${path}.lock`;
  writeFileSync(lock, "");
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  store.create({ name: "a", groups: ["read"] });
  assert.equal(existsSync(lock), false);
  assert.equal(existsSync(`${path}.${process.pid}.tmp`), false);
});

test("concurrent writers lose nothing", async () => {
  const path = newPath();
  const script = fileURLToPath(new URL("./TokenStore.ts", import.meta.url));
  const body = `
    import { TokenStore } from ${JSON.stringify(`file:///${script.replace(/\\/g, "/")}`)};
    const store = new TokenStore(${JSON.stringify(path)}, { warn: () => {} });
    for (let i = 0; i < 6; i++) store.create({ name: process.argv[1] + "-" + i, groups: ["read"] });
  `;
  const writers = ["a", "b", "c", "d"].map(
    (name) =>
      new Promise<number | null>((resolve) => {
        const child = spawn(
          process.execPath,
          ["--import", "tsx", "--input-type=module", "-e", body, name],
          { stdio: "inherit" },
        );
        child.on("close", resolve);
      }),
  );
  assert.deepEqual(await Promise.all(writers), [0, 0, 0, 0]);
  const store = new TokenStore(path, { warn: () => {} });
  assert.equal(store.list().length, 24);
  assert.equal(new Set(store.list().map((t) => t.id)).size, 24);
  assert.equal(existsSync(`${path}.lock`), false);
});

// ── with the real transport ──────────────────────────────────────────────────

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createNetServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

function makeServer(): Server {
  const s = new Server({ name: "test", version: "0.0.0" }, { capabilities: { tools: {} } });
  s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
  return s;
}

async function withServedStore(
  path: string,
  run: (ctx: { port: number; store: TokenStore; t: HttpTransport }) => Promise<void>,
): Promise<void> {
  const store = new TokenStore(path, { warn: () => {} });
  const port = await freePort();
  const t = new HttpTransport({
    port,
    heartbeatMs: 0,
    createServer: makeServer,
    authenticate: (req) => store.authenticateHeader(req.headers.authorization),
  });
  store.onInvalidated((id) => void t.closeSessionsFor(id));
  store.watch();
  await t.start();
  try {
    await run({ port, store, t });
  } finally {
    store.close();
    await t.stop();
  }
}

/** Holds an /sse stream open with this token. Resolves its closing moment. */
function holdStream(port: number, token: string): Promise<{ closed: Promise<number> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path: "/sse", headers: { authorization: `Bearer ${token}` } },
      (res) => {
        assert.equal(res.statusCode, 200);
        const closed = new Promise<number>((done) => res.on("close", () => done(Date.now())));
        res.resume();
        resolve({ closed });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function statusWith(port: number, token: string): Promise<number> {
  return (
    await fetch(`http://127.0.0.1:${port}/healthz`, { headers: { authorization: `Bearer ${token}` } })
  ).status;
}

test("a revoke from another process closes a stream within about a second, and the next request is refused", async () => {
  const path = newPath();
  const { token, record } = new TokenStore(path, { warn: () => {} }).create({
    name: "a",
    groups: ["read"],
  });
  const other = new TokenStore(path, { warn: () => {} }).create({ name: "b", groups: ["read"] });
  await withServedStore(path, async ({ port, t }) => {
    assert.equal(await statusWith(port, token), 200);
    const stream = await holdStream(port, token);
    const untouched = await holdStream(port, other.token);
    assert.equal(t.status().sse, 2);

    const revokedAt = Date.now();
    revokeFromAnotherProcess(path, record.id);
    const closedAt = await stream.closed;
    assert.ok(closedAt - revokedAt < 1_500, `took ${closedAt - revokedAt} ms`);

    assert.equal(await statusWith(port, token), 401);
    assert.equal(await statusWith(port, other.token), 200);
    assert.equal(t.status().sse, 1);
    void untouched;
  });
});

test("expiry mid-session: the token stops working and its stream closes, with no request needed", async () => {
  const path = newPath();
  const { token } = new TokenStore(path, { warn: () => {} }).create({
    name: "short",
    groups: ["read"],
    expiresAt: new Date(Date.now() + 400),
  });
  await withServedStore(path, async ({ port }) => {
    assert.equal(await statusWith(port, token), 200);
    const stream = await holdStream(port, token);
    const closedAt = await stream.closed;
    assert.ok(closedAt > 0);
    assert.equal(await statusWith(port, token), 401);
  });
});
