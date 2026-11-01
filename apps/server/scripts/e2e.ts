/**
 * Live end-to-end check of the built server against a real browser engine, with
 * real MCP SDK clients. Not part of test:unit: it opens real browser windows. Run it
 * from PowerShell or cmd: Ctrl+C can't be delivered to anything started from Git Bash.
 *
 *   corepack yarn workspace @multizen/server build
 *   corepack yarn workspace @multizen/server exec tsx scripts/e2e.ts \
 *     --data-dir %TEMP%\mzts2 --engine-version-dir <dir with chrome.exe> \
 *     [--engine cloakbrowser] [--flows http,sigint,stdio,tabs] [--keep]
 *
 * --engine-version-dir links an installed engine into the temp data dir through a
 * junction on the version directory only, so nothing the server does to its own
 * engine cache can reach the original. Without it the engine is downloaded.
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
 *
 * Windows only: the signal delivery, the junction and the process scan all are.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const { values } = parseArgs({
  options: {
    "data-dir": { type: "string" },
    "engine-version-dir": { type: "string" },
    engine: { type: "string" },
    flows: { type: "string" },
    keep: { type: "boolean" },
  },
});
if (process.platform !== "win32") throw new Error("This check only runs on Windows");
const dataDirFlag = values["data-dir"];
if (!dataDirFlag) throw new Error("--data-dir is required");
const DATA_DIR = resolve(dataDirFlag);
const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(APP_ROOT, "dist", "cli.js");
if (!existsSync(CLI)) throw new Error(`${CLI} is missing: build the server first`);

const FLOWS = (values.flows ?? "http,sigint,stdio,tabs").split(",");
const ENGINE_ARGS = values.engine ? { engine: values.engine } : {};
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

function prepareDataDir(): void {
  mkdirSync(DATA_DIR, { recursive: true });
  const versionDir = values["engine-version-dir"];
  if (!versionDir) return;
  const version = basename(versionDir);
  const cache = join(DATA_DIR, "chromium", "cloakbrowser");
  const link = join(cache, version);
  mkdirSync(cache, { recursive: true });
  if (!existsSync(link)) {
    const res = spawnSync("cmd", ["/c", "mklink", "/J", link, versionDir], { encoding: "utf8" });
    expect(res.status === 0, `mklink failed: ${res.stdout}${res.stderr}`);
  }
  writeFileSync(
    join(cache, "current.json"),
    JSON.stringify({ version, binaryRelative: "chrome.exe" }),
  );
}

/** Removes the junction itself first, so the deletion can't follow it. */
function cleanDataDir(): void {
  const versionDir = values["engine-version-dir"];
  if (versionDir) {
    const link = join(DATA_DIR, "chromium", "cloakbrowser", basename(versionDir));
    if (existsSync(link)) {
      const res = spawnSync("cmd", ["/c", "rmdir", link], { encoding: "utf8" });
      expect(res.status === 0, `rmdir of the junction failed: ${res.stderr}`);
    }
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
  close(): Promise<void>;
}

async function startFixture(): Promise<Fixture> {
  const cookieHeaders: string[] = [];
  const server = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/page") {
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

async function startServe(): Promise<Running & { url: string; token: string }> {
  const port = await freePort();
  const running = startServer(["serve", "--data-dir", DATA_DIR, "--port", String(port)]);
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

function findRef(nodes: AxNode[], role: string, name: string): string | null {
  for (const node of nodes) {
    if (node.role === role && node.name === name && node.ref) return node.ref;
    const inChild = findRef(node.children ?? [], role, name);
    if (inChild) return inChild;
  }
  return null;
}

/** Windows delivers no signals: a console control event is the graceful equivalent. */
function sendConsoleCtrl(pid: number, event: "CTRL_C" | "CTRL_BREAK"): void {
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
    expect(Number(launched.pid) > 0, "launch_profile returned no pid");
    pass("launch_profile", `pid ${launched.pid}, ${launched.cdpEndpoint}`);

    const navigated = await call(client, "navigate", { profile_id: id, url: fixture.url });
    expect(navigated.url === fixture.url, `navigate went to ${String(navigated.url)}`);
    pass("navigate to the local fixture", String(navigated.url));

    const extracted = await call(client, "extract", { profile_id: id });
    const before = extracted.result as { title: string; accessibilityTree: AxNode[] };
    expect(before.title === "MZ Fixture", `extract saw the title "${before.title}"`);
    const ref = findRef(before.accessibilityTree, "button", "Press me");
    expect(ref, "extract gave no ref for the button");
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
    expect(/"reason":"SIGBREAK"/.test(serve.output()), "the shutdown was not started by SIGBREAK");
    expect(!existsSync(join(DATA_DIR, "server.lock")), "the lock outlived the shutdown");
    pass("Ctrl+Break with a browser running", `exit ${code}, lock released`);
    await assertNoLeftovers("Ctrl+Break");
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
    const killed = spawnSync("taskkill", ["/PID", String(launched.pid), "/T", "/F"], {
      encoding: "utf8",
      windowsHide: true,
    });
    expect(killed.status === 0, `taskkill failed: ${killed.stderr}`);
    await waitFor(() => /"reason":"external-exit"/.test(serve.output()), "the browser's exit to register");
    const after = (await call(client, "list_profiles")).profiles as Array<{ isRunning: boolean }>;
    expect(after[0]?.isRunning === false, "the killed browser still reads as running");
    expect(serve.child.exitCode === null, "the server died with its browser");
    expect(!/uncaught exception|unhandled rejection/.test(serve.output()), "a killed browser was fatal");
    pass("a browser killed from outside", "the server stays up, the profile reads as closed");

    await launch(client, profileId);
    pass("relaunch after the kill");
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
    args: [CLI, "stdio", "--data-dir", DATA_DIR],
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
  expect(/post-bootstrap probe/.test(stderrText), "MULTIZEN_DEBUG produced no driver log line");
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

function refOf(tree: AxNode[], name: string): string {
  const ref = findByName(tree, name)?.ref;
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

    const extract = async (): Promise<AxNode[]> =>
      ((await call(client, "extract", profile)).result as { accessibilityTree: AxNode[] })
        .accessibilityTree;
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
    const extractUntil = async (name: string): Promise<AxNode[]> => {
      const deadline = Date.now() + 15_000;
      for (;;) {
        const tree = await extract();
        if (findByName(tree, name)) return tree;
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
    expect(
      iframes.some((t) => t.url.startsWith(site.child)) && iframes.some((t) => t.url.startsWith(site.nested)),
      `no OOPIF targets: ${JSON.stringify(targets.targetInfos)}`,
    );
    expect(!iframes.some((t) => t.url.endsWith("/same")), "the same-origin frame should not be a target");
    pass("type:iframe targets exist", iframes.map((t) => t.url).join(", "));
    const firstTab = targets.activeTargetId;
    expect(
      targets.targetInfos.some((t) => t.targetId === firstTab && t.type === "page"),
      "activeTargetId is not a page",
    );
    pass("list_tabs reports activeTargetId", firstTab);

    const frames = ["Main", "Same", "Child", "Nested"];
    const refs = Object.fromEntries(frames.map((f) => [f, refOf(tree, `${f} button`)]));
    pass("extract gives refs in all four frames", JSON.stringify(refs));
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
    const oopifChooser = await code("upload_file", {
      ref: refOf(tree, "Child chooser"),
      files: [{ file_name: "x.txt", data_base64: hello }],
    });
    expect(oopifChooser === "INVALID_INPUT", `a chooser in an OOPIF: ${oopifChooser}`);
    pass("upload_file through a chooser in an OOPIF is refused, nothing clicked", oopifChooser);
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
    expect(findByName(mainTree, "Main button"), "extract did not follow activate_tab");
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

    const sameDocumentAt = Date.now();
    await act("navigate", { url: `${site.child}/other#there` });
    expect(Date.now() - sameDocumentAt < 3_000, "a same-document navigate waited for a load event");
    pass("a same-document navigate returns at once", `${Date.now() - sameDocumentAt} ms`);

    // ── after the browser ──
    await act("set_dialog_policy", { mode: "manual" });
    await call(client, "cdp_send", {
      ...profile,
      method: "Runtime.evaluate",
      params: { expression: "setTimeout(() => alert('left open'), 10); 1" },
    });
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
  } finally {
    if (serve.child.exitCode === null) serve.child.kill();
    await site.close();
  }
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
  } finally {
    await fixture.close();
    if (!values.keep) cleanDataDir();
  }
  process.stdout.write(`\n${results.length} checks passed\n`);
}

main().catch((e: unknown) => {
  process.stdout.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
