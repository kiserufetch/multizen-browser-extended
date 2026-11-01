import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
import { pinnedCloakBrowserManifest } from "@multizen/browser-runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { build } from "../scripts/build.mjs";
import { dataPaths } from "./config.ts";

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

/** A test that fails on its way can leave a server up, which would hold the whole run open. */
const started = new Set<ChildProcess>();

after(() => {
  for (const child of started) child.kill();
  rmSync(ABS_OUTDIR, { recursive: true, force: true });
});

function newDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mz-it-"));
  const cache = join(dir, "chromium", "cloakbrowser");
  const pin = pinnedCloakBrowserManifest();
  mkdirSync(join(cache, pin.version), { recursive: true });
  // Exists, so ensure() is satisfied; can't run, so a launch fails at spawn.
  writeFileSync(join(cache, pin.version, "chrome.exe"), "not an executable");
  writeFileSync(
    join(cache, "current.json"),
    JSON.stringify({ version: pin.version, binaryRelative: "chrome.exe", sha256: pin.sha256 }),
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
  started.add(child);
  child.once("close", () => started.delete(child));
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
async function startServe(dataDir: string, extra: string[] = [], onPort?: number): Promise<Serve> {
  const port = onPort ?? (await freePort());
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
    assert.match(stdio.stderr, /token create/);
    assert.equal(stdio.stderr.includes("owner-token"), false, "not a token for an agent");

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

/** A relay with its exit code in reach. The SDK's close() would kill it before it could say. */
async function startRelay(
  serve: Serve,
  extra: string[] = [],
): Promise<{ client: Client; stderr(): string; exited: Promise<number | null>; end(): Promise<void> }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, "stdio", "--connect", serve.url, "--token-file", serve.tokenFile, ...extra],
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
  const client = new Client({ name: "relay", version: "1.0.0" });
  await client.connect(transport);
  const child = (transport as unknown as { _process: ChildProcess })._process;
  const exited = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
  return {
    client,
    stderr: () => stderr,
    exited,
    end: async () => {
      await client.close().catch(() => {});
    },
  };
}

function withinMs<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`no ${what} within ${ms} ms`)), ms).unref()),
  ]);
}

test("stdio --connect: its pings keep the session past the server's idle TTL", async () => {
  const dir = newDataDir();
  const serve = await startServe(dir, ["--session-idle-ttl-ms", "1500"]);
  try {
    const kept = await startRelay(serve, ["--keepalive-ms", "300"]);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const { tools } = await kept.client.listTools();
    assert.ok(tools.some((t) => t.name === "create_profile"), "the relay should still work");
    assert.equal(kept.stderr().includes("relay ending"), false, kept.stderr());
    await kept.end();
  } finally {
    serve.stop();
    await serve.exited;
    removeDir(dir);
  }
});

test("stdio --connect: a session idled out anyway ends the relay with exit 1, and says why", async () => {
  const dir = newDataDir();
  const serve = await startServe(dir, ["--session-idle-ttl-ms", "1000"]);
  try {
    // The stream drops with the session, so this needs no client call and no ping.
    const relay = await startRelay(serve, ["--keepalive-ms", "600000"]);
    const code = await withinMs(relay.exited, 20_000, "relay exit");
    assert.equal(code, 1, relay.stderr());
    assert.match(relay.stderr(), /stdio relay ending: The server no longer has this session/);
    assert.match(relay.stderr(), /--keepalive-ms/);
    await relay.end();
  } finally {
    serve.stop();
    await serve.exited;
    removeDir(dir);
  }
});

test("stdio --connect: killing the server ends the relay with exit 1, and says why", async () => {
  const dir = newDataDir();
  const serve = await startServe(dir);
  const relay = await startRelay(serve, ["--keepalive-ms", "300"]);
  try {
    await relay.client.listTools();
    serve.child.kill("SIGKILL");
    await serve.exited;
    const code = await withinMs(relay.exited, 20_000, "relay exit");
    assert.equal(code, 1, relay.stderr());
    assert.match(relay.stderr(), /stdio relay ending: The server does not answer/);
    await relay.end();
  } finally {
    removeDir(dir);
  }
});

