import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { build } from "../scripts/build.mjs";

/**
 * The built bundle as a real process, with real SDK clients: everything a server
 * does around a browser, short of launching one. A placeholder engine keeps the
 * eager ensure() offline. scripts/e2e.ts drives the same paths with a real browser.
 */

const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUTDIR = join("dist", `test-integration-${process.pid}`);
const ABS_OUTDIR = join(APP_ROOT, OUTDIR);
const CLI = join(ABS_OUTDIR, "cli.js");

before(async () => {
  await build({ outdir: OUTDIR });
});

after(() => {
  rmSync(ABS_OUTDIR, { recursive: true, force: true });
});

function newDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mz-it-"));
  const cache = join(dir, "chromium", "cloakbrowser");
  mkdirSync(join(cache, "146.0.0.0"), { recursive: true });
  // Exists, so ensure() is satisfied; can't run, so a launch fails at spawn.
  writeFileSync(join(cache, "146.0.0.0", "chrome.exe"), "not an executable");
  writeFileSync(
    join(cache, "current.json"),
    JSON.stringify({ version: "146.0.0.0", binaryRelative: "chrome.exe" }),
  );
  return dir;
}

function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

interface Running {
  child: ChildProcess;
  stdout(): string;
  stderr(): string;
  exited: Promise<number | null>;
}

function startCli(args: string[], env: NodeJS.ProcessEnv = {}): Running {
  const child = spawn(process.execPath, [CLI, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, ...env },
  });
  let out = "";
  let err = "";
  child.stdout?.on("data", (c: Buffer) => (out += c.toString("utf8")));
  child.stderr?.on("data", (c: Buffer) => (err += c.toString("utf8")));
  return {
    child,
    stdout: () => out,
    stderr: () => err,
    exited: new Promise((resolve) => child.on("close", (code) => resolve(code))),
  };
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${what}`);
}

function runCli(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    timeout: 90_000,
    windowsHide: true,
    env: { ...process.env, ...env },
  });
}

function jsonLogs(text: string): Array<Record<string, unknown>> {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

interface Serve extends Running {
  url: string;
  tokenFile: string;
  stop(): void;
}

/** Starts `serve` and waits for it to listen. `stop` is a hard kill on Windows,
 *  which can't deliver SIGTERM, and graceful elsewhere. The graceful path is covered
 *  through stdio EOF below and by shutdown.test.ts and scripts/e2e.ts. */
async function startServe(dataDir: string, extra: string[] = []): Promise<Serve> {
  const port = await freePort();
  const running = startCli(["serve", "--data-dir", dataDir, "--port", String(port), ...extra]);
  await waitFor(() => running.stdout().includes('"listening"'), "serve to listen");
  return {
    ...running,
    url: `http://127.0.0.1:${port}/mcp`,
    tokenFile: join(dataDir, "owner-token"),
    stop: () => running.child.kill(),
  };
}

async function httpClient(url: string, token?: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: token ? { headers: { authorization: `Bearer ${token}` } } : undefined,
  });
  const client = new Client({ name: "integration", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

function toolText(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ text?: string }> }).content;
  return JSON.parse(content[0]?.text ?? "{}") as Record<string, unknown>;
}

test("serve: a real client works, with the token, against the bundle", async () => {
  const dir = newDataDir();
  const serve = await startServe(dir);
  try {
    const token = readFileSync(serve.tokenFile, "utf8");
    assert.match(token, /^mz_t_[0-9a-f]+_[A-Za-z0-9_-]{43}$/);
    // The path is logged, the value never.
    assert.ok(serve.stdout().includes("owner-token"));
    assert.equal(serve.stdout().includes(token), false);
    assert.equal(serve.stderr().includes(token), false);
    if (process.platform !== "win32") {
      assert.equal(statSync(serve.tokenFile).mode & 0o777, 0o600);
    }

    const client = await httpClient(serve.url, token);
    const { tools } = await client.listTools();
    assert.ok(tools.some((t) => t.name === "launch_profile"));

    const created = toolText(
      await client.callTool({ name: "create_profile", arguments: { name: "it" } }),
    );
    assert.equal(created.engine, "cloakbrowser");
    const listed = toolText(await client.callTool({ name: "list_profiles", arguments: {} }));
    assert.equal((listed.profiles as unknown[]).length, 1);
    await client.close();

    // /healthz says only ok, to anyone. What a token gets is /readyz.
    const health = await fetch(new URL("/healthz", serve.url));
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });
    const ready = new URL("/readyz", serve.url);
    assert.equal((await fetch(ready)).status, 401);
    const authed = await fetch(ready, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(authed.status, 200);

    // Every log line is JSON, the tool calls among them.
    const logs = jsonLogs(serve.stdout());
    assert.ok(logs.some((l) => l.msg === "tool call" && l.tool === "create_profile"));
  } finally {
    serve.stop();
    await serve.exited;
    removeDir(dir);
  }
});

