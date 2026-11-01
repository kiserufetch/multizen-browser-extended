/**
 * Live check of what keeps a hostile page, token or file from hurting this server: the built
 * server, a real engine, real MCP clients, and local fixtures. Not part of test:unit. Every server
 * here runs with --headless and the production policy.
 *
 *   corepack yarn workspace @multizen/server build
 *   corepack yarn workspace @multizen/server exec tsx scripts/security-live.ts \
 *     --data-dir %TEMP%\mztsec --engine cloakbrowser --engine-version-dir <dir with chrome.exe> \
 *     [--engine camoufox --camoufox-install <dir>] [--only downloads,proxy,...] [--cli <cli.js>]
 *
 * --only names flows, all of them when left out except `dns`, which needs a resolver that answers
 * nothing: run this where /etc/resolv.conf points at a host that drops UDP port 53. `corrupt` swaps
 * the real pinned engine download for bad bytes from a local fixture, through the runtime's
 * host.request, and runs no server. `bodies` and `sockets` attack the port and need no browser, and
 * --only with just those three doesn't wait for an engine.
 *
 * --cli runs those against another build's cli.js, as `dist/cli.js` of an earlier image: what these
 * flows show about the attacks is only worth something if that one fails them.
 *
 * Each row says what was observed. A row that threw reads as FAIL, with what happened.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createCipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { connect as netConnect, createServer as createNetServer, type AddressInfo, type Server as NetServer, type Socket } from "node:net";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ChromiumBootstrap, pinnedCloakBrowserManifest } from "@multizen/browser-runtime";
import { ProfileManager } from "@multizen/profile-manager";
import { createNodeHost } from "../src/nodeHost.ts";

const { values } = parseArgs({
  options: {
    "data-dir": { type: "string" },
    engine: { type: "string" },
    "engine-version-dir": { type: "string" },
    "camoufox-install": { type: "string" },
    only: { type: "string" },
    cli: { type: "string" },
    keep: { type: "boolean" },
  },
});
// As the server's own start does: this script is what makes the directory.
process.umask(0o077);
const IS_WINDOWS = process.platform === "win32";
const dataDirFlag = values["data-dir"];
if (!dataDirFlag) throw new Error("--data-dir is required");
const DATA_DIR = resolve(dataDirFlag);
const ENGINE = values.engine ?? "cloakbrowser";
const CLI = values.cli ? resolve(values.cli) : join(fileURLToPath(new URL("..", import.meta.url)), "dist", "cli.js");
if (!existsSync(CLI)) throw new Error(`${CLI} is missing: build the server first`);
const FLOWS = new Set(
  (values.only ?? "downloads,uploads,navigate,sessions,proxy,archive,modes,warnings,corrupt,bodies,sockets").split(","),
);
const ENGINE_READY_BUDGET_MS = 15 * 60_000;
/** A hostile page's worst, in the old code: 6 s of a stopped event loop per download. */
const RESPONSIVE_MS = 1_500;
/** The flows that start no browser. */
const NO_BROWSER_FLOWS = new Set(["corrupt", "bodies", "sockets"]);
const MIB = 1024 * 1024;

let failures = 0;
function row(name: string, ok: boolean, observed: string): void {
  if (!ok) failures += 1;
  process.stdout.write(`${ok ? "ok  " : "FAIL"} ${name}: ${observed}\n`);
}

/** Windows' loopback can fail in bursts (a VPN's tun, say), and it says nothing about the server. */
const LOOPBACK_FAILURE = /fetch failed|ETIMEDOUT|ECONNRESET/;

async function attempt(name: string, fn: () => Promise<void>): Promise<void> {
  for (let tries = 1; ; tries++) {
    try {
      await fn();
      if (tries > 1) process.stdout.write(`note ${name}: passed on try ${tries}, after a loopback failure\n`);
      return;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (IS_WINDOWS && tries < 4 && LOOPBACK_FAILURE.test(message)) {
        await wait(2_000);
        continue;
      }
      row(name, false, `the check itself failed: ${message}`);
      return;
    }
  }
}

const wait = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

async function until(what: string, check: () => boolean | Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await wait(100);
  }
}

// ── data dir ─────────────────────────────────────────────────────────────────

function junction(link: string, target: string): void {
  if (existsSync(link)) return;
  if (!IS_WINDOWS) {
    symlinkSync(target, link);
    return;
  }
  const res = spawnSync("cmd", ["/c", "mklink", "/J", link, target], { encoding: "utf8" });
  if (res.status !== 0) throw new Error(`mklink failed: ${res.stdout}${res.stderr}`);
}

function prepareDataDir(): void {
  mkdirSync(DATA_DIR, { recursive: true });
  const camoufox = values["camoufox-install"];
  if (camoufox) junction(join(DATA_DIR, "camoufox"), resolve(camoufox));
  const versionDir = values["engine-version-dir"];
  if (!versionDir) return;
  const version = basename(versionDir);
  const cache = join(DATA_DIR, "chromium", "cloakbrowser");
  mkdirSync(cache, { recursive: true });
  junction(join(cache, version), versionDir);
  const pin = pinnedCloakBrowserManifest();
  if (version !== pin.version) throw new Error(`--engine-version-dir is ${version}, and the server only runs ${pin.version}`);
  writeFileSync(
    join(cache, "current.json"),
    JSON.stringify({ version, binaryRelative: IS_WINDOWS ? "chrome.exe" : "chrome", sha256: pin.sha256 }),
  );
}

/** Removes the junctions first, so the deletion can't follow them. */
function cleanDataDir(): void {
  const versionDir = values["engine-version-dir"];
  const links = [
    ...(versionDir ? [join(DATA_DIR, "chromium", "cloakbrowser", basename(versionDir))] : []),
    ...(values["camoufox-install"] ? [join(DATA_DIR, "camoufox")] : []),
  ];
  for (const link of links) {
    if (!existsSync(link)) continue;
    if (IS_WINDOWS) spawnSync("cmd", ["/c", "rmdir", link], { encoding: "utf8" });
    else if (lstatSync(link).isSymbolicLink()) unlinkSync(link);
  }
  rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}

// ── fixtures ─────────────────────────────────────────────────────────────────