test("stdio --connect: a restarted server has no such session: exit 1 on the next ping", async () => {
  const dir = newDataDir();
  const port = await freePort();
  const first = await startServe(dir, [], port);
  const relay = await startRelay(first, ["--keepalive-ms", "60000"]);
  let second: Serve | undefined;
  try {
    await relay.client.listTools();
    first.child.kill("SIGKILL");
    await first.exited;
    second = await startServe(dir, [], port);
    // Whichever it hears first, its next client call or the dropped stream: the same end.
    await relay.client.listTools().catch(() => {});
    const code = await withinMs(relay.exited, 20_000, "relay exit");
    assert.equal(code, 1, relay.stderr());
    assert.match(relay.stderr(), /stdio relay ending/);
    await relay.end();
  } finally {
    second?.stop();
    await second?.exited;
    removeDir(dir);
  }
});

test("stdio --connect: a revoked token ends the relay with exit 1, and says why", async () => {
  const dir = newDataDir();
  const serve = await startServe(dir);
  try {
    const token = createToken(dir, "--name", "relay-token");
    const tokenFile = join(dir, "relay-token");
    writeFileSync(tokenFile, token);
    const relay = await startRelay({ ...serve, tokenFile }, ["--keepalive-ms", "300"]);
    await relay.client.listTools();
    const revoke = runCli(["token", "revoke", "relay-token", "--data-dir", dir]);
    assert.equal(revoke.status, 0, revoke.stderr);
    const code = await withinMs(relay.exited, 20_000, "relay exit");
    assert.equal(code, 1, relay.stderr());
    assert.match(relay.stderr(), /stdio relay ending: The server (refuses this relay's token|no longer has this session)/);
    await relay.end();
  } finally {
    serve.stop();
    await serve.exited;
    removeDir(dir);
  }
});

/** Runs until killed, with these arguments on its command line, as a browser would have them. */
function startDecoy(args: string[]): ChildProcess {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", ...args], {
    stdio: "ignore",
    windowsHide: true,
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function logsOf(serve: Pick<Running, "stdout">): Array<Record<string, unknown>> {
  return jsonLogs(serve.stdout());
}

test("the reaper at start: ours by their arguments go, everything else stays, and it says which", async () => {
  const dir = newDataDir();
  const { profilesRoot, stateFile, xvfbRunDir } = dataPaths(dir);
  const profile = (name: string): string => join(profilesRoot, name, "engines", "cloakbrowser");
  // Recorded, and ours: a journal from a server that died.
  const recorded = startDecoy([`--user-data-dir=${profile("recorded")}`]);
  // Not recorded, and ours: a crash before the journal heard of it.
  const stray = startDecoy(["-profile", join(profilesRoot, "stray", "engines", "camoufox")]);
  // Recorded, and not ours any more: PID reuse.
  const reused = startDecoy(["worker.js"]);
  // Not ours: the next directory along, and one that merely names a path inside.
  const nextDoor = startDecoy([`--user-data-dir=${join(`${profilesRoot}2`, "x", "engines", "cloakbrowser")}`]);
  const mentions = startDecoy([profile("recorded")]);
  const started = [recorded, stray, reused, nextDoor, mentions];
  const pidOf = (child: ChildProcess): number => child.pid!;
  mkdirSync(join(stateFile, ".."), { recursive: true });
  writeFileSync(
    stateFile,
    JSON.stringify({
      serverPid: 1234,
      serverStartedAt: "before",
      entries: [
        { kind: "browser", engine: "cloakbrowser", profileId: "r", pid: pidOf(recorded), userDataDir: profile("recorded"), startedAt: "t" },
        { kind: "browser", engine: "cloakbrowser", profileId: "u", pid: pidOf(reused), userDataDir: profile("reused"), startedAt: "t" },
        { kind: "browser", engine: "camoufox", profileId: "m", pid: 999_999, userDataDir: profile("missing"), startedAt: "t" },
      ],
    }),
  );
  mkdirSync(profile("recorded"), { recursive: true });
  writeFileSync(join(profile("recorded"), "SingletonCookie"), "");
  mkdirSync(join(xvfbRunDir, "mz-xvfb-old"), { recursive: true });
  // The node decoys need a moment to exist for the OS, with their arguments.
  await new Promise((resolve) => setTimeout(resolve, 300));

  const serve = await startServe(dir);
  try {
    assert.equal(alive(pidOf(recorded)), false, "the recorded one should be gone");
    assert.equal(alive(pidOf(stray)), false, "the unrecorded one should be gone");
    assert.equal(alive(pidOf(reused)), true, "a reused PID must survive");
    assert.equal(alive(pidOf(nextDoor)), true, "the next directory along must survive");
    assert.equal(alive(pidOf(mentions)), true, "a mere mention must survive");
    const lines = logsOf(serve);
    const notOurs = lines.find((l) => String(l.msg).includes("not ours"));
    assert.equal(notOurs?.pid, pidOf(reused));
    const report = lines.find((l) => l.msg === "previous run reaped");
    assert.deepEqual(report?.killed, [pidOf(recorded)]);
    assert.deepEqual(report?.strays, [pidOf(stray)]);
    assert.deepEqual(report?.notOwned, [pidOf(reused)]);
    assert.deepEqual(report?.gone, [999_999]);
    // In order: the port opens after all of that.
    const order = lines.map((l) => l.msg);
    assert.ok(order.indexOf("previous run reaped") < order.indexOf("listening"));

    const state = JSON.parse(readFileSync(stateFile, "utf8")) as { serverPid: number; entries: unknown[] };
    assert.equal(state.serverPid, serve.child.pid);
    assert.deepEqual(state.entries, []);
    assert.equal(existsSync(join(profile("recorded"), "SingletonCookie")), false);
    assert.deepEqual(readdirSync(xvfbRunDir), []);
  } finally {
    serve.stop();
    await serve.exited;
    for (const child of started) child.kill("SIGKILL");
    removeDir(dir);
  }
});

test("two servers: the one refused by the lock reaps nothing", async () => {
  const dir = newDataDir();
  const serve = await startServe(dir);
  const { profilesRoot } = dataPaths(dir);
  // Exactly what the first server's own browser would look like.
  const browser = startDecoy([`--user-data-dir=${join(profilesRoot, "live", "engines", "cloakbrowser")}`]);
  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const second = runCli(["serve", "--data-dir", dir, "--port", "1"]);
    assert.equal(second.status, 1, second.stdout);
    assert.match(second.stdout, /in use by another MultiZen server/);
    const stdio = runCli(["stdio", "--data-dir", dir]);
    assert.equal(stdio.status, 1, stdio.stderr);
    assert.equal(alive(browser.pid!), true, "a refused start must not touch a live server's browser");
  } finally {
    browser.kill("SIGKILL");
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
          proxy: { type: "socks5", host: "203.0.113.1", port: 1, username: "u", password },
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
    assert.equal(row?.proxy.host, "203.0.113.1");
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
      proxy: { type: "socks5", host: "203.0.113.1", port: 1, username: "u", password: "pw" },
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
        proxy: { type: "socks5", host: "203.0.113.1", port: 1, username: "u", password: "pw" },
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

test("egress: a server blocks private addresses unless told otherwise, and says which it does", async () => {
  const dir = newDataDir();
  const metadataProxy = { type: "socks5", host: "169.254.169.254", port: 1 };
  const createWithProxy = async (serve: Serve): Promise<{ isError?: boolean; text: string }> => {
    const client = await httpClient(serve.url, readFileSync(serve.tokenFile, "utf8"));
    const res = (await client.callTool({
      name: "create_profile",
      arguments: { name: "pivot", proxy: metadataProxy },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    await client.close();
    return { isError: res.isError, text: res.content[0]!.text };
  };
  let serve = await startServe(dir);
  try {
    assert.ok(jsonLogs(serve.stdout()).some((l) => l.msg === "listening" && l.egressPolicy === "block-private"));
    const refused = await createWithProxy(serve);
    assert.equal(refused.isError, true);
    assert.equal((JSON.parse(refused.text) as { error: { code: string } }).error.code, "EGRESS_BLOCKED");
    serve.stop();
    await serve.exited;

    serve = await startServe(dir, ["--egress-policy", "allow-all"]);
    assert.match(serve.stdout(), /egress policy allow-all/);
    assert.equal((await createWithProxy(serve)).isError, undefined);
    serve.stop();
    await serve.exited;

    const bad = runCli(["serve", "--data-dir", dir, "--port", "1", "--egress-allow", "10.0.0.0/99"]);
    assert.equal(bad.status, 2, bad.stdout);
    assert.match(bad.stdout, /--egress-allow takes/);
  } finally {
    serve.stop();
    await serve.exited;
    removeDir(dir);
  }
});

// ── the panel's routes, and a live desktop ───────────────────────────────────

function httpGet(url: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
    const req = httpRequest(url, { headers }, (res) => {
      let body = "";
      res.on("data", (c: Buffer) => (body += c.toString("utf8")));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("serve has a panel: a public shell behind a strict CSP, and an API behind its own session", async () => {
  const dir = newDataDir();
  const serve = await startServe(dir);
  try {
    const base = serve.url.replace(/\/mcp$/, "");
    const shell = await httpGet(`${base}/panel`);
    assert.equal(shell.status, 200);
    assert.match(String(shell.headers["content-security-policy"]), /frame-ancestors 'none'/);
    assert.equal(shell.headers["cache-control"], "no-store");
    assert.match(shell.body, /app\.js/);

    const api = await httpGet(`${base}/panel/api/handoffs`);
    assert.equal(api.status, 401);

    const token = readFileSync(serve.tokenFile, "utf8").trim();
    const bearer = await httpGet(`${base}/panel/api/handoffs`, { authorization: `Bearer ${token}` });
    assert.equal(bearer.status, 401, "a bearer token isn't a panel session");

    const download = await httpGet(`${base}/files/downloads/x/y`);
    assert.equal(download.status, 401, "a download takes a bearer token");
    const withToken = await httpGet(`${base}/files/downloads/x/y`, { authorization: `Bearer ${token}` });
    assert.equal(withToken.status, 404);

    const listening = jsonLogs(serve.stdout()).find((l) => l.msg === "listening")!;
    assert.equal(listening.panel, `${base}/panel`);
    assert.equal(listening.handoffWebhook, false);
  } finally {
    serve.stop();
    await serve.exited;
    removeDir(dir);
  }
});

test("a live desktop on the directory refuses serve and stdio; a stale lock doesn't", async () => {
  const dir = newDataDir();
  const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  try {
    const { hostname } = await import("node:os");
    const { processIdentity } = await import("@multizen/browser-runtime");
    const identity = (await processIdentity(holder.pid!))!;
    writeFileSync(
      join(dir, "desktop.lock"),
      JSON.stringify({
        hostname: hostname(),
        pid: holder.pid,
        startTime: identity.startTime,
        cmdline: identity.cmdline,
        acquiredAt: new Date().toISOString(),
      }),
    );

    const port = String(await freePort());
    const refusedServe = runCli(["serve", "--data-dir", dir, "--port", port]);
    assert.equal(refusedServe.status, 1, refusedServe.stdout + refusedServe.stderr);
    assert.match(refusedServe.stdout, /desktop app/);
    assert.equal(existsSync(join(dir, "server.lock")), false, "the lock it took is given back");

    const refusedStdio = runCli(["stdio", "--data-dir", dir]);
    assert.equal(refusedStdio.status, 1, refusedStdio.stdout + refusedStdio.stderr);
    assert.match(refusedStdio.stderr, /desktop app/);

    const exited = new Promise((resolve) => holder.once("exit", resolve));
    holder.kill();
    await exited;
    const serve = await startServe(dir);
    serve.stop();
    await serve.exited;
  } finally {
    holder.kill();
    removeDir(dir);
  }
});

test("with --no-auth the panel signs in with no token", async () => {
  const dir = newDataDir();
  const serve = await startServe(dir, ["--no-auth"]);
  try {
    const base = serve.url.replace(/\/mcp$/, "");
    const me = await httpGet(`${base}/panel/api/me`);
    assert.equal(me.status, 401);
    assert.equal(JSON.parse(me.body).no_login, true);
    const login = await fetch(`${base}/panel/api/login`, {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({ token: "" }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const handoffs = await httpGet(`${base}/panel/api/handoffs`, { cookie });
    assert.equal(handoffs.status, 200);
    assert.deepEqual(JSON.parse(handoffs.body).handoffs, []);
  } finally {
    serve.stop();
    await serve.exited;
    removeDir(dir);
  }
});
