// The live bullets of AC6, AC7 and AC8 that e2e.ts doesn't run: real drivers, real engines, real clients, with
// --headless. On Windows, and on Linux where the sandbox runs, such as a container with docker/seccomp-chromium.json.
//
//   corepack yarn workspace @multizen/server build
//   corepack yarn workspace @multizen/server exec tsx scripts/acceptance/ac67-extra.mjs \
//     --engine cloakbrowser|camoufox --data-dir <short dir> \
//     [--engine-version-dir <dir with the pinned chrome>] [--camoufox-install <pinned install>] [--refs-only]
//
// Without the two links the engines download into the data dir, which is removed at the end. Exit 0 and ALL PASS
// mean every check held.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CLI, fetchRetryingConnect, freePort, IS_WINDOWS, seedEngines, sleep, unseedEngines } from "./flow.mjs";

const { values } = parseArgs({
  options: {
    engine: { type: "string", default: "cloakbrowser" },
    "data-dir": { type: "string" },
    "engine-version-dir": { type: "string" },
    "camoufox-install": { type: "string" },
    "refs-only": { type: "boolean" },
  },
});
const ENGINE = values.engine;
if (!values["data-dir"]) throw new Error("--data-dir is required");
const DATA = resolve(values["data-dir"]);
const fails = [];
function check(name, ok, detail = "") {
  if (!ok) fails.push(name);
  console.log(ok ? "PASS" : "FAIL", `[${ENGINE}]`, name, typeof detail === "string" ? detail : JSON.stringify(detail));
}
mkdirSync(DATA, { recursive: true });
const seed = { engineVersionDir: values["engine-version-dir"], camoufoxInstall: values["camoufox-install"] };
seedEngines(DATA, seed);

// The page: counts each click it gets, so a click that fired after its call gave up shows.
const clicks = [];
const fixture = createHttpServer((req, res) => {
  if (req.url === "/clicked") {
    clicks.push(Date.now());
    res.writeHead(204).end();
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><title>extra</title><button id="b" onclick="fetch('/clicked')">Press me</button>`);
});
await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${fixture.address().port}`;

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [CLI, "serve", "--data-dir", DATA, "--port", String(port), "--headless", "--default-engine", ENGINE, "--egress-allow", "127.0.0.1"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
let output = "";
child.stdout.on("data", (d) => (output += d));
child.stderr.on("data", (d) => (output += d));
const exited = new Promise((r) => child.once("close", (c) => r(c)));
for (let i = 0; i < 300 && !output.includes('"listening"'); i++) await sleep(100);
if (!output.includes('"listening"')) throw new Error(output.slice(-1500));
const owner = readFileSync(join(DATA, "owner-token"), "utf8").trim();

const connect = async (token, name) => {
  const c = new Client({ name, version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } }, fetch: fetchRetryingConnect }));
  return c;
};
async function raw(c, tool, args = {}) {
  const res = await c.callTool({ name: tool, arguments: args }, undefined, { timeout: 120_000 });
  let parsed = res.content?.[0]?.text ?? "";
  try { parsed = JSON.parse(parsed); } catch {}
  return { isError: res.isError === true, parsed };
}
async function call(c, tool, args = {}) {
  const r = await raw(c, tool, args);
  if (r.isError) throw new Error(`${tool}: ${JSON.stringify(r.parsed).slice(0, 400)}`);
  return r.parsed;
}
async function launch(c, args) {
  for (let i = 0; i < 400; i++) {
    const r = await raw(c, "launch_profile", args);
    if (!r.isError) return r.parsed;
    if (r.parsed?.error?.code !== "ENGINE_NOT_READY") throw new Error(JSON.stringify(r.parsed));
    await sleep(3000);
  }
  throw new Error("engine never ready");
}

/** Browser roots whose command line names this directory. */
function browserRoots(needle) {
  if (IS_WINDOWS) {
    const script = `Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('chrome.exe','camoufox.exe') -and $_.CommandLine -and $_.CommandLine.Contains('${needle}') -and $_.CommandLine -notmatch '--type=|-contentproc' } | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }`;
    const rows = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true }).stdout.split(/\r?\n/).filter(Boolean).map((l) => l.split(" ").map(Number));
    // Firefox on Windows starts through a launcher process, which waits under -wait-for-browser: one browser, two processes.
    const pids = new Set(rows.map(([pid]) => pid));
    return rows.filter(([, parent]) => !pids.has(parent)).map(([pid]) => pid);
  }
  const found = [];
  for (const p of readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
    let cmd = "";
    try { cmd = readFileSync(`/proc/${p}/cmdline`, "utf8").split("\0").join(" "); } catch { continue; }
    if (cmd.includes(needle) && /(\/chrome |camoufox-bin )/.test(cmd) && !/--type=|-contentproc/.test(cmd)) found.push(Number(p));
  }
  return found;
}

