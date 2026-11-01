// The live rig of the handoff scenarios: a real serve, a real SDK agent, a local fixture and webhook listener, all
// behind a little control API, so a person-shaped step can be interleaved. ac5-run.mjs starts it. By hand:
//
//   corepack yarn workspace @multizen/server exec tsx scripts/acceptance/harness.mjs --engine cloakbrowser|camoufox \
//     [--ttl-ms N] [--webhook unreachable] [--tag <data dir under %TEMP%>] [--ctrl <port>] \
//     [--engine-version-dir <dir with the pinned chrome>] [--camoufox-install <pinned install>]
//   ... harness.mjs --docker xvfb|headless --engine ...   a fresh container of multizen-server:local on a fresh volume
//
// With no links the engine downloads, into the data dir or the volume. It prints "ready ctrl=<port>" once that is done.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CLI, fetchRetryingConnect, freePort, getJsonRetrying, HERE, IS_WINDOWS, REPO, seedEngines, sleep, unseedEngines } from "./flow.mjs";

const { values } = parseArgs({
  options: {
    engine: { type: "string", default: "cloakbrowser" },
    "ttl-ms": { type: "string" },
    webhook: { type: "string", default: "local" },
    secret: { type: "string" },
    quota: { type: "string" },
    tag: { type: "string", default: "mzt14h" },
    ctrl: { type: "string", default: "18980" },
    docker: { type: "string" },
    "engine-version-dir": { type: "string" },
    "camoufox-install": { type: "string" },
  },
});
const ENGINE = values.engine;
const TAG = values.tag;
const DATA = join(tmpdir(), TAG);
const seed = { engineVersionDir: values["engine-version-dir"], camoufoxInstall: values["camoufox-install"] };
const CONTAINER = `mz-${TAG}`;
const VOLUME = `mz-${TAG}-data`;
const docker = values.docker;

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const port = await freePort();
const fixturePort = await freePort();
const webhookPort = await freePort();
const webhooks = [];
const base = `http://127.0.0.1:${port}`;
const fixture = `http://127.0.0.1:${fixturePort}`;

// ── webhook listener ─────────────────────────────────────────────────────────
const hookServer = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    webhooks.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
    res.writeHead(204).end();
  });
});
await new Promise((resolve) => hookServer.listen(webhookPort, "127.0.0.1", resolve));

// ── server ───────────────────────────────────────────────────────────────────
let child = null;
let serverLog = "";
let tokens = {};

