import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Metafile } from "esbuild";
import { build } from "../scripts/build.mjs";

const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUTDIR = join("dist", `test-bundle-${process.pid}`);
const ABS_OUTDIR = join(APP_ROOT, OUTDIR);
const manifest = JSON.parse(readFileSync(join(APP_ROOT, "package.json"), "utf8")) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

let meta: Metafile;

before(async () => {
  meta = await build({ outdir: OUTDIR });
});

after(() => {
  rmSync(ABS_OUTDIR, { recursive: true, force: true });
});

/** Package name of a bare import specifier. */
function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? `${parts[0]}/${parts[1]}` : (parts[0] ?? specifier);
}

function externalImports(): Array<{ path: string; kind: string; output: string }> {
  return Object.entries(meta.outputs).flatMap(([output, o]) =>
    o.imports.filter((i) => i.external).map((i) => ({ path: i.path, kind: i.kind, output })),
  );
}

function isBuiltin(specifier: string): boolean {
  return specifier.startsWith("node:") || builtinModules.includes(specifier);
}

test("every external import is a Node builtin or a direct dependency", () => {
  const externals = externalImports().filter((i) => !isBuiltin(i.path));
  assert.ok(externals.length > 0);
  for (const { path } of externals) {
    assert.ok(
      manifest.dependencies[packageName(path)],
      `${path} is external but not in apps/server dependencies`,
    );
  }
});

test("every declared dependency is used by the bundle", () => {
  const used = new Set(externalImports().map((i) => packageName(i.path)));
  for (const name of Object.keys(manifest.dependencies)) {
    // better-sqlite3 and zod come in through the inlined workspace packages too,
    // so this catches a dependency left behind by a refactor.
    assert.ok(used.has(name), `${name} is declared but the bundle never imports it`);
  }
});

test("workspace packages are inlined and only dev dependencies", () => {
  assert.equal(
    externalImports().filter((i) => i.path.startsWith("@multizen/")).length,
    0,
  );
  for (const name of Object.keys(manifest.dependencies)) {
    assert.equal(name.startsWith("@multizen/"), false, name);
  }
  assert.ok(manifest.devDependencies["@multizen/browser-runtime"]);
});

test("the patched camoufox-js descriptor is kept", () => {
  assert.match(manifest.dependencies["camoufox-js"] ?? "", /^patch:camoufox-js@/);
});

test("camoufox-js and playwright-core stay out of startup", () => {
  for (const { path, kind, output } of externalImports()) {
    if (kind !== "import-statement") continue;
    if (!/^(camoufox-js|playwright-core)(\/|$)/.test(path)) continue;
    const inputs = Object.keys(meta.outputs[output]?.inputs ?? {});
    assert.ok(
      inputs.some((i) => i.endsWith("FirefoxBrowserDriver.ts")),
      `${output} imports ${path} statically`,
    );
  }
});

test("electron really is absent from this app's module resolution", () => {
  assert.equal(existsSync(join(APP_ROOT, "node_modules", "electron")), false);
  assert.equal(existsSync(join(APP_ROOT, "..", "..", "node_modules", "electron")), false);
});

test("the bundle has no electron import and every chunk loads without it", () => {
  const chunks = readdirSync(ABS_OUTDIR).filter((f) => f.endsWith(".js"));
  assert.ok(chunks.length >= 3, `expected split chunks, got ${chunks.join(", ")}`);
  for (const { path } of externalImports()) {
    assert.notEqual(packageName(path), "electron");
  }

  // Imports every chunk but the entry, whose body would run the CLI: the driver
  // chunks, the runtime, all of it. Throws if anything reaches for electron.
  const urls = chunks
    .filter((f) => f !== "cli.js")
    .map((f) => pathToFileURL(join(ABS_OUTDIR, f)).href);
  const probe = `
    import { registerHooks } from "node:module";
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (/^electron(\\/|$)/.test(specifier)) throw new Error("ELECTRON_LOAD " + specifier);
        return nextResolve(specifier, context);
      },
    });
    for (const url of ${JSON.stringify(urls)}) await import(url);
    console.log("LOADED");
  `;
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
    cwd: APP_ROOT,
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /LOADED/);
});

test("the built CLI starts: help, no command, an unknown command", () => {
  const cli = join(ABS_OUTDIR, "cli.js");
  const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8", timeout: 60_000 });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /multizen-server serve/);
  assert.match(help.stdout, /--display-mode/);
  assert.match(help.stdout, /--headless/);

  const none = spawnSync(process.execPath, [cli], { encoding: "utf8", timeout: 60_000 });
  assert.equal(none.status, 2, none.stderr);

  const bad = spawnSync(process.execPath, [cli, "nonsense"], { encoding: "utf8", timeout: 60_000 });
  assert.equal(bad.status, 2, bad.stderr);
  assert.match(bad.stdout, /Unknown command/);
});
