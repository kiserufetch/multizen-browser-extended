/**
 * Live end-to-end check of the built server against a real browser engine, with
 * real MCP SDK clients. Not part of test:unit: it opens real browser windows, unless
 * --headless. On Windows run it from PowerShell or cmd: Ctrl+C can't be delivered to
 * anything started from Git Bash. On Linux run it where there is no DISPLAY, such as in
 * the image of docker/Dockerfile, with its seccomp profile: without --headless, browsers
 * run under Xvfb there, and its checks say so.
 *
 *   corepack yarn workspace @multizen/server build
 *   corepack yarn workspace @multizen/server exec tsx scripts/e2e.ts \
 *     --data-dir %TEMP%\mzts2 --engine-version-dir <dir with chrome.exe> \
 *     [--engine cloakbrowser|camoufox] [--flows http,sigint,stdio,tabs,concurrency,display,auth]
 *     [--keep] [--camoufox-install <dir>] [--headless] [--lan-address <ip>]
 *
 * --engine-version-dir links an installed engine into the temp data dir through a
 * junction (a symlink on Linux) on the version directory only, so nothing the server
 * does to its own engine cache can reach the original. Without it the engine is downloaded.
 * --camoufox-install does the same for an installed Camoufox, and adds the concurrency
 * flow's checks across both engines.
 *
 * Checks, in order: tools/list carries all four annotation hints on every tool, and
 * a typed error reports its code and retryable. An HTTP client creates a profile,
 * launches, navigates to a local fixture, reads with extract, clicks by ref,
 * screenshots, sets a cookie, closes, and a relaunch still sends that cookie.
 * A second serve and a plain stdio
 * refuse the lock. A stdio --connect client reaches the same server. Ctrl+Break and
 * Ctrl+C with a browser running each exit 0 and leave no process behind. A plain
 * stdio client launches a browser with stdout staying valid JSON-RPC, and stdin
 * EOF exits 0 and leaves no process behind. The tabs flow runs real input against
 * local pages in a main frame, a same-process iframe, a cross-origin iframe and one
 * nested in that, and asserts each page's own handler reported back to the fixture.
 * The concurrency flow, not run by default, starts a server with --max-browsers 2: three
 * launches at once, a timeout with no slot free, a browser killed by its PID, two clients
 * clicking one page with the page logging event order, queued clicks of clients that
 * leave, a lease across a reconnect, close_profile on a stuck page, a ref from before a
 * relaunch, and shutdown with a launch under way.
 *
 * --headless starts every server with --headless, so all those flows run with no window.
 * The display flow, not run by default, covers the modes themselves: what a headless page
 * reports about itself (pointer, hover, UA, Client Hints, webdriver), whether it is visible
 * and painted right after load, the refusals, one data dir going headed, headless, headed
 * with its cookies intact (a short real window), session restore in headless, and an
 * unpacked extension loading in headless.
 *
 * The auth flow, not run by default, covers tokens and remote access: what a read token
 * and a scoped token can see and call, a revoke from another process stopping a client, its
 * stream, its queued call and its lease, a bind on --lan-address (a host-only adapter is a
 * good choice; it binds there for a moment) with TLS and a wrong Host and Origin, the shape
 * of a reverse proxy on loopback, and a proxy password encrypted on disk that still gets a
 * browser through a local SOCKS proxy. It needs openssl for its certificate.
 *
 * --engine camoufox runs the same flows on Camoufox, minus what is CDP's or CloakBrowser's:
 * there are no OOPIF targets, cdp_send refuses, its pid is unknown (so nothing is killed
 * from outside), and no chrome:// pages. Its engine installs into the data dir.
 *
 * The signal delivery, the link to the engine and the process scan differ by platform.
 */
import { spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect, createServer as createNetServer, type AddressInfo, type Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ProfileManager } from "@multizen/profile-manager";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const { values } = parseArgs({
  options: {
    "data-dir": { type: "string" },
    "engine-version-dir": { type: "string" },
    "camoufox-install": { type: "string" },
    engine: { type: "string" },
    flows: { type: "string" },
    keep: { type: "boolean" },
    headless: { type: "boolean" },
    "lan-address": { type: "string" },
  },
});
const IS_WINDOWS = process.platform === "win32";
/** What ends the server gracefully from outside: Ctrl+Break there, a plain SIGTERM here. */
const STOP_SIGNAL = IS_WINDOWS ? "SIGBREAK" : "SIGTERM";
/** The mode with a window this machine can run, and the one it can't. */
const WINDOW_MODE = IS_WINDOWS ? "headed" : "xvfb";
const IMPOSSIBLE_MODE = IS_WINDOWS ? "xvfb" : "headed";
const dataDirFlag = values["data-dir"];
if (!dataDirFlag) throw new Error("--data-dir is required");
const DATA_DIR = resolve(dataDirFlag);
const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(APP_ROOT, "dist", "cli.js");
if (!existsSync(CLI)) throw new Error(`${CLI} is missing: build the server first`);

const FLOWS = (values.flows ?? "http,sigint,stdio,tabs").split(",");
const ENGINE_ARGS = values.engine ? { engine: values.engine } : {};
const IS_CAMOUFOX = values.engine === "camoufox";
const FORCED_HEADLESS = values.headless === true;
/** A server installs its default engine on start: this keeps CloakBrowser out of this run. */
const ENGINE_FLAGS = IS_CAMOUFOX ? ["--default-engine", "camoufox"] : [];
const SERVER_FLAGS = [...ENGINE_FLAGS, ...(FORCED_HEADLESS ? ["--headless"] : [])];
const ENGINE_INSTALL_BUDGET_MS = 15 * 60_000;
const CTRL_C_EXIT_BUDGET_MS = 30_000;
const results: Array<{ check: string; observed: string }> = [];
function pass(check: string, observed = ""): void {
  results.push({ check, observed });
  process.stdout.write(`ok   ${check}${observed ? `: ${observed}` : ""}\n`);
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

function junction(link: string, target: string): void {
  if (existsSync(link)) return;
  if (!IS_WINDOWS) {
    symlinkSync(target, link);
    return;
  }
  const res = spawnSync("cmd", ["/c", "mklink", "/J", link, target], { encoding: "utf8" });
  expect(res.status === 0, `mklink failed: ${res.stdout}${res.stderr}`);
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

/** Removes the junction itself first, so the deletion can't follow it. */
function cleanDataDir(): void {
  const versionDir = values["engine-version-dir"];
  const links = [
    ...(versionDir ? [join(DATA_DIR, "chromium", "cloakbrowser", basename(versionDir))] : []),
    ...(values["camoufox-install"] ? [join(DATA_DIR, "camoufox")] : []),
  ];
  for (const link of links) {
    if (!existsSync(link)) continue;
    if (!IS_WINDOWS) {
      unlinkSync(link);
      continue;
    }
    const res = spawnSync("cmd", ["/c", "rmdir", link], { encoding: "utf8" });
    expect(res.status === 0, `rmdir of the junction failed: ${res.stderr}`);
  }
  rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  await new Promise((done) => server.close(done));
  return port;
}

const FIXTURE_HTML = `<!doctype html>
<html><head><title>MZ Fixture</title></head>
<body>
  <h1>MultiZen fixture</h1>
  <button id="the-button" onclick="document.title='clicked'; document.getElementById('out').textContent='button was clicked'">Press me</button>
  <p id="out">not clicked yet</p>
</body></html>`;

interface Fixture {
  url: string;
  cookieHeaders: string[];
  /** The last page request's headers, which say what a page's browser claims on the wire. */
  lastHeaders(): IncomingMessage["headers"];
  close(): Promise<void>;
}

async function startFixture(): Promise<Fixture> {
  const cookieHeaders: string[] = [];
  let lastHeaders: IncomingMessage["headers"] = {};
  const server = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url?.split("?")[0] === "/page") {
      lastHeaders = req.headers;
      if (req.headers.cookie) cookieHeaders.push(req.headers.cookie);
      res.writeHead(200, { "content-type": "text/html" }).end(FIXTURE_HTML);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/page`,
    cookieHeaders,
    lastHeaders: () => lastHeaders,
    close: () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

interface Running {
  child: ChildProcess;
  output(): string;
  exited: Promise<number | null>;
}

function startServer(args: string[]): Running {
  // windowsHide with no inherited stdio gives the child its own hidden console,
  // which is what lets sendConsoleCtrl below reach it and nothing else.
  const child = spawn(process.execPath, [CLI, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  child.stdout?.on("data", (c: Buffer) => (output += c.toString("utf8")));
  child.stderr?.on("data", (c: Buffer) => (output += c.toString("utf8")));
  return {
    child,
    output: () => output,
    exited: new Promise((done) => child.on("close", (code) => done(code))),
  };
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`FAILED: timed out waiting for ${what}`);
}

async function startServe(extra: string[] = []): Promise<Running & { url: string; token: string }> {
  const port = await freePort();
  const running = startServer([
    "serve",
    "--data-dir",
    DATA_DIR,
    "--port",
    String(port),
    ...SERVER_FLAGS,
    ...extra,
  ]);
  await waitFor(() => running.output().includes('"listening"'), `serve to listen:\n${running.output()}`);
  const token = readFileSync(join(DATA_DIR, "owner-token"), "utf8");
  expect(!running.output().includes(token), "the token value appeared in the logs");
  return { ...running, url: `http://127.0.0.1:${port}/mcp`, token };
}

async function httpClient(url: string, token: string): Promise<Client> {
  const client = new Client({ name: "e2e", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string; data?: string }> };

async function rawCall(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args }, undefined, {
    timeout: 120_000,
  })) as ToolResult;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const result = await rawCall(client, name, args);
  const text = result.content[0]?.text ?? "{}";
  expect(!result.isError, `${name} returned an error: ${text}`);
  return JSON.parse(text) as Record<string, unknown>;
}

/** The `error` object of a call that must fail. */
async function callError(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await rawCall(client, name, args);
  const text = result.content[0]?.text ?? "{}";
  expect(result.isError, `${name} was expected to fail: ${text}`);
  return (JSON.parse(text) as { error: Record<string, unknown> }).error;
}

/** A launch during an engine download is refused as retryable, as it is for any client. */
async function launch(client: Client, id: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + ENGINE_INSTALL_BUDGET_MS;
  for (;;) {
    const result = await rawCall(client, "launch_profile", { profile_id: id });
    const body = JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown> & {
      error?: { code?: string; retryable?: boolean; details?: { retry_after_ms?: number } };
    };
    if (!result.isError) return body;
    const retry = body.error?.code === "ENGINE_NOT_READY" && body.error.retryable === true;
    expect(retry && Date.now() < deadline, `launch_profile failed: ${JSON.stringify(body)}`);
    await new Promise((done) => setTimeout(done, body.error?.details?.retry_after_ms ?? 5000));
  }
}

const ANNOTATION_HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"];
const EXPECTED_NEW_TOOLS = [
  "press_key",
  "hover",
  "select_option",
  "scroll",
  "upload_file",
  "list_downloads",
  "get_download",
  "set_dialog_policy",
  "handle_dialog",
  "list_dialogs",
  "acquire_profile",
  "renew_profile",
  "release_profile",
  "get_human_status",
];

async function toolSurfaceChecks(client: Client, profileId: string): Promise<void> {
  const { tools } = await client.listTools();
  for (const tool of tools) {
    const annotations = (tool.annotations ?? {}) as Record<string, unknown>;
    for (const hint of ANNOTATION_HINTS) {
      expect(typeof annotations[hint] === "boolean", `${tool.name} has no boolean ${hint}`);
    }
  }
  const names = new Set(tools.map((t) => t.name));
  for (const name of EXPECTED_NEW_TOOLS) expect(names.has(name), `tools/list lacks ${name}`);
  pass("tools/list annotations", `all 4 hints on each of ${tools.length} tools`);

  const notRunning = await callError(client, "navigate", {
    profile_id: profileId,
    url: "http://127.0.0.1:1/",
  });
  expect(notRunning.code === "PROFILE_NOT_RUNNING", `navigate: ${JSON.stringify(notRunning)}`);
  expect(notRunning.retryable === false, `navigate: ${JSON.stringify(notRunning)}`);
  expect(/launch_profile/.test(String(notRunning.message)), "navigate: the message lost its advice");
  pass("typed error on navigate", JSON.stringify(notRunning));

  const notFound = await callError(client, "launch_profile", { profile_id: "no-such-profile" });
  expect(notFound.code === "PROFILE_NOT_FOUND", `launch: ${JSON.stringify(notFound)}`);
  const refused = await callError(client, "no_such_tool", {});
  expect(refused.code === "FORBIDDEN", `unknown tool: ${JSON.stringify(refused)}`);
  pass("typed errors on launch_profile and an unknown tool", "PROFILE_NOT_FOUND, FORBIDDEN");
}

/** What a page says about itself. Hidden and unpainted drops all input. */
async function pageState(client: Client, id: string): Promise<string> {
  const state = await call(client, "evaluate_js", {
    profile_id: id,
    expression: "JSON.stringify([document.visibilityState, performance.getEntriesByType('paint').length])",
  });
  return String((state.result as { value?: unknown } | undefined)?.value);
}

interface AxNode {
  ref?: string;
  role?: string;
  name?: string;
  children?: AxNode[];
}

/** What extract gives: an accessibility tree on CloakBrowser, aria snapshot text on Camoufox. */
type PageTree = AxNode[] | string;

interface Extracted {
  title: string;
  accessibilityTree?: AxNode[];
  ariaSnapshot?: string;
}

function treeOf(extracted: Extracted): PageTree {
  return extracted.ariaSnapshot ?? extracted.accessibilityTree ?? [];
}

function findRef(nodes: AxNode[], role: string, name: string): string | null {
  for (const node of nodes) {
    if (node.role === role && node.name === name && node.ref) return node.ref;
    const inChild = findRef(node.children ?? [], role, name);
    if (inChild) return inChild;
  }
  return null;
}

/** The line of a snapshot that shows an element of this name, quoted as a name is. */
function snapshotLine(snapshot: string, name: string): string | undefined {
  return snapshot.split("\n").find((line) => line.includes(`"${name}"`));
}

/** Windows delivers no signals: a console control event is the graceful equivalent. */
function sendConsoleCtrl(pid: number, event: "CTRL_C" | "CTRL_BREAK"): void {
  if (!IS_WINDOWS) {
    process.kill(pid, event === "CTRL_C" ? "SIGINT" : STOP_SIGNAL);
    return;
  }
  const code = event === "CTRL_C" ? 0 : 1;
  const script = `
Add-Type -Namespace Mz -Name Console -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole();
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint pid);
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool GenerateConsoleCtrlEvent(uint ev, uint group);
'@
[Mz.Console]::FreeConsole() | Out-Null
if (-not [Mz.Console]::AttachConsole(${pid})) { exit 3 }
[Mz.Console]::SetConsoleCtrlHandler([IntPtr]::Zero, $true) | Out-Null
if (-not [Mz.Console]::GenerateConsoleCtrlEvent(${code}, 0)) { exit 4 }
Start-Sleep -Milliseconds 300
`;
  const res = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
  });
  // The helper shares the console it just signalled. It can ignore Ctrl+C, but
  // Ctrl+Break ends it too, with STATUS_CONTROL_C_EXIT.
  const STATUS_CONTROL_C_EXIT = 0xc000013a;
  expect(
    res.status === 0 || res.status === STATUS_CONTROL_C_EXIT,
    `console control event failed (${res.status}): ${res.stderr}`,
  );
}

