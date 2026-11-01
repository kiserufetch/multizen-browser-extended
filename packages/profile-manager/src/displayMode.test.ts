import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { Profile } from "@multizen/types";
import { exportProfile } from "./archive.js";
import { exportProfileToArchive, importProfileFromArchive } from "./transfer.js";
import { ProfileManager } from "./ProfileManager.js";

const removeDir = (dir: string): void =>
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "mz-dm-"));
  t.after(() => removeDir(dir));
  return dir;
}

function open(t: TestContext): { pm: ProfileManager; dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "mz-dm-"));
  const dbPath = join(dir, "profiles.db");
  const pm = new ProfileManager({ dbPath, profilesRoot: join(dir, "profiles") });
  // Windows can't remove a database that is still open.
  t.after(() => {
    pm.close();
    removeDir(dir);
  });
  return { pm, dir, dbPath };
}

function columnNames(dbPath: string): string[] {
  const db = new Database(dbPath);
  try {
    return (db.prepare(`PRAGMA table_info(profiles)`).all() as Array<{ name: string }>).map((c) => c.name);
  } finally {
    db.close();
  }
}

/** A database as a release from before this column left it, with one real row. */
function legacyDatabase(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, notes TEXT, tags TEXT NOT NULL DEFAULT '[]',
      proxy TEXT, fingerprint TEXT NOT NULL, data_dir TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_opened_at TEXT,
      proxy_country TEXT, extensions TEXT, icon TEXT, start_url TEXT, search_provider TEXT,
      align_timezone_to_proxy INTEGER, strict_geo_coherence INTEGER, engine TEXT
    );
  `);
  db.prepare(
    `INSERT INTO profiles (id, name, tags, fingerprint, data_dir, created_at, updated_at, engine)
     VALUES ('old', 'Old', '[]', '{"timezone":"UTC","device":"windows-laptop-intel"}', 'x', 'c', 'u', 'camoufox')`,
  ).run();
  db.close();
}

test("migration: a real older database gains the column, and its row follows the default", (t) => {
  const dir = tempDir(t);
  const dbPath = join(dir, "profiles.db");
  legacyDatabase(dbPath);
  assert.equal(columnNames(dbPath).includes("display_mode"), false);

  const pm = new ProfileManager({ dbPath, profilesRoot: join(dir, "profiles") });
  assert.equal(columnNames(dbPath).includes("display_mode"), true);
  const row = pm.get("old")!;
  assert.equal(row.displayMode, undefined);
  assert.equal(row.engine, "camoufox", "the older columns are untouched");
  assert.equal(pm.list()[0]!.displayMode, undefined);
  pm.close();
});

test("migration is idempotent: reopening keeps both the column and the values", (t) => {
  const dir = tempDir(t);
  const dbPath = join(dir, "profiles.db");
  legacyDatabase(dbPath);
  const opts = { dbPath, profilesRoot: join(dir, "profiles") };
  const first = new ProfileManager(opts);
  first.update("old", { displayMode: "headless" });
  first.close();

  const second = new ProfileManager(opts);
  second.close();
  const third = new ProfileManager(opts);
  assert.equal(third.get("old")!.displayMode, "headless");
  assert.equal(columnNames(dbPath).filter((c) => c === "display_mode").length, 1);
  third.close();
});

test("create: stored and returned, and absent stays absent", (t) => {
  const { pm } = open(t);
  const set = pm.create({ name: "a", displayMode: "headless" });
  assert.equal(set.displayMode, "headless");
  assert.equal(pm.get(set.id)!.displayMode, "headless");

  const unset = pm.create({ name: "b" });
  assert.equal(unset.displayMode, undefined);
  assert.equal(pm.get(unset.id)!.displayMode, undefined);
});

test("list carries it, in its own explicit SELECT", (t) => {
  const { pm } = open(t);
  const a = pm.create({ name: "a", displayMode: "xvfb" });
  const b = pm.create({ name: "b" });
  const byId = new Map(pm.list().map((p) => [p.id, p]));
  assert.equal(byId.get(a.id)!.displayMode, "xvfb");
  assert.equal(byId.get(b.id)!.displayMode, undefined);
});

test("update: sets, keeps when omitted, and null clears", (t) => {
  const { pm } = open(t);
  const { id } = pm.create({ name: "a" });

  assert.equal(pm.update(id, { displayMode: "headless" }).displayMode, "headless");
  assert.equal(pm.get(id)!.displayMode, "headless");

  assert.equal(pm.update(id, { name: "renamed" }).displayMode, "headless", "an unrelated edit");
  assert.equal(pm.get(id)!.displayMode, "headless");

  assert.equal(pm.update(id, { displayMode: null }).displayMode, undefined);
  assert.equal(pm.get(id)!.displayMode, undefined);
});

test("insertImported writes it verbatim", (t) => {
  const { pm, dir } = open(t);
  const template = pm.create({ name: "t" });
  const imported: Profile = {
    ...pm.get(template.id)!,
    id: "imported",
    dataDir: join(dir, "profiles", "imported"),
    displayMode: "xvfb",
  };
  assert.equal(pm.insertImported(imported).displayMode, "xvfb");
  assert.equal(pm.get("imported")!.displayMode, "xvfb");
  assert.equal(pm.list().find((p) => p.id === "imported")!.displayMode, "xvfb");
});

test("a stored value this build can't run reads as unset, in get and in list", (t) => {
  const { pm, dbPath } = open(t);
  const { id } = pm.create({ name: "a", displayMode: "headless" });
  const db = new Database(dbPath);
  db.prepare(`UPDATE profiles SET display_mode = 'holographic' WHERE id = ?`).run(id);
  db.close();
  assert.equal(pm.get(id)!.displayMode, undefined);
  assert.equal(pm.list()[0]!.displayMode, undefined);
});

// ── .mzar ────────────────────────────────────────────────────────────────────

const PASSPHRASE = "a passphrase long enough";

test(".mzar carries the mode across machines", async (t) => {
  const from = open(t);
  const to = open(t);
  const source = from.pm.create({ name: "moved", displayMode: "headless" });
  writeFileSync(join(source.dataDir, "file"), "x");
  const archive = join(from.dir, "a.mzar");
  await exportProfileToArchive(from.pm.get(source.id)!, PASSPHRASE, archive, join(from.dir, "store"));

  const { id } = await importProfileFromArchive(to.pm, archive, PASSPHRASE, {
    profilesRoot: join(to.dir, "profiles"),
    extensionStoreRoot: join(to.dir, "store"),
    defaultEngine: "cloakbrowser",
  });
  assert.equal(to.pm.get(id)!.displayMode, "headless");
  assert.equal(to.pm.list()[0]!.displayMode, "headless");
});

test(".mzar without a mode stays unset; one with a mode this build doesn't know follows the default", async (t) => {
  const from = open(t);
  const to = open(t);
  const options = {
    profilesRoot: join(to.dir, "profiles"),
    extensionStoreRoot: join(to.dir, "store"),
    defaultEngine: "cloakbrowser" as const,
  };

  const plain = from.pm.create({ name: "plain" });
  const plainArchive = join(from.dir, "plain.mzar");
  await exportProfile(from.pm.get(plain.id)!, PASSPHRASE, plainArchive, {});
  const imported = await importProfileFromArchive(to.pm, plainArchive, PASSPHRASE, options);
  assert.equal(to.pm.get(imported.id)!.displayMode, undefined);

  const odd = from.pm.create({ name: "odd" });
  const oddArchive = join(from.dir, "odd.mzar");
  await exportProfile(
    { ...from.pm.get(odd.id)!, displayMode: "holographic" } as unknown as Profile,
    PASSPHRASE,
    oddArchive,
    {},
  );
  const oddImported = await importProfileFromArchive(to.pm, oddArchive, PASSPHRASE, options);
  assert.equal(to.pm.get(oddImported.id)!.displayMode, undefined);
  const raw = new Database(join(to.dir, "profiles.db"));
  const row = raw.prepare(`SELECT display_mode FROM profiles WHERE id = ?`).get(oddImported.id) as {
    display_mode: string | null;
  };
  raw.close();
  assert.equal(row.display_mode, null, "not even stored");
});