test("serve: the token survives a restart, without the token a client is refused", async () => {
  const dir = newDataDir();
  let serve = await startServe(dir);
  const first = readFileSync(serve.tokenFile, "utf8");
  serve.stop();
  await serve.exited;
  try {
    // Hard-killed on Windows, the holder left its lock behind: a dead pid, no obstacle.
    assert.equal(existsSync(join(dir, "server.lock")), process.platform === "win32");
    serve = await startServe(dir);
    assert.equal(readFileSync(serve.tokenFile, "utf8"), first);
    await assert.rejects(httpClient(serve.url), /401|Unauthorized|unauthorized/);
    await (await httpClient(serve.url, first)).close();
  } finally {
    serve.stop();
    await serve.exited;
    removeDir(dir);
  }
});

test("a launch whose binary can't spawn is a tool error, and the server stays up", async () => {
  const dir = newDataDir();
  const serve = await startServe(dir);
  try {
    const client = await httpClient(serve.url, readFileSync(serve.tokenFile, "utf8"));
    const profile = toolText(
      await client.callTool({ name: "create_profile", arguments: { name: "bad-binary" } }),
    );
    const launch = (await client.callTool({
      name: "launch_profile",
      arguments: { profile_id: profile.id },
    })) as { isError?: boolean };
    assert.equal(launch.isError, true);

    const listed = toolText(await client.callTool({ name: "list_profiles", arguments: {} }));
    assert.equal((listed.profiles as Array<{ isRunning: boolean }>)[0]?.isRunning, false);
    await client.close();
    assert.equal(serve.child.exitCode, null);
    assert.equal(serve.stdout().includes("uncaught exception"), false);
  } finally {
    serve.stop();
    await serve.exited;
    removeDir(dir);
  }
});

