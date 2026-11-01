import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ShutdownManager, withinBudget } from "./shutdown.ts";

const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));
const moduleUrl = (file: string): string =>
  pathToFileURL(fileURLToPath(new URL(file, import.meta.url))).href;

function manager(watchdogMs = 2000): { shutdown: ShutdownManager; exits: number[] } {
  const exits: number[] = [];
  return { shutdown: new ShutdownManager({ watchdogMs, exit: (code) => exits.push(code) }), exits };
}

test("steps run last-added first, then the process exits with the code", async () => {
  const { shutdown, exits } = manager();
  const order: string[] = [];
  shutdown.add("lock", () => order.push("lock"));
  shutdown.add("runtime", () => order.push("runtime"));
  shutdown.add("http", () => order.push("http"));
  await shutdown.run("SIGINT", 0);
  assert.deepEqual(order, ["http", "runtime", "lock"]);
  assert.deepEqual(exits, [0]);
});

test("a second call neither reruns the steps nor exits again", async () => {
  const { shutdown, exits } = manager();
  let runs = 0;
  shutdown.add("step", () => {
    runs += 1;
  });
  await Promise.all([shutdown.run("SIGINT"), shutdown.run("SIGTERM")]);
  await shutdown.run("SIGTERM");
  assert.equal(runs, 1);
  assert.deepEqual(exits, [0]);
});

test("a failing step is skipped and the later steps still run", async () => {
  const { shutdown, exits } = manager();
  const order: string[] = [];
  shutdown.add("lock", () => order.push("lock"));
  shutdown.add("runtime", () => {
    throw new Error("sync failure");
  });
  shutdown.add("http", async () => {
    await Promise.reject(new Error("async failure"));
  });
  await shutdown.run("SIGINT", 0);
  assert.deepEqual(order, ["lock"]);
  assert.deepEqual(exits, [0]);
});

test("a hung step overruns its budget and the later steps still run", async () => {
  const { shutdown, exits } = manager();
  const order: string[] = [];
  shutdown.add("lock", () => order.push("lock"));
  shutdown.add("http", () => new Promise(() => {}), 20);
  await shutdown.run("SIGINT", 0);
  assert.deepEqual(order, ["lock"]);
  assert.deepEqual(exits, [0]);
});

test("the watchdog bounds the whole shutdown and exits 1", async () => {
  const { shutdown, exits } = manager(30);
  shutdown.add("wedged", () => new Promise(() => {}), 1000);
  const done = shutdown.run("SIGINT", 0);
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.deepEqual(exits, [1]);
  // Past the watchdog nothing else exits, not even the end of the steps.
  await done;
  assert.deepEqual(exits, [1]);
});

test("a later failure can only raise the exit code", async () => {
  const { shutdown, exits } = manager();
  shutdown.add("slow", () => new Promise((resolve) => setTimeout(resolve, 30)));
  const first = shutdown.run("SIGINT", 0);
  void shutdown.run("uncaughtException", 1);
  await first;
  assert.deepEqual(exits, [1]);

  const second = manager();
  second.shutdown.add("slow", () => new Promise((resolve) => setTimeout(resolve, 30)));
  const failing = second.shutdown.run("uncaughtException", 1);
  void second.shutdown.run("SIGINT", 0);
  await failing;
  assert.deepEqual(second.exits, [1]);
});

test("withinBudget: true in time, false when late, rejects with the work's error", async () => {
  assert.equal(await withinBudget(Promise.resolve(), 1000), true);
  assert.equal(await withinBudget(new Promise(() => {}), 10), false);
  await assert.rejects(withinBudget(Promise.reject(new Error("boom")), 1000), /boom/);
});

/**
 * The fatal policy on real process machinery: the child installs the handlers and
 * then fails for real. Exit status, cleanup order and the JSON log line are all
 * read from outside, as an operator would see them.
 */
function fatalChild(failure: string): { status: number | null; lines: Array<Record<string, unknown>> } {
  const script = `
    const { installLogging, log } = await import(${JSON.stringify(moduleUrl("./log.ts"))});
    installLogging("stdout");
    const { ShutdownManager } = await import(${JSON.stringify(moduleUrl("./shutdown.ts"))});
    const shutdown = new ShutdownManager();
    shutdown.installProcessHandlers();
    shutdown.add("lock", () => log.info("cleanup ran", { step: "lock" }));
    shutdown.add("runtime", () => log.info("cleanup ran", { step: "runtime" }));
    setTimeout(() => { ${failure} }, 0);
    setInterval(() => {}, 1000);
  `;
  const res = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: APP_ROOT,
    encoding: "utf8",
    timeout: 60_000,
  });
  return {
    status: res.status,
    lines: res.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

for (const [name, failure, logged] of [
  ["uncaughtException", `throw new Error("boom");`, "uncaught exception"],
  ["unhandledRejection", `void Promise.reject(new Error("boom"));`, "unhandled rejection"],
] as const) {
  test(`${name}: logs it, runs the cleanup, exits 1`, () => {
    const { status, lines } = fatalChild(failure);
    assert.equal(status, 1);
    const fatal = lines.find((l) => l.msg === logged);
    assert.equal(fatal?.level, "error");
    assert.equal(fatal?.error, "boom");
    assert.deepEqual(
      lines.filter((l) => l.msg === "cleanup ran").map((l) => l.step),
      ["runtime", "lock"],
    );
    assert.equal(lines.at(-1)?.msg, "shutdown complete");
    assert.equal(lines.at(-1)?.exitCode, 1);
  });
}