/** Processes whose command line mentions the data dir: the server and its browsers,
 *  renderers and GPU process. Not this script or whatever shell started it. */
function leftoverProcesses(): string[] {
  if (!IS_WINDOWS) return leftoverLinuxProcesses();
  const dir = DATA_DIR.toLowerCase().replace(/'/g, "''");
  const script =
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8; " +
    "Get-CimInstance Win32_Process | Where-Object { " +
    "$_.ProcessId -ne $PID -and $_.CommandLine -and " +
    `$_.CommandLine.ToLower().Contains('${dir}') -and -not $_.CommandLine.ToLower().Contains('e2e.ts') ` +
    '} | ForEach-Object { "$($_.ProcessId) $($_.Name)" }';
  const res = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
  });
  return res.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

/**
 * The same from /proc, and what a Linux child hides from that test: a renderer needn't
 * name the data dir, and Xvfb never does. A zombie has an empty command line, so it counts
 * by its state: that is the point of the image's init, and of reaping here too.
 */
function leftoverLinuxProcesses(): string[] {
  const found: string[] = [];
  for (const entry of readdirSync("/proc")) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid === process.pid) continue;
    try {
      const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
      const name = stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")"));
      const line = argv.join(" ");
      if (line.includes("e2e.ts")) continue;
      const ours = /(^|\/)(chrome|chrome_crashpad_handler|camoufox-bin|Xvfb)$/.test(argv[0] ?? "");
      const zombieOfOurs = state === "Z" && /^(chrome|camoufox|Xvfb|Isolated|Web Content|Socket)/i.test(name);
      if (ours || line.includes(DATA_DIR) || zombieOfOurs) found.push(`${pid} ${state} ${name}`);
    } catch {
      // Gone between the listing and the read.
    }
  }
  return found;
}

/** A browser's whole tree, from outside, as something other than this server would. */
function killBrowserTree(pid: number): void {
  if (!IS_WINDOWS) {
    process.kill(-pid, "SIGKILL");
    return;
  }
  const killed = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { encoding: "utf8", windowsHide: true });
  expect(killed.status === 0, `taskkill failed: ${killed.stdout}${killed.stderr}`);
}

async function assertNoLeftovers(what: string): Promise<void> {
  // A renderer can take a moment to follow its browser out.
  let leftovers = leftoverProcesses();
  for (let i = 0; i < 10 && leftovers.length > 0; i++) {
    await new Promise((done) => setTimeout(done, 300));
    leftovers = leftoverProcesses();
  }
  expect(leftovers.length === 0, `${what} left processes behind: ${leftovers.join(", ")}`);
  pass(`${what}: leftover processes`, "0");
}

async function httpFlow(fixture: Fixture): Promise<string> {
  const serve = await startServe();
  try {
    const client = await httpClient(serve.url, serve.token);
    const created = await call(client, "create_profile", { name: "e2e", ...ENGINE_ARGS });
    const id = String(created.id);
    pass("create_profile", id);

    await toolSurfaceChecks(client, id);

    const launched = await launch(client, id);
    expect(IS_CAMOUFOX || Number(launched.pid) > 0, "launch_profile returned no pid");
    expect(
      !FORCED_HEADLESS || launched.displayMode === "headless",
      `--headless launched in ${String(launched.displayMode)}`,
    );
    pass("launch_profile", `pid ${launched.pid}, ${launched.cdpEndpoint}, ${launched.displayMode}`);

    const navigated = await call(client, "navigate", { profile_id: id, url: fixture.url });
    expect(navigated.url === fixture.url, `navigate went to ${String(navigated.url)}`);
    pass("navigate to the local fixture", String(navigated.url));

    const extracted = await call(client, "extract", { profile_id: id });
    const before = extracted.result as Extracted;
    expect(before.title === "MZ Fixture", `extract saw the title "${before.title}"`);
    const ref = refOf(treeOf(before), "Press me");
    if (!IS_CAMOUFOX) {
      expect(findRef(before.accessibilityTree ?? [], "button", "Press me") === ref, "not the button");
    }
    pass("extract", `title "${before.title}", button is ${ref}`);

    pass("page state before the first input [visibility, paints]", await pageState(client, id));
    await call(client, "click_ref", { profile_id: id, ref });
    const after = (await call(client, "extract", { profile_id: id })).result as { title: string };
    expect(after.title === "clicked", `the click did not land: title "${after.title}"`);
    pass("click_ref", `page handler ran, title "${after.title}"`);

    const shot = await rawCall(client, "screenshot", { profile_id: id });
    const png = Buffer.from(shot.content[0]?.data ?? "", "base64");
    expect(png.subarray(1, 4).toString() === "PNG", "screenshot is not a PNG");
    pass("screenshot", `${png.length} bytes of PNG`);

    await call(client, "set_cookies", {
      profile_id: id,
      cookies: [
        {
          name: "mz_e2e",
          value: "kept-across-relaunch",
          domain: "127.0.0.1",
          path: "/",
          expires: Math.floor(Date.now() / 1000) + 86_400,
        },
      ],
    });
    pass("set_cookies");

    await call(client, "close_profile", { profile_id: id });
    const closed = (await call(client, "list_profiles")).profiles as Array<{ isRunning: boolean }>;
    expect(closed[0]?.isRunning === false, "the profile still reads as running after close");
    pass("close_profile");

    await launch(client, id);
    await call(client, "navigate", { profile_id: id, url: fixture.url });
    expect(
      fixture.cookieHeaders.at(-1)?.includes("mz_e2e=kept-across-relaunch"),
      `relaunch lost the cookie; the page got: ${String(fixture.cookieHeaders.at(-1))}`,
    );
    pass("relaunch keeps the cookie", `the fixture received "${fixture.cookieHeaders.at(-1)}"`);

    // Lock: a live serve refuses everything else that wants the directory.
    const second = spawnSync(
      process.execPath,
      [CLI, "serve", "--data-dir", DATA_DIR, "--port", "1"],
      { encoding: "utf8", windowsHide: true },
    );
    expect(second.status === 1, `second serve exited ${second.status}: ${second.stdout}`);
    expect(/in use by another MultiZen server/.test(second.stdout), "no lock error from second serve");
    pass("second serve refused", `exit ${second.status}`);

    const plainStdio = spawnSync(process.execPath, [CLI, "stdio", "--data-dir", DATA_DIR], {
      encoding: "utf8",
      windowsHide: true,
    });
    expect(plainStdio.status === 1, `plain stdio exited ${plainStdio.status}`);
    expect(/stdio --connect/.test(plainStdio.stderr), "plain stdio gave no hint");
    expect(plainStdio.stdout === "", "plain stdio wrote to stdout");
    pass("plain stdio refused with the --connect hint", `exit ${plainStdio.status}`);

    // Relay: a stdio-only client through to the same running server.
    const relayTransport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI, "stdio", "--connect", serve.url, "--token-file", join(DATA_DIR, "owner-token")],
      stderr: "pipe",
    });
    const relayErrors: unknown[] = [];
    relayTransport.onerror = (e) => relayErrors.push(e);
    const relay = new Client({ name: "e2e-relay", version: "1.0.0" });
    await relay.connect(relayTransport);
    const through = (await call(relay, "list_profiles")).profiles as Array<{
      id: string;
      isRunning: boolean;
    }>;
    expect(through[0]?.id === id && through[0].isRunning, "the relay did not see the running profile");
    const overRelay = (await call(relay, "extract", { profile_id: id })).result as { title: string };
    expect(overRelay.title === "MZ Fixture", `extract over the relay saw "${overRelay.title}"`);
    await relay.close();
    expect(relayErrors.length === 0, `the relay had stream errors: ${String(relayErrors)}`);
    pass("stdio --connect proxies to the running serve", `extract saw "${overRelay.title}"`);

    await client.close();
    sendConsoleCtrl(serve.child.pid!, "CTRL_BREAK");
    const code = await serve.exited;
    expect(code === 0, `Ctrl+Break exit code ${code}:\n${serve.output()}`);
    expect(serve.output().includes(`"reason":"${STOP_SIGNAL}"`), `the shutdown was not started by ${STOP_SIGNAL}`);
    expect(!existsSync(join(DATA_DIR, "server.lock")), "the lock outlived the shutdown");
    pass(`${STOP_SIGNAL} with a browser running`, `exit ${code}, lock released`);
    await assertNoLeftovers(STOP_SIGNAL);
    return id;
  } finally {
    if (serve.child.exitCode === null) serve.child.kill();
  }
}

async function sigintFlow(profileId: string): Promise<void> {
  const serve = await startServe();
  try {
    const client = await httpClient(serve.url, serve.token);
    const launched = await launch(client, profileId);

    // A browser dying under the server must cost that profile only. In Electron a
    // stray socket error is survivable; under plain Node it would end the process.
    if (!IS_CAMOUFOX) {
      killBrowserTree(Number(launched.pid));
      await waitFor(() => /"reason":"external-exit"/.test(serve.output()), "the browser's exit to register");
      const after = (await call(client, "list_profiles")).profiles as Array<{ isRunning: boolean }>;
      expect(after[0]?.isRunning === false, "the killed browser still reads as running");
      expect(serve.child.exitCode === null, "the server died with its browser");
      expect(!/uncaught exception|unhandled rejection/.test(serve.output()), "a killed browser was fatal");
      pass("a browser killed from outside", "the server stays up, the profile reads as closed");

      await launch(client, profileId);
      pass("relaunch after the kill");
    }
    await client.close();
    sendConsoleCtrl(serve.child.pid!, "CTRL_C");
    const code = await Promise.race([
      serve.exited,
      new Promise<"no exit">((done) => setTimeout(() => done("no exit"), CTRL_C_EXIT_BUDGET_MS)),
    ]);
    expect(
      code !== "no exit",
      "Ctrl+C never reached the server. A process started from Git Bash inherits Ctrl+C " +
        "disabled, which nothing below it can undo: run this script from PowerShell or cmd.",
    );
    expect(code === 0, `Ctrl+C exit code ${code}:\n${serve.output()}`);
    expect(/"reason":"SIGINT"/.test(serve.output()), "the shutdown was not started by SIGINT");
    pass("Ctrl+C with a browser running", `exit ${code}`);
    await assertNoLeftovers("Ctrl+C");
  } finally {
    if (serve.child.exitCode === null) serve.child.kill();
  }
}

async function stdioFlow(fixture: Fixture): Promise<void> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, "stdio", "--data-dir", DATA_DIR, ...SERVER_FLAGS],
    // Makes the driver log from its launch path, which is the noise that would
    // corrupt stdout if the rebinding were not in place.
    env: { MULTIZEN_DEBUG: "1" },
    stderr: "pipe",
  });
  let stderrText = "";
  transport.stderr?.on("data", (c: Buffer) => (stderrText += c.toString("utf8")));
  const protocolErrors: unknown[] = [];
  transport.onerror = (e) => protocolErrors.push(e);

  const client = new Client({ name: "e2e-stdio", version: "1.0.0" });
  await client.connect(transport);
  // The SDK's close() gives a child two seconds and then kills it. To read the
  // real exit code the EOF is sent by hand, on the transport's own child.
  const child = (transport as unknown as { _process: ChildProcess })._process;
  const exited = new Promise<number | null>((done) => child.on("close", (code) => done(code)));

  const created = await call(client, "create_profile", { name: "e2e-stdio", ...ENGINE_ARGS });
  const id = String(created.id);
  await launch(client, id);
  await call(client, "navigate", { profile_id: id, url: fixture.url });
  const page = (await call(client, "extract", { profile_id: id })).result as { title: string };
  expect(page.title === "MZ Fixture", `extract over stdio saw "${page.title}"`);
  expect(IS_CAMOUFOX || /post-bootstrap probe/.test(stderrText), "MULTIZEN_DEBUG produced no driver log line");
  expect(protocolErrors.length === 0, `stdout carried non-JSON-RPC: ${String(protocolErrors)}`);
  pass(
    "stdio: a real client created and launched a profile",
    "stdout stayed valid JSON-RPC while the driver logged from the launch path",
  );

  const startedAt = Date.now();
  child.stdin?.end();
  const code = await exited;
  expect(code === 0, `stdin EOF exit code ${code}:\n${stderrText}`);
  expect(!existsSync(join(DATA_DIR, "server.lock")), "the lock outlived the shutdown");
  pass("stdio: stdin EOF with a browser running", `exit ${code} in ${Date.now() - startedAt} ms`);
  await assertNoLeftovers("stdin EOF");
  await client.close();
}

// ── Tabs, frames and page actions ────────────────────────────────────────────

/** Every page reports to the fixture from its own handlers: nothing here reads the page. */
const SITE_REPORTING = (frame: string): string => `<script>
  const FRAME = ${JSON.stringify(frame)};
  function hit(what, value) {
    fetch("/hit?frame=" + FRAME + "&what=" + encodeURIComponent(what) +
      "&value=" + encodeURIComponent(value === undefined ? "" : String(value)), { mode: "no-cors" });
  }
  let scrollTimer;
  addEventListener("scroll", () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => hit("scrolled", Math.round(scrollY)), 100);
  }, { passive: true });
  addEventListener("keydown", (e) => {
    hit("key", (e.ctrlKey ? "Ctrl+" : "") + (e.shiftKey ? "Shift+" : "") + e.key);
  }, true);
  addEventListener("load", () => hit("loaded"));
</script>`;

const controls = (name: string): string => `
  <button onclick="hit('click')">${name} button</button>
  <input aria-label="${name} input" oninput="hit('type', this.value)">
  <select aria-label="${name} select" onchange="hit('select', this.value)" oninput="hit('select-input', this.value)">
    <option value="a">Alpha</option><option value="b">Bravo</option>
  </select>
  <button onmouseover="hit('hover')">${name} hover</button>
  <input type="file" aria-label="${name} file" onchange="hit('upload', this.files[0].name + ':' + this.files[0].size)">
  <input type="file" id="hidden-file" style="display:none" onchange="hit('chooser', this.files[0].name)">
  <button onclick="document.getElementById('hidden-file').click()">${name} chooser</button>`;

