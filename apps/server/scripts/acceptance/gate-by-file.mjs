// The gate's tests on a machine whose loopback fails by itself (see "Local connections time out by themselves" in
// apps/server/README.md): every workspace's test list, file by file, in test:unit's order. A test that fails is rerun by
// name, and everything it failed on is printed. Anything but a connect timeout, or a test that keeps failing, shows as what
// it is. A pass here is weaker than a whole `corepack yarn test:unit`, and a Linux container (gate-linux.mjs) is the one that
// counts. Exit 0 when nothing is left failing.
//
//   node apps/server/scripts/acceptance/gate-by-file.mjs
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "../../../..");
const WORKSPACES = ["packages/types", "packages/cdp-driver", "packages/mcp-server", "packages/profile-manager", "packages/browser-runtime", "apps/server", "scripts/detection-baseline"];
const say = (s) => console.log(s);

function run(cwd, flags, args, loader) {
  const res = spawnSync(process.execPath, ["--import", loader, "--test", ...flags, ...args], { cwd, encoding: "utf8", timeout: 500_000, maxBuffer: 1 << 28, windowsHide: true });
  const out = res.stdout + res.stderr;
  const num = (name) => [...out.matchAll(new RegExp(`^ℹ ${name} (\\d+)`, "gm"))].reduce((a, m) => a + Number(m[1]), 0);
  const at = out.indexOf("failing tests");
  const tail = at < 0 ? "" : out.slice(at);
  const failed = [...new Set([...tail.matchAll(/^✖ (.+?) \(\d/gm)].map((m) => m[1]))];
  const causes = [...new Set([...tail.matchAll(/(connect ETIMEDOUT|ERR_CONNECTION[A-Z_]*|fetch failed|AssertionError|timed out waiting[^\n]{0,60}|test timed out|Error: [^\n]{0,70})/g)].map((m) => m[1].replace(/\d+\.\d+\.\d+\.\d+:\d+/, "")))];
  return { code: res.status, tests: num("tests"), pass: num("pass"), fail: num("fail"), skipped: num("skipped"), failed, causes };
}

let total = 0;
let passedFirst = 0;
const reran = [];
const stuck = [];
for (const ws of WORKSPACES) {
  const cwd = join(REPO, ws);
  const script = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")).scripts.test;
  const flags = [...script.matchAll(/--test-[a-z-]+(?:=\S+)?/g)].map((m) => m[0]);
  const files = [...script.matchAll(/\S+\.test\.tsx?/g)].map((m) => m[0]);
  const loader = /--import (\S+)/.exec(script)[1];
  let wsTests = 0;
  for (const file of files) {
    let first = run(cwd, flags, [file], loader);
    // No summary: it hung until the timeout above, or crashed. Whatever it held isn't counted otherwise.
    for (let t = 1; t <= 3 && first.tests === 0 && first.code !== 0; t += 1) {
      say(`${ws}/${file}: no summary, exit ${first.code}: running the file again, try ${t}`);
      first = run(cwd, flags, [file], loader);
    }
    if (first.tests === 0 && first.code !== 0) stuck.push(`${ws}/${file} (never finished)`);
    wsTests += first.tests;
    passedFirst += first.pass;
    if (first.skipped) say(`${ws}/${file}: ${first.skipped} SKIPPED`);
    if (first.code === 0) continue;
    say(`${ws}/${file}: ${first.fail} of ${first.tests} failed: ${first.causes.join(" | ").slice(0, 200)}`);
    for (const name of first.failed.filter((n) => !n.endsWith(".ts"))) {
      let ok = false;
      for (let t = 1; t <= 12 && !ok; t += 1) {
        const pattern = `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
        const again = run(cwd, flags, ["--test-name-pattern", pattern, file], loader);
        ok = again.code === 0 && again.pass >= 1;
        say(`  rerun ${t}: "${name.slice(0, 80)}": ${ok ? "pass" : `fail: ${again.causes.join(" | ").slice(0, 120)}`}`);
      }
      reran.push(name);
      if (!ok) stuck.push(name);
    }
  }
  total += wsTests;
  say(`${ws}: ${wsTests} tests`);
}
say(`total ${total} tests, ${passedFirst} passed first time, ${reran.length} rerun by name, still failing: ${stuck.length ? stuck.join("; ") : "none"}`);
process.exit(stuck.length ? 1 : 0);
