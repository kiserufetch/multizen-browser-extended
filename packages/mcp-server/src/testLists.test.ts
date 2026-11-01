import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Test files run only if a package's `test` script names them and the root
 * `test:unit` names that package, so a new file can silently never run. CI runs
 * `test:unit`, so that is the list that counts.
 */
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SKIPPED_DIRS = new Set(["node_modules", "dist", "out", "release", ".cache", ".git"]);

function readJson(path: string): {
  name?: string;
  scripts?: Record<string, string>;
} {
  return JSON.parse(readFileSync(path, "utf8")) as {
    name?: string;
    scripts?: Record<string, string>;
  };
}

function findTestFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) found.push(...findTestFiles(join(dir, entry.name)));
    } else if (/\.test\.tsx?$/.test(entry.name)) {
      found.push(join(dir, entry.name));
    }
  }
  return found;
}

function workspaceDirs(): string[] {
  return ["apps", "packages"].flatMap((parent) =>
    readdirSync(join(REPO_ROOT, parent), { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(REPO_ROOT, parent, e.name, "package.json")))
      .map((e) => join(parent, e.name)),
  );
}

/** Repo-relative, forward-slash paths of every test the root test:unit will run. */
function testsRunByUnitScript(): Set<string> {
  const unit = readJson(join(REPO_ROOT, "package.json")).scripts?.["test:unit"] ?? "";
  const named = new Set(
    [...unit.matchAll(/yarn workspace (@multizen\/[\w-]+) test/g)].map((m) => m[1]!),
  );
  const running = new Set<string>();
  for (const dir of workspaceDirs()) {
    const manifest = readJson(join(REPO_ROOT, dir, "package.json"));
    if (!manifest.name || !named.has(manifest.name)) continue;
    for (const [file] of (manifest.scripts?.test ?? "").matchAll(/\S+\.test\.tsx?/g)) {
      running.add(posix.join(dir.split(sep).join("/"), file));
    }
  }
  return running;
}

test("every *.test.ts in the repo is run by test:unit", () => {
  const running = testsRunByUnitScript();
  const files = ["apps", "packages", "scripts"]
    .filter((dir) => existsSync(join(REPO_ROOT, dir)))
    .flatMap((dir) => findTestFiles(join(REPO_ROOT, dir)))
    .map((file) => relative(REPO_ROOT, file).split(sep).join("/"));
  assert.ok(files.length >= 25, `only ${files.length} test files found: is the walk broken?`);
  assert.deepEqual(
    files.filter((file) => !running.has(file)),
    [],
    "test files outside every test script: add them to their package's `test` script, " +
      "and the package to the root `test:unit`",
  );
});

test("every test a script names exists: a stale entry fails only at run time", () => {
  for (const file of testsRunByUnitScript()) {
    assert.ok(existsSync(join(REPO_ROOT, file)), `${file} is listed but missing`);
  }
});

test("CI and the release workflow run test:unit", () => {
  for (const workflow of ["ci.yml", "release.yml"]) {
    const text = readFileSync(join(REPO_ROOT, ".github", "workflows", workflow), "utf8");
    assert.match(text, /yarn test:unit/, workflow);
  }
});
