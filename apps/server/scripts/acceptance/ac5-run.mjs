// AC5: starts harness.mjs, runs one handoff scenario against it, and takes it down.
//
//   corepack yarn workspace @multizen/server build
//   corepack yarn workspace @multizen/server exec tsx scripts/acceptance/ac5-run.mjs \
//     --scenario core|expiry|ui --engine cloakbrowser|camoufox \
//     [--chrome <CloakBrowser binary, for ui>] [--docker xvfb|headless] \
//     [--engine-version-dir <dir with the pinned chrome>] [--camoufox-install <pinned install>]
//
// core and expiry need no display. ui drives the panel's page in a bare headless browser of its own. With --docker
// the server runs in a fresh container of multizen-server:local (docker compose build) on a fresh volume, where the
// engine downloads, and these scripts stay on the host. expiry adds its short TTL and unreachable webhook itself.
// Exit 0 and ALL PASS mean every check held. On a machine that loses loopback connects (see "Local connections time
// out by themselves" in apps/server/README.md) a launch can fail by itself: run it again, and read what failed.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fetchRetryingConnect, freePort, HERE, sleep } from "./flow.mjs";

const argv = process.argv.slice(2);
const take = (flag) => {
  const at = argv.indexOf(flag);
  return at < 0 ? undefined : argv.splice(at, 2)[1];
};
const scenario = take("--scenario");
const chrome = take("--chrome");
if (!["core", "expiry", "ui"].includes(scenario)) throw new Error("--scenario must be core, expiry or ui");

const ctrl = await freePort();
const script = (name) => [...process.execArgv, join(HERE, name)];
const harness = spawn(
  process.execPath,
  [...script("harness.mjs"), "--ctrl", String(ctrl), ...argv, ...(scenario === "expiry" ? ["--ttl-ms", "6000", "--webhook", "unreachable"] : [])],
  { stdio: ["ignore", "pipe", "inherit"], windowsHide: true },
);
let harnessOutput = "";
harness.stdout.on("data", (d) => (harnessOutput += d));
const harnessExited = new Promise((done) => harness.once("close", done));

for (let i = 0; !harnessOutput.includes("ready ctrl="); i++) {
  if (harness.exitCode !== null || i > 2400) {
    harness.kill();
    throw new Error(`the harness never came up: ${harnessOutput.slice(-1000)}`);
  }
  await sleep(500);
}

const code = await new Promise((done) => {
  const child = spawn(process.execPath, script(`ac5-${scenario}.mjs`), {
    stdio: "inherit",
    windowsHide: true,
    env: { ...process.env, CTRL: String(ctrl), ...(chrome ? { CHROME: chrome } : {}) },
  });
  const stuck = setTimeout(() => child.kill(), 300_000);
  child.once("close", (exit) => {
    clearTimeout(stuck);
    done(exit ?? 1);
  });
});

await fetchRetryingConnect(`http://127.0.0.1:${ctrl}/shutdown`, { method: "POST" }).catch(() => {});
await Promise.race([harnessExited, sleep(60_000)]);
if (harness.exitCode === null) harness.kill();
process.exit(code);