const LONG_NAME = `x${".".repeat(100_000)}y.bin`;
const FILE_BYTES = 40_000;

function page(body: string): string {
  return `<!doctype html><html><head><title>MZ security</title></head><body>${body}</body></html>`;
}

interface Fixture {
  port: number;
  close(): Promise<void>;
}

async function startFixture(): Promise<Fixture> {
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const path = (req.url ?? "/").split("?")[0];
    res.setHeader("connection", "close");
    res.setHeader("cache-control", "no-store");
    if (path === "/long-disposition") {
      res
        .writeHead(200, {
          "content-type": "application/octet-stream",
          "content-disposition": `attachment; filename="${LONG_NAME}"`,
        })
        .end(Buffer.alloc(FILE_BYTES, 1));
    } else if (path === "/file") {
      res
        .writeHead(200, { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="plain.bin"' })
        .end(Buffer.alloc(FILE_BYTES, 2));
    } else if (path === "/upload") {
      res.writeHead(200, { "content-type": "text/html" }).end(page('<input id="f" type="file" multiple>'));
    } else {
      res.writeHead(200, { "content-type": "text/html" }).end(page("<h1>fixture</h1>"));
    }
  };
  const server = createHttpServer(handler);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

/** Counts who connects. Nothing should. */
async function startSink(): Promise<{ port: number; connections: () => number; close(): Promise<void> }> {
  let connections = 0;
  const server: NetServer = createNetServer((socket) => {
    connections += 1;
    socket.on("error", () => {});
    socket.destroy();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    port: (server.address() as AddressInfo).port,
    connections: () => connections,
    close: () => new Promise((done) => server.close(() => done())),
  };
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createNetServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => done(port));
    });
  });
}

// ── server and clients ───────────────────────────────────────────────────────

interface Serve {
  child: ChildProcess;
  port: number;
  log: () => string;
  stop(): Promise<void>;
}

async function serve(flags: string[], env: Record<string, string> = {}): Promise<Serve> {
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [CLI, "serve", "--headless", "--data-dir", DATA_DIR, "--port", String(port), "--default-engine", ENGINE, ...flags],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: { ...process.env, ...env } },
  );
  let output = "";
  child.stdout!.on("data", (chunk) => (output += String(chunk)));
  child.stderr!.on("data", (chunk) => (output += String(chunk)));
  let exited = false;
  child.once("exit", () => (exited = true));
  await until(
    "the server to listen",
    () => {
      if (exited) throw new Error(`the server exited: ${output.slice(-800)}`);
      return output.includes('"listening"');
    },
    60_000,
  );
  return {
    child,
    port,
    log: () => output,
    stop: async () => {
      if (exited) return;
      child.kill(IS_WINDOWS ? undefined : "SIGTERM");
      await until("the server to exit", () => exited, 30_000).catch(() => child.kill("SIGKILL"));
    },
  };
}

async function waitForEngine(server: Serve, token: string): Promise<void> {
  await until(
    "the engine",
    async () => {
      const res = await fetch(`http://127.0.0.1:${server.port}/readyz`, {
        headers: { authorization: `Bearer ${token}` },
      }).catch(() => null);
      return res?.status === 200;
    },
    ENGINE_READY_BUDGET_MS,
  );
}