test("serve --headless: asking for a window by name is INVALID_INPUT, through the real bundle", async () => {
  const dir = newDataDir();
  const serve = await startServe(dir, ["--headless"]);
  try {
    const client = await httpClient(serve.url, readFileSync(serve.tokenFile, "utf8"));
    assert.match(serve.stdout(), /"displayMode":"headless \(forced\)"/);
    const profile = toolText(
      await client.callTool({ name: "create_profile", arguments: { name: "forced", display_mode: "headed" } }),
    );
    assert.equal(profile.displayMode, "headed", "saving it is fine: --headless decides at launch");

    const refused = (await client.callTool({
      name: "launch_profile",
      arguments: { profile_id: profile.id, display_mode: "headed" },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(refused.isError, true);
    assert.equal(JSON.parse(refused.content[0]!.text).error.code, "INVALID_INPUT");
    await client.close();
  } finally {
    serve.stop();
    await serve.exited;
    removeDir(dir);
  }
});

test("serve refuses zero tokens: an owner-token file with no valid token", () => {
  const dir = newDataDir();
  try {
    writeFileSync(join(dir, "owner-token"), "\n");
    const res = runCli(["serve", "--data-dir", dir, "--port", "1"]);
    assert.equal(res.status, 1, res.stdout);
    assert.match(res.stdout, /holds no valid token/);
    // Left as it was, and the lock released on the way out.
    assert.equal(readFileSync(join(dir, "owner-token"), "utf8"), "\n");
    assert.equal(existsSync(join(dir, "server.lock")), false);
  } finally {
    removeDir(dir);
  }
});

test("serve --no-auth runs with no token at all, on loopback only", async () => {
  const dir = newDataDir();
  const serve = await startServe(dir, ["--no-auth"]);
  try {
    assert.equal(existsSync(serve.tokenFile), false);
    await (await httpClient(serve.url)).close();
    assert.ok(jsonLogs(serve.stdout()).some((l) => l.msg === "listening" && l.auth === "none"));

    const remote = runCli(["serve", "--data-dir", dir, "--no-auth", "--host", "0.0.0.0"]);
    assert.equal(remote.status, 2);
    assert.match(remote.stdout, /loopback/);
  } finally {
    serve.stop();
    await serve.exited;
    removeDir(dir);
  }
});

test("a busy port is a clean failure that releases the lock", async () => {
  const dir = newDataDir();
  const blocker = createServer();
  await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = blocker.address() as AddressInfo;
    const res = runCli(["serve", "--data-dir", dir, "--port", String(port)]);
    assert.equal(res.status, 1, res.stdout);
    assert.match(res.stdout, /EADDRINUSE/);
    assert.equal(existsSync(join(dir, "server.lock")), false);
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
    removeDir(dir);
  }
});

test("a row left outside the data dir refuses the start with its id", async () => {
  const dir = newDataDir();
  const serve = await startServe(dir);
  const client = await httpClient(serve.url, readFileSync(serve.tokenFile, "utf8"));
  const profile = toolText(
    await client.callTool({ name: "create_profile", arguments: { name: "moved" } }),
  );
  await client.close();
  serve.stop();
  await serve.exited;
  rmSync(join(dir, "profiles", String(profile.id)), { recursive: true });
  const moved = `${dir}-moved`;
  mkdirSync(moved);
  try {
    for (const name of ["profiles.db", "profiles.db-wal", "profiles.db-shm"]) {
      if (existsSync(join(dir, name))) writeFileSync(join(moved, name), readFileSync(join(dir, name)));
    }
    const res = runCli(["serve", "--data-dir", moved, "--port", "1"]);
    assert.equal(res.status, 1, res.stdout);
    assert.match(res.stdout, new RegExp(String(profile.id)));
    assert.match(res.stdout, /point outside/);
  } finally {
    removeDir(dir);
    removeDir(moved);
  }
});

test("the lock: a second serve and a plain stdio refuse, the relay works", async () => {
  const dir = newDataDir();
  const serve = await startServe(dir);
  try {
    const second = runCli(["serve", "--data-dir", dir, "--port", "1"]);
    assert.equal(second.status, 1, second.stdout);
    assert.match(second.stdout, /in use by another MultiZen server/);

    const stdio = runCli(["stdio", "--data-dir", dir]);
    assert.equal(stdio.status, 1, stdio.stderr);
    // stdio mode: logs on stderr, and stdout, the protocol's, stays silent.
    assert.equal(stdio.stdout, "");
    assert.match(stdio.stderr, /in use by another MultiZen server/);
    assert.match(stdio.stderr, /stdio --connect/);
    assert.ok(stdio.stderr.includes(serve.url));
    assert.ok(stdio.stderr.includes("owner-token"));

    const profile = runCli(
      ["profile", "export", "any", "--data-dir", dir, "--passphrase-file", join(dir, "owner-token")],
    );
    assert.equal(profile.status, 1, profile.stdout);
    assert.match(profile.stdout, /in use by another MultiZen server/);

    // A proxied client sees the same server: the profile made through it is real.
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI, "stdio", "--connect", serve.url, "--token-file", serve.tokenFile],
      stderr: "pipe",
    });
    const relayErrors: unknown[] = [];
    transport.onerror = (e) => relayErrors.push(e);
    const relay = new Client({ name: "relay", version: "1.0.0" });
    await relay.connect(transport);
    const { tools } = await relay.listTools();
    assert.ok(tools.some((t) => t.name === "create_profile"));
    await relay.callTool({ name: "create_profile", arguments: { name: "through-relay" } });
    await relay.close();
    assert.deepEqual(relayErrors, []);

    const direct = await httpClient(serve.url, readFileSync(serve.tokenFile, "utf8"));
    const listed = toolText(await direct.callTool({ name: "list_profiles", arguments: {} }));
    assert.deepEqual(
      (listed.profiles as Array<{ name: string }>).map((p) => p.name),
      ["through-relay"],
    );
    await direct.close();
  } finally {
    serve.stop();
    await serve.exited;
    removeDir(dir);
  }
});