function page(title: string, frame: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${SITE_REPORTING(frame)}</head><body>${body}</body></html>`;
}

interface Hit {
  frame: string;
  what: string;
  value: string;
}

interface Site {
  /** Same origin as the main page, and on a host of its own. */
  parent: string;
  child: string;
  nested: string;
  hits: Hit[];
  waitHit(frame: string, what: string, value?: string): Promise<Hit>;
  close(): Promise<void>;
}

/** Three hosts, so three sites: 127.0.0.1 embeds localhost, which embeds 127.0.0.2. */
async function startSite(): Promise<Site> {
  const hits: Hit[] = [];
  let port = 0;
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/hit") {
      hits.push({
        frame: url.searchParams.get("frame") ?? "",
        what: url.searchParams.get("what") ?? "",
        value: url.searchParams.get("value") ?? "",
      });
      res.writeHead(204).end();
      return;
    }
    if (url.pathname === "/file") {
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-disposition": 'attachment; filename="../report.txt"',
      });
      res.end("downloaded-bytes");
      return;
    }
    const html: Record<string, string> = {
      "/main": page(
        "S5 main",
        "main",
        `<h1>Main</h1>${controls("Main")}
        <p>see [ref=e1] here</p>
        <a href="/file">Download report</a>
        <button onclick="hit('confirm', confirm('Sure?'))">Confirm button</button>
        <button onclick="hit('prompt', prompt('Name?', 'nobody'))">Prompt button</button>
        <button onclick="alert('hello'); hit('alert-closed')">Alert button</button>
        <button onclick="window.open('/popup?n=1'); hit('opened')">Popup button</button>
        <button onclick="window.open('/popup?n=2', '_blank', 'noopener'); hit('opened')">Noopener popup</button>
        <button onclick="document.getElementById('gone').remove()">Remove below</button>
        <button id="gone">Removed button</button>
        <iframe title="Same frame" src="/same" style="width:420px;height:160px"></iframe>
        <iframe title="Child frame" src="http://localhost:${port}/child" style="width:520px;height:300px;border:7px solid red;padding:3px"></iframe>
        <div style="height:2000px"></div>
        <button onclick="hit('bottom')">Bottom button</button>`,
      ),
      "/same": page(
        "S5 same",
        "same",
        `${controls("Same")}<div style="height:600px"></div><button onclick="hit('bottom')">Same bottom</button>`,
      ),
      "/child": page(
        "S5 child",
        "child",
        `${controls("Child")}
        <button onclick="hit('confirm', confirm('From the frame?'))">Child confirm</button>
        <iframe title="Nested frame" src="http://127.0.0.2:${port}/nested" style="width:440px;height:120px"></iframe>
        <div style="height:800px"></div>
        <button onclick="hit('bottom')">Child bottom</button>`,
      ),
      "/nested": page("S5 nested", "nested", controls("Nested")),
      "/tab2": page(
        "S5 tab two",
        "tab2",
        `<button onclick="hit('click')">Tab two button</button>
        <input aria-label="Tab two input" oninput="hit('type', this.value)">`,
      ),
      "/popup": page("S5 popup", "popup", `<p>Popup</p>`),
      "/other": page("S5 other", "other", `<button onclick="hit('click')">Main button</button>`),
    };
    const body = html[url.pathname];
    if (body === undefined) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
  };
  const first = createHttpServer(handler);
  await new Promise<void>((done) => first.listen(0, "127.0.0.1", done));
  port = (first.address() as AddressInfo).port;
  const second = createHttpServer(handler);
  await new Promise<void>((done) => second.listen(port, "127.0.0.2", done));
  return {
    parent: `http://127.0.0.1:${port}`,
    child: `http://localhost:${port}`,
    nested: `http://127.0.0.2:${port}`,
    hits,
    async waitHit(frame, what, value) {
      let found: Hit | undefined;
      const matches = (h: Hit): boolean =>
        h.frame === frame && h.what === what && (value === undefined || h.value === value);
      await waitFor(
        () => (found = hits.find(matches)) !== undefined,
        `${frame}'s handler for ${what}${value === undefined ? "" : ` = ${value}`}. Hits: ${JSON.stringify(hits.slice(-8))}`,
        8_000,
      );
      hits.splice(hits.indexOf(found!), 1);
      return found!;
    },
    close: () =>
      Promise.all(
        [first, second].map(
          (server) =>
            new Promise<void>((done) => {
              server.closeAllConnections();
              server.close(() => done());
            }),
        ),
      ).then(() => {}),
  };
}

function findByName(nodes: AxNode[], name: string): AxNode | null {
  for (const node of nodes) {
    if (node.name === name) return node;
    const inChild = findByName(node.children ?? [], name);
    if (inChild) return inChild;
  }
  return null;
}

function hasName(tree: PageTree, name: string): boolean {
  return typeof tree === "string" ? snapshotLine(tree, name) !== undefined : findByName(tree, name) !== null;
}

function refOf(tree: PageTree, name: string): string {
  const ref =
    typeof tree === "string"
      ? /\[ref=([^\]]+)\]/.exec(snapshotLine(tree, name) ?? "")?.[1]
      : findByName(tree, name)?.ref;
  expect(ref, `extract gave no ref for "${name}"`);
  return ref;
}

interface TabList {
  targetInfos: Array<{ targetId: string; type: string; url: string }>;
  activeTargetId: string;
}

async function waitForDialog(client: Client, id: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const { dialogs } = (await call(client, "list_dialogs", { profile_id: id })) as unknown as {
      dialogs: unknown[];
    };
    if (dialogs.length > 0) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error("FAILED: the dialog never opened");
}