async function connect(server: Serve, token: string): Promise<Client> {
  const client = new Client({ name: "security-live", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

interface CallResult {
  isError: boolean;
  body: Record<string, any>;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<CallResult> {
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
  const text = (res.content as Array<{ type: string; text?: string }>)[0]?.text ?? "{}";
  return { isError: res.isError === true, body: JSON.parse(text) as Record<string, any> };
}

async function must(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const { isError, body } = await call(client, name, args);
  if (isError) throw new Error(`${name} failed: ${JSON.stringify(body).slice(0, 400)}`);
  return body;
}

function ownerToken(): string {
  return readFileSync(join(DATA_DIR, "owner-token"), "utf8").trim();
}

function tokenCreate(name: string, tools: string): string {
  const res = spawnSync(process.execPath, [CLI, "token", "create", "--name", name, "--tools", tools, "--data-dir", DATA_DIR], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (res.status !== 0) throw new Error(`token create failed: ${res.stdout}${res.stderr}`);
  return /mz_t_[0-9a-f]+_[A-Za-z0-9_-]{43}/.exec(res.stdout)![0];
}

async function newProfile(client: Client, name: string): Promise<string> {
  return (await must(client, "create_profile", { name, engine: ENGINE })).id as string;
}

/** While `work` runs, a client keeps asking something that only needs the event loop. */
async function latencyDuring(client: Client, work: () => Promise<void>): Promise<{ count: number; maxMs: number }> {
  let running = true;
  let count = 0;
  let maxMs = 0;
  const probing = (async () => {
    while (running) {
      const started = performance.now();
      await must(client, "list_profiles", {});
      maxMs = Math.max(maxMs, performance.now() - started);
      count += 1;
      await wait(25);
    }
  })();
  try {
    await work();
  } finally {
    running = false;
    await probing;
  }
  return { count, maxMs: Math.round(maxMs) };
}

function evaluate(expression: string): string {
  return `(() => { ${expression}; return "started"; })()`;
}

// ── flows ────────────────────────────────────────────────────────────────────

async function flowDownloads(server: Serve, client: Client, base: string): Promise<void> {
  const id = await newProfile(client, "downloads");
  await must(client, "launch_profile", { profile_id: id });
  await must(client, "navigate", { profile_id: id, url: `${base}/page` });

  await attempt("S1 long Content-Disposition", async () => {
    const before = (await must(client, "list_downloads", { profile_id: id })).downloads.length as number;
    const { count, maxMs } = await latencyDuring(client, async () => {
      await must(client, "evaluate_js", {
        profile_id: id,
        expression: evaluate(`const a = document.createElement("a"); a.href = "/long-disposition"; a.click()`),
      });
      await until("that download", async () => {
        const { downloads } = await must(client, "list_downloads", { profile_id: id });
        return downloads.length > before && downloads.at(-1).state === "completed";
      });
    });
    const { downloads } = await must(client, "list_downloads", { profile_id: id });
    const name = downloads.at(-1).fileName as string;
    row(
      "S1 long Content-Disposition",
      maxMs < RESPONSIVE_MS && name.length <= 200,
      `list_profiles answered ${count} times, slowest ${maxMs} ms; stored as ${name.length} characters: ${name.slice(0, 24)}...`,
    );
  });

  await attempt("S1 long <a download>", async () => {
    const before = (await must(client, "list_downloads", { profile_id: id })).downloads.length as number;
    const { count, maxMs } = await latencyDuring(client, async () => {
      await must(client, "evaluate_js", {
        profile_id: id,
        expression: evaluate(
          `const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob(["bytes"])); a.download = "x" + ".".repeat(100000) + "y.bin"; document.body.append(a); a.click()`,
        ),
      });
      await until("that download", async () => {
        const { downloads } = await must(client, "list_downloads", { profile_id: id });
        return downloads.length > before && downloads.at(-1).state !== "in_progress";
      });
    });
    const { downloads } = await must(client, "list_downloads", { profile_id: id });
    const latest = downloads.at(-1);
    row(
      "S1 long <a download>",
      maxMs < RESPONSIVE_MS && (latest.fileName as string).length <= 200,
      `list_profiles answered ${count} times, slowest ${maxMs} ms; ${latest.state}, stored as ${(latest.fileName as string).length} characters`,
    );
  });

  await attempt("S15 delete_download", async () => {
    // Quota is FILE_BYTES * 3 from serve()'s flags, and two are already held.
    for (const download of (await must(client, "list_downloads", { profile_id: id })).downloads) {
      await must(client, "delete_download", { profile_id: id, download_id: download.id });
    }
    const start = async (): Promise<Record<string, any>> => {
      const before = (await must(client, "list_downloads", { profile_id: id })).downloads.length as number;
      await must(client, "evaluate_js", {
        profile_id: id,
        expression: evaluate(`const a = document.createElement("a"); a.href = "/file?" + Math.random(); a.click()`),
      });
      await until("that download", async () => {
        const { downloads } = await must(client, "list_downloads", { profile_id: id });
        return downloads.length > before && downloads.at(-1).state !== "in_progress";
      });
      return (await must(client, "list_downloads", { profile_id: id })).downloads.at(-1);
    };
    const first = await start();
    const second = await start();
    const third = await start();
    const fourth = await start();
    const refused = fourth.state === "canceled" && fourth.canceledBy === "quota";
    const { path: _path, ...kept } = await must(client, "get_download", { profile_id: id, download_id: first.id });
    await must(client, "delete_download", { profile_id: id, download_id: first.id });
    const gone = await call(client, "get_download", { profile_id: id, download_id: first.id });
    const freed = await start();
    row(
      "S15 delete_download",
      refused && kept.state === "completed" && gone.isError && freed.state === "completed" && second.state === "completed" && third.state === "completed",
      `three completed, the fourth ${fourth.state} by ${fourth.canceledBy}; one deleted (get_download now ${gone.body.error?.code}), the next ${freed.state}`,
    );
  });

  await attempt("S14 names", async () => {
    const before = (await must(client, "list_downloads", { profile_id: id })).downloads as Array<{ id: string }>;
    for (const download of before) await must(client, "delete_download", { profile_id: id, download_id: download.id });
    await must(client, "evaluate_js", {
      profile_id: id,
      expression: evaluate(
        `const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob(["bytes"])); a.download = "\\u202Egpj.exe"; document.body.append(a); a.click()`,
      ),
    });
    await until("that download", async () => {
      const { downloads } = await must(client, "list_downloads", { profile_id: id });
      return downloads.length > 0 && downloads[0].state !== "in_progress";
    });
    const name = (await must(client, "list_downloads", { profile_id: id })).downloads[0].fileName as string;
    row("S14 names", !/‮/.test(name), `a right-to-left override in a name is stored as ${JSON.stringify(name)}`);
  });

  await must(client, "close_profile", { profile_id: id });
  void server;
}

async function flowUploads(client: Client, base: string): Promise<void> {
  const id = await newProfile(client, "uploads");
  await must(client, "launch_profile", { profile_id: id });
  await must(client, "navigate", { profile_id: id, url: `${base}/upload` });
  await attempt("S6 inbox quota", async () => {
    const data = Buffer.alloc(30_000, 3).toString("base64");
    const upload = (): Promise<CallResult> =>
      call(client, "upload_file", { profile_id: id, selector: "#f", files: [{ file_name: "a.bin", data_base64: data }] });
    const first = await upload();
    const second = await upload();
    const third = await upload();
    row(
      "S6 inbox quota",
      !first.isError && !second.isError && third.isError && third.body.error.code === "FILE_TOO_LARGE",
      `two of 30 KB taken, the third ${third.body.error?.code}: ${String(third.body.error?.message).slice(0, 100)}`,
    );
  });
  await must(client, "close_profile", { profile_id: id });
}

async function flowNavigate(server: Serve, client: Client, closedPort: number): Promise<void> {
  const id = await newProfile(client, "navigate");
  await must(client, "launch_profile", { profile_id: id });
  await attempt("S9 failed navigate", async () => {
    const url = `http://mzuser:hunter2@127.0.0.1:${closedPort}/some/secret-path?token=abc123`;
    const { isError, body } = await call(client, "navigate", { profile_id: id, url });
    await wait(300);
    const log = server.log();
    const leaked = ["hunter2", "abc123", "secret-path", "mzuser"].filter((text) => log.includes(text));
    row(
      "S9 failed navigate",
      isError && leaked.length === 0 && body.error?.details?.url === url && !/hunter2|abc123/.test(body.error.message),
      `${body.error?.code}: ${body.error?.message}; in ${log.length} bytes of server log, leaked: ${leaked.join(",") || "none"}; details.url keeps it for the caller`,
    );
  });
  await must(client, "close_profile", { profile_id: id });
}

async function flowSessions(server: Serve, owner: string): Promise<void> {
  const reader = tokenCreate("sec-reader", "read");
  await attempt("S5 sessions per token", async () => {
    const clients: Client[] = [];
    for (let i = 0; i < 3; i++) {
      clients.push(await connect(server, reader));
      await wait(10);
    }
    await must(clients[0]!, "list_profiles", {});
    await must(clients[1]!, "list_profiles", {});
    await must(clients[2]!, "list_profiles", {});
    const fourth = await connect(server, reader);
    const fifth = await connect(server, reader);
    const oldest = await call(clients[0]!, "list_profiles", {}).catch((e: Error) => ({ isError: true, body: { thrown: e.message } }));
    const newest = await call(fifth, "list_profiles", {});
    const ownerClient = await connect(server, owner);
    const ownerList = await call(ownerClient, "list_profiles", {});
    const listed = newest.body.profiles as Array<Record<string, unknown>>;
    row(
      "S5 sessions per token",
      oldest.isError && !newest.isError && !ownerList.isError,
      `cap 3: the oldest of five says ${JSON.stringify(oldest.body).slice(0, 60)}; the newest answers, the owner connects`,
    );
    row(
      "S17 list_profiles names no host path",
      listed.length > 0 && !JSON.stringify(listed).includes(DATA_DIR) && !JSON.stringify(ownerList.body).includes(DATA_DIR),
      `${listed.length} profiles for the read token and for the owner, ${DATA_DIR} in neither`,
    );
    await Promise.all([...clients, fourth, fifth, ownerClient].map((c) => c.close().catch(() => {})));
  });
}

// ── attacks on the port ──────────────────────────────────────────────────────

/** Every request here on a socket of its own: what is at stake is whether a new one gets in. */
function onNewSocket(
  port: number,
  opts: { method?: string; path: string; token?: string; session?: string; body?: string; timeoutMs?: number },
): Promise<{ status: number; text: string; session?: string }> {
  return new Promise((done, fail) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: opts.method ?? "GET",
        path: opts.path,
        agent: false,
        timeout: opts.timeoutMs ?? 10_000,
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
          ...(opts.session ? { "mcp-session-id": opts.session } : {}),
        },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => (text += String(chunk)));
        res.on("end", () => {
          const session = res.headers["mcp-session-id"];
          done({ status: res.statusCode ?? 0, text, ...(typeof session === "string" ? { session } : {}) });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("no answer in time")));
    req.on("error", fail);
    req.end(opts.body);
  });
}

function jsonRpc(id: number, method: string, params: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

const INITIALIZE = jsonRpc(1, "initialize", {
  protocolVersion: "2025-03-26",
  capabilities: {},
  clientInfo: { name: "security-live", version: "0" },
});

/**
 * /healthz, then a token's initialize and a tool call, as a client just arriving would. Says how it
 * went: a server locked out from under its owner shows here as a refusal or a dropped socket.
 */
async function arriving(port: number, token: string): Promise<{ ok: boolean; said: string }> {
  for (let tries = 1; ; tries++) {
    const started = performance.now();
    try {
      const healthz = await onNewSocket(port, { path: "/healthz" });
      if (healthz.status !== 200) return { ok: false, said: `/healthz ${healthz.status}` };
      const initialized = await onNewSocket(port, { method: "POST", path: "/mcp", token, body: INITIALIZE });
      if (initialized.status !== 200 || !initialized.session) {
        return { ok: false, said: `initialize ${initialized.status} ${/"code":"(\w+)"/.exec(initialized.text)?.[1] ?? ""}` };
      }
      const listed = await onNewSocket(port, {
        method: "POST",
        path: "/mcp",
        token,
        session: initialized.session,
        body: jsonRpc(2, "tools/call", { name: "list_profiles", arguments: {} }),
      });
      if (listed.status !== 200 || !listed.text.includes("profiles")) {
        return { ok: false, said: `list_profiles ${listed.status}` };
      }
      return { ok: true, said: `/healthz, initialize and list_profiles answered in ${Math.round(performance.now() - started)} ms` };
    } catch (e) {
      const message = (e as Error).message;
      if (IS_WINDOWS && tries < 4 && message.includes("ETIMEDOUT")) {
        process.stdout.write(`note a loopback ETIMEDOUT, not a refusal: try ${tries + 1}\n`);
        await wait(2_000);
        continue;
      }
      return { ok: false, said: `on a new socket: ${message}` };
    }
  }
}

interface HeldPost {
  /** Its answer, or null if the socket closed with none. */
  reply: Promise<{ status: number; text: string } | null>;
  closed: Promise<void>;
  /** Everything `sent` has gone out, or the socket has gone. */
  written: Promise<void>;
  /** Why it never got anywhere, as an attack that didn't happen proves nothing. */
  failure(): string | null;
  destroy(): void;
}

/** A POST that says how long it will be, sends `sent` of that and then never finishes. */
function heldPost(port: number, token: string, declared: number, sent?: Buffer): HeldPost {
  let setReply = (_: { status: number; text: string } | null): void => {};
  let setClosed = (): void => {};
  let setWritten = (): void => {};
  const reply = new Promise<{ status: number; text: string } | null>((done) => (setReply = done));
  const closed = new Promise<void>((done) => (setClosed = done));
  const written = new Promise<void>((done) => (setWritten = done));
  let failure: string | null = null;
  const req = httpRequest(
    {
      host: "127.0.0.1",
      port,
      method: "POST",
      path: "/mcp",
      agent: false,
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        // As a real client's: on a closing one, a refusal resets what is still being sent, answer included.
        connection: "keep-alive",
        "content-length": String(declared),
      },
    },
    (res) => {
      let text = "";
      res.on("data", (chunk) => (text += String(chunk)));
      res.on("end", () => setReply({ status: res.statusCode ?? 0, text }));
    },
  );
  let connected = false;
  req.on("socket", (socket) => socket.once("connect", () => (connected = true)));
  req.on("error", (e) => {
    if (!connected) failure = e.message;
  });
  req.on("close", () => {
    setReply(null);
    setClosed();
    setWritten();
  });
  if (sent) req.write(sent, () => setWritten());
  else {
    req.flushHeaders();
    setWritten();
  }
  return { reply, closed, written, failure: () => failure, destroy: () => req.destroy() };
}

function mustHaveConnected(posts: HeldPost[]): void {
  const failed = posts.map((post) => post.failure()).find((failure) => failure !== null);
  if (failed) throw new Error(`a POST of the attack never got there: ${failed}`);
}

const within = <T>(work: Promise<T>, ms: number): Promise<T | "not in time"> =>
  Promise.race([work, wait(ms).then(() => "not in time" as const)]);

/** N1: a token with nothing but `read`, and POSTs that say much and send little. */
async function flowBodies(): Promise<void> {
  const server = await serve([]);
  try {
    const { port } = server;
    const owner = ownerToken();
    const reader = tokenCreate("n1-reader", "read");

    const held: HeldPost[] = [];
    let heldAt = 0;
    await attempt("N1 declared, not sent", async () => {
      // The finding's numbers: 128 MiB of promises.
      for (const post of held.splice(0)) post.destroy();
      heldAt = performance.now();
      for (let i = 0; i < 5; i++) held.push(heldPost(port, reader, 23_068_672));
      held.push(heldPost(port, reader, 18_874_368));
      await wait(500);
      mustHaveConnected(held);
      const ownerArrives = await arriving(port, owner);
      const readerArrives = await arriving(port, reader);
      row(
        "N1 declared, not sent",
        ownerArrives.ok && readerArrives.ok,
        `a read-only token holds 6 POSTs saying 5 x 23068672 and 18874368 bytes, none sent. The owner: ${ownerArrives.said}. That token's next: ${readerArrives.said}`,
      );
    });

    await attempt("N1 the deadline", async () => {
      const first = await within(held[0]!.reply, 40_000);
      const tookS = Math.round((performance.now() - heldAt) / 100) / 10;
      const answered = first !== "not in time" && first?.status === 408 && /"code":"TIMEOUT"/.test(first.text);
      const socketsGone = await within(Promise.all(held.map((post) => post.closed)), 3_000);
      row(
        "N1 the deadline",
        answered && tookS < 34 && socketsGone !== "not in time",
        first === "not in time"
          ? `still no answer after ${tookS} s`
          : `the first answered ${first?.status} ${/"code":"(\w+)"/.exec(first?.text ?? "")?.[1]} after ${tookS} s; all 6 sockets closed: ${socketsGone !== "not in time"}`,
      );
    });
    for (const post of held) post.destroy();

    await attempt("N1 bytes actually sent", async () => {
      // What the charges of the POSTs above need to go.
      await wait(300);
      const posts: HeldPost[] = [];
      // All of the budget for everyone, as real bytes, one POST after another.
      for (const size of [20, 20, 20, 20, 20, 20, 8]) {
        const post = heldPost(port, reader, size * MIB + 1, Buffer.alloc(size * MIB, 32));
        posts.push(post);
        await within(post.written, 30_000);
        await wait(100);
      }
      mustHaveConnected(posts);
      const answers = await Promise.all(posts.map((post) => within(post.reply, 2_000)));
      const refused = answers.filter((answer) => answer !== "not in time" && answer?.status === 503).length;
      const ownerArrives = await arriving(port, owner);
      for (const post of posts) post.destroy();
      row(
        "N1 bytes actually sent",
        refused >= 5 && ownerArrives.ok,
        `one token sends 128 MiB in 7 POSTs and stalls: ${refused} refused past its 32 MiB. The owner: ${ownerArrives.said}`,
      );
    });

    await attempt("N1 revoked mid-body", async () => {
      // A name per try: this row can repeat after a lost connect, with the first token still on file.
      const goneName = `n1-gone-${randomBytes(4).toString("hex")}`;
      const gone = tokenCreate(goneName, "read");
      const post = heldPost(port, gone, 10 * MIB, Buffer.alloc(MIB, 32));
      await within(post.written, 5_000);
      mustHaveConnected([post]);
      const started = performance.now();
      const res = spawnSync(process.execPath, [CLI, "token", "revoke", goneName, "--data-dir", DATA_DIR], {
        encoding: "utf8",
        windowsHide: true,
      });
      if (res.status !== 0) throw new Error(`token revoke failed: ${res.stdout}${res.stderr}`);
      const closed = await within(post.closed, 10_000);
      post.destroy();
      row(
        "N1 revoked mid-body",
        closed !== "not in time",
        closed === "not in time"
          ? "still open 10 s after the revoke"
          : `the socket closed ${Math.round(performance.now() - started)} ms after \`token revoke\``,
      );
    });
  } finally {
    await server.stop();
  }
}

interface IdleSockets {
  open(): number;
  closed(): number;
  firstClosedAfterMs(): number | null;
  /** Of a connect that never happened: an attack that didn't happen proves nothing. */
  lastError(): string;
  stop(): void;
}

/** Connected, saying nothing, no token. With `reopen`, whatever the server closes comes back. */
async function holdIdle(port: number, count: number, opts: { localAddress?: string; reopen?: boolean } = {}): Promise<IdleSockets> {
  let lastError = "";
  const started = performance.now();
  const sockets = new Set<Socket>();
  let open = 0;
  let closed = 0;
  let firstClosedAfterMs: number | null = null;
  let stopped = false;
  const one = (): Promise<void> =>
    new Promise((done) => {
      const socket = netConnect({ port, host: "127.0.0.1", ...(opts.localAddress ? { localAddress: opts.localAddress } : {}) });
      sockets.add(socket);
      let connected = false;
      socket.resume();
      socket.on("error", (e) => {
        if (!connected) lastError = e.message;
      });
      socket.once("connect", () => {
        connected = true;
        open += 1;
        done();
      });
      socket.once("close", () => {
        sockets.delete(socket);
        if (connected) {
          open -= 1;
          closed += 1;
          firstClosedAfterMs ??= Math.round(performance.now() - started);
        }
        done();
        if (opts.reopen && !stopped) setTimeout(() => void one(), 50);
      });
    });
  for (let i = 0; i < count; i += 64) {
    await Promise.all(Array.from({ length: Math.min(64, count - i) }, one));
  }
  return {
    open: () => open,
    closed: () => closed,
    firstClosedAfterMs: () => firstClosedAfterMs,
    lastError: () => lastError,
    stop: () => {
      stopped = true;
      for (const socket of sockets) socket.destroy();
    },
  };
}

/** N2: nobody with a token, only sockets, from one address or from many. */
async function flowSockets(): Promise<void> {
  const server = await serve([]);
  try {
    const { port } = server;
    const owner = ownerToken();

    await attempt("N2 256 idle sockets", async () => {
      // The finding's number, from an address of its own.
      const idle = await holdIdle(port, 256, { localAddress: "127.0.0.2" });
      await wait(300);
      const ownerArrives = await arriving(port, owner);
      const open = idle.open();
      idle.stop();
      if (open < 256) throw new Error(`only ${open} of the 256 connected: ${idle.lastError()}`);
      row("N2 256 idle sockets", ownerArrives.ok, `${open} held from 127.0.0.2 with no token. The owner on 127.0.0.1: ${ownerArrives.said}`);
    });

    await attempt("N2 from the owner's own address", async () => {
      // As everyone is behind Docker's published port or a NAT, and more than the backstop's share.
      const idle = await holdIdle(port, IS_WINDOWS ? 400 : 1_500);
      await wait(500);
      const open = idle.open();
      const ownerArrives = await arriving(port, owner);
      idle.stop();
      row(
        "N2 from the owner's own address",
        ownerArrives.ok && open <= 256,
        `${IS_WINDOWS ? 400 : 1_500} tried from 127.0.0.1, ${open} left open. The owner, also on 127.0.0.1: ${ownerArrives.said}`,
      );
    });

    if (!IS_WINDOWS) {
      await attempt("N2 from many addresses", async () => {
        // Past the 4096 backstop if nothing else stopped them.
        const held = await Promise.all(
          Array.from({ length: 20 }, (_, i) => holdIdle(port, 256, { localAddress: `127.0.1.${i + 1}` })),
        );
        await wait(500);
        const open = held.reduce((sum, idle) => sum + idle.open(), 0);
        const ownerArrives = await arriving(port, owner);
        for (const idle of held) idle.stop();
        row(
          "N2 from many addresses",
          ownerArrives.ok && open <= 1_024,
          `20 addresses, 256 sockets each, 5120 tried, ${open} left open. The owner: ${ownerArrives.said}`,
        );
      });
    }

    await attempt("N2 kept up past the headers timeout", async () => {
      const idle = await holdIdle(port, 256, { localAddress: "127.0.0.2", reopen: true });
      if (idle.open() < 256) {
        idle.stop();
        throw new Error(`only ${idle.open()} of the 256 connected: ${idle.lastError()}`);
      }
      const started = performance.now();
      let tries = 0;
      const failed: string[] = [];
      while (performance.now() - started < 13_000) {
        const ownerArrives = await arriving(port, owner);
        tries += 1;
        if (!ownerArrives.ok) failed.push(ownerArrives.said);
        await wait(500);
      }
      const first = idle.firstClosedAfterMs();
      const closed = idle.closed();
      idle.stop();
      row(
        "N2 kept up past the headers timeout",
        failed.length === 0 && first !== null && first < 13_000,
        `256 sockets reopened as they close, 13 s: the server first closed one after ${first} ms, ${closed} in all. The owner got in ${tries - failed.length} of ${tries} times${failed.length ? `: ${failed[0]}` : ""}`,
      );
    });
  } finally {
    await server.stop();
  }
}

function storeProxy(id: string, host: string, port: number): void {
  const profiles = new ProfileManager({ dbPath: join(DATA_DIR, "profiles.db"), profilesRoot: join(DATA_DIR, "profiles") });
  try {
    profiles.update(id, { proxy: { type: "http", host, port } });
  } finally {
    profiles.close();
  }
}

async function flowProxy(flags: string[], client: Client, server: Serve): Promise<Serve> {
  const sink = await startSink();
  const hostile = `127.0.0.1:${sink.port}/#`;
  const id = await newProfile(client, "proxy");
  let current = server;
  await attempt("S2 update_profile", async () => {
    const metadata = await call(client, "update_profile", {
      profile_id: id,
      proxy: { type: "http", host: "169.254.169.254:80/#", port: 8080 },
    });
    const local = await call(client, "update_profile", { profile_id: id, proxy: { type: "http", host: hostile, port: 8080 } });
    row(
      "S2 update_profile",
      metadata.isError && metadata.body.error.code === "EGRESS_BLOCKED" && local.isError && local.body.error.code === "EGRESS_BLOCKED",
      `169.254.169.254:80/# gets ${metadata.body.error?.code}: ${String(metadata.body.error?.message).slice(0, 110)}`,
    );
  });
  await attempt("S2 launch dials nothing", async () => {
    // What a row from before this check, or from an archive, looks like at launch.
    await current.stop();
    storeProxy(id, hostile, 8080);
    current = await serve(flags);
    const fresh = await connect(current, ownerToken());
    const launched = await call(fresh, "launch_profile", { profile_id: id });
    await wait(1_500);
    await fresh.close();
    row(
      "S2 launch dials nothing",
      launched.isError && launched.body.error.code === "EGRESS_BLOCKED" && sink.connections() === 0,
      `a stored host of ${hostile}: launch gets ${launched.body.error?.code}, the fixture on that port saw ${sink.connections()} connections`,
    );
  });
  await sink.close();
  return current;
}

function craftArchive(path: string, passphrase: string, profile: Record<string, unknown>, files: Array<{ path: string; content: string }>): void {
  const uint32 = (value: number): Buffer => {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(value, 0);
    return buffer;
  };
  const json = Buffer.from(
    JSON.stringify({
      magic: "MZAR",
      version: 2,
      profile,
      files: files.map((f) => ({
        path: f.path,
        size: Buffer.byteLength(f.content),
        sha256: createHash("sha256").update(f.content).digest("hex"),
      })),
    }),
  );
  const parts: Buffer[] = [uint32(json.length), json];
  for (const file of files) parts.push(uint32(Buffer.byteLength(file.content)), Buffer.from(file.content));
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", scryptSync(passphrase, salt, 32), iv);
  const body = Buffer.concat([cipher.update(Buffer.concat(parts)), cipher.final()]);
  const header = Buffer.alloc(6);
  header.write("MZAR", 0, 4, "ascii");
  header.writeUInt16BE(2, 4);
  writeFileSync(path, Buffer.concat([header, salt, iv, body, cipher.getAuthTag()]));
}

async function flowArchive(flags: string[], server: Serve, owner: string): Promise<Serve> {
  const secret = readFileSync(join(DATA_DIR, "owner-token"), "utf8");
  const index = JSON.stringify([
    {
      id: "planted",
      guid: "g",
      storedAs: "../../../owner-token",
      fileName: "x.txt",
      url: "http://t/",
      state: "completed",
      bytesReceived: 1,
      bytesTotal: 1,
      startedAt: "2026-11-01T00:00:00.000Z",
    },
    {
      id: "planted2",
      guid: "../../../owner-token",
      fileName: "y.txt",
      url: "http://t/",
      state: "in_progress",
      bytesReceived: 1,
      bytesTotal: 1,
      startedAt: "2026-11-01T00:00:00.000Z",
    },
  ]);
  let current = server;
  await attempt("S3 hostile archive", async () => {
    await current.stop();
    const probe = new ProfileManager({ dbPath: join(DATA_DIR, "probe.db"), profilesRoot: join(DATA_DIR, "probe") });
    const template = probe.create({ name: "hostile", engine: ENGINE as "cloakbrowser" | "camoufox" });
    probe.close();
    const archive = join(DATA_DIR, "hostile.mzar");
    const passFile = join(DATA_DIR, "hostile.pass");
    writeFileSync(passFile, "pw");
    craftArchive(archive, "pw", { ...template, id: "hostile-archive" }, [
      { path: "downloads/.multizen-downloads.json", content: index },
      { path: "engines/x/kept", content: "kept" },
    ]);
    const imported = spawnSync(
      process.execPath,
      [CLI, "profile", "import", archive, "--passphrase-file", passFile, "--data-dir", DATA_DIR, "--default-engine", ENGINE],
      { encoding: "utf8", windowsHide: true },
    );
    if (imported.status !== 0) throw new Error(`profile import failed: ${imported.stdout}${imported.stderr}`);
    rmSync(join(DATA_DIR, "probe.db"), { force: true });
    rmSync(join(DATA_DIR, "probe"), { recursive: true, force: true });

    const dir = join(DATA_DIR, "profiles", "hostile-archive");
    const planted = existsSync(join(dir, "downloads"));
    current = await serve(flags);
    const client = await connect(current, owner);
    const listed = await must(client, "list_downloads", { profile_id: "hostile-archive" });
    const read = await call(client, "get_download", { profile_id: "hostile-archive", download_id: "planted" });

    // And the same index had it got there some other way.
    mkdirSync(join(dir, "downloads"), { recursive: true });
    writeFileSync(join(dir, "downloads", ".multizen-downloads.json"), index);
    await current.stop();
    current = await serve(flags);
    const later = await connect(current, owner);
    const relisted = await must(later, "list_downloads", { profile_id: "hostile-archive" });
    const reread = await call(later, "get_download", { profile_id: "hostile-archive", download_id: "planted" });
    await client.close().catch(() => {});
    await later.close();
    const survives = readFileSync(join(DATA_DIR, "owner-token"), "utf8") === secret;
    row(
      "S3 hostile archive",
      !planted &&
        listed.downloads.length === 0 &&
        read.isError &&
        relisted.downloads.length === 0 &&
        reread.isError &&
        survives,
      `import wrote no downloads dir: ${!planted}; get_download gets ${read.body.error?.code}, and with the index put there by hand ${reread.body.error?.code}; owner-token survives: ${survives}`,
    );
  });
  return current;
}

/** The server's own threads, to tell the pool's size. Linux only. */
function threadsOf(pid: number): number {
  return readdirSync(`/proc/${pid}/task`).length;
}

async function flowDns(server: Serve, client: Client, base: string): Promise<void> {
  const flooded = await newProfile(client, "flooded");
  const other = await newProfile(client, "other");
  await must(client, "launch_profile", { profile_id: flooded });
  await must(client, "launch_profile", { profile_id: other });
  await must(client, "navigate", { profile_id: flooded, url: `${base}/page` });
  await must(client, "navigate", { profile_id: other, url: `${base}/page` });
  await must(client, "evaluate_js", {
    profile_id: flooded,
    expression: evaluate(
      `for (let i = 0; i < 300; i++) { fetch("http://n" + i + ".blackhole.test/", { mode: "no-cors" }).catch(() => {}); }`,
    ),
  });
  await wait(1_000);
  const threads = IS_WINDOWS ? -1 : threadsOf(server.child.pid!);
  const timings: Record<string, number> = {};
  const timed = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
    const started = performance.now();
    await fn();
    timings[name] = Math.round(performance.now() - started);
  };
  await timed("navigate on the other profile", () => must(client, "navigate", { profile_id: other, url: `${base}/page?again` }));
  await timed("extract on the other profile", () => must(client, "extract", { profile_id: other }));
  await timed("list_downloads, which reads no disk once opened", () => must(client, "list_downloads", { profile_id: other }));
  await timed("upload_file, which writes to disk", async () => {
    await must(client, "navigate", { profile_id: other, url: `${base}/upload` });
    await must(client, "upload_file", {
      profile_id: other,
      selector: "#f",
      files: [{ file_name: "a.bin", data_base64: Buffer.alloc(10_000, 4).toString("base64") }],
    });
  });
  await timed("list_profiles", () => must(client, "list_profiles", {}));
  const slowest = Math.max(...Object.values(timings));
  row(
    "S4 names nobody answers",
    slowest < 8_000 && (IS_WINDOWS || threads >= 64),
    `a page asking for 300 names under a resolver that never answers; ${threads} server threads; ${JSON.stringify(timings)}`,
  );
  await must(client, "close_profile", { profile_id: flooded });
  await must(client, "close_profile", { profile_id: other });
}

function modesUnder(dir: string): string[] {
  const open: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isSymbolicLink() || entry.isSocket()) continue;
      if ((statSync(path).mode & 0o077) !== 0) open.push(`${path} ${(statSync(path).mode & 0o777).toString(8)}`);
      if (entry.isDirectory()) walk(path);
    }
  };
  walk(dir);
  return open;
}