test("stdio --connect with a wrong token answers the request with an error", async () => {
  const dir = newDataDir();
  const serve = await startServe(dir);
  const wrongToken = join(dir, "wrong-token");
  writeFileSync(wrongToken, "0".repeat(64));
  try {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI, "stdio", "--connect", serve.url, "--token-file", wrongToken],
      stderr: "pipe",
    });
    const client = new Client({ name: "wrong-token", version: "1.0.0" });
    await assert.rejects(client.connect(transport), /request failed/);
    await client.close();
  } finally {
    serve.stop();
    await serve.exited;
    removeDir(dir);
  }
});

test("stdio: stdout is valid JSON-RPC, and stdin EOF runs the full shutdown, exit 0", async () => {
  const dir = newDataDir();
  // Stdout is read raw here, every line of it. The launch path's console.log, which
  // takes a real browser to reach, is covered in scripts/e2e.ts.
  const running = startCli(["stdio", "--data-dir", dir]);
  const send = (message: unknown): void => {
    running.child.stdin?.write(`${JSON.stringify(message)}\n`);
  };
  const frames = (): Array<Record<string, unknown>> =>
    running
      .stdout()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  try {
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "raw", version: "1.0.0" },
      },
    });
    await waitFor(() => frames().some((f) => f.id === 1), "the initialize reply");
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "create_profile", arguments: { name: "over-stdio" } },
    });
    await waitFor(() => frames().some((f) => f.id === 2), "the create_profile reply");
    assert.equal(existsSync(join(dir, "server.lock")), true);

    running.child.stdin?.end();
    const code = await running.exited;
    assert.equal(code, 0, running.stderr());
    assert.equal(existsSync(join(dir, "server.lock")), false);

    assert.ok(frames().every((f) => f.jsonrpc === "2.0"));
    const logs = jsonLogs(running.stderr());
    assert.ok(logs.some((l) => l.msg === "shutting down" && l.reason === "stdin-eof"));
    assert.equal(logs.at(-1)?.msg, "shutdown complete");
    assert.equal(logs.at(-1)?.exitCode, 0);
  } finally {
    removeDir(dir);
  }
});

test("profile export then import moves a profile between data dirs", async () => {
  const from = newDataDir();
  const to = newDataDir();
  const passphraseFile = join(from, "pass");
  const archive = join(from, "moved.mzar");
  writeFileSync(passphraseFile, "secret\n");
  try {
    const serve = await startServe(from);
    const client = await httpClient(serve.url, readFileSync(serve.tokenFile, "utf8"));
    const profile = toolText(
      await client.callTool({ name: "create_profile", arguments: { name: "traveller" } }),
    );
    await client.close();
    serve.stop();
    await serve.exited;

    mkdirSync(join(from, "profiles", String(profile.id), "engines", "cloakbrowser"), {
      recursive: true,
    });
    writeFileSync(
      join(from, "profiles", String(profile.id), "engines", "cloakbrowser", "Cookies"),
      "cookie-bytes",
    );

    const exported = runCli([
      "profile",
      "export",
      String(profile.id),
      "--out",
      archive,
      "--passphrase-file",
      passphraseFile,
      "--data-dir",
      from,
    ]);
    assert.equal(exported.status, 0, exported.stdout);
    assert.ok(jsonLogs(exported.stdout).some((l) => l.msg === "profile exported"));
    assert.equal(existsSync(archive), true);

    const wrong = runCli(["profile", "import", archive, "--data-dir", to], {
      MULTIZEN_ARCHIVE_PASSPHRASE: "wrong",
    });
    assert.equal(wrong.status, 1);
    assert.match(wrong.stdout, /Wrong passphrase/);

    const noPassphrase = runCli(["profile", "import", archive, "--data-dir", to]);
    assert.equal(noPassphrase.status, 2);
    assert.match(noPassphrase.stdout, /passphrase/);

    const imported = runCli(["profile", "import", archive, "--data-dir", to], {
      MULTIZEN_ARCHIVE_PASSPHRASE: "secret",
    });
    assert.equal(imported.status, 0, imported.stdout);
    assert.equal(existsSync(join(to, "server.lock")), false);
    assert.equal(
      readFileSync(join(to, "profiles", String(profile.id), "engines", "cloakbrowser", "Cookies"), "utf8"),
      "cookie-bytes",
    );

    const missing = runCli(
      ["profile", "export", "no-such-id", "--passphrase-file", passphraseFile, "--data-dir", to],
    );
    assert.equal(missing.status, 2);
    assert.match(missing.stdout, /not found/);
  } finally {
    removeDir(from);
    removeDir(to);
  }
});

