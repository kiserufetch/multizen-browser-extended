import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { policedToolNames, TOOL_GROUPS } from "@multizen/mcp-server";

/**
 * The README is what an operator goes by, so what it lists is checked against the code, both
 * ways: a flag it doesn't mention is one nobody finds, and one it mentions that is gone wastes
 * an afternoon. Reads files only, so it also holds on a checkout with no build.
 */
const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");
const README = read("../README.md");
const ROOT_README = read("../../../README.md");
const CONFIG = read("./config.ts");
const CLI = read("./cli.ts");
const COMPOSE = read("../../../docker-compose.yml");
const POLICY = read("../../../packages/mcp-server/src/toolPolicy.ts");

/** Flags the README shows that aren't this server's: Docker's, tar's, Chromium's, a script's. */
const FOREIGN_FLAGS = new Set([
  "--hostname",
  "--shm-size",
  "--security-opt",
  "--cap-drop",
  "--pids-limit",
  "--log-opt",
  "--rm",
  "--no-deps",
  "--entrypoint",
  "--exclude",
  "--no-sandbox",
  "--user-data-dir",
  "--only",
]);

function matches(text: string, pattern: RegExp): Set<string> {
  return new Set([...text.matchAll(pattern)].map((m) => m[1]!));
}

const FLAG = /(?<![\w-])(--[a-z][a-z-]*)/g;
const ENV = /\b(MULTIZEN_[A-Z][A-Z_]*)\b/g;
/** An entry of a parseArgs options object in config.ts: `"data-dir": { type: "string" }`. */
const CONFIG_OPTION = /"?([a-z][a-z-]*)"?: \{ type: "(?:string|boolean)" \}/g;

const configFlags = new Set([...matches(CONFIG, CONFIG_OPTION)].map((name) => `--${name}`));
const usage = /const USAGE = `([\s\S]*?)`;/.exec(CLI)![1]!;
const usageFlags = matches(usage, FLAG);

/** Everywhere a variable can be read: this package's sources, the compose file, and the driver's. */
function knownEnvVars(): Set<string> {
  const known = new Set([...matches(COMPOSE, ENV), ...matches(usage, ENV)]);
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        for (const name of matches(readFileSync(path, "utf8"), ENV)) known.add(name);
      }
    }
  };
  walk(fileURLToPath(new URL(".", import.meta.url)));
  for (const name of matches(read("../../../packages/browser-runtime/src/ChromiumBrowserDriver.ts"), /process\.env\.(MULTIZEN_[A-Z_]+)/g)) {
    known.add(name);
  }
  return known;
}

test("the walks find something: a broken pattern would pass everything below", () => {
  assert.ok(configFlags.size >= 35, `only ${configFlags.size} flags in config.ts`);
  assert.ok(knownEnvVars().size >= 30, `only ${knownEnvVars().size} variables`);
  assert.ok(matches(CONFIG, /env\.(MULTIZEN_[A-Z_]+)/g).size >= 25);
});

test("every flag in config.ts and in --help is in the README", () => {
  const readmeFlags = matches(README, FLAG);
  const missing = [...new Set([...configFlags, ...usageFlags])].filter((flag) => !readmeFlags.has(flag));
  assert.deepEqual(missing, []);
});

test("every flag in the README is this server's, or known to be someone else's", () => {
  const ours = new Set([...configFlags, ...usageFlags]);
  const unknown = [...matches(README, FLAG)].filter((flag) => !ours.has(flag) && !FOREIGN_FLAGS.has(flag));
  assert.deepEqual(unknown, []);
});

test("every flag in config.ts is in --help, and the reverse", () => {
  assert.deepEqual([...configFlags].filter((flag) => !usageFlags.has(flag)), []);
  assert.deepEqual([...usageFlags].filter((flag) => !configFlags.has(flag)), []);
});

test("every environment variable is in the README, and the reverse", () => {
  const known = knownEnvVars();
  const documented = matches(README, ENV);
  assert.deepEqual([...known].filter((name) => !documented.has(name)), []);
  assert.deepEqual([...documented].filter((name) => !known.has(name)), []);
});

test("every variable config.ts reads is in --help", () => {
  const inUsage = matches(usage, ENV);
  assert.deepEqual([...matches(CONFIG, /env\.(MULTIZEN_[A-Z_]+)/g)].filter((name) => !inUsage.has(name)), []);
});

test("the README's tool-group table is toolPolicy.ts", () => {
  const lines = README.split(/\r?\n/);
  const header = lines.indexOf("| Group | Tools |");
  assert.ok(header > 0, "no group table");
  const table = new Map<string, string[]>();
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith("|")) break;
    const [, group, tools] = line.split("|");
    table.set(/`([a-z-]+)`/.exec(group!)![1]!, [...tools!.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]!));
  }
  assert.deepEqual([...table.keys()].sort(), [...TOOL_GROUPS].sort());
  const entries = [...POLICY.matchAll(/^\s*([a-z_]+): \{ group: "([a-z-]+)"/gm)];
  assert.deepEqual(entries.map((m) => m[1]!).sort(), [...policedToolNames()].sort(), "read toolPolicy.ts wrong");
  for (const group of TOOL_GROUPS) {
    const inPolicy = entries.filter((m) => m[2] === group).map((m) => m[1]!);
    assert.deepEqual([...table.get(group)!].sort(), inPolicy.sort(), `group ${group}`);
  }
});

test("the root README counts and lists every tool", () => {
  const tools = policedToolNames();
  assert.match(ROOT_README, new RegExp(`\\b${tools.length} tools:`));
  const listed = matches(ROOT_README, /`([a-z_]+)`/g);
  assert.deepEqual(tools.filter((tool) => !listed.has(tool)), []);
});