function flowModes(server: Serve, secret: string): void {
  const lock = readFileSync(join(DATA_DIR, "server.lock"), "utf8");
  row(
    "S8 server.lock",
    !lock.includes(secret) && !lock.includes("handoff-webhook-secret"),
    `the webhook secret on the command line isn't in it; fields: ${Object.keys(JSON.parse(lock) as object).join(",")}`,
  );
  if (IS_WINDOWS) {
    row("S7 modes", true, "not applicable on Windows: the directory's ACL is what applies there");
    return;
  }
  row("S8 lock mode", (statSync(join(DATA_DIR, "server.lock")).mode & 0o777) === 0o600, "0600");
  // A linked engine's files are the seed's, outside this data dir.
  const open = modesUnder(DATA_DIR).filter((line) => !line.includes(`${join(DATA_DIR, "camoufox")} `));
  row(
    "S7 modes",
    open.length === 0 && (statSync(DATA_DIR).mode & 0o077) === 0,
    `${DATA_DIR} is ${(statSync(DATA_DIR).mode & 0o777).toString(8)}; open to others under it: ${open.length}${open.length ? `: ${open.slice(0, 5).join("; ")}` : ""}`,
  );
  void server;
}

function flowWarnings(): Promise<void> {
  return attempt("S23 warning", async () => {
    const wide = await serve(["--egress-allow", "127.0.0.1,example.test"], { MULTIZEN_LOG_LEVEL: "info" });
    const warned = /lets pages reach every port on this machine.*"entries":\["127\.0\.0\.1"\]/.test(wide.log());
    await wide.stop();
    const narrow = await serve(["--egress-allow", "127.0.0.1:8080"]);
    const quiet = !narrow.log().includes("lets pages reach every port");
    await narrow.stop();
    row("S23 warning", warned && quiet, `127.0.0.1 with no port warns: ${warned}; 127.0.0.1:8080 doesn't: ${quiet}`);
  });
}