// ── tokens, remote access, secrets ───────────────────────────────────────────

const TOKEN_RE = /^mz_t_[0-9a-f]+_[A-Za-z0-9_-]{43}$/;

function createToken(dir: string, ...flags: string[]): string {
  const res = runCli(["token", "create", "--data-dir", dir, ...flags]);
  assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
  return res.stdout.trim();
}

function toolNames(tools: Array<{ name: string }>): string[] {
  return tools.map((t) => t.name);
}

test("token create prints the token once, as all of stdout; list and the logs never show it", () => {
  const dir = newDataDir();
  try {
    const res = runCli(["token", "create", "--name", "r", "--tools", "read", "--data-dir", dir]);
    assert.equal(res.status, 0, res.stderr);
    const token = res.stdout.trim();
    assert.match(token, TOKEN_RE);
    assert.equal(res.stdout, `${token}\n`);
    assert.equal(res.stderr.includes(token), false);
    assert.ok(jsonLogs(res.stderr).some((l) => l.msg?.toString().startsWith("token created")));

    const onDisk = readFileSync(join(dir, "tokens.json"), "utf8");
    assert.equal(onDisk.includes(token), false);
    assert.equal(onDisk.includes(token.slice(-43)), false);

    const list = runCli(["token", "list", "--data-dir", dir]);
    assert.equal(list.status, 0, list.stderr);
    assert.equal(list.stdout.includes(token), false);
    const [row] = jsonLogs(list.stdout);
    assert.equal(row?.name, "r");
    assert.equal(row?.status, "active");
    assert.equal(row?.panel, false);
    assert.deepEqual(row?.tools, { groups: ["read"], names: [] });
    assert.equal(row && "hash" in row, false);

    const again = runCli(["token", "create", "--name", "r", "--data-dir", dir]);
    assert.equal(again.status, 1);
    assert.match(again.stderr, /already exists/);

    const bad = runCli(["token", "create", "--name", "x", "--tools", "cliks", "--data-dir", dir]);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /--tools takes groups/);

    const revoked = runCli(["token", "revoke", "r", "--data-dir", dir]);
    assert.equal(revoked.status, 0, revoked.stderr);
    assert.equal(jsonLogs(runCli(["token", "list", "--data-dir", dir]).stdout)[0]?.status, "revoked");
  } finally {
    removeDir(dir);
  }
});

test("a limited token and the owner's, through the real bundle", async () => {
  const dir = newDataDir();
  const serve = await startServe(dir);
  try {
    const owner = await httpClient(serve.url, readFileSync(serve.tokenFile, "utf8"));
    const ownerTools = toolNames((await owner.listTools()).tools);
    for (const tool of ["cdp_send_no_safety", "cdp_send", "click", "create_profile", "resume_human"]) {
      assert.ok(ownerTools.includes(tool), tool);
    }
    const first = toolText(await owner.callTool({ name: "create_profile", arguments: { name: "one" } }));
    const second = toolText(await owner.callTool({ name: "create_profile", arguments: { name: "two" } }));

    // Made while the server runs: no restart, the file is the authority.
    const reader = await httpClient(serve.url, createToken(dir, "--name", "reader", "--tools", "read"));
    const readerTools = toolNames((await reader.listTools()).tools);
    assert.ok(readerTools.includes("extract"));
    for (const tool of ["click", "cdp_send", "cdp_send_no_safety", "create_profile", "launch_profile"]) {
      assert.equal(readerTools.includes(tool), false, tool);
    }
    const refused = (await reader.callTool({
      name: "click",
      arguments: { profile_id: first.id, selector: "#x" },
    })) as { isError?: boolean };
    assert.equal(refused.isError, true);
    assert.equal((toolText(refused).error as { code: string }).code, "FORBIDDEN");
    await reader.close();

    const scoped = await httpClient(
      serve.url,
      createToken(dir, "--name", "scoped", "--profiles", String(first.id)),
    );
    const listed = toolText(await scoped.callTool({ name: "list_profiles", arguments: {} }));
    assert.deepEqual((listed.profiles as Array<{ id: string }>).map((p) => p.id), [first.id]);
    const other = await scoped.callTool({
      name: "extract",
      arguments: { profile_id: second.id },
    });
    assert.equal((toolText(other).error as { code: string }).code, "FORBIDDEN");
    await scoped.close();
    await owner.close();

    // Every call is logged with whose it was.
    await waitFor(
      () =>
        jsonLogs(serve.stdout()).some(
          (l) => l.msg === "tool call" && l.tool === "click" && l.actor === "reader",
        ),
      "the actor in the log",
    );
    assert.ok(
      jsonLogs(serve.stdout()).some(
        (l) => l.msg === "tool call" && l.tool === "create_profile" && l.actor === "owner",
      ),
    );
  } finally {
    serve.stop();
    await serve.exited;
    removeDir(dir);
  }
});