async function tabsFlow(): Promise<void> {
  const site = await startSite();
  const serve = await startServe();
  try {
    const client = await httpClient(serve.url, serve.token);
    const id = String((await call(client, "create_profile", { name: "e2e-tabs", ...ENGINE_ARGS })).id);
    const profile = { profile_id: id };
    await launch(client, id);

    const extract = async (): Promise<PageTree> =>
      treeOf((await call(client, "extract", profile)).result as Extracted);
    const tabs = async (): Promise<TabList> =>
      (await call(client, "list_tabs", profile)) as unknown as TabList;
    const evaluate = async (expression: string): Promise<unknown> =>
      ((await call(client, "evaluate_js", { ...profile, expression })).result as { value?: unknown })
        ?.value;
    const act = (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> =>
      call(client, name, { ...profile, ...args });
    const code = async (name: string, args: Record<string, unknown>): Promise<string> =>
      String((await callError(client, name, { ...profile, ...args })).code);
    /** The tree once every frame's content is there: frames load after their parent. */
    const extractUntil = async (name: string): Promise<PageTree> => {
      const deadline = Date.now() + 15_000;
      for (;;) {
        const tree = await extract();
        if (hasName(tree, name)) return tree;
        expect(Date.now() < deadline, `"${name}" never appeared: ${JSON.stringify(tree).slice(0, 1500)}`);
        await new Promise((done) => setTimeout(done, 200));
      }
    };

    const nav = await act("navigate", { url: `${site.parent}/main` });
    pass("navigate to the framed page", String(nav.url));
    let tree = await extractUntil("Nested button");
    await site.waitHit("nested", "loaded");

    // ── targets and refs ──
    const targets = await tabs();
    const iframes = targets.targetInfos.filter((t) => t.type === "iframe");
    if (IS_CAMOUFOX) {
      expect(iframes.length === 0, `frames as targets: ${JSON.stringify(targets.targetInfos)}`);
    } else {
      expect(
        iframes.some((t) => t.url.startsWith(site.child)) && iframes.some((t) => t.url.startsWith(site.nested)),
        `no OOPIF targets: ${JSON.stringify(targets.targetInfos)}`,
      );
      expect(!iframes.some((t) => t.url.endsWith("/same")), "the same-origin frame should not be a target");
      pass("type:iframe targets exist", iframes.map((t) => t.url).join(", "));
    }
    const firstTab = targets.activeTargetId;
    expect(
      targets.targetInfos.some((t) => t.targetId === firstTab && t.type === "page"),
      "activeTargetId is not a page",
    );
    pass("list_tabs reports activeTargetId", firstTab);

    const frames = ["Main", "Same", "Child", "Nested"];
    const refs = Object.fromEntries(frames.map((f) => [f, refOf(tree, `${f} button`)]));
    pass("extract gives refs in all four frames", JSON.stringify(refs));
    if (typeof tree === "string") {
      const snapshot = tree;
      const indent = (name: string): number => /^\s*/.exec(snapshotLine(snapshot, name) ?? "")![0].length;
      expect(
        indent("Main button") < indent("Same button") &&
          indent("Same button") === indent("Child button") &&
          indent("Child button") < indent("Nested button"),
        `frames are not nested in the snapshot: ${snapshot.slice(0, 800)}`,
      );
      for (const name of frames) {
        expect(snapshot.split(`"${name} button"`).length === 2, `${name} button appears twice`);
      }
      pass("each frame's tree hangs under its iframe, once", "iframe > iframe > Nested button");
      // The page wrote one of these in its text: that stays text, and no other survives.
      expect(snapshot.includes("see [ref=e1] here"), "the page's own text was rewritten");
      expect(
        !/\[ref=(f\d+)?e\d+\]/.test(snapshot.replace("see [ref=e1] here", "")),
        `Playwright's own refs came through: ${snapshot.slice(0, 400)}`,
      );
    } else {
      const childFrame = findByName(tree, "Child frame");
      expect(
        childFrame?.role === "Iframe" &&
          findByName(childFrame.children ?? [], "Child button") &&
          findByName(findByName(childFrame.children ?? [], "Nested frame")?.children ?? [], "Nested button"),
        `frames are not stitched under their owners: ${JSON.stringify(childFrame).slice(0, 800)}`,
      );
      const buttons = (nodes: AxNode[], name: string): number =>
        nodes.reduce(
          (n, node) => n + (node.role === "button" && node.name === name ? 1 : 0) + buttons(node.children ?? [], name),
          0,
        );
      for (const name of frames) expect(buttons(tree, `${name} button`) === 1, `${name} button appears twice`);
      pass("each frame's tree hangs under its owner, once", "Iframe > Iframe > Nested button");
    }

    const firstLocale = await evaluate("Intl.DateTimeFormat().resolvedOptions().locale");
    const realDpr = await evaluate("window.devicePixelRatio");
    pass("devicePixelRatio of this run", String(realDpr));

    // ── click and type in each frame ──
    for (const name of frames) {
      const frame = name.toLowerCase();
      await act("click_ref", { ref: refOf(tree, `${name} button`) });
      await site.waitHit(frame, "click");
      await act("type_ref", { ref: refOf(tree, `${name} input`), text: `Hi ${name}!` });
      await site.waitHit(frame, "type", `Hi ${name}!`);
      site.hits.length = 0;
      pass(`click_ref and type_ref in the ${frame} frame`, "its own handlers fired");
    }

    // ── scrolled page and scrolled frames ──
    await act("click_ref", { ref: refOf(tree, "Bottom button") });
    await site.waitHit("main", "bottom");
    const pageScrollY = await evaluate("window.scrollY");
    expect(Number(pageScrollY) > 0, `the page did not scroll: ${String(pageScrollY)}`);
    pass("click_ref below the fold scrolls the page", `scrollY ${String(pageScrollY)}`);

    // Back up, part way, so the frames are in view with the page still scrolled.
    await act("scroll", { delta_y: -Number(pageScrollY) + 120 });
    await new Promise((done) => setTimeout(done, 400));
    const scrolledBy = Number(await evaluate("window.scrollY"));
    expect(scrolledBy > 0, `wheel scrolled to ${scrolledBy}`);
    for (const name of ["Same", "Child", "Nested"]) {
      await act("click_ref", { ref: refOf(tree, `${name} button`) });
      await site.waitHit(name.toLowerCase(), "click");
    }
    pass("click_ref into frames with the page scrolled", `page scrollY ${scrolledBy} at the start`);

    await act("click_ref", { ref: refOf(tree, "Child bottom") });
    await site.waitHit("child", "bottom");
    await act("click_ref", { ref: refOf(tree, "Same bottom") });
    await site.waitHit("same", "bottom");
    await site.waitHit("child", "scrolled");
    await act("click_ref", { ref: refOf(tree, "Child button") });
    await site.waitHit("child", "click");
    await act("click_ref", { ref: refOf(tree, "Nested button") });
    await site.waitHit("nested", "click");
    pass("click_ref in scrolled frames, there and back", "same-process and OOPIF");

    // ── device scale factor: no fingerprint path sets one, so CDP emulation stands in ──
    if (!IS_CAMOUFOX) {
      await act("cdp_send", {
        method: "Emulation.setDeviceMetricsOverride",
        params: { width: 0, height: 0, deviceScaleFactor: 1.75, mobile: false },
      });
      const scaled = await evaluate("window.devicePixelRatio");
      expect(scaled === 1.75, `devicePixelRatio ${String(scaled)}`);
      for (const name of frames) {
        await act("click_ref", { ref: refOf(tree, `${name} button`) });
        await site.waitHit(name.toLowerCase(), "click");
      }
      await act("cdp_send", { method: "Emulation.clearDeviceMetricsOverride", params: {} });
      pass("click_ref in all four frames at an emulated scale factor", `devicePixelRatio ${String(scaled)}`);
    }
    site.hits.length = 0;

    // ── keys ──
    await act("click_ref", { ref: refOf(tree, "Main input") });
    site.hits.length = 0;
    await act("press_key", { key: "Control+A" });
    await site.waitHit("main", "key", "Ctrl+a");
    await act("press_key", { key: "Enter" });
    await site.waitHit("main", "key", "Enter");
    await act("press_key", { key: "Shift+B" });
    await site.waitHit("main", "key", "Shift+B");
    pass("press_key with no target", "Control+A, Enter and Shift+B reached the page");
    const selection = await evaluate(
      "(() => { const i = document.querySelector('input[aria-label=\"Main input\"]'); return i.value; })()",
    );
    expect(selection === "B", `Control+A then Shift+B should replace the text, got ${String(selection)}`);
    pass("the chord did what a keyboard does", `the input holds "${String(selection)}"`);

    await act("press_key", { key: "Tab", ref: refOf(tree, "Child input") });
    await site.waitHit("child", "key", "Tab");
    await act("click_ref", { ref: refOf(tree, "Nested input") });
    site.hits.length = 0;
    await act("press_key", { key: "Enter" });
    await site.waitHit("nested", "key", "Enter");
    pass("press_key lands in frames", "with a ref in the OOPIF; with focus in the nested OOPIF");

    // ── hover, select, scroll ──
    for (const name of ["Main", "Same", "Child", "Nested"]) {
      await act("hover", { ref: refOf(tree, `${name} hover`) });
      await site.waitHit(name.toLowerCase(), "hover");
    }
    pass("hover in all four frames", "mouseover handlers fired");

    await act("select_option", { ref: refOf(tree, "Main select"), label: "Bravo" });
    await site.waitHit("main", "select", "b");
    await site.waitHit("main", "select-input", "b");
    await act("select_option", { selector: "select", value: "a" });
    await site.waitHit("main", "select", "a");
    await act("select_option", { ref: refOf(tree, "Child select"), index: 1 });
    await site.waitHit("child", "select", "b");
    const noOption = await code("select_option", { ref: refOf(tree, "Main select"), value: "zzz" });
    expect(noOption === "ELEMENT_NOT_FOUND", `select_option with no such value: ${noOption}`);
    const notSelect = await code("select_option", { ref: refOf(tree, "Main button"), index: 0 });
    expect(notSelect === "INVALID_INPUT", `select_option on a button: ${notSelect}`);
    pass("select_option", "main and OOPIF; handlers fired; missing option and non-select refused");

    site.hits.length = 0;
    await act("scroll", { ref: refOf(tree, "Main button"), delta_y: 150 });
    const wheelPage = await site.waitHit("main", "scrolled");
    await act("scroll", { ref: refOf(tree, "Child button"), delta_y: 90 });
    const wheelFrame = await site.waitHit("child", "scrolled");
    await act("scroll", { ref: refOf(tree, "Bottom button") });
    await site.waitHit("main", "scrolled");
    pass("scroll by wheel and into view", `page to ${wheelPage.value}, OOPIF to ${wheelFrame.value}`);
    const selected = await evaluate("document.querySelector('select').value");
    expect(selected === "a", `after the wheels, the page's select holds ${String(selected)}`);

    // ── upload ──
    const hello = Buffer.from("hello").toString("base64");
    const upload = (target: Record<string, unknown>, file_name: string): Promise<Record<string, unknown>> =>
      act("upload_file", { ...target, files: [{ file_name, data_base64: hello }] });
    await upload({ ref: refOf(tree, "Main file") }, "real-name.txt");
    await site.waitHit("main", "upload", "real-name.txt:5");
    await upload({ ref: refOf(tree, "Child file") }, "in oopif.txt");
    await site.waitHit("child", "upload", "in oopif.txt:5");
    pass("upload_file sets the real name", "the page saw real-name.txt:5, and in oopif.txt:5 in the OOPIF");
    await upload({ ref: refOf(tree, "Main chooser") }, "chosen.txt");
    await site.waitHit("main", "chooser", "chosen.txt");
    await upload({ ref: refOf(tree, "Same chooser") }, "chosen-too.txt");
    await site.waitHit("same", "chooser", "chosen-too.txt");
    pass("upload_file through a file chooser", "main and same-process frames' change handlers saw it");
    if (IS_CAMOUFOX) {
      await upload({ ref: refOf(tree, "Child chooser") }, "chosen-across.txt");
      await site.waitHit("child", "chooser", "chosen-across.txt");
      pass("upload_file through a chooser in a cross-origin frame", "works here: Playwright catches it");
    } else {
      const oopifChooser = await code("upload_file", {
        ref: refOf(tree, "Child chooser"),
        files: [{ file_name: "x.txt", data_base64: hello }],
      });
      expect(oopifChooser === "INVALID_INPUT", `a chooser in an OOPIF: ${oopifChooser}`);
      pass("upload_file through a chooser in an OOPIF is refused, nothing clicked", oopifChooser);
    }
    const notAllowed = await code("upload_file", {
      ref: refOf(tree, "Main file"),
      files: [{ file_name: "C:\\Windows\\win.ini" }],
    });
    expect(notAllowed === "FILE_NOT_ALLOWED", `a host path: ${notAllowed}`);

    // ── download ──
    await act("click_ref", { ref: refOf(tree, "Download report") });
    let download: { id: string; fileName: string; state: string; url: string } | undefined;
    await (async () => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const { downloads } = (await act("list_downloads", {})) as unknown as {
          downloads: Array<{ id: string; fileName: string; state: string; url: string }>;
        };
        download = downloads[0];
        if (download?.state === "completed") return;
        await new Promise((done) => setTimeout(done, 200));
      }
    })();
    expect(download?.state === "completed", `download state: ${JSON.stringify(download)}`);
    expect(/^[^\\/]*report\.txt$/.test(download?.fileName ?? ""), `a hostile name came through: ${download?.fileName}`);
    expect(download?.url === `${site.parent}/file`, `download url ${download?.url}`);
    const got = (await act("get_download", { download_id: download!.id })) as { data_base64?: string };
    const bytes = Buffer.from(got.data_base64 ?? "", "base64").toString();
    expect(bytes === "downloaded-bytes", `get_download gave "${bytes}"`);
    expect(!JSON.stringify(got).includes(DATA_DIR.replace(/\\/g, "\\\\")), "a host path reached the agent");
    pass("download through list_downloads and get_download", `${download?.fileName}, "${bytes}"`);

    // ── dialogs: the default policy ──
    site.hits.length = 0;
    await act("click_ref", { ref: refOf(tree, "Alert button") });
    await site.waitHit("main", "alert-closed");
    await act("click_ref", { ref: refOf(tree, "Confirm button") });
    await site.waitHit("main", "confirm", "false");
    pass("auto policy", "alert answered, confirm dismissed, as before");

    // ── dialogs: manual ──
    await act("set_dialog_policy", { mode: "manual" });
    const clickedAt = Date.now();
    await act("click_ref", { ref: refOf(tree, "Confirm button") });
    const { dialogs } = (await act("list_dialogs", {})) as unknown as {
      dialogs: Array<{ id: string; type: string; message: string }>;
    };
    expect(dialogs[0]?.type === "confirm" && dialogs[0].message === "Sure?", JSON.stringify(dialogs));
    pass("a click that opens a dialog returns", `${Date.now() - clickedAt} ms, list_dialogs: ${JSON.stringify(dialogs[0])}`);

    const blockedAt = Date.now();
    for (const [tool, args] of [
      ["screenshot", {}],
      ["extract", {}],
      ["click_ref", { ref: refOf(tree, "Main button") }],
      ["type_ref", { ref: refOf(tree, "Main input"), text: "x" }],
      ["click", { selector: "button" }],
      ["press_key", { key: "Enter" }],
      ["hover", { ref: refOf(tree, "Main button") }],
      ["evaluate_js", { expression: "1" }],
      ["navigate", { url: `${site.parent}/other` }],
    ] as const) {
      const shot = await rawCall(client, tool, { ...profile, ...args });
      const body = JSON.parse(shot.content[0]?.text ?? "{}") as { error?: { code?: string } };
      expect(shot.isError && body.error?.code === "DIALOG_OPEN", `${tool}: ${shot.content[0]?.text}`);
    }
    const blockedMs = Date.now() - blockedAt;
    expect(blockedMs < 5_000, `DIALOG_OPEN took ${blockedMs} ms`);
    pass("DIALOG_OPEN with a dialog open, screenshot and extract included", `9 calls in ${blockedMs} ms`);

    await act("handle_dialog", { action: "accept" });
    await site.waitHit("main", "confirm", "true");
    await act("click_ref", { ref: refOf(tree, "Prompt button") });
    await act("handle_dialog", { action: "accept", prompt_text: "Ann" });
    await site.waitHit("main", "prompt", "Ann");
    pass("handle_dialog", "confirm accepted, prompt answered; the page's handlers saw both");

    // A dialog left open is answered when the policy goes back to auto.
    await act("click_ref", { ref: refOf(tree, "Confirm button") });
    await act("set_dialog_policy", { mode: "auto" });
    await site.waitHit("main", "confirm", "false");
    const shot = await rawCall(client, "screenshot", profile);
    expect(!shot.isError, `screenshot after the dialogs: ${shot.content[0]?.text}`);
    pass("back to auto", "the open dialog answered, screenshot works again");

    await act("click_ref", { ref: refOf(tree, "Child confirm") });
    await site.waitHit("child", "confirm", "false");
    await act("set_dialog_policy", { mode: "manual" });
    await act("click_ref", { ref: refOf(tree, "Child confirm") });
    const framed = (await act("list_dialogs", {})) as unknown as { dialogs: Array<{ message: string }> };
    expect(framed.dialogs[0]?.message === "From the frame?", JSON.stringify(framed));
    const inFrame = await code("screenshot", {});
    expect(inFrame === "DIALOG_OPEN", `screenshot with an OOPIF's dialog open: ${inFrame}`);
    await act("handle_dialog", { action: "accept" });
    await site.waitHit("child", "confirm", "true");
    await act("set_dialog_policy", { mode: "auto" });
    pass("a dialog in an OOPIF", "auto dismisses it; manual lists it, DIALOG_OPEN, handle_dialog accepts");

    // ── refs: alive, removed, navigated ──
    tree = await extract();
    const again = await extract();
    for (const name of ["Main button", "Child button", "Nested button"]) {
      expect(refOf(again, name) === refOf(tree, name), `${name} changed ref between extracts`);
      expect(refs[name.split(" ")[0]!] === refOf(tree, name), `${name} changed ref since the first extract`);
    }
    await act("click_ref", { ref: refs.Child });
    await site.waitHit("child", "click");
    pass("an old ref after re-extract", `${refs.Child} is the same element, and still clicks it`);

    const removed = refOf(tree, "Removed button");
    await act("click_ref", { ref: refOf(tree, "Remove below") });
    const removedCode = await code("click_ref", { ref: removed });
    expect(removedCode === "STALE_REF", `a removed element's ref: ${removedCode}`);
    pass("a removed element's ref", removedCode);

    const unknownRef = await code("click_ref", { ref: "e99999999" });
    expect(unknownRef === "ELEMENT_NOT_FOUND", `a ref never issued: ${unknownRef}`);
    if (IS_CAMOUFOX) {
      const unknownTab = await code("click_ref", { ref: "p999.e1" });
      expect(unknownTab === "TAB_NOT_FOUND", `a ref on a tab never opened: ${unknownTab}`);
      for (const tool of ["cdp_send", "cdp_send_no_safety"]) {
        const refused = await code(tool, { method: "Browser.getVersion" });
        expect(refused === "UNSUPPORTED_ON_ENGINE", `${tool}: ${refused}`);
      }
      pass("a tab never opened and raw CDP", "TAB_NOT_FOUND, UNSUPPORTED_ON_ENGINE");
    }

    // ── a second tab ──
    site.hits.length = 0;
    const tab2 = String((await act("new_tab", {})).targetId);
    await act("navigate", { url: `${site.parent}/tab2` });
    let list = await tabs();
    expect(list.activeTargetId === tab2, "new_tab did not make its tab active");
    pass("new_tab followed at once by navigate", `active is ${tab2}, ${list.targetInfos.find((t) => t.targetId === tab2)?.url}`);
    const tab2Tree = await extract();
    const tab2Button = refOf(tab2Tree, "Tab two button");
    await act("click_ref", { ref: tab2Button });
    await site.waitHit("tab2", "click");
    await act("type_ref", { ref: refOf(tab2Tree, "Tab two input"), text: "second" });
    await site.waitHit("tab2", "type", "second");
    pass("click_ref and type_ref on the second tab", tab2Button);
    const secondLocale = await evaluate("Intl.DateTimeFormat().resolvedOptions().locale");
    expect(secondLocale === firstLocale, `locale on the second tab: ${String(secondLocale)}`);
    pass("the second tab has the persona's locale too", String(secondLocale));

    await act("activate_tab", { target_id: firstTab });
    list = await tabs();
    expect(list.activeTargetId === firstTab, "activate_tab did not switch");
    const mainTitle = await evaluate("document.title");
    expect(mainTitle === "S5 main", `evaluate went to "${String(mainTitle)}"`);
    const mainTree = await extract();
    expect(hasName(mainTree, "Main button"), "extract did not follow activate_tab");
    pass("activate_tab", "evaluate_js and extract act on the first tab");

    await act("click_ref", { ref: tab2Button });
    await site.waitHit("tab2", "click");
    list = await tabs();
    expect(list.activeTargetId === tab2, "a ref on a background tab did not activate it");
    const state = await pageState(client, id);
    pass("a ref on a background tab activates it", `active ${tab2}, page state ${state}`);

    const code404 = await code("activate_tab", { target_id: "NO-SUCH-TARGET" });
    expect(code404 === "TAB_NOT_FOUND", `activate_tab: ${code404}`);

    await act("close_tab", { target_id: tab2 });
    list = await tabs();
    expect(list.activeTargetId === firstTab, `after closing the active tab: ${list.activeTargetId}`);
    expect(!list.targetInfos.some((t) => t.targetId === tab2), "the closed tab is still listed");
    await act("click_ref", { ref: refs.Main });
    await site.waitHit("main", "click");
    const staleTab = await code("click_ref", { ref: tab2Button });
    expect(staleTab === "STALE_REF", `a closed tab's ref: ${staleTab}`);
    pass("closing the active tab", `active back to ${firstTab}, clicks land, its refs are STALE_REF`);

    // ── new tabs of every kind load, none stalled by the debugger pause ──
    site.hits.length = 0;
    const popups = async (): Promise<void> => {
      await site.waitHit("popup", "loaded");
    };
    await act("click_ref", { ref: refs.Main });
    const beforePopup = (await tabs()).activeTargetId;
    const popupRef = refOf(tree, "Popup button");
    await act("click_ref", { ref: popupRef });
    await site.waitHit("main", "opened");
    await popups();
    await act("activate_tab", { target_id: beforePopup });
    await act("click_ref", { ref: refOf(tree, "Noopener popup") });
    await popups();
    list = await tabs();
    const popupTabs = list.targetInfos.filter((t) => t.url.includes("/popup"));
    expect(popupTabs.length === 2, `popups: ${JSON.stringify(list.targetInfos)}`);
    expect(list.activeTargetId === beforePopup, "a popup took the active tab");
    pass("window.open, with an opener and noopener: both load", `active stayed ${beforePopup}`);
    for (const popup of popupTabs) await act("close_tab", { target_id: popup.targetId });

    if (!IS_CAMOUFOX) {
      const viaCdp = (await act("cdp_send", {
        method: "Target.createTarget",
        params: { url: `${site.parent}/popup?n=3` },
      })) as { targetId: string };
      await popups();
      list = await tabs();
      expect(list.activeTargetId === beforePopup, "Target.createTarget through cdp_send took the active tab");
      pass("a tab from Target.createTarget through cdp_send loads", viaCdp.targetId);
      await act("activate_tab", { target_id: viaCdp.targetId });
      await act("close_tab", { target_id: viaCdp.targetId });

      // new_tab takes http(s) only, so these come through cdp_send, as an expert's would.
      const openRaw = async (url: string): Promise<string> => {
        const opened = (await act("cdp_send", { method: "Target.createTarget", params: { url } })) as {
          targetId: string;
        };
        await act("activate_tab", { target_id: opened.targetId });
        return opened.targetId;
      };
      for (const url of ["chrome://version/", "chrome://extensions/", "chrome://newtab/"]) {
        const opened = await openRaw(url);
        let readyState: unknown;
        let title: unknown;
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          readyState = await evaluate("document.readyState");
          title = await evaluate("document.title");
          if (readyState === "complete") break;
          await new Promise((done) => setTimeout(done, 100));
        }
        expect(readyState === "complete", `${url} stalled at ${String(readyState)}`);
        pass(`${url} loads`, `readyState complete, title "${String(title)}"`);
        await act("close_tab", { target_id: opened });
      }

      const extensionUrl = "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html";
      const opened = await openRaw(extensionUrl);
      await new Promise((done) => setTimeout(done, 1_000));
      const extensionState = `url ${String(await evaluate("location.href"))}, readyState ${String(await evaluate("document.readyState"))}`;
      pass("the PDF viewer's extension page", extensionState);
      await act("close_tab", { target_id: opened });
    }

    // ── the first tab closes, the session stays ──
    const tab3 = String((await act("new_tab", {})).targetId);
    await act("activate_tab", { target_id: firstTab });
    await act("close_tab", { target_id: firstTab });
    list = await tabs();
    expect(list.activeTargetId === tab3, `after closing the root tab: ${list.activeTargetId}`);
    await act("navigate", { url: `${site.parent}/other` });
    const after = await extract();
    await act("click_ref", { ref: refOf(after, "Main button") });
    await site.waitHit("other", "click");
    const profiles = (await call(client, "list_profiles")).profiles as Array<{ id: string; isRunning: boolean }>;
    expect(profiles.find((p) => p.id === id)?.isRunning, "the profile stopped with its first tab");
    pass("closing the root tab while another exists", `the session lives on in ${tab3}`);

    // ── navigation ──
    site.hits.length = 0;
    const before = refOf(after, "Main button");
    await act("navigate", { url: `${site.parent}/other` });
    const sameUrl = await code("click_ref", { ref: before });
    expect(sameUrl === "STALE_REF", `an old ref after a reload of the same URL: ${sameUrl}`);
    const crossOrigin = refOf(await extract(), "Main button");
    expect(crossOrigin !== before, "a new document reused a ref");
    await act("navigate", { url: `${site.child}/other` });
    const crossProcess = await code("click_ref", { ref: crossOrigin });
    expect(crossProcess === "STALE_REF", `an old ref after a cross-process navigate: ${crossProcess}`);
    expect(
      !site.hits.some((h) => h.what === "click"),
      "an old ref clicked something on the new page",
    );
    pass("an old ref after navigate", `STALE_REF, same URL and cross-process; ${before} and ${crossOrigin} never reused`);

    const toFile = await rawCall(client, "navigate", { ...profile, url: `${site.parent}/file` });
    pass("navigate to an attachment", toFile.content[0]?.text ?? "");

    const failed = await callError(client, "navigate", { ...profile, url: "http://127.0.0.1:1/" });
    expect(failed.code === "NAVIGATION_FAILED", `navigate to a closed port: ${JSON.stringify(failed)}`);
    pass("navigate to a failing URL", String(failed.message));
    const refused = await callError(client, "navigate", {
      ...profile,
      url: `http://127.0.0.1:${await freePort()}/`,
    });
    expect(refused.code === "NAVIGATION_FAILED", `navigate to a closed port: ${JSON.stringify(refused)}`);
    pass("navigate to a port nothing listens on", String(refused.message));

    const sameDocumentAt = Date.now();
    await act("navigate", { url: `${site.child}/other#there` });
    expect(Date.now() - sameDocumentAt < 3_000, "a same-document navigate waited for a load event");
    pass("a same-document navigate returns at once", `${Date.now() - sameDocumentAt} ms`);

    // ── after the browser ──
    await act("set_dialog_policy", { mode: "manual" });
    if (IS_CAMOUFOX) {
      await evaluate("setTimeout(() => alert('left open'), 10); 1");
    } else {
      await call(client, "cdp_send", {
        ...profile,
        method: "Runtime.evaluate",
        params: { expression: "setTimeout(() => alert('left open'), 10); 1" },
      });
    }
    await waitForDialog(client, id);
    const closingAt = Date.now();
    await act("close_profile", {});
    pass("close_profile with a dialog left open", `${Date.now() - closingAt} ms`);
    const stopped = (await act("list_downloads", {})) as unknown as {
      downloads: Array<{ id: string; fileName: string }>;
    };
    expect(stopped.downloads[0]?.id === download!.id, "a stopped profile lost its downloads");
    const fromStopped = (await act("get_download", { download_id: download!.id })) as {
      data_base64?: string;
    };
    expect(fromStopped.data_base64 === got.data_base64, "get_download on a stopped profile");
    pass("list_downloads and get_download on a stopped profile", stopped.downloads[0]!.fileName);

    await client.close();
    sendConsoleCtrl(serve.child.pid!, "CTRL_BREAK");
    const exit = await serve.exited;
    expect(exit === 0, `exit code ${exit}:\n${serve.output()}`);
    await assertNoLeftovers("tabs flow");

    // ── a later run of the server, with no browser started ──
    const later = await startServe();
    try {
      const again = await httpClient(later.url, later.token);
      const kept = (await call(again, "list_downloads", profile)) as unknown as {
        downloads: Array<{ id: string; fileName: string; state: string }>;
      };
      expect(kept.downloads[0]?.id === download!.id, `after a restart: ${JSON.stringify(kept)}`);
      const fromDisk = (await call(again, "get_download", { ...profile, download_id: download!.id })) as {
        data_base64?: string;
      };
      expect(fromDisk.data_base64 === got.data_base64, "get_download after a restart");
      pass("the downloads after a restart of the server", kept.downloads[0]!.fileName);
      await again.close();
      sendConsoleCtrl(later.child.pid!, "CTRL_BREAK");
      expect((await later.exited) === 0, `exit code:\n${later.output()}`);
    } finally {
      if (later.child.exitCode === null) later.child.kill();
    }
  } finally {
    if (serve.child.exitCode === null) serve.child.kill();
    await site.close();
  }
}