/** The real install path and the real pin, with only the bytes swapped. */
async function flowCorrupt(): Promise<void> {
  await attempt("S11 corrupted download", async () => {
    const asked: string[] = [];
    const bad = createHttpServer((req, res) => {
      asked.push(req.url ?? "");
      res.writeHead(200, { "content-type": "application/octet-stream" }).end(Buffer.alloc(1_000_000, 7));
    });
    await new Promise<void>((done) => bad.listen(0, "127.0.0.1", done));
    const { port } = bad.address() as AddressInfo;
    const cacheDir = join(DATA_DIR, "corrupt-cache");
    const realHost = createNodeHost(DATA_DIR);
    const pin = pinnedCloakBrowserManifest();
    const bootstrap = new ChromiumBootstrap({
      engine: "cloakbrowser",
      cacheDir,
      pinned: true,
      retryDelayMs: 20,
      host: {
        ...realHost,
        fetch: () => {
          throw new Error("a pinned install asks nobody what is newest");
        },
        request: (opts) => {
          asked.push(opts.url);
          return realHost.request({ ...opts, url: `http://127.0.0.1:${port}/asset` });
        },
      },
    });
    const error = await bootstrap.ensure().then(
      () => "installed",
      (e: Error) => e.message,
    );
    await new Promise<void>((done) => {
      bad.closeAllConnections();
      bad.close(() => done());
    });
    const left = existsSync(cacheDir) ? readdirSync(cacheDir) : [];
    row(
      "S11 corrupted download",
      /checksum mismatch/.test(error) &&
        bootstrap.getStatus().kind === "error" &&
        asked[0] === pin.url &&
        !left.includes("current.json") &&
        !left.includes(pin.version),
      `asked for ${asked[0]}; ${error.slice(0, 200)}; status ${bootstrap.getStatus().kind}; left in the cache: ${left.join(",") || "nothing"}`,
    );
  });
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  prepareDataDir();
  if (FLOWS.has("corrupt")) await flowCorrupt();
  if (FLOWS.has("bodies")) await flowBodies();
  if (FLOWS.has("sockets")) await flowSockets();
  if ([...FLOWS].every((flow) => NO_BROWSER_FLOWS.has(flow))) {
    if (!values.keep) cleanDataDir();
    process.stdout.write(`${failures === 0 ? "ALL OK" : `${failures} FAILED`}\n`);
    process.exitCode = failures === 0 ? 0 : 1;
    return;
  }
  const fixture = await startFixture();
  const closedPort = await freePort();
  const base = `http://127.0.0.1:${fixture.port}`;
  const webhookSecret = "WEBHOOK-SECRET-ON-THE-COMMAND-LINE";
  const flags = [
    "--egress-allow",
    `127.0.0.1:${fixture.port},127.0.0.1:${closedPort}`,
    "--download-quota-bytes",
    String(FILE_BYTES * 3 + 1_000),
    "--upload-inbox-quota-bytes",
    "80000",
    "--max-sessions-per-token",
    "3",
    "--handoff-webhook",
    "http://127.0.0.1:9/hook",
    "--handoff-webhook-secret",
    webhookSecret,
  ];
  let server = await serve(flags);
  try {
    const owner = ownerToken();
    await waitForEngine(server, owner);
    process.stdout.write(`engine ready: ${ENGINE}\n`);
    const client = await connect(server, owner);
    if (FLOWS.has("modes")) flowModes(server, webhookSecret);
    if (FLOWS.has("downloads")) await flowDownloads(server, client, base);
    if (FLOWS.has("uploads")) await flowUploads(client, base);
    if (FLOWS.has("navigate")) await flowNavigate(server, client, closedPort);
    if (FLOWS.has("dns")) await flowDns(server, client, base);
    if (FLOWS.has("modes")) {
      // Now with what browsers left behind in it.
      flowModes(server, webhookSecret);
    }
    if (FLOWS.has("sessions")) await flowSessions(server, owner);
    if (FLOWS.has("proxy")) server = await flowProxy(flags, client, server);
    if (FLOWS.has("archive")) server = await flowArchive(flags, server, owner);
    await client.close().catch(() => {});
    await server.stop();
    if (FLOWS.has("warnings")) await flowWarnings();
  } finally {
    await server.stop();
    await fixture.close();
    if (!values.keep) cleanDataDir();
  }
  process.stdout.write(`${failures === 0 ? "ALL OK" : `${failures} FAILED`}\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

await main();