test("token revoke from a separate process: the stream closes and the next request is refused", async () => {
  const dir = newDataDir();
  const serve = await startServe(dir);
  try {
    const token = createToken(dir, "--name", "doomed");
    const owner = readFileSync(serve.tokenFile, "utf8");

    const stream = await fetch(new URL("/sse", serve.url), { headers: { authorization: `Bearer ${token}` } });
    assert.equal(stream.status, 200);
    const reader = stream.body!.getReader();
    await reader.read();
    const closed = (async () => {
      for (;;) if ((await reader.read()).done) return Date.now();
    })().catch(() => Date.now());

    const client = await httpClient(serve.url, token);
    assert.ok(toolNames((await client.listTools()).tools).includes("click"));

    const revoke = runCli(["token", "revoke", "doomed", "--data-dir", dir]);
    assert.equal(revoke.status, 0, revoke.stderr);
    const revokedAt = Date.now();
    await assert.rejects(client.listTools(), /401|Unauthorized|unauthorized/);
    const elapsed = (await closed) - revokedAt;
    assert.ok(elapsed < 1_500, `the stream took ${elapsed} ms to close`);
    await client.close();

    // The owner goes on as if nothing happened.
    const ownerClient = await httpClient(serve.url, owner);
    await ownerClient.listTools();
    await ownerClient.close();
    await waitFor(() => serve.stdout().includes('"token ended, sessions closed"'), "the log line");
  } finally {
    serve.stop();
    await serve.exited;
    removeDir(dir);
  }
});

test("--no-auth aside, a server with no active token refuses to start", async () => {
  const dir = newDataDir();
  try {
    createToken(dir, "--name", "only");
    assert.equal(existsSync(join(dir, "owner-token")), false);
    const revoke = runCli(["token", "revoke", "only", "--data-dir", dir]);
    assert.equal(revoke.status, 0);

    const refused = runCli(["serve", "--data-dir", dir, "--port", "1"]);
    assert.equal(refused.status, 1, refused.stdout);
    assert.match(refused.stdout, /revoked or expired/);
    assert.match(refused.stdout, /token create/);
    assert.equal(existsSync(join(dir, "owner-token")), false, "and mints nothing behind a revocation");
    assert.equal(existsSync(join(dir, "server.lock")), false);

    const noAuth = await startServe(dir, ["--no-auth"]);
    noAuth.stop();
    await noAuth.exited;
  } finally {
    removeDir(dir);
  }
});

test("beyond loopback: refused without the flags, before anything is bound or written", () => {
  const dir = newDataDir();
  try {
    for (const [flags, pattern] of [
      [["--host", "10.255.255.1"], /--allow-remote/],
      [["--host", "10.255.255.1", "--allow-remote"], /--allow-insecure-remote/],
      [["--host", "0.0.0.0", "--allow-remote", "--allow-insecure-remote"], /--allowed-hosts or --public-url/],
    ] as Array<[string[], RegExp]>) {
      const res = runCli(["serve", "--data-dir", dir, ...flags]);
      assert.equal(res.status, 2, res.stdout);
      assert.match(res.stdout, pattern);
    }
    assert.equal(existsSync(join(dir, "owner-token")), false);
    assert.equal(existsSync(join(dir, "tokens.json")), false);
  } finally {
    removeDir(dir);
  }
});

