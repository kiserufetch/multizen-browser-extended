import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL(".", import.meta.url));
const PACKAGE_JSON = fileURLToPath(new URL("../package.json", import.meta.url));

const ELECTRON_IMPORT = /(?:from\s+|import\s*\(\s*|require\s*\(\s*|^\s*import\s+)["']electron["']/m;
const ELECTRON_GLOBALS = /process\.resourcesPath|\bapp\.(?:getPath|isPackaged|getVersion)\b/;

/** Everything under src but this file, whose samples below would match. */
function sourceFiles(): string[] {
  return (readdirSync(SRC, { recursive: true, encoding: "utf8" }) as string[])
    .filter((name) => name.endsWith(".ts") && name !== "noElectron.test.ts")
    .map((name) => join(SRC, name));
}

test("the pattern recognises each way of importing electron", () => {
  assert.match(`import { app, net } from "electron";`, ELECTRON_IMPORT);
  assert.match(`const e = await import("electron");`, ELECTRON_IMPORT);
  assert.match(`const e = require('electron');`, ELECTRON_IMPORT);
  assert.match(`import "electron";`, ELECTRON_IMPORT);
  assert.doesNotMatch(`import x from "electron-updater";`, ELECTRON_IMPORT);
});

test("nothing under src imports electron", () => {
  const files = sourceFiles();
  assert.ok(files.length > 20, `expected the moved files, found ${files.length}`);
  for (const file of files) {
    assert.doesNotMatch(readFileSync(file, "utf8"), ELECTRON_IMPORT, file);
  }
});

test("nothing under src reaches for Electron's app or resources path", () => {
  for (const file of sourceFiles()) {
    assert.doesNotMatch(readFileSync(file, "utf8"), ELECTRON_GLOBALS, file);
  }
});

test("the package does not declare electron", () => {
  const manifest = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert.equal(manifest.dependencies?.electron, undefined);
  assert.equal(manifest.devDependencies?.electron, undefined);
});

test("camoufox-js keeps the patched descriptor", () => {
  const manifest = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as {
    dependencies: Record<string, string>;
  };
  assert.match(manifest.dependencies["camoufox-js"] ?? "", /^patch:camoufox-js@/);
});
