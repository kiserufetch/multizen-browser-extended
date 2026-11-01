import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "./ProfileManager.js";

async function withDir<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "mz-reconcile-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Creates profiles under `old`, then reopens the same database with `next` as its root. */
function movedDb(dir: string, names: string[], mkdirUnderNew: (id: string) => boolean) {
  const dbPath = join(dir, "profiles.db");
  const oldRoot = join(dir, "old");
  const newRoot = join(dir, "new");
  const before = new ProfileManager({ dbPath, profilesRoot: oldRoot });
  const profiles = names.map((name) => before.create({ name }));
  before.close();
  for (const p of profiles) {
    if (mkdirUnderNew(p.id)) mkdirSync(join(newRoot, p.id), { recursive: true });
  }
  return { pm: new ProfileManager({ dbPath, profilesRoot: newRoot }), profiles, newRoot };
}

test("rows inside the root are left alone", async () => {
  await withDir((dir) => {
    const pm = new ProfileManager({
      dbPath: join(dir, "profiles.db"),
      profilesRoot: join(dir, "profiles"),
    });
    const profile = pm.create({ name: "a" });
    try {
      assert.deepEqual(pm.reconcileDataDirs(), { rebased: [], unresolved: [] });
      assert.equal(pm.get(profile.id)?.dataDir, profile.dataDir);
    } finally {
      pm.close();
    }
  });
});

test("a row outside the root is rebased when its directory exists under it", async () => {
  await withDir((dir) => {
    const { pm, profiles, newRoot } = movedDb(dir, ["a"], () => true);
    try {
      const id = profiles[0]!.id;
      assert.deepEqual(pm.reconcileDataDirs(), { rebased: [id], unresolved: [] });
      assert.equal(pm.get(id)?.dataDir, join(newRoot, id));
      // Now inside the root, so nothing further to do.
      assert.deepEqual(pm.reconcileDataDirs(), { rebased: [], unresolved: [] });
    } finally {
      pm.close();
    }
  });
});

test("a row with no directory under the root is reported, with nothing written", async () => {
  await withDir((dir) => {
    const present = new Set<string>();
    let first = true;
    const { pm, profiles, newRoot } = movedDb(dir, ["has-dir", "no-dir"], (id) => {
      if (first) present.add(id);
      first = false;
      return present.has(id);
    });
    try {
      const [hasDir, noDir] = profiles as [(typeof profiles)[0], (typeof profiles)[0]];
      const result = pm.reconcileDataDirs();
      assert.deepEqual(result.rebased, []);
      assert.deepEqual(result.unresolved, [
        {
          id: noDir.id,
          name: "no-dir",
          dataDir: noDir.dataDir,
          expected: join(newRoot, noDir.id),
        },
      ]);
      // All-or-nothing: the rebasable row keeps its old path too.
      assert.equal(pm.get(hasDir.id)?.dataDir, hasDir.dataDir);
    } finally {
      pm.close();
    }
  });
});

test("a sibling sharing the root's prefix counts as outside", async () => {
  await withDir((dir) => {
    const dbPath = join(dir, "profiles.db");
    const before = new ProfileManager({ dbPath, profilesRoot: join(dir, "profiles-old") });
    const profile = before.create({ name: "a" });
    before.close();
    const pm = new ProfileManager({ dbPath, profilesRoot: join(dir, "profiles") });
    try {
      const result = pm.reconcileDataDirs();
      assert.equal(result.unresolved[0]?.id, profile.id);
    } finally {
      pm.close();
    }
  });
});
