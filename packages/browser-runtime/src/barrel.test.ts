import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

// Runs in a child so this process's own module graph cannot hide a load. The
// hook throws on the first resolve of a forbidden package, so the module is
// never evaluated and CAMOUFOX_INSTALL_DIR is never frozen, even on failure.
const PROBE = `
import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^(camoufox-js|playwright-core)(\\/|$)/.test(specifier)) {
      throw new Error("FORBIDDEN_LOAD " + specifier);
    }
    return nextResolve(specifier, context);
  },
});
const loaded = await import(process.argv[1]);
console.log(JSON.stringify(Object.keys(loaded)));
`;

function importInChild(file: string): ReturnType<typeof spawnSync> {
  const url = pathToFileURL(fileURLToPath(new URL(file, import.meta.url))).href;
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", PROBE, url],
    { cwd: PACKAGE_ROOT, encoding: "utf8", timeout: 60_000 },
  );
}

test("importing the barrel loads neither camoufox-js nor playwright-core", () => {
  const res = importInChild("./index.ts");
  assert.equal(res.status, 0, String(res.stderr));
  const exported = JSON.parse(String(res.stdout).trim()) as string[];
  for (const name of [
    "ChromiumBrowserDriver",
    "ChromiumBootstrap",
    "CamoufoxBootstrap",
    "EngineRegistry",
    "EngineRouter",
    "ExtensionsService",
    "LinuxSandboxManager",
    "companionDir",
    "cacheDirForEngine",
  ]) {
    assert.ok(exported.includes(name), `barrel should export ${name}`);
  }
});

test("the barrel exports FirefoxBrowserDriver as a type only", () => {
  const res = importInChild("./index.ts");
  assert.equal(res.status, 0, String(res.stderr));
  const exported = JSON.parse(String(res.stdout).trim()) as string[];
  assert.equal(exported.includes("FirefoxBrowserDriver"), false);
});

test("the probe does catch a real load (the driver module itself)", () => {
  const res = importInChild("./FirefoxBrowserDriver.ts");
  assert.notEqual(res.status, 0);
  assert.match(String(res.stderr), /FORBIDDEN_LOAD (playwright-core|camoufox-js)/);
});
