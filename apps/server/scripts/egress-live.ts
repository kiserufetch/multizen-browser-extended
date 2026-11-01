/**
 * Live check of the egress policy: the built server, a real engine, real MCP clients, and
 * local listeners that count who reaches them. Not part of test:unit. Every server here
 * runs with --headless and the production policy; its fixtures are let through by
 * --egress-allow, one host:port at a time, so a page on the fixture still can't reach
 * anything else on this machine.
 *
 *   corepack yarn workspace @multizen/server build
 *   corepack yarn workspace @multizen/server exec tsx scripts/egress-live.ts \
 *     --data-dir %TEMP%\mzts9 --engine cloakbrowser --engine-version-dir <dir with chrome.exe> \
 *     [--engine camoufox --camoufox-install <dir>] [--lan-address <ip>] [--out <file>] [--keep]
 *
 * --lan-address is a non-loopback address of this machine to use as a private target and for
 * WebRTC, which ignores loopback (a host-only adapter is a good choice; it binds there).
 * Without it the first non-internal IPv4 address is used, on Windows too.
 *
 * Each row is reported enforced, not enforced or not applicable. Rows that expect silence have
 * a control: the same probes under --egress-policy allow-all must reach the same listeners,
 * or that silence proves nothing. DNS rebinding runs on the real path, with the server's
 * resolver replaced by a preload (see DNS_STUB), as nothing else can make one name answer
 * differently on command. On CloakBrowser the WebRTC control is the bare binary with its UDP
 * policy opened by a flag: with no flag at all this engine gathers no UDP candidates anyway.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createSocket, type Socket as UdpSocket } from "node:dgram";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect as netConnect, createServer as createNetServer, type AddressInfo, type Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const { values } = parseArgs({
  options: {
    "data-dir": { type: "string" },
    engine: { type: "string" },
    "engine-version-dir": { type: "string" },
    "camoufox-install": { type: "string" },
    "lan-address": { type: "string" },
    out: { type: "string" },
    keep: { type: "boolean" },
  },
});
const IS_WINDOWS = process.platform === "win32";
const dataDirFlag = values["data-dir"];
if (!dataDirFlag) throw new Error("--data-dir is required");
const DATA_DIR = resolve(dataDirFlag);
const ENGINE = values.engine ?? "cloakbrowser";
const IS_CAMOUFOX = ENGINE === "camoufox";
const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "cli.js");
if (!existsSync(CLI)) throw new Error(`${CLI} is missing: build the server first`);
const ENGINE_INSTALL_BUDGET_MS = 15 * 60_000;
/** How long a page's requests get to arrive at a listener before it is counted. */
const SETTLE_MS = 2_500;

function lanAddress(): string {
  if (values["lan-address"]) return values["lan-address"];
  for (const addresses of Object.values(networkInterfaces())) {
    const found = addresses?.find((a) => a.family === "IPv4" && !a.internal);
    if (found) return found.address;
  }
  throw new Error("no non-loopback address here: pass --lan-address");
}

// ── results ──────────────────────────────────────────────────────────────────

type Verdict = "enforced" | "not enforced" | "not applicable" | "documented hole" | "no hole here";
const rows: Array<{ row: string; verdict: Verdict; observed: string }> = [];

function report(row: string, verdict: Verdict, observed: string): void {
  rows.push({ row, verdict, observed });
  process.stdout.write(`${verdict.padEnd(16)} ${row}: ${observed}\n`);
}

function enforcedIf(row: string, ok: boolean, observed: string): void {
  report(row, ok ? "enforced" : "not enforced", observed);
}

