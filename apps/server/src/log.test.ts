import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));
const LOG_MODULE = pathToFileURL(fileURLToPath(new URL("./log.ts", import.meta.url))).href;

/** Runs `body` in a child that imported log.ts and installed it for `target`. */
function run(
  target: "stdout" | "stderr",
  body: string,
  level?: string,
): { stdout: string; stderr: string } {
  const script = `
    const { installLogging, log, protocolStdout, flushLogs, errorFields } = await import(${JSON.stringify(LOG_MODULE)});
    installLogging(${JSON.stringify(target)});
    ${body}
    await flushLogs();
  `;
  const res = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: APP_ROOT,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, MULTIZEN_LOG_LEVEL: level },
  });
  assert.equal(res.status, 0, res.stderr);
  return { stdout: res.stdout, stderr: res.stderr };
}

function jsonLines(text: string): Array<Record<string, unknown>> {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("normal mode: JSON lines on stdout, nothing on stderr", () => {
  const { stdout, stderr } = run("stdout", `log.info("hello", { a: 1 }); log.error("bad");`);
  assert.equal(stderr, "");
  const lines = jsonLines(stdout);
  assert.equal(lines[0]?.level, "info");
  assert.equal(lines[0]?.msg, "hello");
  assert.equal(lines[0]?.a, 1);
  assert.equal(typeof lines[0]?.ts, "string");
  assert.equal(lines[1]?.level, "error");
});

test("console.* is rebound, with levels and format strings kept", () => {
  const { stdout } = run(
    "stdout",
    `console.log("n=%d", 5); console.info("i"); console.debug("d"); console.warn("w"); console.error("e", new Error("boom").message);`,
    "debug",
  );
  assert.deepEqual(
    jsonLines(stdout).map((l) => [l.level, l.msg]),
    [
      ["info", "n=5"],
      ["info", "i"],
      ["debug", "d"],
      ["warn", "w"],
      ["error", "e boom"],
    ],
  );
});

test("MULTIZEN_LOG_LEVEL decides what is written, debug being off unless asked for", () => {
  const body = `log.debug("d"); log.info("i"); log.warn("w"); log.error("e"); console.debug("cd");`;
  const levels = (level?: string): unknown[] =>
    jsonLines(run("stdout", body, level).stdout).map((l) => l.msg);
  assert.deepEqual(levels(), ["i", "w", "e"]);
  assert.deepEqual(levels("debug"), ["d", "i", "w", "e", "cd"]);
  assert.deepEqual(levels("WARN"), ["w", "e"]);
  assert.deepEqual(levels("error"), ["e"]);
});

test("a MULTIZEN_LOG_LEVEL nobody knows gets a warning, and info", () => {
  const lines = jsonLines(run("stdout", `log.debug("d"); log.info("i");`, "loud").stdout);
  assert.deepEqual(lines.map((l) => [l.level, l.value]), [
    ["warn", "loud"],
    ["info", undefined],
  ]);
});

test("stdio mode: stdout stays empty whatever gets written, all logs on stderr", () => {
  const { stdout, stderr } = run(
    "stderr",
    `log.info("x");
     console.log("from a library");
     process.stdout.write("direct to stdout\\n");
     process.stderr.write("direct to stderr\\n");`,
  );
  assert.equal(stdout, "");
  assert.deepEqual(
    jsonLines(stderr).map((l) => l.msg),
    ["x", "from a library", "direct to stdout", "direct to stderr"],
  );
});

test("stdio mode: only protocolStdout reaches the real stdout", () => {
  const { stdout, stderr } = run(
    "stderr",
    `console.log("noise");
     await new Promise((resolve) => protocolStdout.write('{"jsonrpc":"2.0"}\\n', resolve));`,
  );
  assert.equal(stdout, '{"jsonrpc":"2.0"}\n');
  assert.equal(jsonLines(stderr)[0]?.msg, "noise");
});

test("direct stream writes become one JSON line each, callbacks still fire", () => {
  const { stdout } = run(
    "stdout",
    `await new Promise((resolve) => process.stdout.write("a\\nb\\n\\n", resolve));
     await new Promise((resolve) => process.stderr.write(Buffer.from("c\\n"), resolve));`,
  );
  assert.deepEqual(
    jsonLines(stdout).map((l) => [l.msg, l.source, l.level]),
    [
      ["a", "stdout", "info"],
      ["b", "stdout", "info"],
      ["c", "stderr", "warn"],
    ],
  );
});

test("a field JSON can't serialize doesn't lose the message", () => {
  const { stdout } = run("stdout", `const o = {}; o.self = o; log.info("cyclic", { o });`);
  const line = jsonLines(stdout)[0];
  assert.equal(line?.msg, "cyclic");
  assert.equal(line?.o, undefined);
});

test("errorFields keeps the message of an Error and of anything else", () => {
  const { stdout } = run(
    "stdout",
    `log.error("a", errorFields(new Error("boom"))); log.error("b", errorFields("plain"));`,
  );
  const [a, b] = jsonLines(stdout);
  assert.equal(a?.error, "boom");
  assert.match(String(a?.stack), /boom/);
  assert.equal(b?.error, "plain");
});
