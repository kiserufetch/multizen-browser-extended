// The gate that counts: a fresh throwaway Linux container from the working tree, installed as CI does, then typecheck and
// test:unit. No browser runs in it. docs/ stays out, as from a checkout. Needs Docker, on any host.
//
//   node apps/server/scripts/acceptance/gate-linux.mjs [--node <image tag, default 22>] [--out <file for the full log>]
//
// Prints the Node version, INSTALL= and GATE= exit codes, then tests, pass, fail, cancelled, skipped per workspace, and the
// total. Exit 0 only if both exit codes are 0 and nothing failed.
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { node: { type: "string", default: "22" }, out: { type: "string" } } });
const REPO = resolve(import.meta.dirname, "../../../..");
const NAME = `mz-gate-${process.pid}`;
// Windows' own: Git's GNU tar takes C:\... for a remote host.
const TAR = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
const EXCLUDED = ["node_modules", "./.git", "./.omc", "./.claude", "./docs", "dist", "out", "release", "./todo.txt", ".yarn/install-state.gz", ".yarn/cache", ".cache"];

function docker(args, opts = {}) {
  const res = spawnSync("docker", args, { encoding: "utf8", maxBuffer: 1 << 28, windowsHide: true, ...opts });
  if (res.status !== 0 && !opts.mayFail) throw new Error(`docker ${args.slice(0, 3).join(" ")}: ${res.stderr}`);
  return res;
}
const sh = (user, env, script) => docker(["exec", "-u", user, ...env.flatMap((e) => ["-e", e]), NAME, "sh", "-c", script], { mayFail: true });

function copyTree() {
  return new Promise((done, fail) => {
    const pack = spawn(TAR, ["-C", REPO, ...EXCLUDED.map((p) => `--exclude=${p}`), "-cf", "-", "."], { stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
    const unpack = spawn("docker", ["exec", "-i", "-u", "gate", NAME, "tar", "-xf", "-", "-C", "/repo", "--no-same-owner"], { stdio: ["pipe", "inherit", "inherit"], windowsHide: true });
    pack.stdout.pipe(unpack.stdin);
    pack.on("error", fail);
    unpack.on("error", fail);
    unpack.on("close", (code) => (code === 0 ? done() : fail(new Error(`unpacking the tree: exit ${code}`))));
  });
}

let code = 1;
try {
  docker(["rm", "-f", NAME], { mayFail: true });
  docker(["run", "-d", "--name", NAME, `node:${values.node}`, "sleep", "7200"]);
  sh("root", [], "useradd -m gate 2>/dev/null; mkdir -p /repo && chown gate /repo");
  await copyTree();
  // A Windows working tree has CRLF, which isn't what a checkout on Linux has.
  sh("gate", [], String.raw`cd /repo && find . -type f \( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.mjs" -o -name "*.cjs" -o -name "*.json" -o -name "*.md" -o -name "*.lock" -o -name "*.patch" -o -name "*.yml" -o -name "*.yaml" -o -name "*.css" -o -name "*.html" -o -name "*.sh" \) -exec sed -i "s/\r$//" {} +`);
  const env = ["COREPACK_ENABLE_DOWNLOAD_PROMPT=0", "CI=true"];
  console.log(sh("gate", env, "node --version").stdout.trim());
  const install = sh("gate", env, "cd /repo && corepack yarn install --immutable > /tmp/install.log 2>&1");
  console.log(`INSTALL=${install.status}`);
  if (install.status !== 0) console.log(sh("gate", [], "tail -30 /tmp/install.log").stdout);
  const gate = sh("gate", env, "cd /repo && (corepack yarn typecheck && corepack yarn test:unit) > /tmp/gate.log 2>&1");
  console.log(`GATE=${gate.status}`);
  const log = sh("gate", [], "cat /tmp/gate.log").stdout;
  if (values.out) writeFileSync(values.out, log);
  // With no terminal node:test reports as TAP, and with one in its own marks.
  const count = (name) => [...log.matchAll(new RegExp(`^(?:ℹ|#) ${name} (\\d+)`, "gm"))].map((m) => Number(m[1]));
  const sum = (list) => list.reduce((a, b) => a + b, 0);
  const tests = count("tests");
  console.log(`tests per workspace: ${tests.join(", ")}`);
  console.log(`total ${sum(tests)} tests, ${sum(count("pass"))} pass, ${sum(count("fail"))} fail, ${sum(count("cancelled"))} cancelled, ${sum(count("skipped"))} skipped`);
  for (const line of log.split("\n").filter((l) => /^(✖ |not ok )/.test(l)).slice(0, 20)) console.log(line.slice(0, 170));
  code = install.status === 0 && gate.status === 0 && sum(tests) > 0 && sum(count("fail")) === 0 ? 0 : 1;
} finally {
  docker(["rm", "-f", NAME], { mayFail: true });
}
process.exit(code);