/** A row that threw is no evidence either way: it reads as not enforced, with what happened. */
async function attempt(row: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    report(row, "not enforced", `the check itself failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const wait = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

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
  writeFileSync(
    join(cache, "current.json"),
    JSON.stringify({ version, binaryRelative: IS_WINDOWS ? "chrome.exe" : "chrome" }),
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
    // An install of another version than the server wants gets replaced by a real directory.
    else if (lstatSync(link).isSymbolicLink()) unlinkSync(link);
  }
  rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}

// ── fixtures ─────────────────────────────────────────────────────────────────

const PAGE = `<!doctype html><html><head><title>MZ allowed</title></head><body><h1>allowed</h1></body></html>`;
/** What the bare binary of the WebRTC control opens: a page that tries it by itself. */
const pageRunning = (script: string): string => `${PAGE}<script>${script}</script>`;

/**
 * The one site a page may be on. Any Host: a proxied profile reaches it under a made-up name.
 * Every response ends its connection, so the next request is a new CONNECT at the bridge.
 */
interface Site {
  server: Server;
  port: number;
  requests: string[];
  close(): Promise<void>;
}

async function startSite(privateUrl: () => string, webrtcControlPage: () => string): Promise<Site> {
  const requests: string[] = [];
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    requests.push(`${req.headers.host ?? ""}${req.url ?? ""}`);
    const path = req.url?.split("?")[0];
    res.setHeader("connection", "close");
    res.setHeader("cache-control", "no-store");
    if (path === "/redirect-private") res.writeHead(302, { location: `${privateUrl()}/from-redirect` }).end();
    else if (path === "/redirect-metadata") res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }).end();
    else if (path === "/redirect-decimal") res.writeHead(302, { location: "http://2852039166/latest/meta-data/" }).end();
    else if (path === "/webrtc-control") res.writeHead(200, { "content-type": "text/html" }).end(webrtcControlPage());
    else res.writeHead(200, { "content-type": "text/html" }).end(PAGE);
  };
  const server = createHttpServer(handler);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    server,
    port: (server.address() as AddressInfo).port,
    requests,
    close: () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

/** A private service: it counts every TCP connection, whatever comes of it, per address. */
interface Sink {
  port: number;
  connections: string[];
  close(): Promise<void>;
}

async function startSink(hosts: readonly string[], portWanted = 0): Promise<Sink> {
  const connections: string[] = [];
  const servers: Server[] = [];
  let port = portWanted;
  for (const host of hosts) {
    const server = createHttpServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html" }).end(`<title>MZ private</title>${req.url ?? ""}`);
    });
    server.on("connection", (socket) => connections.push(`${socket.localAddress}:${socket.localPort}`));
    server.on("upgrade", (_req, socket) => (socket as Socket).destroy());
    server.on("error", () => {});
    await new Promise<void>((done) => {
      server.once("error", () => done());
      server.listen(port, host, () => {
        port = (server.address() as AddressInfo).port;
        servers.push(server);
        done();
      });
    });
  }
  return {
    port,
    connections,
    close: async () => {
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((done) => {
              server.closeAllConnections();
              server.close(() => done());
            }),
        ),
      );
    },
  };
}

interface UdpResponder {
  port: number;
  datagrams: () => number;
  close(): void;
}

async function startUdpResponder(hosts: readonly string[]): Promise<UdpResponder> {
  let received = 0;
  const sockets: UdpSocket[] = [];
  let port = 0;
  for (const host of hosts) {
    const socket = createSocket("udp4");
    socket.on("message", () => (received += 1));
    socket.on("error", () => {});
    await new Promise<void>((done) => {
      socket.once("error", () => done());
      socket.bind(port, host, () => {
        port = socket.address().port;
        sockets.push(socket);
        done();
      });
    });
  }
  return {
    port,
    datagrams: () => received,
    close: () => {
      for (const socket of sockets) socket.close();
    },
  };
}

/** A public-style upstream proxy, no password: every CONNECT lands on the site, and is noted. */
async function startSocksProxy(targetPort: number): Promise<{ port: number; connects: string[]; close(): Promise<void> }> {
  const connects: string[] = [];
  const sockets = new Set<Socket>();
  const server = createNetServer((client) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => {});
    client.once("data", () => {
      client.write(Buffer.from([5, 0]));
      client.once("data", (request: Buffer) => {
        const type = request[3];
        const nameLength = request[4]!;
        const host =
          type === 3 ? request.subarray(5, 5 + nameLength).toString() : request.subarray(4, type === 1 ? 8 : 20).join(".");
        const portAt = type === 3 ? 5 + nameLength : type === 1 ? 8 : 20;
        connects.push(`${host}:${request.readUInt16BE(portAt)}`);
        const upstream = netConnect(targetPort, "127.0.0.1", () => {
          client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          client.pipe(upstream);
          upstream.pipe(client);
        });
        upstream.on("error", () => client.destroy());
        client.on("close", () => upstream.destroy());
      });
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    port: (server.address() as AddressInfo).port,
    connects,
    close: () =>
      new Promise((done) => {
        server.close(() => done());
        for (const socket of sockets) socket.destroy();
      }),
  };
}

/**
 * Replaces the lookup behind the policy with a table this script rewrites between steps, and
 * logs each name asked for. Anything not in the table goes to the real resolver.
 */
const DNS_STUB = `
import { promises as dns } from "node:dns";
import { appendFileSync, readFileSync } from "node:fs";
const real = dns.lookup.bind(dns);
dns.lookup = async (host, options) => {
  appendFileSync(process.env.MZ_DNS_STUB_LOG, host + "\\n");
  const table = JSON.parse(readFileSync(process.env.MZ_DNS_STUB_TABLE, "utf8"));
  if (table[host]) {
    return table[host].map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  }
  return real(host, options);
};
`;

interface DnsStub {
  answer(table: Record<string, string[]>): void;
  asked(): string[];
  env: Record<string, string>;
  preload: string;
}

function prepareDnsStub(): DnsStub {
  const stubDir = join(DATA_DIR, "dns-stub");
  mkdirSync(stubDir, { recursive: true });
  const preload = join(stubDir, "stub.mjs");
  const table = join(stubDir, "table.json");
  const log = join(stubDir, "asked.log");
  writeFileSync(preload, DNS_STUB);
  writeFileSync(table, "{}");
  writeFileSync(log, "");
  return {
    answer: (t) => writeFileSync(table, JSON.stringify(t)),
    asked: () => readFileSync(log, "utf8").split("\n").filter(Boolean),
    env: { MZ_DNS_STUB_TABLE: table, MZ_DNS_STUB_LOG: log },
    preload,
  };
}

// ── the server and its client ────────────────────────────────────────────────

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };

interface Serve {
  child: ChildProcess;
  port: number;
  client: Client;
  output(): string;
}

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  await new Promise((done) => server.close(done));
  return port;
}

async function startServe(flags: string[], stub: DnsStub): Promise<Serve> {
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [
      "--import",
      pathToFileURL(stub.preload).href,
      CLI,
      "serve",
      "--data-dir",
      DATA_DIR,
      "--port",
      String(port),
      "--headless",
      ...(IS_CAMOUFOX ? ["--default-engine", "camoufox"] : []),
      ...flags,
    ],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env, ...stub.env } },
  );
  let output = "";
  child.stdout?.on("data", (c: Buffer) => (output += c.toString("utf8")));
  child.stderr?.on("data", (c: Buffer) => (output += c.toString("utf8")));
  const deadline = Date.now() + 60_000;
  while (!output.includes('"listening"')) {
    if (Date.now() > deadline || child.exitCode !== null) throw new Error(`serve did not listen:\n${output}`);
    await wait(50);
  }
  const token = readFileSync(join(DATA_DIR, "owner-token"), "utf8");
  const client = new Client({ name: "egress-live", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return { child, port, client, output: () => output };
}

async function stopServe(serve: Serve): Promise<void> {
  const { profiles } = await call(serve.client, "list_profiles").catch(() => ({ profiles: [] }));
  for (const profile of profiles as Array<{ id: string; isRunning: boolean }>) {
    if (profile.isRunning) await call(serve.client, "close_profile", { profile_id: profile.id }).catch(() => {});
  }
  await serve.client.close().catch(() => {});
  const exited = new Promise((done) => serve.child.once("close", done));
  // No browser is left to wait for, so on Windows, which delivers no signals, this is enough.
  serve.child.kill();
  await exited;
}

async function rawCall(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 })) as ToolResult;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const result = await rawCall(client, name, args);
  const text = result.content[0]?.text ?? "{}";
  if (result.isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text) as Record<string, unknown>;
}

/** What a call answered: its error code and message, or `ok`. */
async function outcome(client: Client, name: string, args: Record<string, unknown>): Promise<{ code: string; message: string }> {
  const result = await rawCall(client, name, args);
  const text = result.content[0]?.text ?? "{}";
  if (!result.isError) return { code: "ok", message: text.slice(0, 200) };
  const { error } = JSON.parse(text) as { error: { code: string; message: string } };
  return error;
}

async function launch(client: Client, id: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + ENGINE_INSTALL_BUDGET_MS;
  for (;;) {
    const result = await rawCall(client, "launch_profile", { profile_id: id });
    const body = JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown> & {
      error?: { code?: string; retryable?: boolean; details?: { retry_after_ms?: number } };
    };
    if (!result.isError) return body;
    if (body.error?.code !== "ENGINE_NOT_READY" || Date.now() > deadline) {
      throw new Error(`launch_profile failed: ${JSON.stringify(body)}`);
    }
    await wait(body.error.details?.retry_after_ms ?? 5000);
  }
}

async function createProfile(client: Client, name: string, extra: Record<string, unknown> = {}): Promise<string> {
  return String((await call(client, "create_profile", { name, engine: ENGINE, ...extra })).id);
}

async function evaluate(client: Client, id: string, expression: string): Promise<unknown> {
  const result = await call(client, "evaluate_js", { profile_id: id, expression });
  return (result.result as { value?: unknown } | undefined)?.value;
}

async function browserCommandLine(pid: number): Promise<string> {
  if (!IS_WINDOWS) return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ");
  const res = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
    { encoding: "utf8", windowsHide: true },
  );
  return res.stdout;
}

// ── page probes ──────────────────────────────────────────────────────────────

/**
 * Starts a fetch, an image, an iframe and a WebSocket at `origin`, each noting how it ended
 * in window.__mz. evaluate_js doesn't await on CloakBrowser, so a later call reads the results.
 */
function probeScript(origin: string): string {
  return `(() => {
    const origin = ${JSON.stringify(origin)};
    const slot = (window.__mz = window.__mz || {})[origin] = {};
    fetch(origin + "/p-fetch", { mode: "no-cors", cache: "no-store" }).then(
      () => (slot.fetch = "resolved"),
      (e) => (slot.fetch = "rejected"),
    );
    const img = new Image();
    img.onload = () => (slot.img = "loaded");
    img.onerror = () => (slot.img = "failed");
    img.src = origin + "/p-img";
    const frame = document.createElement("iframe");
    frame.onload = () => (slot.frame = "load fired");
    frame.src = origin + "/p-frame";
    document.body.append(frame);
    try {
      const ws = new WebSocket(origin.replace(/^http/, "ws") + "/p-ws");
      ws.onopen = () => (slot.ws = "open");
      ws.onerror = () => (slot.ws = "error");
    } catch (e) {
      slot.ws = "threw";
    }
    return 1;
  })()`;
}

interface ProbeResults {
  [origin: string]: { fetch?: string; img?: string; frame?: string; ws?: string };
}

async function probePage(client: Client, id: string, origins: readonly string[]): Promise<ProbeResults> {
  for (const origin of origins) await evaluate(client, id, probeScript(origin));
  await wait(SETTLE_MS);
  return JSON.parse(String(await evaluate(client, id, "JSON.stringify(window.__mz)"))) as ProbeResults;
}

const WEBRTC_SCRIPT = (urls: string[]): string => `(() => {
  window.__rtc = "started";
  if (typeof RTCPeerConnection === "undefined") {
    window.__rtc = "no RTCPeerConnection";
    return 1;
  }
  (async () => {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: ${JSON.stringify(urls)} }] });
    pc.createDataChannel("x");
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise((done) => {
      pc.onicegatheringstatechange = () => pc.iceGatheringState === "complete" && done();
      setTimeout(done, 5000);
    });
    const candidates = (pc.localDescription.sdp.match(/a=candidate:.*/g) || []).map((c) => c.split(" ")[7]);
    pc.close();
    window.__rtc = "gathered: " + (candidates.join(",") || "none");
  })().catch((e) => (window.__rtc = "threw " + e));
  return 1;
})()`;

const WEBTRANSPORT_SCRIPT = (url: string): string => `(() => {
  window.__wt = "started";
  if (typeof WebTransport === "undefined") {
    window.__wt = "no WebTransport";
    return 1;
  }
  try {
    const wt = new WebTransport(${JSON.stringify(url)});
    wt.ready.then(() => (window.__wt = "ready"), (e) => (window.__wt = "failed: " + e.message));
  } catch (e) {
    window.__wt = "threw " + e;
  }
  return 1;
})()`;

async function webrtcAttempt(client: Client, id: string, udp: UdpResponder, lan: string): Promise<{ page: string; datagrams: number }> {
  const before = udp.datagrams();
  await evaluate(client, id, WEBRTC_SCRIPT([`stun:${lan}:${udp.port}`, `stun:127.0.0.1:${udp.port}`]));
  const deadline = Date.now() + 8_000;
  let page = "started";
  while (Date.now() < deadline && page === "started") {
    await wait(250);
    page = String(await evaluate(client, id, "window.__rtc"));
  }
  await wait(500);
  return { page, datagrams: udp.datagrams() - before };
}

async function webTransportAttempt(client: Client, id: string, udp: UdpResponder, lan: string): Promise<{ page: string; datagrams: number }> {
  const before = udp.datagrams();
  await evaluate(client, id, WEBTRANSPORT_SCRIPT(`https://${lan}:${udp.port}/`));
  await wait(SETTLE_MS);
  return { page: String(await evaluate(client, id, "window.__wt")), datagrams: udp.datagrams() - before };
}

