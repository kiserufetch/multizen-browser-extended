/**
 * Live end-to-end check of the built server against a real browser engine, with
 * real MCP SDK clients. Not part of test:unit: it opens real browser windows. Run it
 * from PowerShell or cmd: Ctrl+C can't be delivered to anything started from Git Bash.
 *
 *   corepack yarn workspace @multizen/server build
 *   corepack yarn workspace @multizen/server exec tsx scripts/e2e.ts \
 *     --data-dir %TEMP%\mzts2 --engine-version-dir <dir with chrome.exe> [--keep]
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
 * EOF exits 0 and leaves no process behind.
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
    const created = await call(client, "create_profile", { name: "e2e" });
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

  const created = await call(client, "create_profile", { name: "e2e-stdio" });
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

async function main(): Promise<void> {
  prepareDataDir();
  const fixture = await startFixture();
  try {
    const profileId = await httpFlow(fixture);
    await sigintFlow(profileId);
    await stdioFlow(fixture);
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
