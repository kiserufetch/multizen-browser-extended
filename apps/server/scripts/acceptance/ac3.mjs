// AC3: Windows, the built server, a real SDK client, an engine cache that starts empty. It downloads CloakBrowser,
// about 560 MB, and its headed part opens real windows for about 15 s. Windows only: it looks for what is left with
// PowerShell, and AC4 is its counterpart in Docker.
//
//   corepack yarn workspace @multizen/server build
//   corepack yarn workspace @multizen/server exec tsx scripts/acceptance/ac3.mjs [--camoufox-install <dir>]
//
// --camoufox-install links an install of the pinned Camoufox, which otherwise downloads too. Its data dir is
// %TEMP%\mzt14c, which must not exist yet and is removed at the end. Exit 0 and ALL PASS mean every check held.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { check, CLI, connect, fails, freePort, fullFlow, HERE, launchWaiting, log, navigate, seedEngines, sleep, unseedEngines } from "./flow.mjs";

const { values } = parseArgs({ options: { "camoufox-install": { type: "string" } } });
const seed = { camoufoxInstall: values["camoufox-install"] };
const DATA = join(tmpdir(), "mzt14c");
if (existsSync(DATA)) throw new Error(`${DATA} exists`);

const fixturePort = await freePort();
const fixture = spawn(process.execPath, [join(HERE, "ac-fixture.cjs")], { env: { ...process.env, FIXTURE_PORT: String(fixturePort) }, stdio: "ignore", windowsHide: true });
const origin = `http://127.0.0.1:${fixturePort}`;
await sleep(300);

let running = null;
async function serve(flags) {
  const port = await freePort();
  const child = spawn(process.execPath, [CLI, "serve", "--data-dir", DATA, "--port", String(port), "--egress-allow", "127.0.0.1", ...flags], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const exited = new Promise((r) => child.once("close", (code) => r(code)));
  running = { child, exited };
  for (let i = 0; i < 300 && !output.includes('"listening"'); i++) await sleep(100);
  if (!output.includes('"listening"')) throw new Error(`no listening: ${output.slice(-1000)}`);
  const token = readFileSync(join(DATA, "owner-token"), "utf8").trim();
  const c = await connect(`http://127.0.0.1:${port}/mcp`, token, "ac3");
  return { child, c, port, token, exited, output: () => output };
}

async function stop(s) {
  await s.c.close().catch(() => {});
  s.child.kill();
  await s.exited;
  running = null;
  await sleep(800);
}

function leftovers() {
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('mzt14c') -and $_.Name -ne 'powershell.exe' } | ForEach-Object { "$($_.ProcessId) $($_.Name)" }`;
  return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true }).stdout.trim();
}

try {
  log("data dir", DATA, "exists:", existsSync(DATA), "(empty, so the engine is cold)");

  // ── --headless, with nothing cached ──────────────────────────────────────
  let s = await serve(["--headless"]);
  check("first start: owner token written and not logged", !s.output().includes(s.token) && s.output().includes("owner token created"));
  const statusBefore = await fetch(`http://127.0.0.1:${s.port}/readyz`, { headers: { authorization: `Bearer ${s.token}` } }).then((r) => r.json());
  log("/readyz right after start", JSON.stringify(statusBefore));
  await fullFlow(s.c, { what: "cold cloakbrowser --headless", engine: "cloakbrowser", origin });
  const progress = s.output().split("\n").filter((l) => l.includes('"engine status"'));
  check("the engine downloaded on first start, with progress in the log", progress.some((l) => /"downloading"/.test(l)) && progress.some((l) => /"ready"/.test(l)), `${progress.length} status lines; last: ${progress.at(-1)?.slice(0, 160)}`);
  const statusAfter = await fetch(`http://127.0.0.1:${s.port}/readyz`, { headers: { authorization: `Bearer ${s.token}` } }).then((r) => r.json());
  check("/readyz says ready", statusAfter.ready === true, JSON.stringify(statusAfter));
  check("only the token's holder sees /readyz, anyone /healthz", (await fetch(`http://127.0.0.1:${s.port}/readyz`)).status === 401 && (await fetch(`http://127.0.0.1:${s.port}/healthz`)).status === 200);
  await stop(s);
  check("nothing left after --headless", leftovers() === "", leftovers());

  seedEngines(DATA, seed);

  s = await serve(["--headless"]);
  await fullFlow(s.c, { what: "camoufox --headless", engine: "camoufox", origin });
  await stop(s);

  // ── headed, on the same data dir ─────────────────────────────────────────
  s = await serve([]);
  await fullFlow(s.c, { what: "cloakbrowser headed", engine: "cloakbrowser", mode: "headed", origin });
  await fullFlow(s.c, { what: "camoufox headed", engine: "camoufox", mode: "headed", origin });

  // One profile, one data dir: headed, then a server that allows no windows.
  const id = (await s.c.call("create_profile", { name: "ac switch", engine: "cloakbrowser", display_mode: "headed" })).id;
  const headed = await launchWaiting(s.c, { profile_id: id });
  check("switch: saved as headed runs headed", headed.launched.displayMode === "headed");
  await navigate(s.c, { profile_id: id, url: `${origin}/page` });
  await s.c.call("set_cookies", { profile_id: id, cookies: [{ name: "mz_switch", value: "kept", domain: "127.0.0.1", path: "/", expires: Math.floor(Date.now() / 1000) + 86_400 }] });
  await s.c.call("close_profile", { profile_id: id });
  await stop(s);
  check("nothing left after headed", leftovers() === "", leftovers());

  s = await serve(["--headless"]);
  const headless = await launchWaiting(s.c, { profile_id: id });
  const listed = (await s.c.call("list_profiles")).profiles.find((p) => p.id === id);
  check("switch: --headless on that data dir runs it headless, and keeps its saved mode", headless.launched.displayMode === "headless" && listed.displayMode === "headed" && listed.runningDisplayMode === "headless", JSON.stringify({ displayMode: listed.displayMode, running: listed.runningDisplayMode }));
  await navigate(s.c, { profile_id: id, url: `${origin}/echo` });
  const echo = (await s.c.call("extract", { profile_id: id })).result;
  check("switch: the cookie from the headed run", echo.title.includes("mz_switch=kept"), echo.title);
  const refused = await s.c.raw("launch_profile", { profile_id: id, display_mode: "headed" });
  check("switch: naming headed under --headless", refused.parsed?.error?.code === "INVALID_INPUT", refused.parsed?.error?.message);
  const noXvfb = await s.c.raw("launch_profile", { profile_id: id, display_mode: "xvfb" });
  log("xvfb under --headless:", noXvfb.parsed?.error?.code);
  await s.c.call("close_profile", { profile_id: id });
  await stop(s);
  check("nothing left at the end", leftovers() === "", leftovers());

  // ── the engine downloaded here is a real one, on this data dir ──────────
  const cache = JSON.parse(readFileSync(join(DATA, "chromium", "cloakbrowser", "current.json"), "utf8"));
  log("engine now in the temp cache:", JSON.stringify(cache));
} catch (e) {
  fails.push(String(e));
  log("ERROR", e.stack ?? e);
} finally {
  fixture.kill();
  if (running) {
    running.child.kill();
    await running.exited;
    await sleep(2000);
  }
  unseedEngines(DATA, seed);
  rmSync(DATA, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  log("removed data dir:", !existsSync(DATA));
}
log(fails.length ? `FAILED: ${fails.join("; ")}` : "ALL PASS");
process.exit(fails.length ? 1 : 0);