// ── the runs ─────────────────────────────────────────────────────────────────

interface World {
  site: Site;
  sink: Sink;
  rebindSink: Sink;
  udp: UdpResponder;
  stub: DnsStub;
  lan: string;
}

/** What control rows compare against: the same probes under allow-all. */
interface Controls {
  sinkConnections?: number;
  mcpFetch?: string;
  cdpFetch?: string;
  webrtcDatagrams?: number;
  webTransportDatagrams?: number;
}

const blocked = (o: { code: string }): boolean => o.code === "EGRESS_BLOCKED";

function privateOrigins(w: World): string[] {
  return [
    `http://127.0.0.2:${w.sink.port}`,
    `http://127.0.0.1:${w.sink.port}`,
    `http://localhost:${w.sink.port}`,
    `http://${w.lan}:${w.sink.port}`,
    `http://[::1]:${w.sink.port}`,
    // The same address, in the spellings a parser normalizes and a bridge has to handle.
    `http://2130706434:${w.sink.port}`,
    `http://0x7f.2:${w.sink.port}`,
    `http://[::ffff:127.0.0.2]:${w.sink.port}`,
  ];
}

async function pageProbeRows(
  what: string,
  serve: Serve,
  w: World,
  id: string,
  cdpPort: number | null,
  controls: Controls,
): Promise<void> {
  const before = w.sink.connections.length;
  const results = await probePage(serve.client, id, privateOrigins(w));
  const reached = w.sink.connections.slice(before);
  enforcedIf(
    `${what}: page fetch, img, iframe, ws to private and loopback addresses`,
    reached.length === 0,
    `listeners saw ${reached.length} connections over ${privateOrigins(w).length} origins, 4 probes each` +
      (controls.sinkConnections === undefined ? "" : ` (allow-all control: ${controls.sinkConnections})`) +
      `; fetches: ${[...new Set(Object.values(results).map((r) => r.fetch))].join(",")}`,
  );

  const mcp = `http://127.0.0.1:${serve.port}`;
  const mcpResult = await probePage(serve.client, id, [mcp]);
  const mcpLogged = serve.output().includes(`egress policy blocked 127.0.0.1:${serve.port}`);
  enforcedIf(
    `${what}: page to 127.0.0.1:<MCP port>`,
    mcpResult[mcp]?.fetch === "rejected" && mcpResult[mcp]?.ws !== "open" && mcpLogged,
    `fetch ${mcpResult[mcp]?.fetch}, ws ${mcpResult[mcp]?.ws}; bridge logged the block: ${mcpLogged}` +
      (controls.mcpFetch === undefined ? "" : ` (allow-all control fetch: ${controls.mcpFetch})`),
  );

  if (cdpPort === null) {
    report(`${what}: page to 127.0.0.1:<CDP port>`, "not applicable", "Camoufox has no CDP port: Playwright drives it over a pipe");
    return;
  }
  const cdp = `http://127.0.0.1:${cdpPort}`;
  const cdpResult = await probePage(serve.client, id, [cdp]);
  const cdpLogged = serve.output().includes(`egress policy blocked 127.0.0.1:${cdpPort}`);
  enforcedIf(
    `${what}: page to 127.0.0.1:<CDP port>`,
    cdpResult[cdp]?.fetch === "rejected" && cdpResult[cdp]?.ws !== "open" && cdpLogged,
    `fetch ${cdpResult[cdp]?.fetch}, ws ${cdpResult[cdp]?.ws}; bridge logged the block: ${cdpLogged}` +
      (controls.cdpFetch === undefined ? "" : ` (allow-all control fetch: ${controls.cdpFetch})`),
  );
}