// ── concurrency ──────────────────────────────────────────────────────────────

/**
 * Two large buttons and a text field, and a page-side log of each trusted event in the
 * order the page got them: what proves two agents' input did not interleave.
 */
const EVENTS_HTML = `<!doctype html>
<html><head><title>MZ Events</title></head>
<body style="margin:0">
  <button id="left" style="position:absolute;left:40px;top:40px;width:200px;height:120px">left</button>
  <button id="right" style="position:absolute;left:400px;top:40px;width:200px;height:120px">right</button>
  <input id="field" style="position:absolute;left:40px;top:220px;width:300px">
  <script>
    window.__log = [];
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click", "keydown"]) {
      addEventListener(type, (e) => {
        if (e.isTrusted) window.__log.push(type + ":" + (e.target.id || e.target.tagName));
      }, true);
    }
  </script>
</body></html>`;

const MANY_ELEMENTS_HTML = `<!doctype html>
<html><head><title>MZ Many</title></head><body>
  <script>
    for (let i = 0; i < 6000; i++) {
      const b = document.createElement("button");
      b.textContent = "b" + i;
      document.body.appendChild(b);
    }
  </script>
</body></html>`;

async function startEventsSite(): Promise<{ origin: string; close(): Promise<void> }> {
  const server = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    const html = req.url === "/events" ? EVENTS_HTML : req.url === "/many" ? MANY_ELEMENTS_HTML : null;
    if (html) res.writeHead(200, { "content-type": "text/html" }).end(html);
    else res.writeHead(404).end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

async function eventLog(client: Client, id: string): Promise<string[]> {
  const read = await call(client, "evaluate_js", {
    profile_id: id,
    expression: "JSON.stringify(window.__log)",
  });
  return JSON.parse(String((read.result as { value?: unknown }).value)) as string[];
}

/** Keeps the renderer busy, which is what a stuck page looks like from here. */
function busyPage(ms: number): string {
  return `(() => { const end = Date.now() + ${ms}; while (Date.now() < end); return "done"; })()`;
}

function errorOf(result: ToolResult): Record<string, unknown> {
  expect(result.isError, `expected an error: ${result.content[0]?.text}`);
  return (JSON.parse(result.content[0]?.text ?? "{}") as { error: Record<string, unknown> }).error;
}

/** Spends at most what the caller still wants to wait, for what must be gone by then. */
async function isSettledWithin(pending: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<false>((done) => {
    timer = setTimeout(() => done(false), ms);
  });
  const settled = await Promise.race([pending.then(() => true as const, () => true as const), late]);
  clearTimeout(timer);
  return settled;
}

async function waitUntilStopped(client: Client, id: string, budgetMs: number): Promise<number> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < budgetMs) {
    const listed = (await call(client, "list_profiles")) as unknown as {
      profiles: Array<{ id: string; isRunning: boolean }>;
    };
    if (!listed.profiles.find((p) => p.id === id)?.isRunning) return Date.now() - startedAt;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`FAILED: ${id} still reads as running after ${budgetMs} ms`);
}

const SLOT_WAIT_MS = 12_000;

/** Three at once with two slots; a kill frees one; the third times out with none free. */
async function limitChecks(owner: Client, ids: string[]): Promise<void> {
  const [a, b, c, d] = ids as [string, string, string, string];
  const startedAt = Date.now();
  const settled = new Map<string, number>();
  const launches = new Map(
    [a, b, c].map((id) => [
      id,
      rawCall(owner, "launch_profile", { profile_id: id }).then((result) => {
        settled.set(id, Date.now() - startedAt);
        return result;
      }),
    ]),
  );
  await waitFor(() => settled.size === 2, "two of three launches to finish", 60_000);
  const [firstUp, secondUp] = [...settled.keys()] as [string, string];
  const waiter = [a, b, c].find((id) => !settled.has(id))!;
  await new Promise((done) => setTimeout(done, 1_500));
  expect(!settled.has(waiter), "the third browser started past the limit");
  pass("3 launches at once with --max-browsers 2", `2 up in ${Math.max(...settled.values())} ms, the third waits`);

  const closedAt = Date.now();
  await call(owner, "close_profile", { profile_id: firstUp });
  const third = await launches.get(waiter)!;
  expect(!third.isError, `the third launch failed: ${third.content[0]?.text}`);
  pass("the third starts once one closes", `${Date.now() - closedAt} ms after the close`);
  for (const id of [firstUp, secondUp]) {
    const up = await launches.get(id)!;
    expect(!up.isError, `a launch failed: ${up.content[0]?.text}`);
  }

  // Both slots taken, none closing: it times out.
  const refusedAt = Date.now();
  const refused = errorOf(await rawCall(owner, "launch_profile", { profile_id: d }));
  const waited = Date.now() - refusedAt;
  expect(refused.code === "BROWSER_LIMIT_REACHED", `limit: ${JSON.stringify(refused)}`);
  expect(refused.retryable === true, `limit: ${JSON.stringify(refused)}`);
  expect(waited >= SLOT_WAIT_MS - 500, `refused after only ${waited} ms`);
  pass("with none free it times out", `BROWSER_LIMIT_REACHED, retryable, after ${waited} ms`);

  // A kill from outside, by the PID this client was told: the slot comes back.
  const victim = secondUp;
  const running = (await call(owner, "launch_profile", { profile_id: victim })) as { pid?: number };
  expect(typeof running.pid === "number" && running.pid > 0, `no pid: ${JSON.stringify(running)}`);
  killBrowserTree(running.pid);
  const noticedIn = await waitUntilStopped(owner, victim, 10_000);
  const afterKill = await rawCall(owner, "launch_profile", { profile_id: d });
  expect(!afterKill.isError, `after the kill: ${afterKill.content[0]?.text}`);
  pass("killing a browser by its PID frees a slot", `noticed in ${noticedIn} ms, the next launch got it`);

  await call(owner, "close_profile", { profile_id: waiter });
  await call(owner, "close_profile", { profile_id: d });
}

/** Two clients on one page. The page's own log says whether their input interleaved. */
async function noInterleavingChecks(url: string, token: string, id: string, origin: string): Promise<void> {
  const left = await httpClient(url, token);
  const right = await httpClient(url, token);
  await launch(left, id);
  await call(left, "navigate", { profile_id: id, url: `${origin}/events` });

  const CLICKS = 6;
  const spans: Array<[number, number]> = [];
  const clicker = async (client: Client, selector: string): Promise<void> => {
    for (let i = 0; i < CLICKS; i++) {
      const startedAt = Date.now();
      await call(client, "click", { profile_id: id, selector });
      spans.push([startedAt, Date.now()]);
    }
  };
  await Promise.all([clicker(left, "#left"), clicker(right, "#right")]);
  const overlapping = spans.filter(([s, e]) =>
    spans.some(([s2, e2]) => s2 !== s && s2 < e && s < e2),
  ).length;
  expect(overlapping > 0, "the clicks never ran at the same time, so this proved nothing");

  const log = await eventLog(left, id);
  const groups: string[][] = [];
  for (let i = 0; i < log.length; i += 5) groups.push(log.slice(i, i + 5));
  expect(groups.length === 2 * CLICKS, `${log.length} events: ${log.join(" ")}`);
  for (const group of groups) {
    const target = group[0]!.split(":")[1]!;
    const expected = ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].map(
      (type) => `${type}:${target}`,
    );
    expect(group.join() === expected.join(), `interleaved events: ${log.join(" ")}`);
  }
  const sides = groups.map((g) => (g[0]!.endsWith("left") ? "L" : "R")).join("");
  pass("two clients clicking one page don't interleave", `${overlapping} calls in flight together, page saw ${sides}`);

  await call(left, "evaluate_js", { profile_id: id, expression: "window.__log.length = 0" });
  await Promise.all([
    call(left, "type", { profile_id: id, selector: "#field", text: "interleave" }),
    call(right, "click", { profile_id: id, selector: "#right" }),
  ]);
  const typed = (await eventLog(left, id)).map((e) => e.split(":")[0]!);
  const keys = typed.map((t) => (t === "keydown" ? "k" : "m")).join("");
  expect(/^(m*k{10}m*)$/.test(keys), `a click cut into the typing: ${typed.join(" ")}`);
  pass("a click can't cut into typing from another client", keys);

  await left.close();
  await right.close();
}