test("behind a proxy on loopback: --allowed-hosts is all it takes, and foreign names stay out", async () => {
  const dir = newDataDir();
  const serve = await startServe(dir, ["--allowed-hosts", "example.test"]);
  try {
    const port = new URL(serve.url).port;
    const token = readFileSync(serve.tokenFile, "utf8");
    const status = (headers: Record<string, string>): Promise<number> =>
      new Promise((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port,
            path: "/mcp",
            headers: { authorization: `Bearer ${token}`, ...headers },
          },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode ?? 0));
          },
        );
        req.on("error", reject);
        req.end();
      });
    assert.equal(await status({ host: "example.test" }), 400, "past the gate: a GET with no session");
    assert.equal(await status({ host: "example.test:8443" }), 400);
    assert.equal(await status({ origin: "https://example.test" }), 400);
    assert.equal(await status({ host: "evil.test" }), 403);
    assert.equal(await status({ origin: "https://evil.test" }), 403);
  } finally {
    serve.stop();
    await serve.exited;
    removeDir(dir);
  }
});

test("TLS through the bundle: https works, and the /readyz behind it knows the engine", async () => {
  const dir = newDataDir();
  const testdata = fileURLToPath(new URL("../../../packages/mcp-server/src/testdata/", import.meta.url));
  const cert = join(testdata, "tls-test-only.crt");
  const serve = await startServe(dir, ["--tls-cert", cert, "--tls-key", join(testdata, "tls-test-only.key")]);
  try {
    assert.match(serve.stdout(), /"url":"https:\/\/127\.0\.0\.1:/);
    const token = readFileSync(serve.tokenFile, "utf8");
    const reply = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = httpsRequest(
        {
          host: "127.0.0.1",
          port: new URL(serve.url).port,
          path: "/readyz",
          ca: readFileSync(cert),
          headers: { authorization: `Bearer ${token}` },
        },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => (text += chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(reply.status, 200, reply.text);
    const ready = JSON.parse(reply.text) as Record<string, unknown>;
    assert.equal(ready.ready, true);
    assert.equal(ready.engine, "cloakbrowser");
    assert.equal(ready.engineStatus, "ready");
    assert.deepEqual(ready.sessions, { sse: 0, streamable: 0 });
  } finally {
    serve.stop();
    await serve.exited;
    removeDir(dir);
  }
});

test("a certificate that can't be read is a clean failure that releases the lock", () => {
  const dir = newDataDir();
  try {
    const res = runCli(["serve", "--data-dir", dir, "--port", "1", "--tls-cert", join(dir, "no"), "--tls-key", join(dir, "no")]);
    assert.equal(res.status, 1, res.stdout);
    assert.match(res.stdout, /ENOENT/);
    assert.equal(existsSync(join(dir, "server.lock")), false);
  } finally {
    removeDir(dir);
  }
});

test("a proxy password through MCP: sealed in the real DB and WAL, kept across restarts", async () => {
  const dir = newDataDir();
  const password = "s3cret-proxy-passw0rd-distinctive";
  const dbPath = join(dir, "profiles.db");
  let serve = await startServe(dir);
  try {
    assert.match(serve.stdout(), /"secret key created"/);
    assert.match(serve.stdout(), /same volume as the database/);
    const client = await httpClient(serve.url, readFileSync(serve.tokenFile, "utf8"));
    const created = toolText(
      await client.callTool({
        name: "create_profile",
        arguments: {
          name: "proxied",
          proxy: { type: "socks5", host: "127.0.0.1", port: 1, username: "u", password },
        },
      }),
    );
    await client.close();

    for (const file of [dbPath, `${dbPath}-wal`]) {
      assert.equal(existsSync(file) && readFileSync(file).includes(password), false, `${file} while running`);
    }
    assert.ok(
      readFileSync(existsSync(`${dbPath}-wal`) ? `${dbPath}-wal` : dbPath).includes("mzenc:v1:"),
      "the sealed form is what was written",
    );
    assert.equal(serve.stdout().includes(password), false, "nor in the logs");
    serve.stop();
    await serve.exited;

    serve = await startServe(dir);
    const again = await httpClient(serve.url, readFileSync(serve.tokenFile, "utf8"));
    const listed = toolText(await again.callTool({ name: "list_profiles", arguments: {} }));
    const [row] = listed.profiles as Array<{ id: string; proxy: Record<string, unknown> }>;
    assert.equal(row?.id, created.id);
    assert.equal(row?.proxy.host, "127.0.0.1");
    await again.close();
  } finally {
    serve.stop();
    await serve.exited;
    removeDir(dir);
  }
});

test("an encrypted database with its key gone refuses the start, saying what to do", async () => {
  const dir = newDataDir();
  const serve = await startServe(dir);
  const client = await httpClient(serve.url, readFileSync(serve.tokenFile, "utf8"));
  await client.callTool({
    name: "create_profile",
    arguments: {
      name: "proxied",
      proxy: { type: "socks5", host: "127.0.0.1", port: 1, username: "u", password: "pw" },
    },
  });
  await client.close();
  serve.stop();
  await serve.exited;
  try {
    rmSync(join(dir, "secret.key"));
    const res = runCli(["serve", "--data-dir", dir, "--port", "1"]);
    assert.equal(res.status, 1, res.stdout);
    assert.match(res.stdout, /1 proxy password\(s\) .* are encrypted and there is no key/);
    assert.match(res.stdout, /MULTIZEN_SECRET_KEY/);
    assert.equal(existsSync(join(dir, "secret.key")), false);
    assert.equal(existsSync(join(dir, "server.lock")), false);
  } finally {
    removeDir(dir);
  }
});

test("secrets rotate: refused while a server runs, works once it is gone", async () => {
  const dir = newDataDir();
  const serve = await startServe(dir);
  const client = await httpClient(serve.url, readFileSync(serve.tokenFile, "utf8"));
  const created = toolText(
    await client.callTool({
      name: "create_profile",
      arguments: {
        name: "proxied",
        proxy: { type: "socks5", host: "127.0.0.1", port: 1, username: "u", password: "pw" },
      },
    }),
  );
  await client.close();
  const keyBefore = readFileSync(join(dir, "secret.key"), "utf8");
  try {
    const busy = runCli(["secrets", "rotate", "--data-dir", dir]);
    assert.equal(busy.status, 1, busy.stdout);
    assert.match(busy.stdout, /in use by another MultiZen server/);
    assert.equal(readFileSync(join(dir, "secret.key"), "utf8"), keyBefore);
    serve.stop();
    await serve.exited;

    const done = runCli(["secrets", "rotate", "--data-dir", dir]);
    assert.equal(done.status, 0, done.stdout);
    assert.ok(jsonLogs(done.stdout).some((l) => l.msg === "secret key rotated" && l.passwords === 1));
    assert.equal(done.stdout.includes(keyBefore), false);
    assert.notEqual(readFileSync(join(dir, "secret.key"), "utf8"), keyBefore);

    const again = await startServe(dir);
    const reopened = await httpClient(again.url, readFileSync(again.tokenFile, "utf8"));
    const listed = toolText(await reopened.callTool({ name: "list_profiles", arguments: {} }));
    assert.equal((listed.profiles as Array<{ id: string }>)[0]?.id, created.id);
    await reopened.close();
    again.stop();
    await again.exited;
  } finally {
    serve.stop();
    await serve.exited;
    removeDir(dir);
  }
});

test("the key in the environment never reaches the logs or a key file", async () => {
  const dir = newDataDir();
  const key = "ab".repeat(32);
  const port = await freePort();
  const running = startCli(["serve", "--data-dir", dir, "--port", String(port)], {
    MULTIZEN_SECRET_KEY: key,
  });
  try {
    await waitFor(() => running.stdout().includes('"listening"'), "serve to listen");
    assert.equal(running.stdout().includes(key), false);
    assert.equal(existsSync(join(dir, "secret.key")), false);
    assert.equal(running.stdout().includes("same volume"), false);
  } finally {
    running.child.kill();
    await running.exited;
    removeDir(dir);
  }
});