async function udpRows(what: string, serve: Serve, w: World, id: string, controls: Controls): Promise<void> {
  const rtc = await webrtcAttempt(serve.client, id, w.udp, w.lan);
  enforcedIf(
    `${what}: WebRTC STUN to a local UDP responder`,
    rtc.datagrams === 0,
    `responder got ${rtc.datagrams} datagrams; page: ${rtc.page}` +
      (controls.webrtcDatagrams === undefined ? "" : ` (control: ${controls.webrtcDatagrams})`),
  );
  const wt = await webTransportAttempt(serve.client, id, w.udp, w.lan);
  enforcedIf(
    `${what}: WebTransport (QUIC) to the same responder`,
    wt.datagrams === 0 && wt.page !== "ready",
    `responder got ${wt.datagrams} datagrams; page: ${wt.page}` +
      (controls.webTransportDatagrams === undefined ? "" : ` (allow-all control: ${controls.webTransportDatagrams})`),
  );
}

/**
 * CloakBrowser gathers no UDP candidates by default, so allow-all can't show what a leak would
 * look like at the responder. The bare binary with the policy opened by a flag can. Nothing
 * of this server's is involved: this proves only that the page's attempt and the responder
 * can see a STUN request at all.
 */
async function bareEngineWebrtcControl(w: World): Promise<number> {
  const versionDir = values["engine-version-dir"];
  if (!versionDir) return -1;
  const binary = join(versionDir, IS_WINDOWS ? "chrome.exe" : "chrome");
  const dir = join(DATA_DIR, "bare");
  const before = w.udp.datagrams();
  const child = spawn(
    binary,
    [
      `--user-data-dir=${dir}`,
      `--remote-debugging-port=${await freePort()}`,
      "--no-first-run",
      "--headless=new",
      "--webrtc-ip-handling-policy=default",
      `http://127.0.0.1:${w.site.port}/webrtc-control`,
    ],
    { stdio: "ignore", detached: !IS_WINDOWS },
  );
  try {
    await wait(10_000);
    return w.udp.datagrams() - before;
  } finally {
    if (IS_WINDOWS) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    else if (child.pid) process.kill(-child.pid, "SIGKILL");
    await wait(500);
  }
}