/** A queued click whose client goes away must not fire when the profile comes free. */
async function disconnectChecks(url: string, token: string, id: string): Promise<void> {
  const holder = await httpClient(url, token);
  const clicks = async (): Promise<number> =>
    (await eventLog(holder, id)).filter((e) => e.startsWith("click")).length;

  const holdFor = (ms: number): Promise<ToolResult> =>
    rawCall(holder, "evaluate_js", { profile_id: id, expression: busyPage(ms) });
  const queueClick = (client: Client, signal?: AbortSignal): Promise<unknown> =>
    client
      .callTool(
        { name: "click", arguments: { profile_id: id, selector: "#left" } },
        undefined,
        signal ? { signal, timeout: 120_000 } : { timeout: 120_000 },
      )
      .catch(() => {});

  // A cancelled call: the SDK sends notifications/cancelled.
  let before = await clicks();
  let holding = holdFor(2_000);
  await new Promise((done) => setTimeout(done, 300));
  const cancelling = await httpClient(url, token);
  const cancel = new AbortController();
  void queueClick(cancelling, cancel.signal);
  await new Promise((done) => setTimeout(done, 300));
  cancel.abort();
  await holding;
  await new Promise((done) => setTimeout(done, 800));
  expect((await clicks()) === before, "a cancelled queued click fired");
  await cancelling.close();
  pass("a cancelled queued click never fires");

  // A session ended with DELETE.
  before = await clicks();
  holding = holdFor(2_000);
  await new Promise((done) => setTimeout(done, 300));
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const ending = new Client({ name: "e2e-ending", version: "1.0.0" });
  await ending.connect(transport);
  void queueClick(ending);
  await new Promise((done) => setTimeout(done, 300));
  await transport.terminateSession();
  await ending.close();
  await holding;
  await new Promise((done) => setTimeout(done, 800));
  expect((await clicks()) === before, "the queued click of a terminated session fired");
  pass("a session's end drops its queued click");

  // A Streamable client gone with no DELETE, as a process that died would be.
  before = await clicks();
  holding = holdFor(2_000);
  await new Promise((done) => setTimeout(done, 300));
  const vanishing = await httpClient(url, token);
  void queueClick(vanishing);
  await new Promise((done) => setTimeout(done, 300));
  await vanishing.close();
  await holding;
  await new Promise((done) => setTimeout(done, 800));
  expect((await clicks()) === before, "the queued click of a client gone without DELETE fired");
  pass("a client gone without DELETE loses its queued click");

  // Legacy SSE: the stream closing is the session closing.
  before = await clicks();
  holding = holdFor(2_000);
  await new Promise((done) => setTimeout(done, 300));
  const sse = new Client({ name: "e2e-sse", version: "1.0.0" });
  await sse.connect(
    new SSEClientTransport(new URL("/sse", url), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  void queueClick(sse);
  await new Promise((done) => setTimeout(done, 300));
  await sse.close();
  await holding;
  await new Promise((done) => setTimeout(done, 800));
  expect((await clicks()) === before, "the queued click of a dropped SSE client fired");
  pass("a dropped SSE client loses its queued click");

  await holder.close();
}

/** A stuck page: close_profile goes past the queue and the holder fails at once. */
async function preemptionChecks(url: string, token: string, id: string): Promise<void> {
  const holder = await httpClient(url, token);
  const queued = await httpClient(url, token);
  const closer = await httpClient(url, token);
  const stuck = rawCall(holder, "evaluate_js", { profile_id: id, expression: busyPage(25_000) });
  await new Promise((done) => setTimeout(done, 500));
  const waiting = rawCall(queued, "click", { profile_id: id, selector: "#left" });
  await new Promise((done) => setTimeout(done, 300));

  const startedAt = Date.now();
  const closing = call(closer, "close_profile", { profile_id: id });
  const waiterError = errorOf(await waiting);
  const waiterMs = Date.now() - startedAt;
  const holderError = errorOf(await stuck);
  const holderMs = Date.now() - startedAt;
  await closing;
  const closeMs = Date.now() - startedAt;
  expect(waiterError.code === "PROFILE_NOT_RUNNING", `waiter: ${JSON.stringify(waiterError)}`);
  expect(holderError.code === "PROFILE_NOT_RUNNING", `holder: ${JSON.stringify(holderError)}`);
  expect(holderMs < 3_000, `the holder took ${holderMs} ms to fail`);
  expect(closeMs < 15_000, `the close took ${closeMs} ms`);
  pass(
    "close_profile preempts a stuck page",
    `waiter failed in ${waiterMs} ms, holder in ${holderMs} ms, closed in ${closeMs} ms`,
  );
  await holder.close();
  await queued.close();
  await closer.close();
}

async function leaseChecks(url: string, token: string, id: string): Promise<void> {
  const holder = await httpClient(url, token);
  const other = await httpClient(url, token);
  const lease = await call(holder, "acquire_profile", { profile_id: id, ttl_ms: 60_000 });
  const leaseId = String(lease.lease_id);
  expect(/^lease_/.test(leaseId), JSON.stringify(lease));

  const blocked = errorOf(await rawCall(other, "click", { profile_id: id, selector: "#left" }));
  expect(blocked.code === "PROFILE_LEASED", JSON.stringify(blocked));
  await call(other, "extract", { profile_id: id });
  await call(other, "list_tabs", { profile_id: id });
  await call(holder, "click", { profile_id: id, selector: "#left" });
  pass("a lease blocks another session's click, not its reads", String(blocked.code));

  await holder.close();
  const back = await httpClient(url, token);
  const before = errorOf(await rawCall(back, "click", { profile_id: id, selector: "#left" }));
  expect(before.code === "PROFILE_LEASED", JSON.stringify(before));
  const reattached = await call(back, "acquire_profile", { profile_id: id, lease_id: leaseId });
  expect(reattached.lease_id === leaseId, JSON.stringify(reattached));
  await call(back, "click", { profile_id: id, selector: "#left" });
  const bad = errorOf(await rawCall(other, "renew_profile", { profile_id: id, lease_id: "nope" }));
  expect(bad.code === "LEASE_INVALID", JSON.stringify(bad));
  pass("a lease outlives its session, and a reconnect reattaches with its id");

  const forced = await call(other, "release_profile", { profile_id: id, force: true });
  expect(forced.released === true, JSON.stringify(forced));
  await call(other, "click", { profile_id: id, selector: "#left" });
  pass("force-release by a token with the operator group");

  await back.close();
  await other.close();
}

/** An old ref held across a relaunch fails instead of naming something else. */
async function relaunchRefCheck(client: Client, id: string, origin: string, what: string): Promise<void> {
  await call(client, "navigate", { profile_id: id, url: `${origin}/events` });
  const extracted = (await call(client, "extract", { profile_id: id })) as unknown as { result: Extracted };
  const tree = treeOf(extracted.result);
  const ref = refOf(tree, "left");
  await call(client, "close_profile", { profile_id: id });
  await launch(client, id);
  await call(client, "navigate", { profile_id: id, url: `${origin}/events` });
  const again = (await call(client, "extract", { profile_id: id })) as unknown as { result: Extracted };
  const fresh = refOf(treeOf(again.result), "left");
  expect(fresh !== ref, `the same ref ${ref} after a relaunch`);
  const old = errorOf(await rawCall(client, "click_ref", { profile_id: id, ref }));
  expect(old.code === "ELEMENT_NOT_FOUND", `an old ref: ${JSON.stringify(old)}`);
  pass(`${what}: a ref from before a relaunch fails, it doesn't reach anything`, `${ref} then ${fresh}`);
}

/** Both engines share the limit, on real browsers. Camoufox's extract keeps to its cap. */
async function bothEnginesChecks(client: Client, origin: string): Promise<void> {
  const profile = async (name: string, engine: string): Promise<string> =>
    String((await call(client, "create_profile", { name, engine })).id);
  const cloak = await profile("cloak", "cloakbrowser");
  const fox = await profile("fox", "camoufox");
  const third = await profile("cloak-3", "cloakbrowser");
  await launch(client, cloak);
  await launch(client, fox);

  const refused = errorOf(await rawCall(client, "launch_profile", { profile_id: third }));
  expect(refused.code === "BROWSER_LIMIT_REACHED", JSON.stringify(refused));
  pass("CloakBrowser and Camoufox count against one limit", String(refused.code));

  await call(client, "navigate", { profile_id: fox, url: `${origin}/many` });
  const huge = (await call(client, "extract", { profile_id: fox })) as unknown as {
    result: { ariaSnapshot: string; truncated?: boolean };
  };
  const lines = huge.result.ariaSnapshot.split("\n").length;
  expect(huge.result.truncated === true, "no truncation flag on a 6000 element page");
  expect(lines === 5_000, `${lines} lines`);
  pass("Camoufox extract caps a huge page and says so", `${lines} of about 6000 lines, truncated: true`);
  await relaunchRefCheck(client, fox, origin, "Camoufox");

  const closedAt = Date.now();
  await call(client, "close_profile", { profile_id: fox });
  await launch(client, third);
  pass("a Camoufox browser's slot goes to a CloakBrowser profile", `${Date.now() - closedAt} ms`);

  await call(client, "close_profile", { profile_id: cloak });
  await call(client, "close_profile", { profile_id: third });
}

async function concurrencyFlow(): Promise<void> {
  expect(!IS_CAMOUFOX, "this flow kills a browser by its PID, which Camoufox doesn't report");
  const site = await startEventsSite();
  const serve = await startServe([
    "--max-browsers",
    "2",
    "--browser-queue-timeout-ms",
    String(SLOT_WAIT_MS),
  ]);
  try {
    const owner = await httpClient(serve.url, serve.token);
    const ids: string[] = [];
    for (const name of ["a", "b", "c", "d"]) {
      ids.push(String((await call(owner, "create_profile", { name: `c-${name}`, ...ENGINE_ARGS })).id));
    }
    // A first launch alone: an engine that still has to install must not skew the timings.
    await launch(owner, ids[0]!);
    await call(owner, "close_profile", { profile_id: ids[0]! });

    await limitChecks(owner, ids);
    const page = ids[0]!;
    await noInterleavingChecks(serve.url, serve.token, page, site.origin);
    await disconnectChecks(serve.url, serve.token, page);
    await leaseChecks(serve.url, serve.token, page);
    await preemptionChecks(serve.url, serve.token, page);
    await launch(owner, page);
    await relaunchRefCheck(owner, page, site.origin, "CloakBrowser");
    await call(owner, "close_profile", { profile_id: page });
    if (values["camoufox-install"]) {
      await bothEnginesChecks(owner, site.origin);
    }

    // Shutdown with a launch under way: the late browser must not be left running.
    void rawCall(owner, "launch_profile", { profile_id: page }).catch(() => {});
    await new Promise((done) => setTimeout(done, 400));
    sendConsoleCtrl(serve.child.pid!, "CTRL_BREAK");
    const exit = await serve.exited;
    expect(exit === 0, `exit code ${exit}:\n${serve.output()}`);
    await assertNoLeftovers("shutdown during a launch");
  } finally {
    if (serve.child.exitCode === null) serve.child.kill();
    await site.close();
  }
}

// ── Display modes ────────────────────────────────────────────────────────────

/** What a page says about itself. Everything here is what a site can read. */
const PAGE_SURFACE = `JSON.stringify({
  pointerFine: matchMedia("(pointer: fine)").matches,
  hover: matchMedia("(hover: hover)").matches,
  anyPointerFine: matchMedia("(any-pointer: fine)").matches,
  anyHover: matchMedia("(any-hover: hover)").matches,
  webdriver: navigator.webdriver,
  userAgent: navigator.userAgent,
  brands: navigator.userAgentData ? navigator.userAgentData.brands.map((b) => b.brand) : null,
  visibility: document.visibilityState,
  hasFocus: document.hasFocus(),
  paints: performance.getEntriesByType("paint").map((p) => p.name),
  screen: [screen.width, screen.height, screen.colorDepth],
  outer: [outerWidth, outerHeight],
  inner: [innerWidth, innerHeight],
})`;

interface PageSurface {
  pointerFine: boolean;
  hover: boolean;
  webdriver: boolean;
  userAgent: string;
  brands: string[] | null;
  visibility: string;
  hasFocus: boolean;
  paints: string[];
}

async function pageSurface(client: Client, id: string): Promise<PageSurface> {
  const read = await call(client, "evaluate_js", { profile_id: id, expression: PAGE_SURFACE });
  return JSON.parse(String((read.result as { value?: unknown }).value)) as PageSurface;
}

async function runningMode(client: Client, id: string): Promise<{ saved: unknown; running: unknown }> {
  const { profiles } = await call(client, "list_profiles");
  const row = (profiles as Array<Record<string, unknown>>).find((p) => p.id === id);
  expect(row, `list_profiles lacks ${id}`);
  return { saved: row.displayMode, running: row.runningDisplayMode };
}

async function closeAndExit(serve: Awaited<ReturnType<typeof startServe>>, client: Client): Promise<void> {
  await client.close();
  sendConsoleCtrl(serve.child.pid!, "CTRL_BREAK");
  const code = await serve.exited;
  expect(code === 0, `exit code ${code}:\n${serve.output()}`);
}

const SESSION_COOKIE = (name: string): Record<string, unknown> => ({
  name,
  value: "kept",
  domain: "127.0.0.1",
  path: "/",
  expires: Math.floor(Date.now() / 1000) + 86_400,
});

/** With --headless, forced: the page's surface, the visibility it loads with, the refusals. */
async function headlessSurfaceChecks(fixture: Fixture): Promise<void> {
  const serve = await startServe(["--headless"]);
  try {
    const client = await httpClient(serve.url, serve.token);
    const id = String(
      (await call(client, "create_profile", { name: "saved headed", display_mode: "headed", ...ENGINE_ARGS })).id,
    );
    expect((await runningMode(client, id)).saved === "headed", "the saved mode didn't round trip");

    const launched = await launch(client, id);
    expect(launched.displayMode === "headless", `launched ${String(launched.displayMode)}`);
    const modes = await runningMode(client, id);
    expect(modes.saved === "headed" && modes.running === "headless", JSON.stringify(modes));
    pass("--headless: a profile saved as headed runs headless", JSON.stringify(modes));

    await call(client, "navigate", { profile_id: id, url: fixture.url });
    const surface = await pageSurface(client, id);
    pass("page right after load", JSON.stringify(surface));
    for (const ms of [100, 900]) {
      await new Promise((done) => setTimeout(done, ms));
      const later = await pageSurface(client, id);
      pass(`the same page ${ms === 100 ? "100 ms" : "1 s"} later`, `${later.visibility}, paints ${JSON.stringify(later.paints)}, focus ${later.hasFocus}`);
    }
    expect(surface.pointerFine, "(pointer: fine) is false");
    expect(surface.hover, "(hover: hover) is false");
    expect(surface.webdriver === false, `navigator.webdriver is ${surface.webdriver}`);
    expect(surface.hasFocus, "the page has no focus in headless");
    const claims = JSON.stringify([surface.userAgent, surface.brands, fixture.lastHeaders()]);
    expect(!/headless/i.test(claims), `a headless marker in ${claims}`);
    pass("no headless marker", `in the UA, brands or request headers; sec-ch-ua: ${String(fixture.lastHeaders()["sec-ch-ua"])}`);

    // A fresh tab, right after it loads: where an occluded headed window has no paint.
    await call(client, "new_tab", { profile_id: id, url: `${fixture.url}?fresh=1` });
    await call(client, "wait_for_load", { profile_id: id });
    const fresh = await pageSurface(client, id);
    pass("a new tab right after load", `${fresh.visibility}, paints ${JSON.stringify(fresh.paints)}, focus ${fresh.hasFocus}`);

    const tree = treeOf((await call(client, "extract", { profile_id: id })).result as Extracted);
    await call(client, "click_ref", { profile_id: id, ref: refOf(tree, "Press me") });
    const clicked = (await call(client, "extract", { profile_id: id })).result as { title: string };
    expect(clicked.title === "clicked", `the click in the new tab didn't land: ${clicked.title}`);
    pass("input in that tab at once", "delivered, no INPUT_NOT_DELIVERED");

    const probe = await call(client, "probe_fingerprint", { profile_id: id });
    pass("probe_fingerprint in headless", JSON.stringify({ ok: probe.ok, drift: probe.drift }));

    expect((await call(client, "launch_profile", { profile_id: id })).displayMode === "headless", "idempotent");
    expect(
      (await call(client, "launch_profile", { profile_id: id, display_mode: "headless" })).displayMode === "headless",
      "naming the running mode",
    );
    pass("launch on a running profile: no parameter, or naming its mode", "idempotent");

    for (const mode of ["headed", "xvfb"]) {
      const refused = await callError(client, "launch_profile", { profile_id: id, display_mode: mode });
      expect(refused.code === "INVALID_INPUT", `explicit ${mode}: ${JSON.stringify(refused)}`);
    }
    pass("--headless plus an explicit headed or xvfb", "INVALID_INPUT, running or not");
    await call(client, "close_profile", { profile_id: id });
    const stopped = await callError(client, "launch_profile", { profile_id: id, display_mode: "headed" });
    expect(stopped.code === "INVALID_INPUT", `on a stopped profile: ${JSON.stringify(stopped)}`);
    pass("the same on a stopped profile", String(stopped.message));

    await closeAndExit(serve, client);
    await assertNoLeftovers("forced headless");
  } finally {
    if (serve.child.exitCode === null) serve.child.kill();
  }
}

/** Xvfb is what a Linux server runs by default: the same questions of a page as for headless. */
async function xvfbSurfaceChecks(fixture: Fixture): Promise<void> {
  const serve = await startServe();
  try {
    const client = await httpClient(serve.url, serve.token);
    const id = String((await call(client, "create_profile", { name: "under xvfb", ...ENGINE_ARGS })).id);
    const launched = await launch(client, id);
    expect(launched.displayMode === "xvfb", `auto chose ${String(launched.displayMode)}`);
    pass("auto on Linux with Xvfb", "xvfb");

    await call(client, "navigate", { profile_id: id, url: fixture.url });
    const surface = await pageSurface(client, id);
    pass("xvfb: page right after load", JSON.stringify(surface));
    for (const ms of [100, 900]) {
      await new Promise((done) => setTimeout(done, ms));
      const later = await pageSurface(client, id);
      pass(`xvfb: the same page ${ms === 100 ? "100 ms" : "1 s"} later`, `${later.visibility}, paints ${JSON.stringify(later.paints)}, focus ${later.hasFocus}`);
    }
    expect(surface.pointerFine, "(pointer: fine) is false");
    expect(surface.hover, "(hover: hover) is false");
    expect(surface.webdriver === false, `navigator.webdriver is ${surface.webdriver}`);
    expect(surface.hasFocus, "the page has no focus under Xvfb");

    await call(client, "new_tab", { profile_id: id, url: `${fixture.url}?fresh=1` });
    await call(client, "wait_for_load", { profile_id: id });
    const fresh = await pageSurface(client, id);
    pass("xvfb: a new tab right after load", `${fresh.visibility}, paints ${JSON.stringify(fresh.paints)}, focus ${fresh.hasFocus}`);

    const tree = treeOf((await call(client, "extract", { profile_id: id })).result as Extracted);
    await call(client, "click_ref", { profile_id: id, ref: refOf(tree, "Press me") });
    const clicked = (await call(client, "extract", { profile_id: id })).result as { title: string };
    expect(clicked.title === "clicked", `the click in the new tab didn't land: ${clicked.title}`);
    pass("xvfb: input in that tab at once", "delivered, no INPUT_NOT_DELIVERED");

    const probe = await call(client, "probe_fingerprint", { profile_id: id });
    pass("probe_fingerprint under xvfb", JSON.stringify({ ok: probe.ok, drift: probe.drift }));

    await call(client, "close_profile", { profile_id: id });
    await closeAndExit(serve, client);
    await assertNoLeftovers("xvfb");
  } finally {
    if (serve.child.exitCode === null) serve.child.kill();
  }
}

/** With nothing forced: what a machine can't do, and what a running browser won't change. */
async function refusalChecks(): Promise<void> {
  const serve = await startServe();
  try {
    const client = await httpClient(serve.url, serve.token);
    const id = String((await call(client, "create_profile", { name: "refusals", ...ENGINE_ARGS })).id);

    const impossible = await callError(client, "launch_profile", { profile_id: id, display_mode: IMPOSSIBLE_MODE });
    expect(impossible.code === "DISPLAY_UNAVAILABLE", `${IMPOSSIBLE_MODE}: ${JSON.stringify(impossible)}`);
    pass(`${IMPOSSIBLE_MODE} on this machine`, `DISPLAY_UNAVAILABLE: ${String(impossible.message)}`);

    await call(client, "update_profile", { profile_id: id, display_mode: IMPOSSIBLE_MODE });
    const saved = await callError(client, "launch_profile", { profile_id: id });
    expect(saved.code === "DISPLAY_UNAVAILABLE", `a saved ${IMPOSSIBLE_MODE}: ${JSON.stringify(saved)}`);
    await call(client, "update_profile", { profile_id: id, display_mode: null });
    pass(`a saved ${IMPOSSIBLE_MODE} on this machine`, "DISPLAY_UNAVAILABLE, not some other mode");

    const launched = await call(client, "launch_profile", { profile_id: id, display_mode: "headless" });
    expect(launched.displayMode === "headless", `launched ${String(launched.displayMode)}`);

    const mismatch = await callError(client, "launch_profile", { profile_id: id, display_mode: WINDOW_MODE });
    expect(mismatch.code === "PROFILE_ALREADY_RUNNING", `mismatch: ${JSON.stringify(mismatch)}`);
    expect(/close_profile/.test(String(mismatch.hint)), `no way out: ${JSON.stringify(mismatch)}`);
    pass("an explicit mismatch on a running profile", `PROFILE_ALREADY_RUNNING: ${String(mismatch.hint)}`);

    const plain = await call(client, "launch_profile", { profile_id: id });
    expect(plain.displayMode === "headless", "a plain launch changed something");
    pass("a plain launch on it", "idempotent, still headless");

    const change = await callError(client, "update_profile", { profile_id: id, display_mode: WINDOW_MODE });
    expect(change.code === "PROFILE_ALREADY_RUNNING", `a real change: ${JSON.stringify(change)}`);
    await call(client, "update_profile", { profile_id: id, name: "renamed", display_mode: null });
    pass("update_profile while it runs", "a real change is refused, re-sending the same saves");

    await closeAndExit(serve, client);
    await assertNoLeftovers("refusals");
  } finally {
    if (serve.child.exitCode === null) serve.child.kill();
  }
}

/** One data dir through every mode. Includes one short real window. */
async function dataDirSwitchChecks(fixture: Fixture): Promise<void> {
  const serve = await startServe();
  try {
    const client = await httpClient(serve.url, serve.token);
    const id = String((await call(client, "create_profile", { name: "switching", ...ENGINE_ARGS })).id);
    const stage = async (mode: string, cookie: string, expected: string[]): Promise<void> => {
      const launched = await call(client, "launch_profile", { profile_id: id, display_mode: mode });
      expect(launched.displayMode === mode, `launched ${String(launched.displayMode)}`);
      await call(client, "navigate", { profile_id: id, url: fixture.url });
      pass(`one data dir: the page in ${mode}`, JSON.stringify(await pageSurface(client, id)));
      const sent = fixture.cookieHeaders.at(-1) ?? "";
      for (const name of expected) {
        expect(sent.includes(`${name}=kept`), `in ${mode} the page got "${sent}", wanting ${name}`);
      }
      await call(client, "set_cookies", { profile_id: id, cookies: [SESSION_COOKIE(cookie)] });
      await call(client, "close_profile", { profile_id: id });
      pass(`one data dir: ${mode}`, expected.length ? `the page got "${sent}"` : "the cookie is set");
    };
    await stage(WINDOW_MODE, "from_window", []);
    await stage("headless", "from_headless", ["from_window"]);
    await stage(WINDOW_MODE, "from_window_again", ["from_window", "from_headless"]);
    await closeAndExit(serve, client);
    await assertNoLeftovers("data dir switching");
  } finally {
    if (serve.child.exitCode === null) serve.child.kill();
  }
}

/** CloakBrowser restores tabs: critic C6 asks whether that holds in --headless=new. */
async function restoreChecks(fixture: Fixture): Promise<void> {
  const serve = await startServe(["--headless"]);
  try {
    const client = await httpClient(serve.url, serve.token);
    const id = String((await call(client, "create_profile", { name: "restore", ...ENGINE_ARGS })).id);
    await launch(client, id);
    await call(client, "navigate", { profile_id: id, url: `${fixture.url}?tab=one` });
    await call(client, "new_tab", { profile_id: id, url: `${fixture.url}?tab=two` });
    const tabsOf = async (): Promise<string[]> => {
      const listed = await call(client, "list_tabs", { profile_id: id });
      return ((listed.tabs ?? listed.targetInfos ?? []) as Array<{ url?: string }>).map((t) => String(t.url));
    };
    pass("restore: open before closing", JSON.stringify(await tabsOf()));
    await call(client, "close_profile", { profile_id: id });

    await launch(client, id);
    const after = await tabsOf();
    if (IS_CAMOUFOX) {
      expect(after.length === 1, `Camoufox has no restore, yet: ${JSON.stringify(after)}`);
      pass("restore on Camoufox", `none by design: ${JSON.stringify(after)}`);
    } else {
      const has = (tab: string): boolean => after.some((url) => url.includes(`tab=${tab}`));
      expect(has("one") && has("two"), `restore in --headless=new lost tabs: ${JSON.stringify(after)}`);
      pass("restore in --headless=new", JSON.stringify(after));
    }
    await closeAndExit(serve, client);
    await assertNoLeftovers("restore");
  } finally {
    if (serve.child.exitCode === null) serve.child.kill();
  }
}

const EXTENSION_MANIFEST = {
  manifest_version: 3,
  name: "MZ e2e",
  version: "1.0",
  background: { service_worker: "worker.js" },
  content_scripts: [{ matches: ["<all_urls>"], js: ["content.js"], run_at: "document_start" }],
};

/** No tool installs one on a server, so this writes the profile's row while nothing runs. */
async function extensionChecks(fixture: Fixture): Promise<void> {
  const created = await (async (): Promise<string> => {
    const serve = await startServe();
    try {
      const client = await httpClient(serve.url, serve.token);
      const id = String((await call(client, "create_profile", { name: "extension" })).id);
      await closeAndExit(serve, client);
      return id;
    } finally {
      if (serve.child.exitCode === null) serve.child.kill();
    }
  })();
  const pm = new ProfileManager({
    dbPath: join(DATA_DIR, "profiles.db"),
    profilesRoot: join(DATA_DIR, "profiles"),
  });
  const dataDir = pm.get(created)!.dataDir;
  const relative = join("extensions", "mz-e2e");
  mkdirSync(join(dataDir, relative), { recursive: true });
  writeFileSync(join(dataDir, relative, "manifest.json"), JSON.stringify(EXTENSION_MANIFEST));
  writeFileSync(join(dataDir, relative, "worker.js"), "");
  writeFileSync(
    join(dataDir, relative, "content.js"),
    'document.documentElement.setAttribute("data-mz-ext", "loaded");',
  );
  pm.update(created, {
    extensions: [{ id: "mz-e2e", name: "MZ e2e", version: "1.0", scope: "profile", enabled: true, dir: relative, source: "folder" }],
  });
  pm.close();

  const serve = await startServe(["--headless"]);
  try {
    const client = await httpClient(serve.url, serve.token);
    const launched = await launch(client, created);
    expect(launched.displayMode === "headless", `launched ${String(launched.displayMode)}`);
    await call(client, "navigate", { profile_id: created, url: fixture.url });
    const read = await call(client, "evaluate_js", {
      profile_id: created,
      expression: 'document.documentElement.getAttribute("data-mz-ext")',
    });
    expect((read.result as { value?: unknown }).value === "loaded", `no content script: ${JSON.stringify(read)}`);
    const targets = (await call(client, "cdp_send", { profile_id: created, method: "Target.getTargets" })) as {
      result?: { targetInfos?: Array<{ type: string; url: string }> };
      targetInfos?: Array<{ type: string; url: string }>;
    };
    const infos = targets.result?.targetInfos ?? targets.targetInfos ?? [];
    const worker = infos.find((t) => t.type === "service_worker" && t.url.startsWith("chrome-extension://"));
    pass(
      "an unpacked extension in --headless=new",
      `content script ran; service worker: ${worker?.url ?? "not listed"}`,
    );
    await closeAndExit(serve, client);
    await assertNoLeftovers("extension");
  } finally {
    if (serve.child.exitCode === null) serve.child.kill();
  }
}

async function displayFlow(fixture: Fixture): Promise<void> {
  expect(!FORCED_HEADLESS, "this flow decides per server whether --headless is on: run it without");
  await headlessSurfaceChecks(fixture);
  if (!IS_WINDOWS) await xvfbSurfaceChecks(fixture);
  await refusalChecks();
  await dataDirSwitchChecks(fixture);
  await restoreChecks(fixture);
  if (!IS_CAMOUFOX) await extensionChecks(fixture);
}

// ── tokens, remote access, secrets ───────────────────────────────────────────

function cli(args: string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", windowsHide: true, timeout: 60_000 });
}

/** Another process, as an operator's would be. Returns the token it printed. */
function createToken(...flags: string[]): string {
  const res = cli(["token", "create", "--data-dir", DATA_DIR, ...flags]);
  expect(res.status === 0, `token create failed: ${res.stderr}`);
  const token = res.stdout.trim();
  expect(/^mz_t_[0-9a-f]+_[A-Za-z0-9_-]{43}$/.test(token), "token create printed something else");
  return token;
}

async function toolNamesOf(client: Client): Promise<string[]> {
  return (await client.listTools()).tools.map((t) => t.name);
}

async function stopServe(serve: Running): Promise<void> {
  sendConsoleCtrl(serve.child.pid!, "CTRL_BREAK");
  const code = await serve.exited;
  expect(code === 0, `exit code ${code}:\n${serve.output()}`);
}

interface RawAnswer {
  status: number;
  text: string;
}

function rawHttp(
  url: string,
  opts: { headers?: Record<string, string>; ca?: Buffer } = {},
): Promise<RawAnswer> {
  const target = new URL(url);
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((done, fail) => {
    const req = send(
      {
        host: target.hostname,
        port: target.port,
        path: target.pathname,
        headers: opts.headers ?? {},
        // Node would check the certificate against the Host header these tests forge. The
        // real client above has already checked it against the address.
        ...(opts.ca ? { ca: opts.ca, checkServerIdentity: () => undefined } : {}),
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (text += c));
        res.on("end", () => done({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on("error", fail);
    req.end();
  });
}

/** What the page says about the fixture's button, which only a click changes. */
async function buttonState(client: Client, id: string): Promise<unknown> {
  const read = await call(client, "evaluate_js", {
    profile_id: id,
    expression: "document.getElementById('out').textContent",
  });
  return (read.result as { value?: unknown }).value;
}

async function permissionChecks(fixture: Fixture): Promise<void> {
  const serve = await startServe();
  try {
    const owner = await httpClient(serve.url, serve.token);
    const id = String((await call(owner, "create_profile", { name: "auth-a", ...ENGINE_ARGS })).id);
    const other = String((await call(owner, "create_profile", { name: "auth-b", ...ENGINE_ARGS })).id);
    const launched = await launch(owner, id);
    await call(owner, "navigate", { profile_id: id, url: fixture.url });

    const ownerTools = await toolNamesOf(owner);
    if (!IS_CAMOUFOX) {
      expect(typeof launched.cdpEndpoint === "string", "the owner's launch lost its cdpEndpoint");
      expect(ownerTools.includes("cdp_send_no_safety"), "the owner can't see cdp_send_no_safety");
      const version = await call(owner, "cdp_send_no_safety", {
        profile_id: id,
        method: "Browser.getVersion",
      });
      expect(typeof version.product === "string", `cdp_send_no_safety: ${JSON.stringify(version)}`);
      pass("the owner token sees cdp_send_no_safety, and it works", String(version.product));
    }

    const reader = await httpClient(serve.url, createToken("--name", "r", "--tools", "read"));
    const readerTools = await toolNamesOf(reader);
    for (const hidden of ["click", "cdp_send_no_safety", "cdp_send", "create_profile", "resume_human"]) {
      expect(!readerTools.includes(hidden), `a read token can see ${hidden}`);
    }
    expect(readerTools.includes("extract"), "a read token can't see extract");
    const refused = await callError(reader, "click", { profile_id: id, selector: "#the-button" });
    expect(refused.code === "FORBIDDEN", `click with a read token: ${JSON.stringify(refused)}`);
    const refusedRaw = await callError(reader, "cdp_send_no_safety", {
      profile_id: id,
      method: "Browser.getVersion",
    });
    expect(refusedRaw.code === "FORBIDDEN", `raw with a read token: ${JSON.stringify(refusedRaw)}`);
    expect((await buttonState(owner, id)) === "not clicked yet", "the refused click reached the page");
    pass("a read token: no click or cdp_send_no_safety in tools/list, FORBIDDEN on calling them");
    await reader.close();

    const actor = await httpClient(serve.url, createToken("--name", "a"));
    const again = await launch(actor, id);
    expect(!("cdpEndpoint" in again) && !("pid" in again), `launch for act: ${JSON.stringify(again)}`);
    pass("launch_profile without raw hides cdpEndpoint and pid", Object.keys(again).join(","));
    await actor.close();

    const scoped = await httpClient(
      serve.url,
      createToken("--name", "s", "--profiles", id, "--tools", "read,act,profile-admin"),
    );
    const { profiles } = await call(scoped, "list_profiles");
    const visible = (profiles as Array<{ id: string }>).map((p) => p.id);
    expect(visible.length === 1 && visible[0] === id, `a scoped token sees ${visible.join(",")}`);
    const foreign = await callError(scoped, "extract", { profile_id: other });
    expect(foreign.code === "FORBIDDEN", `another profile: ${JSON.stringify(foreign)}`);
    const created = await callError(scoped, "create_profile", { name: "nope" });
    expect(created.code === "FORBIDDEN", `create_profile: ${JSON.stringify(created)}`);
    pass("a profile-scoped token sees and reaches only its profile, and can't create one");
    await scoped.close();

    await revokeChecks(serve.url, id, owner);
    await call(owner, "close_profile", { profile_id: id });
    await closeAndExit(serve, owner);
    await assertNoLeftovers("the permissions run");
  } finally {
    if (serve.child.exitCode === null) serve.child.kill();
  }
}

/** Everything a token holds ends when another process revokes it. */
async function revokeChecks(url: string, id: string, owner: Client): Promise<void> {
  const token = createToken("--name", "doomed");
  const doomed = await httpClient(url, token);
  await call(doomed, "list_tabs", { profile_id: id });

  const stream = await fetch(new URL("/sse", url), { headers: { authorization: `Bearer ${token}` } });
  expect(stream.status === 200, `/sse: ${stream.status}`);
  const reader = stream.body!.getReader();
  await reader.read();
  const closed = (async () => {
    for (;;) if ((await reader.read()).done) return Date.now();
  })().catch(() => Date.now());

  const holding = rawCall(owner, "evaluate_js", { profile_id: id, expression: busyPage(2_500) });
  await new Promise((done) => setTimeout(done, 300));
  const queued = doomed
    .callTool({ name: "click", arguments: { profile_id: id, selector: "#the-button" } }, undefined, {
      timeout: 120_000,
    })
    .catch(() => {});
  await new Promise((done) => setTimeout(done, 300));

  const res = cli(["token", "revoke", "doomed", "--data-dir", DATA_DIR]);
  expect(res.status === 0, `token revoke failed: ${res.stderr}`);
  const revokedAt = Date.now();
  let nextRequest = "";
  await doomed.listTools().catch((e: unknown) => {
    nextRequest = String(e);
  });
  expect(/unauthorized/.test(nextRequest), `after the revoke: ${nextRequest || "the call worked"}`);
  const closedAfter = (await closed) - revokedAt;
  expect(closedAfter < 2_000, `the stream stayed open ${closedAfter} ms`);
  pass("revoke from another process", `next request refused, stream closed after ${closedAfter} ms`);

  await holding;
  await new Promise((done) => setTimeout(done, 800));
  expect((await buttonState(owner, id)) === "not clicked yet", "the revoked token's queued click fired");
  pass("revoke drops the token's queued call");
  await doomed.close();
  await queued;

  const leaseToken = createToken("--name", "holder");
  const holder = await httpClient(url, leaseToken);
  await call(holder, "acquire_profile", { profile_id: id, ttl_ms: 600_000 });
  const leased = await callError(owner, "click", { profile_id: id, selector: "#the-button" });
  expect(leased.code === "PROFILE_LEASED", `with a lease out: ${JSON.stringify(leased)}`);
  expect(cli(["token", "revoke", "holder", "--data-dir", DATA_DIR]).status === 0, "token revoke failed");
  await holder.listTools().catch(() => {});
  await call(owner, "click", { profile_id: id, selector: "#the-button" });
  expect((await buttonState(owner, id)) === "button was clicked", "the click after the lease went nowhere");
  pass("revoke drops the token's leases");
  await holder.close();
}

function opensslBinary(): string {
  const candidates = [
    "openssl",
    "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe",
    "C:\\Program Files\\Git\\usr\\bin\\openssl.exe",
  ];
  for (const candidate of candidates) {
    if (spawnSync(candidate, ["version"], { windowsHide: true }).status === 0) return candidate;
  }
  throw new Error("FAILED: this check needs openssl to make its certificate");
}

function selfSignedCert(dir: string, address: string): { cert: string; key: string } {
  mkdirSync(dir, { recursive: true });
  const cert = join(dir, "cert.pem");
  const key = join(dir, "key.pem");
  const res = spawnSync(
    opensslBinary(),
    [
      "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
      "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=mz-e2e",
      "-addext", `subjectAltName=IP:${address}`,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  expect(res.status === 0, `openssl failed: ${res.stderr}`);
  return { cert, key };
}

/** A real SDK client, in a process of its own: only that can trust a CA from its environment. */
function sdkClientWithCa(url: string, token: string, ca: string): string {
  const script = `
    import { Client } from "@modelcontextprotocol/sdk/client/index.js";
    import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
    const client = new Client({ name: "e2e-tls", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(process.env.MZ_URL), {
      requestInit: { headers: { authorization: "Bearer " + process.env.MZ_TOKEN } },
    }));
    const { tools } = await client.listTools();
    process.stdout.write(String(tools.length));
    await client.close();
  `;
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: APP_ROOT,
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
    env: { ...process.env, NODE_EXTRA_CA_CERTS: ca, MZ_URL: url, MZ_TOKEN: token },
  });
  expect(res.status === 0, `the TLS client failed: ${res.stderr}`);
  return res.stdout;
}

function lanAddress(): string {
  const chosen = values["lan-address"];
  if (chosen) return chosen;
  for (const addresses of Object.values(networkInterfaces())) {
    const found = addresses?.find((a) => a.family === "IPv4" && !a.internal);
    if (found) return found.address;
  }
  throw new Error("FAILED: no non-loopback address to bind: pass --lan-address");
}

async function remoteBindChecks(): Promise<void> {
  const address = lanAddress();
  const port = await freePort();
  const bind = ["serve", "--data-dir", DATA_DIR, "--host", address, "--port", String(port), ...SERVER_FLAGS];

  const bare = cli(bind);
  expect(bare.status === 2 && /--allow-remote/.test(bare.stdout), `no flags: ${bare.status} ${bare.stdout}`);
  const insecure = cli([...bind, "--allow-remote"]);
  expect(
    insecure.status === 2 && /--allow-insecure-remote/.test(insecure.stdout),
    `no TLS: ${insecure.status} ${insecure.stdout}`,
  );
  pass("a LAN address is refused without the flags", address);

  const { cert, key } = selfSignedCert(join(DATA_DIR, "tls"), address);
  const serve = await startServe(["--host", address, "--allow-remote", "--tls-cert", cert, "--tls-key", key]);
  try {
    const servePort = new URL(serve.url).port;
    const origin = `https://${address}:${servePort}`;
    const url = `${origin}/mcp`;
    const ca = readFileSync(cert);
    const authed = { authorization: `Bearer ${serve.token}` };

    const tools = sdkClientWithCa(url, serve.token, cert);
    expect(Number(tools) > 0, `tools over TLS: ${tools}`);
    pass("--allow-remote with TLS: a real client over https on that address", `${tools} tools`);

    const gated = await rawHttp(url, { headers: authed, ca });
    expect(gated.status === 400, `the right Host: ${gated.status} ${gated.text}`);
    const wrongHost = await rawHttp(url, { headers: { ...authed, host: "evil.test" }, ca });
    expect(wrongHost.status === 403, `a wrong Host: ${wrongHost.status}`);
    const wrongOrigin = await rawHttp(url, { headers: { ...authed, origin: "https://evil.test" }, ca });
    expect(wrongOrigin.status === 403, `a wrong Origin: ${wrongOrigin.status}`);
    const rightOrigin = await rawHttp(url, { headers: { ...authed, origin }, ca });
    expect(rightOrigin.status === 400, `its own Origin: ${rightOrigin.status}`);
    const noToken = await rawHttp(url, { ca });
    expect(noToken.status === 401, `no token: ${noToken.status}`);
    const health = await rawHttp(`${origin}/healthz`, { ca });
    expect(health.status === 200 && health.text === '{"ok":true}', `/healthz: ${health.text}`);
    pass("a wrong Host and a wrong Origin are refused", "403, 403");

    let plainFailed = false;
    await rawHttp(`http://${address}:${servePort}/healthz`).catch(() => {
      plainFailed = true;
    });
    expect(plainFailed, "plain HTTP got an answer from the TLS port");
    let loopbackFailed = false;
    await rawHttp(`https://127.0.0.1:${servePort}/healthz`, { ca }).catch(() => {
      loopbackFailed = true;
    });
    expect(loopbackFailed, "it also listens on loopback");
    pass("bound there and only there, TLS only");
    await stopServe(serve);
  } finally {
    if (serve.child.exitCode === null) serve.child.kill();
  }
}

async function proxyShapeChecks(): Promise<void> {
  const serve = await startServe(["--allowed-hosts", "example.test"]);
  const authed = { authorization: `Bearer ${serve.token}` };
  // A reverse proxy in its plainest form: a port of its own, and another Host going upstream.
  const hop = createHttpServer((req, res) => {
    const upstream = httpRequest(
      {
        host: "127.0.0.1",
        port: new URL(serve.url).port,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host: "example.test" },
      },
      (reply) => {
        res.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(res);
      },
    );
    upstream.on("error", () => res.destroy());
    req.pipe(upstream);
  });
  await new Promise<void>((done) => hop.listen(0, "127.0.0.1", done));
  try {
    const raw = async (headers: Record<string, string>): Promise<number> =>
      (await rawHttp(serve.url, { headers: { ...authed, ...headers } })).status;
    expect((await raw({ host: "example.test" })) === 400, "Host example.test was refused");
    expect((await raw({ host: "example.test:8443" })) === 400, "a mapped port was refused");
    expect((await raw({ host: "other.test" })) === 403, "another name got through");
    expect((await raw({ origin: "https://example.test" })) === 400, "its Origin was refused");
    expect((await raw({ origin: "https://other.test" })) === 403, "another Origin got through");

    const hopUrl = `http://127.0.0.1:${(hop.address() as AddressInfo).port}/mcp`;
    const client = await httpClient(hopUrl, serve.token);
    const tools = await toolNamesOf(client);
    expect(tools.length > 0, "no tools through the hop");
    await client.close();
    pass("loopback behind a proxy needs only --allowed-hosts", `${tools.length} tools through the hop`);
    await stopServe(serve);
  } finally {
    hop.closeAllConnections();
    await new Promise((done) => hop.close(done));
    if (serve.child.exitCode === null) serve.child.kill();
  }
}

/** A SOCKS5 proxy with a password, whose every CONNECT lands on the given local port. */
async function startSocksProxy(
  user: string,
  password: string,
  targetPort: number,
): Promise<{ port: number; logins: string[]; connects: string[]; close(): Promise<void> }> {
  const logins: string[] = [];
  const connects: string[] = [];
  const sockets = new Set<Socket>();
  const server = createNetServer((client) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => {});
    client.once("data", () => {
      client.write(Buffer.from([5, 2]));
      client.once("data", (login: Buffer) => {
        const userEnd = 2 + login[1]!;
        const name = login.subarray(2, userEnd).toString();
        const pass = login.subarray(userEnd + 1, userEnd + 1 + login[userEnd]!).toString();
        logins.push(`${name}:${pass}`);
        const allowed = name === user && pass === password;
        client.write(Buffer.from([1, allowed ? 0 : 1]));
        if (!allowed) {
          client.end();
          return;
        }
        client.once("data", (request: Buffer) => {
          const nameLength = request[4]!;
          const isName = request[3] === 3;
          const portAt = isName ? 5 + nameLength : 8;
          const host = isName ? request.subarray(5, portAt).toString() : request.subarray(4, 8).join(".");
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
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    port: (server.address() as AddressInfo).port,
    logins,
    connects,
    close: () =>
      new Promise((done) => {
        server.close(() => done());
        for (const socket of sockets) socket.destroy();
      }),
  };
}

async function secretBoxChecks(fixture: Fixture): Promise<void> {
  const password = "s3cret-proxy-passw0rd-e2e";
  const dbPath = join(DATA_DIR, "profiles.db");
  const holdsPassword = (): string[] =>
    [dbPath, `${dbPath}-wal`].filter((f) => existsSync(f) && readFileSync(f).includes(password));

  const proxy = await startSocksProxy("mz-user", password, Number(new URL(fixture.url).port));
  try {
    let serve = await startServe();
    let client = await httpClient(serve.url, serve.token);
    const id = String(
      (
        await call(client, "create_profile", {
          name: "proxied",
          ...ENGINE_ARGS,
          proxy: { type: "socks5", host: "127.0.0.1", port: proxy.port, username: "mz-user", password },
        })
      ).id,
    );
    expect(holdsPassword().length === 0, `plaintext in ${holdsPassword().join(", ")}`);
    const onDisk = [dbPath, `${dbPath}-wal`].some(
      (f) => existsSync(f) && readFileSync(f).includes("mzenc:v1:"),
    );
    expect(onDisk, "no sealed value in the database or its WAL");
    expect(!serve.output().includes(password), "the password reached the logs");
    pass("a proxy password from create_profile is encrypted in the DB and the WAL");

    const browse = async (): Promise<void> => {
      await launch(client, id);
      await call(client, "navigate", { profile_id: id, url: "http://mz-proxy-e2e.invalid/page" });
      const title = await call(client, "evaluate_js", { profile_id: id, expression: "document.title" });
      expect((title.result as { value?: unknown }).value === "MZ Fixture", "the page came through wrong");
      await call(client, "close_profile", { profile_id: id });
    };
    await browse();
    expect(proxy.connects.includes("mz-proxy-e2e.invalid:80"), `connects: ${proxy.connects.join(",")}`);
    expect(new Set(proxy.logins).size === 1, "the proxy saw another login");
    expect(proxy.logins[0] === `mz-user:${password}`, "the proxy saw a garbled password");
    pass("the profile launches through a SOCKS proxy with the decrypted password", `${proxy.logins.length} logins`);

    await closeAndExit(serve, client);
    expect(holdsPassword().length === 0, `plaintext after shutdown in ${holdsPassword().join(", ")}`);

    proxy.connects.length = 0;
    serve = await startServe();
    client = await httpClient(serve.url, serve.token);
    await browse();
    expect(proxy.connects.includes("mz-proxy-e2e.invalid:80"), "no proxy use after a restart");
    pass("and again after a restart, from what is on disk");
    await closeAndExit(serve, client);
    await assertNoLeftovers("the secret box run");
  } finally {
    await proxy.close();
  }
}

async function authFlow(fixture: Fixture): Promise<void> {
  await permissionChecks(fixture);
  await remoteBindChecks();
  await proxyShapeChecks();
  await secretBoxChecks(fixture);
}

async function main(): Promise<void> {
  prepareDataDir();
  const fixture = await startFixture();
  try {
    if (FLOWS.includes("http")) {
      const profileId = await httpFlow(fixture);
      if (FLOWS.includes("sigint")) await sigintFlow(profileId);
    }
    if (FLOWS.includes("stdio")) await stdioFlow(fixture);
    if (FLOWS.includes("tabs")) await tabsFlow();
    if (FLOWS.includes("concurrency")) await concurrencyFlow();
    if (FLOWS.includes("display")) await displayFlow(fixture);
    if (FLOWS.includes("auth")) await authFlow(fixture);
  } finally {
    await fixture.close();
    if (!values.keep) {
      // After a failure a browser can still hold the directory: that must not hide the failure.
      try {
        cleanDataDir();
      } catch (e) {
        process.stdout.write(`could not remove ${DATA_DIR}: ${String(e)}
`);
      }
    }
  }
  process.stdout.write(`\n${results.length} checks passed\n`);
}

main().catch((e: unknown) => {
  process.stdout.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