function dockerRun(args, opts = {}) {
  return spawnSync("docker", args, { encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1" }, ...opts });
}
function hostPath(p) {
  return IS_WINDOWS ? p.replace(/\//g, "\\") : p;
}

function cliToken(name, tools, extra = []) {
  if (docker) {
    const r = dockerRun(["exec", CONTAINER, "node", "/app/dist/cli.js", "token", "create", "--name", name, "--tools", tools, "--data-dir", "/data", ...extra]);
    return (r.stdout.match(/mz_t_[0-9a-f]+_[A-Za-z0-9_-]{43}/) ?? [])[0];
  }
  const r = spawnSync(process.execPath, [CLI, "token", "create", "--name", name, "--tools", tools, "--data-dir", DATA, ...extra], { encoding: "utf8" });
  return (r.stdout.match(/mz_t_[0-9a-f]+_[A-Za-z0-9_-]{43}/) ?? [])[0];
}

async function startFixtureLocal() {
  const f = spawn(process.execPath, [join(HERE, "handoff-fixture.cjs")], {
    env: { ...process.env, FIXTURE_PORT: String(fixturePort) },
    stdio: "ignore",
    windowsHide: true,
  });
  return f;
}

let fixtureChild = null;

async function startServer() {
  if (docker) {
    dockerRun(["rm", "-f", CONTAINER]);
    dockerRun(["volume", "rm", VOLUME]);
    dockerRun(["volume", "create", VOLUME]);
    const env = [
      "-e", `MULTIZEN_EGRESS_ALLOW=127.0.0.1,localhost`,
      "-e", `MULTIZEN_HOST=0.0.0.0`,
      "-e", `MULTIZEN_ALLOW_REMOTE=1`,
      "-e", `MULTIZEN_ALLOW_INSECURE_REMOTE=1`,
      "-e", `MULTIZEN_ALLOWED_HOSTS=127.0.0.1:${port},localhost:${port}`,
      "-e", `MULTIZEN_PUBLIC_URL=http://127.0.0.1:${port}`,
      "-e", `MULTIZEN_DISPLAY_MODE=${docker}`,
      "-e", `MULTIZEN_DEFAULT_ENGINE=${ENGINE}`,
      "-e", values.webhook === "unreachable"
        ? "MULTIZEN_HANDOFF_WEBHOOK=http://127.0.0.1:9/hook?key=SECRETWEBHOOKKEY"
        : `MULTIZEN_HANDOFF_WEBHOOK=http://127.0.0.1:${fixturePort}/hook`,
      ...(values["ttl-ms"] ? ["-e", `MULTIZEN_HANDOFF_TTL_MS=${values["ttl-ms"]}`] : []),
    ];
    const run = dockerRun(["run", "-d", "--name", CONTAINER, "--hostname", "multizen", "--shm-size", "1g",
      "--security-opt", `seccomp=${hostPath(join(REPO, "docker/seccomp-chromium.json"))}`, "--security-opt", "no-new-privileges:true", "--cap-drop", "ALL",
      "-p", `127.0.0.1:${port}:7777`, "-p", `127.0.0.1:${fixturePort}:${fixturePort}`,
      ...env,
      "-v", `${VOLUME}:/data`,
      "multizen-server:local"]);
    if (run.status !== 0) throw new Error(run.stderr);
    dockerRun(["cp", hostPath(join(HERE, "handoff-fixture.cjs")), `${CONTAINER}:/tmp/fixture.cjs`]);
    for (let i = 0; i < 90; i++) {
      serverLog = dockerRun(["logs", CONTAINER]).stdout;
      if (serverLog.includes('"listening"')) break;
      await sleep(1000);
    }
    if (!serverLog.includes('"listening"')) throw new Error(`no listen: ${serverLog.slice(-2000)}`);
    dockerRun(["exec", "-d", "-e", `FIXTURE_PORT=${fixturePort}`, "-e", "FIXTURE_HOST=0.0.0.0", CONTAINER, "node", "/tmp/fixture.cjs"]);
    await sleep(1000);
    return;
  }

  seedEngines(DATA, seed);
  const args = [
    CLI, "serve", "--data-dir", DATA, "--port", String(port), "--headless",
    "--default-engine", ENGINE,
    "--egress-allow", "127.0.0.1,localhost",
    ...(values.webhook === "local" ? ["--handoff-webhook", `http://127.0.0.1:${webhookPort}/hook`] : []),
    ...(values.webhook === "unreachable" ? ["--handoff-webhook", `http://127.0.0.1:9/hook?key=SECRETWEBHOOKKEY`] : []),
    ...(values.secret ? ["--handoff-webhook-secret", values.secret] : []),
    ...(values["ttl-ms"] ? ["--handoff-ttl-ms", values["ttl-ms"]] : []),
    ...(values.quota ? ["--download-quota-bytes", values.quota] : []),
  ];
  child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stdout.on("data", (c) => (serverLog += c.toString("utf8")));
  child.stderr.on("data", (c) => (serverLog += c.toString("utf8")));
  for (let i = 0; i < 300 && !serverLog.includes('"listening"'); i++) await sleep(100);
  if (!serverLog.includes('"listening"')) throw new Error(`no listen: ${serverLog.slice(-2000)}`);
  fixtureChild = await startFixtureLocal();
  await sleep(300);
}

function logs() {
  if (docker) serverLog = dockerRun(["logs", CONTAINER]).stdout + dockerRun(["logs", CONTAINER]).stderr;
  return serverLog;
}

// Nothing left behind when it can't come up: a published port can stop answering by itself on such a machine.
process.on("uncaughtException", (e) => {
  console.error(e);
  void shutdown(1);
});

await startServer();
tokens = {
  owner: docker
    ? dockerRun(["exec", CONTAINER, "cat", "/data/owner-token"]).stdout.trim()
    : readFileSync(join(DATA, "owner-token"), "utf8").trim(),
  agent: cliToken("agent", "read,act"),
  op: cliToken("op", "read", ["--panel"]),
};
if (!tokens.agent || !tokens.op) throw new Error("token create failed");

// The scenarios launch once, and don't wait out a download.
const readyBy = Date.now() + 15 * 60_000;
for (let ready = false; !ready; ) {
  if (Date.now() > readyBy) throw new Error(`the engine never got ready: ${logs().slice(-1000)}`);
  const state = await fetchRetryingConnect(`${base}/readyz`, { headers: { authorization: `Bearer ${tokens.owner}` } }).then((r) => r.json()).catch(() => null);
  ready = state?.ready === true;
  if (!ready) await sleep(1000);
}

const clients = {};
async function clientFor(name) {
  if (clients[name]) return clients[name];
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${tokens[name]}` } },
    fetch: fetchRetryingConnect,
  });
  const client = new Client({ name: `harness-${name}`, version: "0" });
  await client.connect(transport);
  clients[name] = client;
  return client;
}

async function call(tool, args, who = "agent") {
  const client = await clientFor(who);
  const res = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 90_000 });
  const first = res.content?.[0];
  if (first?.type === "image") return { isError: false, image: true, bytes: first.data.length };
  return { isError: res.isError === true, body: JSON.parse(first?.text ?? "{}") };
}

// A profile and the fixture, ready.
const created = await call("create_profile", { name: `s11 "<b>${ENGINE}</b>"`, engine: ENGINE }, "owner");
const PROFILE = created.body.id;
log("profile", PROFILE);

function killBrowser(pid) {
  if (docker) dockerRun(["exec", CONTAINER, "kill", "-9", pid]);
  else if (IS_WINDOWS) spawnSync("taskkill", ["/PID", pid, "/T", "/F"]);
  else process.kill(Number(pid), "SIGKILL");
}

// ── control API ──────────────────────────────────────────────────────────────
const ctrl = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    const url = new URL(req.url, "http://x");
    const reply = (o, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(o, null, 1));
    };
    try {
      const input = body ? JSON.parse(body) : {};
      switch (url.pathname) {
        case "/info":
          return reply({ port, base, fixture, profile: PROFILE, engine: ENGINE, webhookPort, panel: `${base}/panel` });
        case "/call":
          return reply(await call(input.tool, { profile_id: PROFILE, ...input.args }, input.who ?? "agent"));
        case "/token":
          return reply({ token: tokens[url.searchParams.get("who") ?? "op"] });
        case "/reports":
          return reply(await getJsonRetrying(`${fixture}/reports`));
        case "/clear":
          await fetchRetryingConnect(`${fixture}/clear`);
          return reply({ ok: true });
        case "/webhooks":
          return reply(docker ? await getJsonRetrying(`${fixture}/hooks`) : webhooks);
        case "/kill-pid": {
          const pid = url.searchParams.get("pid");
          killBrowser(pid);
          return reply({ killed: pid });
        }
        case "/grep": {
          const text = logs();
          const q = url.searchParams.get("q");
          const lines = text.split("\n").filter((l) => l.includes(q));
          return reply({ total: text.length, matches: lines.length, sample: lines.slice(0, 5).map((l) => l.slice(0, 300)) });
        }
        case "/lifecycle": {
          const lines = logs().split("\n").filter((l) => l.includes('"handoff.'));
          return reply(lines.map((l) => { const j = JSON.parse(l); return [j.tool, j.status, j.actor, j.profileId === PROFILE ? "p" : j.profileId]; }));
        }
        case "/warns": {
          const lines = logs().split("\n").filter((l) => /"level":"(warn|error)"/.test(l));
          return reply(lines.map((l) => l.slice(0, 260)));
        }
        case "/raw-token-revoke": {
          const args = ["token", "revoke", url.searchParams.get("who") ?? "op"];
          const r = docker
            ? dockerRun(["exec", CONTAINER, "node", "/app/dist/cli.js", ...args, "--data-dir", "/data"])
            : spawnSync(process.execPath, [CLI, ...args, "--data-dir", DATA], { encoding: "utf8" });
          return reply({ status: r.status });
        }
        case "/kill-browser": {
          const launched = await call("launch_profile", { profile_id: PROFILE }, "owner");
          const pid = launched.body.pid;
          killBrowser(String(pid));
          return reply({ killed: pid });
        }
        case "/shutdown":
          reply({ ok: true });
          await shutdown();
          return;
        default:
          return reply({ error: "unknown" }, 404);
      }
    } catch (e) {
      reply({ failed: String(e), stack: e.stack }, 500);
    }
  });
});

async function shutdown(code = 0) {
  await Promise.race([Promise.all(Object.values(clients).map((c) => c.close().catch(() => {}))), sleep(3000)]);
  if (docker) {
    dockerRun(["logs", CONTAINER]);
    dockerRun(["rm", "-f", CONTAINER]);
    dockerRun(["volume", "rm", VOLUME]);
  } else {
    fixtureChild?.kill();
    if (child) {
      if (IS_WINDOWS) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
      else child.kill("SIGTERM");
      await sleep(1500);
    }
    unseedEngines(DATA, seed);
    rmSync(DATA, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
  log("down");
  process.exit(code);
}

ctrl.listen(Number(values.ctrl), "127.0.0.1", () => log(`ready ctrl=${values.ctrl} base=${base} fixture=${fixture} profile=${PROFILE}`));