/** allow-all first: what the enforcing runs' silence is compared with. */
async function allowAllRun(w: World, pivotProxyHost: string): Promise<{ controls: Controls; pivotId: string }> {
  const controls: Controls = {};
  const serve = await startServe(["--egress-policy", "allow-all"], w.stub);
  let pivotId = "";
  try {
    const { client } = serve;
    pivotId = await createProfile(client, "egress-pivot", {
      proxy: { type: "socks5", host: pivotProxyHost, port: 1080 },
    });
    const id = await createProfile(client, "egress-open");
    const launched = await launch(client, id);

    if (!IS_CAMOUFOX) {
      const argv = await browserCommandLine(Number(launched.pid));
      enforcedIf(
        "allow-all, direct: argv as on the desktop, no bridge",
        !/--proxy-server|--proxy-bypass-list|--webrtc-ip-handling-policy/.test(argv),
        "no --proxy-server, --proxy-bypass-list or --webrtc-ip-handling-policy",
      );
    } else {
      report("allow-all, direct: argv as on the desktop, no bridge", "not applicable", "prefs, not flags, on Camoufox");
    }

    const sinkUrl = `http://127.0.0.2:${w.sink.port}/page`;
    const before = w.sink.connections.length;
    const loaded = await outcome(client, "navigate", { profile_id: id, url: sinkUrl });
    enforcedIf(
      "--egress-policy allow-all loads a private address",
      loaded.code === "ok" && w.sink.connections.length > before,
      `navigate ${loaded.code}; listener saw ${w.sink.connections.length - before} connections`,
    );

    await call(client, "navigate", { profile_id: id, url: `http://127.0.0.1:${w.site.port}/page` });
    const sinkBefore = w.sink.connections.length;
    await probePage(client, id, privateOrigins(w));
    controls.sinkConnections = w.sink.connections.length - sinkBefore;
    const mcp = `http://127.0.0.1:${serve.port}`;
    controls.mcpFetch = (await probePage(client, id, [mcp]))[mcp]?.fetch ?? "no result";
    if (!IS_CAMOUFOX) {
      const cdp = String(launched.cdpEndpoint);
      controls.cdpFetch = (await probePage(client, id, [cdp]))[cdp]?.fetch ?? "no result";
    }
    const rtc = await webrtcAttempt(client, id, w.udp, w.lan);
    controls.webrtcDatagrams = rtc.datagrams;
    if (!IS_CAMOUFOX) {
      process.stdout.write(`control          allow-all gathers no UDP on this engine: ${rtc.page}\n`);
      controls.webrtcDatagrams = await bareEngineWebrtcControl(w);
      process.stdout.write(
        `control          bare binary, --webrtc-ip-handling-policy=default: ${controls.webrtcDatagrams} datagrams\n`,
      );
    }
    const wt = await webTransportAttempt(client, id, w.udp, w.lan);
    controls.webTransportDatagrams = wt.datagrams;
    process.stdout.write(
      `control          allow-all, same probes: ${JSON.stringify(controls)}; WebRTC page: ${rtc.page}; WebTransport page: ${wt.page}\n`,
    );
  } finally {
    await stopServe(serve);
  }
  return { controls, pivotId };
}

