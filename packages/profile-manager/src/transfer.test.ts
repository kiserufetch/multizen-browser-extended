import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserEngine, CreateProfileInput, ExtensionConfig } from "@multizen/types";
import { ProfileManager } from "./ProfileManager.js";
import { exportProfile } from "./archive.js";
import {
  archiveFileName,
  exportProfileToArchive,
  importProfileFromArchive,
} from "./transfer.js";

interface Side {
  root: string;
  profilesRoot: string;
  extensionStoreRoot: string;
  pm: ProfileManager;
}

function openSide(root: string): Side {
  const profilesRoot = join(root, "profiles");
  return {
    root,
    profilesRoot,
    extensionStoreRoot: join(root, "extension-store"),
    pm: new ProfileManager({ dbPath: join(root, "profiles.db"), profilesRoot }),
  };
}

async function withSides<T>(fn: (from: Side, to: Side, dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "mz-transfer-"));
  const from = openSide(join(dir, "from"));
  const to = openSide(join(dir, "to"));
  try {
    return await fn(from, to, dir);
  } finally {
    from.pm.close();
    to.pm.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const sharedExt: ExtensionConfig = {
  id: "abc",
  name: "Ext",
  version: "1.0",
  scope: "shared",
  enabled: true,
  dir: "",
  source: "file",
};

function create(side: Side, input: Partial<CreateProfileInput> = {}) {
  return side.pm.create({ name: "My profile/1", engine: "cloakbrowser", ...input });
}

test("archiveFileName replaces path-hostile runs", () => {
  assert.equal(archiveFileName({ name: "My profile/1" }), "My_profile_1.mzar");
  assert.equal(archiveFileName({ name: "..\\..\\evil" }), "_evil.mzar");
});

test("export then import restores files and the row, keeping a free id", async () => {
  await withSides(async (from, to, dir) => {
    const profile = create(from);
    mkdirSync(join(profile.dataDir, "engines", "cloakbrowser"), { recursive: true });
    writeFileSync(join(profile.dataDir, "engines", "cloakbrowser", "Cookies"), "cookie-bytes");
    const archive = join(dir, "p.mzar");

    await exportProfileToArchive(profile, "pw", archive, from.extensionStoreRoot);
    const { id, unavailableEngine } = await importProfileFromArchive(to.pm, archive, "pw", {
      profilesRoot: to.profilesRoot,
      extensionStoreRoot: to.extensionStoreRoot,
      defaultEngine: "cloakbrowser",
    });

    assert.equal(id, profile.id);
    assert.equal(unavailableEngine, undefined);
    const imported = to.pm.get(id);
    assert.equal(imported?.name, profile.name);
    assert.equal(imported?.dataDir, join(to.profilesRoot, id));
    assert.equal(
      readFileSync(join(imported!.dataDir, "engines", "cloakbrowser", "Cookies"), "utf8"),
      "cookie-bytes",
    );
  });
});

test("export bundles shared extensions, import restores them to the store", async () => {
  await withSides(async (from, to, dir) => {
    const entry = join(from.extensionStoreRoot, sharedExt.id, sharedExt.version);
    mkdirSync(entry, { recursive: true });
    writeFileSync(join(entry, "manifest.json"), "{}");
    const profile = create(from, { extensions: [sharedExt] });
    const archive = join(dir, "p.mzar");

    await exportProfileToArchive(profile, "pw", archive, from.extensionStoreRoot);
    await importProfileFromArchive(to.pm, archive, "pw", {
      profilesRoot: to.profilesRoot,
      extensionStoreRoot: to.extensionStoreRoot,
      defaultEngine: "cloakbrowser",
    });

    assert.equal(
      existsSync(join(to.extensionStoreRoot, sharedExt.id, sharedExt.version, "manifest.json")),
      true,
    );
  });
});

test("importing onto a taken id mints a new one and leaves the existing profile", async () => {
  await withSides(async (from, to, dir) => {
    const profile = create(from);
    const archive = join(dir, "p.mzar");
    await exportProfileToArchive(profile, "pw", archive, from.extensionStoreRoot);

    const opts = {
      profilesRoot: to.profilesRoot,
      extensionStoreRoot: to.extensionStoreRoot,
      defaultEngine: "cloakbrowser" as BrowserEngine,
    };
    const first = await importProfileFromArchive(to.pm, archive, "pw", opts);
    const second = await importProfileFromArchive(to.pm, archive, "pw", opts);

    assert.notEqual(second.id, first.id);
    assert.equal(to.pm.list().length, 2);
  });
});

test("an engine this build lacks is cleared, reported and pinned to the default", async () => {
  await withSides(async (from, to, dir) => {
    const profile = create(from);
    const archive = join(dir, "p.mzar");
    await exportProfile({ ...profile, engine: "cft" as BrowserEngine }, "pw", archive);

    const { id, unavailableEngine } = await importProfileFromArchive(to.pm, archive, "pw", {
      profilesRoot: to.profilesRoot,
      extensionStoreRoot: to.extensionStoreRoot,
      defaultEngine: "camoufox",
    });

    assert.equal(unavailableEngine, "cft");
    assert.equal(to.pm.get(id)?.engine, "camoufox");
  });
});

test("an archive with no recorded engine is pinned to the default, silently", async () => {
  await withSides(async (from, to, dir) => {
    const profile = create(from);
    const archive = join(dir, "p.mzar");
    await exportProfile({ ...profile, engine: undefined }, "pw", archive);

    const { id, unavailableEngine } = await importProfileFromArchive(to.pm, archive, "pw", {
      profilesRoot: to.profilesRoot,
      extensionStoreRoot: to.extensionStoreRoot,
      defaultEngine: "camoufox",
    });

    assert.equal(unavailableEngine, undefined);
    assert.equal(to.pm.get(id)?.engine, "camoufox");
  });
});

test("a wrong passphrase rejects and inserts nothing", async () => {
  await withSides(async (from, to, dir) => {
    const archive = join(dir, "p.mzar");
    await exportProfileToArchive(create(from), "pw", archive, from.extensionStoreRoot);
    await assert.rejects(
      importProfileFromArchive(to.pm, archive, "wrong", {
        profilesRoot: to.profilesRoot,
        extensionStoreRoot: to.extensionStoreRoot,
        defaultEngine: "cloakbrowser",
      }),
      /Wrong passphrase/,
    );
    assert.equal(to.pm.list().length, 0);
  });
});