try {
  const a = await connect(owner, "a");
  const b = await connect(owner, "b");

  // ── AC8: one ref, two sessions ──────────────────────────────────────────
  const refOf = (result, name) => {
    if (result.ariaSnapshot) return /\[ref=([^\]]+)\]/.exec(result.ariaSnapshot.split("\n").find((l) => l.includes(`"${name}"`)) ?? "")?.[1];
    const walk = (nodes) => {
      for (const node of nodes) {
        if (node.name === name) return node.ref;
        const inner = walk(node.children ?? []);
        if (inner) return inner;
      }
      return undefined;
    };
    return walk(result.accessibilityTree ?? []);
  };
  const shared = (await call(a, "create_profile", { name: "refs", engine: ENGINE })).id;
  await launch(a, { profile_id: shared });
  await call(a, "navigate", { profile_id: shared, url: `${origin}/` });
  const refA = refOf((await call(a, "extract", { profile_id: shared })).result, "Press me");
  const refB = refOf((await call(b, "extract", { profile_id: shared })).result, "Press me");
  check("AC8: two sessions extracting one page: the same element keeps its ref", !!refA && refA === refB, `${refA}, ${refB}`);
  clicks.length = 0;
  await call(a, "click_ref", { profile_id: shared, ref: refA });
  await sleep(400);
  await call(b, "click_ref", { profile_id: shared, ref: refB });
  await sleep(400);
  check("AC8: each session's click_ref ran the page's handler", clicks.length === 2, `${clicks.length} clicks at the page`);
  await call(b, "navigate", { profile_id: shared, url: `${origin}/?again` });
  const before = clicks.length;
  const old = await raw(a, "click_ref", { profile_id: shared, ref: refA });
  await sleep(400);
  check("AC8: session B navigates: session A's old ref is STALE_REF, and clicks nothing", old.isError && old.parsed?.error?.code === "STALE_REF" && clicks.length === before, `${old.parsed?.error?.code}, ${clicks.length - before} new clicks`);
  await call(a, "close_profile", { profile_id: shared });
  clicks.length = 0;
  if (values["refs-only"]) throw new Error("refs-only: stopping here");

  // ── two launches at once ────────────────────────────────────────────────
  const twin = (await call(a, "create_profile", { name: "twin", engine: ENGINE })).id;
  await launch(a, { profile_id: twin }); // A first launch alone, in case the engine still has to install.
  await call(a, "close_profile", { profile_id: twin });
  const [one, two] = await Promise.all([call(a, "launch_profile", { profile_id: twin }), call(b, "launch_profile", { profile_id: twin })]);
  await sleep(500);
  const roots = browserRoots(twin);
  check("AC6: two sessions launching one profile at once get one browser", roots.length === 1 && one.pid === two.pid && one.startedAt === two.startedAt, { roots, pids: [one.pid, two.pid] });
  await call(a, "close_profile", { profile_id: twin });

  // ── close during launch ─────────────────────────────────────────────────
  const race = (await call(a, "create_profile", { name: "race", engine: ENGINE })).id;
  const launching = raw(a, "launch_profile", { profile_id: race });
  await sleep(150);
  const closing = await raw(b, "close_profile", { profile_id: race });
  const launched = await launching;
  await sleep(ENGINE === "camoufox" ? 4000 : 2000);
  const after = (await call(a, "list_profiles")).profiles.find((p) => p.id === race);
  check("AC6: close during launch leaves nothing running", after.isRunning === false && browserRoots(race).length === 0, { launch: launched.isError ? launched.parsed?.error?.code : "ok", close: closing.isError ? closing.parsed?.error?.code : "ok", running: after.isRunning, roots: browserRoots(race) });
  const again = await launch(a, { profile_id: race });
  check("AC6: and it launches fine after that", Number(again.pid) > 0, `pid ${again.pid}`);
  await call(a, "close_profile", { profile_id: race });

  // ── queue timeout on a real page, and the depth ─────────────────────────
  const page = (await call(a, "create_profile", { name: "queue", engine: ENGINE })).id;
  await launch(a, { profile_id: page });
  await call(a, "navigate", { profile_id: page, url: `${origin}/` });
  const holding = raw(a, "evaluate_js", { profile_id: page, expression: `(() => { const end = Date.now() + 33000; while (Date.now() < end); return 1; })()` });
  await sleep(300);
  // A raw CDP call gives up at 30 s by itself, so a second holder keeps the line busy past the click's wait.
  const holdingNext = raw(a, "evaluate_js", { profile_id: page, expression: `(() => { const end = Date.now() + 5000; while (Date.now() < end); return 1; })()` });
  await sleep(300);
  const queuedAt = Date.now();
  const queued = raw(b, "click", { profile_id: page, selector: "#b" });
  await sleep(200);
  const burst = await Promise.all(Array.from({ length: 18 }, () => raw(b, "click", { profile_id: page, selector: "#b" }).then((r) => ({ r, at: Date.now() }))).slice(0, 18).map((p) => Promise.race([p, sleep(1500).then(() => null)])));
  const refusedAtOnce = burst.filter((x) => x && x.r.isError && x.r.parsed?.error?.code === "TIMEOUT");
  check("AC6: past queue depth 16 a call is refused at once, retryable", refusedAtOnce.length >= 1 && refusedAtOnce.every((x) => x.r.parsed.error.retryable === true), `${refusedAtOnce.length} of 18 refused within 1.5 s: ${refusedAtOnce[0]?.r.parsed?.error?.message ?? ""}`);
  const q = await queued;
  const waited = Date.now() - queuedAt;
  check("AC6: a queued call times out at 30 s, retryable", q.isError && q.parsed?.error?.code === "TIMEOUT" && q.parsed.error.retryable === true && waited > 28_000 && waited < 33_000, `${q.parsed?.error?.code} after ${waited} ms`);
  await holding;
  await holdingNext;
  await sleep(4000);
  check("AC6: and none of the clicks that gave up fired later", clicks.length === 0, `${clicks.length} clicks at the page`);
  await call(a, "close_profile", { profile_id: page });

  // ── a session belongs to its token ──────────────────────────────────────
  const makeToken = (name) => spawnSync(process.execPath, [CLI, "token", "create", "--name", name, "--data-dir", DATA], { encoding: "utf8", windowsHide: true }).stdout.trim();
  const tokenA = makeToken("sse-a");
  const tokenB = makeToken("sse-b");
  const stream = await fetchRetryingConnect(`${base}/sse`, { headers: { authorization: `Bearer ${tokenA}` } });
  const reader = stream.body.getReader();
  const firstChunk = new TextDecoder().decode((await reader.read()).value);
  const endpoint = /data: (\S+)/.exec(firstChunk)?.[1];
  const rpc = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const asB = await fetchRetryingConnect(`${base}${endpoint}`, { method: "POST", headers: { authorization: `Bearer ${tokenB}`, "content-type": "application/json" }, body: rpc });
  const asA = await fetchRetryingConnect(`${base}${endpoint}`, { method: "POST", headers: { authorization: `Bearer ${tokenA}`, "content-type": "application/json" }, body: rpc });
  check("AC7: /messages with a foreign token: 403, with its own: accepted", asB.status === 403 && asA.status === 202, `foreign ${asB.status}, own ${asA.status}, ${endpoint.slice(0, 24)}...`);
  await reader.cancel();

  const init = await fetchRetryingConnect(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${tokenA}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "raw", version: "1" } } }) });
  const session = init.headers.get("mcp-session-id");
  await init.body.cancel();
  const foreign = await fetchRetryingConnect(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${tokenB}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": session }, body: rpc });
  const foreignGet = await fetchRetryingConnect(`${base}/mcp`, { headers: { authorization: `Bearer ${tokenB}`, accept: "text/event-stream", "mcp-session-id": session } });
  const foreignDelete = await fetchRetryingConnect(`${base}/mcp`, { method: "DELETE", headers: { authorization: `Bearer ${tokenB}`, "mcp-session-id": session } });
  check("AC7: /mcp POST, GET, DELETE of a session with a foreign token: 403", foreign.status === 403 && foreignGet.status === 403 && foreignDelete.status === 403, [foreign.status, foreignGet.status, foreignDelete.status]);

  const badHost = await new Promise((done) => {
    import("node:http").then(({ request }) => {
      const r = request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { host: "evil.example", authorization: `Bearer ${owner}`, "content-type": "application/json" } }, (res) => { res.resume(); done(res.statusCode); });
      r.on("error", () => done(0));
      r.end("{}");
    });
  });
  const badOrigin = await fetchRetryingConnect(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${owner}`, origin: "http://evil.example", "content-type": "application/json" }, body: "{}" });
  check("AC7: a foreign Host and a foreign Origin: 403, even with a good token", badHost === 403 && badOrigin.status === 403, [badHost, badOrigin.status]);

  // Failed logins from one address.
  let limited = null;
  for (let i = 0; i < 13; i++) {
    const res = await fetchRetryingConnect(`${base}/healthz/../mcp`, { method: "POST", headers: { authorization: "Bearer nope", "content-type": "application/json" }, body: "{}" });
    if (res.status === 429) { limited = { after: i + 1, retryAfter: res.headers.get("retry-after") }; break; }
  }
  check("AC7: failed logins hit the limit with Retry-After", limited !== null && limited.after <= 11 && !!limited.retryAfter, limited);

  await a.close();
  await b.close();
} catch (e) {
  if (!String(e).includes("refs-only")) {
    fails.push(String(e));
    console.log("ERROR", e.stack ?? e);
    console.log(output.slice(-1500));
  }
} finally {
  child.kill();
  await exited;
  fixture.close();
  await sleep(800);
  unseedEngines(DATA, seed);
  rmSync(DATA, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
console.log(fails.length ? `FAILED: ${fails.join("; ")}` : "ALL PASS");
process.exit(fails.length ? 1 : 0);