async function directRun(w: World, controls: Controls): Promise<void> {
  const allowSite = `127.0.0.1:${w.site.port}`;
  const serve = await startServe(["--egress-allow", allowSite], w.stub);
  try {
    const { client } = serve;
    const id = await createProfile(client, "egress-direct");
    const launched = await launch(client, id);
    const cdpPort = IS_CAMOUFOX ? null : Number(new URL(String(launched.cdpEndpoint)).port);

    if (!IS_CAMOUFOX) {
      const argv = await browserCommandLine(Number(launched.pid));
      const flags = argv.split(/\s+/).filter((a) => /^"?--(proxy|webrtc|dns|disable-(async|background|component|domain|client))/.test(a));
      enforcedIf(
        "direct: only the three flags",
        flags.length === 3 && !/--disable-features=[^ ]*DnsOverHttps/.test(argv),
        flags.join(" "),
      );
    } else {
      report("direct: only the three flags", "not applicable", "block_webrtc plus the nine prefs on Camoufox");
    }

    const page = `http://${allowSite}/page`;
    const loaded = await outcome(client, "navigate", { profile_id: id, url: page });
    enforcedIf("direct: the allowed fixture loads", loaded.code === "ok", `navigate ${loaded.code}`);

    for (const url of [
      "http://169.254.169.254/",
      "http://169.254.169.254/latest/meta-data/",
      "http://2852039166/",
      "http://[::ffff:169.254.169.254]/",
      "http://0x7f.1/",
      "http://metadata.google.internal/",
      "http://localhost/",
    ]) {
      const result = await outcome(client, "navigate", { profile_id: id, url });
      enforcedIf(`direct: navigate ${url}`, blocked(result), `${result.code}: ${result.message}`);
    }
    const tab = await outcome(client, "new_tab", { profile_id: id, url: "http://169.254.169.254/" });
    enforcedIf("direct: new_tab http://169.254.169.254/", blocked(tab), `${tab.code}: ${tab.message}`);

    w.stub.answer({ "meta.mzt.test": ["169.254.169.254"] });
    const byName = await outcome(client, "navigate", { profile_id: id, url: "http://meta.mzt.test/" });
    enforcedIf(
      "direct: a name resolving to metadata",
      blocked(byName),
      `${byName.code}: ${byName.message}`,
    );

    for (const [path, what] of [
      ["/redirect-private", "a private address"],
      ["/redirect-metadata", "the metadata address"],
      ["/redirect-decimal", "the metadata address, in decimal"],
    ] as const) {
      await call(client, "navigate", { profile_id: id, url: page });
      const sinkBefore = w.sink.connections.length;
      const redirected = await outcome(client, "navigate", { profile_id: id, url: `http://${allowSite}${path}` });
      const reached = w.sink.connections.length - sinkBefore;
      const where = await evaluate(client, id, "location.href").catch(() => "an error page");
      enforcedIf(
        `direct: 302 from the allowed fixture to ${what}`,
        blocked(redirected) && reached === 0,
        `${redirected.code}: ${redirected.message}; listener ${reached}; page at ${String(where)}`,
      );
    }

    await call(client, "navigate", { profile_id: id, url: page });
    await pageProbeRows("direct", serve, w, id, cdpPort, controls);
    await call(client, "navigate", { profile_id: id, url: page });
    await udpRows("direct", serve, w, id, controls);

    await rebindingRow(serve, w, id);
    await rawRow(serve, w, id);
    await call(client, "close_profile", { profile_id: id });
  } finally {
    await stopServe(serve);
  }
}

async function rebindingRow(serve: Serve, w: World, id: string): Promise<void> {
  const { client } = serve;
  const row = "direct: DNS rebinding, with the server's lookup answering differently on command";
  await attempt(row, async () => {
    const name = "rebind.mzt.test";
    w.stub.answer({ [name]: ["127.0.0.1"] });
    const origin = `http://${name}:${w.site.port}`;
    const loaded = await outcome(client, "navigate", { profile_id: id, url: `${origin}/page` });
    if (loaded.code !== "ok") throw new Error(`the first answer should have loaded: ${JSON.stringify(loaded)}`);
    const requestsBefore = w.site.requests.length;
    const askedBefore = w.stub.asked().filter((host) => host === name).length;

    // From here the name means another address, with a listener on it at the same port.
    w.stub.answer({ [name]: ["127.0.0.2"] });
    const sinkBefore = w.rebindSink.connections.length;
    await evaluate(
      client,
      id,
      `(() => { window.__again = "started"; fetch("/again", { cache: "no-store" }).then(
        (r) => r.text().then(() => (window.__again = "resolved")),
        () => (window.__again = "rejected"),
      ); return 1; })()`,
    );
    await wait(SETTLE_MS);
    const page = await evaluate(client, id, "window.__again");
    const asked = w.stub.asked().filter((host) => host === name).length - askedBefore;
    const reached = w.rebindSink.connections.length - sinkBefore;
    const servedByFirst = w.site.requests.slice(requestsBefore).filter((r) => r.includes("/again")).length;
    enforcedIf(
      row,
      // A few asks, not thousands: that is what a browser retrying a refused CONNECT looks like.
      reached === 0 && page === "rejected" && asked > 0 && asked < 50,
      `the bridge asked the resolver ${asked} more times; listener on the new address saw ${reached}; ` +
        `fetch ${String(page)}; the first address served it ${servedByFirst} times`,
    );
  });
}

async function rawRow(serve: Serve, w: World, id: string): Promise<void> {
  const { client } = serve;
  const row = "raw: Target.createBrowserContext{proxyServer:direct://} with cdp_send_no_safety";
  if (IS_CAMOUFOX) {
    const refused = await outcome(client, "cdp_send_no_safety", { profile_id: id, method: "Browser.getVersion" });
    report(row, "not applicable", `Camoufox has no CDP: ${refused.code}`);
    return;
  }
  await attempt(row, async () => {
    const version = (await call(client, "cdp_send_no_safety", { profile_id: id, method: "Browser.getVersion" })) as {
      product?: string;
    };
    process.stdout.write(`info             owner token, cdp_send_no_safety works as before: ${version.product}\n`);

    // Through the profile's own context the bridge still has its say.
    const inPlaceBefore = w.sink.connections.length;
    const tab = (await call(client, "cdp_send_no_safety", {
      profile_id: id,
      method: "Target.createTarget",
      params: { url: `http://127.0.0.2:${w.sink.port}/raw-same-context` },
    })) as { targetId: string };
    await wait(SETTLE_MS);
    enforcedIf(
      "raw: Target.createTarget in the profile's own context",
      w.sink.connections.length === inPlaceBefore,
      `listener saw ${w.sink.connections.length - inPlaceBefore}: the bridge still sees this`,
    );
    await call(client, "cdp_send_no_safety", { profile_id: id, method: "Target.closeTarget", params: { targetId: tab.targetId } });

    for (const tool of ["cdp_send_no_safety", "cdp_send"]) {
      const before = w.sink.connections.length;
      const context = (await call(client, tool, {
        profile_id: id,
        method: "Target.createBrowserContext",
        params: { proxyServer: "direct://" },
      })) as { browserContextId: string };
      const target = (await call(client, tool, {
        profile_id: id,
        method: "Target.createTarget",
        params: { url: `http://127.0.0.2:${w.sink.port}/raw-bypass`, browserContextId: context.browserContextId },
      })) as { targetId: string };
      await wait(SETTLE_MS);
      const reached = w.sink.connections.length - before;
      report(
        `raw: Target.createBrowserContext{proxyServer:direct://} with ${tool}`,
        reached > 0 ? "documented hole" : "no hole here",
        `a page in that context reached the private listener ${reached} times`,
      );
      await call(client, tool, { profile_id: id, method: "Target.closeTarget", params: { targetId: target.targetId } }).catch(() => {});
      await call(client, tool, {
        profile_id: id,
        method: "Target.disposeBrowserContext",
        params: { browserContextId: context.browserContextId },
      }).catch(() => {});
    }
  });
}

async function proxiedRun(w: World, controls: Controls, pivotId: string): Promise<void> {
  const proxy = await startSocksProxy(w.site.port);
  const allowProxy = `127.0.0.1:${proxy.port}`;
  // The site's own address only because WebTransport exists only in a secure context.
  const securePage = `http://127.0.0.1:${w.site.port}/page`;
  const serve = await startServe(["--egress-allow", `${allowProxy},127.0.0.1:${w.site.port}`], w.stub);
  try {
    const { client } = serve;
    w.stub.answer({ "pivot.mzt.test": ["169.254.169.254"] });

    // A proxy pointing at what the policy protects.
    const metadataProxy = { type: "socks5", host: "169.254.169.254", port: 1080 };
    const atCreate = await outcome(client, "create_profile", { name: "pivot", engine: ENGINE, proxy: metadataProxy });
    enforcedIf("proxy at 169.254.169.254: create_profile", blocked(atCreate), `${atCreate.code}: ${atCreate.message}`);
    const byName = await outcome(client, "create_profile", {
      name: "pivot",
      engine: ENGINE,
      proxy: { type: "http", host: "pivot.mzt.test", port: 3128 },
    });
    enforcedIf("proxy by a name resolving to metadata: create_profile", blocked(byName), `${byName.code}: ${byName.message}`);
    const clean = await createProfile(client, "egress-clean");
    const atUpdate = await outcome(client, "update_profile", { profile_id: clean, proxy: metadataProxy });
    enforcedIf("proxy at 169.254.169.254: update_profile", blocked(atUpdate), `${atUpdate.code}: ${atUpdate.message}`);
    const startedAt = Date.now();
    const atLaunch = await outcome(client, "launch_profile", { profile_id: pivotId });
    enforcedIf(
      "proxy at 169.254.169.254: launch of a profile saved earlier",
      blocked(atLaunch),
      `${atLaunch.code} in ${Date.now() - startedAt} ms: ${atLaunch.message}`,
    );

    // A public-style proxy, let through by name of its address.
    const asked = (): string[] => w.stub.asked();
    const askedBefore = asked().length;
    const id = await createProfile(client, "egress-proxied", {
      proxy: { type: "socks5", host: "127.0.0.1", port: proxy.port },
    });
    const launched = await launch(client, id);
    const cdpPort = IS_CAMOUFOX ? null : Number(new URL(String(launched.cdpEndpoint)).port);
    if (!IS_CAMOUFOX) {
      const argv = await browserCommandLine(Number(launched.pid));
      enforcedIf(
        "proxied: <-loopback> and the proxied hardening",
        argv.includes("--proxy-bypass-list=<-loopback>") && argv.includes("--disable-background-networking"),
        "both on the command line",
      );
    } else {
      report("proxied: <-loopback> and the proxied hardening", "not applicable", "block_webrtc plus the nine prefs on Camoufox");
    }

    const publicPage = "http://public.mzt.test/page";
    const viaProxy = await outcome(client, "navigate", { profile_id: id, url: publicPage });
    const title = viaProxy.code === "ok" ? await evaluate(client, id, "document.title") : "";
    enforcedIf(
      "proxied: a public-style allowed proxy still works, through a local SOCKS test proxy",
      viaProxy.code === "ok" && title === "MZ allowed" && proxy.connects.includes("public.mzt.test:80"),
      `navigate ${viaProxy.code}, title "${String(title)}", the proxy saw public.mzt.test:80`,
    );
    const lookedUp = asked().slice(askedBefore).filter((host) => host.endsWith(".mzt.test"));
    enforcedIf("proxied: no local DNS for a target", lookedUp.length === 0, `names asked of this machine's resolver: ${lookedUp.length}`);

    for (const url of ["http://169.254.169.254/", "http://2852039166/", "http://localhost:1/", "http://127.0.0.2/"]) {
      const result = await outcome(client, "navigate", { profile_id: id, url });
      enforcedIf(`proxied: navigate ${url}`, blocked(result), `${result.code}: ${result.message}`);
    }

    await call(client, "navigate", { profile_id: id, url: publicPage });
    const connectsBefore = proxy.connects.length;
    const redirected = await outcome(client, "navigate", { profile_id: id, url: "http://public.mzt.test/redirect-private" });
    const leaked = proxy.connects.slice(connectsBefore).filter((c) => c.startsWith("127.0.0.2")).length;
    enforcedIf(
      "proxied: 302 from the proxied site to a private address",
      blocked(redirected) && leaked === 0,
      `${redirected.code}: ${redirected.message}; through the proxy ${leaked}`,
    );

    await call(client, "navigate", { profile_id: id, url: publicPage });
    const probeBefore = proxy.connects.length;
    await pageProbeRows("proxied", serve, w, id, cdpPort, controls);
    const throughProxy = proxy.connects
      .slice(probeBefore)
      .filter((c) => /^(127\.|localhost|\[?::1|0x7f|2130706434|169\.254)/.test(c));
    enforcedIf(
      "proxied: those probes never reach the upstream either",
      throughProxy.length === 0,
      `private targets the proxy was asked for: ${throughProxy.join(", ") || "none"}`,
    );
    await call(client, "navigate", { profile_id: id, url: securePage });
    await udpRows("proxied", serve, w, id, controls);
    await call(client, "close_profile", { profile_id: id });
  } finally {
    await stopServe(serve);
    await proxy.close();
  }
}

async function exceptionRun(w: World): Promise<void> {
  const serve = await startServe(
    ["--egress-allow", `127.0.0.2/32:${w.sink.port},localhost:${w.sink.port},${w.lan}`],
    w.stub,
  );
  try {
    const { client } = serve;
    const id = await createProfile(client, "egress-exception");
    await launch(client, id);
    for (const [form, host] of [
      ["CIDR with a port", "127.0.0.2"],
      ["name with a port", "localhost"],
      ["IP", w.lan],
    ] as const) {
      const before = w.sink.connections.length;
      const loaded = await outcome(client, "navigate", { profile_id: id, url: `http://${host}:${w.sink.port}/exception` });
      enforcedIf(
        `--egress-allow (${form}) loads a private fixture`,
        loaded.code === "ok" && w.sink.connections.length > before,
        `navigate ${host}: ${loaded.code}; listener saw ${w.sink.connections.length - before}`,
      );
    }
    const other = await outcome(client, "navigate", { profile_id: id, url: `http://127.0.0.3:${w.sink.port}/` });
    enforcedIf("and the exception goes no further", blocked(other), `127.0.0.3: ${other.code}`);
    await call(client, "close_profile", { profile_id: id });
  } finally {
    await stopServe(serve);
  }
}

async function main(): Promise<void> {
  prepareDataDir();
  const lan = lanAddress();
  const stub = prepareDnsStub();
  let sinkPort = 0;
  const sink = await startSink(["127.0.0.1", "127.0.0.2", "127.0.0.3", lan, "::1"]);
  sinkPort = sink.port;
  const udp = await startUdpResponder(["127.0.0.1", lan]);
  const site = await startSite(
    () => `http://127.0.0.2:${sinkPort}`,
    () => pageRunning(WEBRTC_SCRIPT([`stun:${lan}:${udp.port}`])),
  );
  const rebindSink = await startSink(["127.0.0.2"], site.port);
  const w: World = { site, sink, rebindSink, udp, stub, lan };
  process.stdout.write(`engine ${ENGINE}, private address ${lan}, site :${site.port}, sink :${sink.port}, udp :${udp.port}\n`);
  try {
    const { controls, pivotId } = await allowAllRun(w, "169.254.169.254");
    await directRun(w, controls);
    await proxiedRun(w, controls, pivotId);
    await exceptionRun(w);
  } finally {
    await site.close();
    await sink.close();
    await rebindSink.close();
    udp.close();
    if (!values.keep) {
      try {
        cleanDataDir();
      } catch (e) {
        process.stdout.write(`could not remove ${DATA_DIR}: ${String(e)}\n`);
      }
    }
  }
  if (values.out) writeFileSync(values.out, JSON.stringify({ engine: ENGINE, platform: process.platform, rows }, null, 2));
  const failing = rows.filter((r) => r.verdict === "not enforced");
  process.stdout.write(`\n${rows.length} rows, ${failing.length} not enforced\n`);
  if (failing.length > 0) process.exitCode = 1;
}

main().catch((e: unknown) => {
  process.stdout.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exitCode = 1;
});
