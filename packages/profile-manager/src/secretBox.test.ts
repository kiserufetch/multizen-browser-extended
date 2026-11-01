import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { ProxyConfig } from "@multizen/types";
import { ProfileManager, type ProfileManagerOptions } from "./ProfileManager.js";
import {
  createSecretBox,
  generateSecretKey,
  isSealed,
  parseSecretKey,
  SecretKeyError,
} from "./secretBox.js";
import { exportProfileToArchive, importProfileFromArchive } from "./transfer.js";

const SECRET = "hunter2-very-distinctive-password";
const proxy = (password = SECRET): ProxyConfig => ({
  type: "socks5",
  host: "proxy.test",
  port: 1080,
  username: "user-name",
  password,
});

interface Rig {
  dir: string;
  dbPath: string;
  profilesRoot: string;
  open(opts?: Partial<ProfileManagerOptions>): ProfileManager;
  /** The column as stored, read with no ProfileManager in between. */
  storedProxy(id: string): ProxyConfig;
}

function withRig(run: (rig: Rig) => void | Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "mz-secret-"));
    const dbPath = join(dir, "profiles.db");
    const profilesRoot = join(dir, "profiles");
    try {
      await run({
        dir,
        dbPath,
        profilesRoot,
        open: (opts = {}) => new ProfileManager({ dbPath, profilesRoot, ...opts }),
        storedProxy: (id) => {
          const db = new Database(dbPath, { readonly: true });
          try {
            const row = db.prepare(`SELECT proxy FROM profiles WHERE id = ?`).get(id) as { proxy: string };
            return JSON.parse(row.proxy) as ProxyConfig;
          } finally {
            db.close();
          }
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  };
}

function bytesOf(path: string): Buffer {
  return existsSync(path) ? readFileSync(path) : Buffer.alloc(0);
}

function holdsSecret(path: string, secret = SECRET): boolean {
  return bytesOf(path).includes(secret);
}

test("seal and open round-trip; the format; a fresh IV each time", () => {
  const box = createSecretBox(generateSecretKey());
  for (const plaintext of [SECRET, "", "пароль 🔑", "x".repeat(10_000)]) {
    const sealed = box.seal(plaintext);
    assert.match(sealed, /^mzenc:v1:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]*$/);
    assert.ok(isSealed(sealed));
    assert.equal(box.open(sealed), plaintext);
    assert.equal(sealed.includes(plaintext) && plaintext !== "", false);
  }
  assert.notEqual(box.seal(SECRET), box.seal(SECRET));
});

test("a wrong key or a changed byte is refused with a clear error", () => {
  const box = createSecretBox(generateSecretKey());
  const sealed = box.seal(SECRET);
  assert.throws(() => createSecretBox(generateSecretKey()).open(sealed), SecretKeyError);
  const parts = sealed.split(":");
  const tampered = [...parts.slice(0, -1), Buffer.from("tampered").toString("base64url")].join(":");
  assert.throws(() => box.open(tampered), SecretKeyError);
  assert.throws(() => box.open(SECRET), SecretKeyError);
});

test("isSealed tells a sealed value from a password that merely starts the same", () => {
  assert.equal(isSealed("mzenc:v1:not really"), false);
  assert.equal(isSealed("mzenc:v1:a:b:c"), false);
  assert.equal(isSealed(SECRET), false);
  assert.equal(isSealed(""), false);
});

test("keys come in hex or base64, 32 bytes, and a refusal shows no part of the value", () => {
  const key = generateSecretKey();
  assert.deepEqual(parseSecretKey(key.toString("hex")), key);
  assert.deepEqual(parseSecretKey(key.toString("hex").toUpperCase()), key);
  assert.deepEqual(parseSecretKey(key.toString("base64")), key);
  assert.deepEqual(parseSecretKey(`  ${key.toString("base64url")}\n`), key);
  for (const bad of ["short", "", "ab".repeat(16), "ab".repeat(33)]) {
    assert.throws(
      () => parseSecretKey(bad),
      (e: unknown) => {
        assert.ok(e instanceof SecretKeyError);
        assert.equal(bad !== "" && e.message.includes(bad), false);
        return true;
      },
    );
  }
  assert.throws(() => createSecretBox(Buffer.alloc(16)), SecretKeyError);
});

test(
  "with a box: sealed in the column at every write, plain to every reader",
  withRig(({ open, storedProxy }) => {
    const box = createSecretBox(generateSecretKey());
    const pm = open({ secrets: box });
    const created = pm.create({ name: "a", proxy: proxy() });
    pm.close();
    const stored = storedProxy(created.id);
    assert.ok(isSealed(stored.password ?? ""));
    assert.equal(stored.username, "user-name", "only the password is sealed");
    assert.equal(stored.host, "proxy.test");

    const reopened = open({ secrets: box });
    assert.equal(created.proxy?.password, SECRET);
    assert.equal(reopened.get(created.id)?.proxy?.password, SECRET);
    assert.equal(reopened.list()[0]?.proxy?.password, SECRET);

    const updated = reopened.update(created.id, { proxy: proxy("changed-password") });
    assert.equal(updated.proxy?.password, "changed-password");
    assert.equal(reopened.get(created.id)?.proxy?.password, "changed-password");
    reopened.close();
    assert.ok(isSealed(storedProxy(created.id).password ?? ""));
  }),
);

test(
  "an unrelated update keeps it sealed, and doesn't count as the proxy changing",
  withRig(({ open, storedProxy }) => {
    const pm = open({ secrets: createSecretBox(generateSecretKey()) });
    const { id } = pm.create({ name: "a", proxy: proxy() });
    pm.setProxyCountry(id, "DE");
    const before = storedProxy(id).password;
    assert.equal(pm.update(id, { name: "b" }).proxyCountry, "DE");
    pm.update(id, { proxy: proxy() });
    assert.equal(pm.get(id)?.proxyCountry, "DE");
    pm.close();
    assert.ok(isSealed(storedProxy(id).password ?? ""));
    assert.notEqual(storedProxy(id).password, before, "a write seals afresh");
  }),
);

test(
  "a proxy with no password has nothing to seal",
  withRig(({ open, storedProxy }) => {
    const pm = open({ secrets: createSecretBox(generateSecretKey()) });
    const { password: _password, ...noPassword } = proxy();
    const { id } = pm.create({ name: "a", proxy: noPassword });
    assert.deepEqual(pm.storedSecrets(), { sealed: 0, plaintext: 0 });
    pm.close();
    assert.equal(storedProxy(id).password, undefined);
  }),
);

test(
  "without a box nothing changes: the desktop's plaintext goes in and comes out as it was",
  withRig(({ open, storedProxy }) => {
    const pm = open();
    const { id } = pm.create({ name: "a", proxy: proxy() });
    assert.equal(pm.get(id)?.proxy?.password, SECRET);
    pm.update(id, { proxy: proxy("other") });
    assert.equal(pm.list()[0]?.proxy?.password, "other");
    pm.close();
    assert.equal(storedProxy(id).password, "other");
  }),
);

test(
  "a sealed value with no box is a clear error, not a garbled password handed to a proxy",
  withRig(({ open }) => {
    const pm = open({ secrets: createSecretBox(generateSecretKey()) });
    const { id } = pm.create({ name: "a", proxy: proxy() });
    pm.close();
    const locked = open();
    assert.throws(() => locked.get(id), /encrypted proxy passwords and no secret key/);
    assert.throws(() => locked.list(), SecretKeyError);
    assert.deepEqual(locked.storedSecrets(), { sealed: 1, plaintext: 0 });
    locked.close();
  }),
);

test(
  "plaintext rows still read, then seal on write or in bulk, and old bytes leave the DB and the WAL",
  withRig(({ open, dbPath, storedProxy }) => {
    // As an older build or the desktop left it.
    const legacy = open();
    const a = legacy.create({ name: "a", proxy: proxy() });
    const b = legacy.create({ name: "b", proxy: proxy(`${SECRET}-b`) });
    legacy.create({ name: "c" });
    legacy.close();
    assert.ok(holdsSecret(dbPath), "the check below has to be able to fail");

    const pm = open({ secrets: createSecretBox(generateSecretKey()) });
    assert.equal(pm.get(a.id)?.proxy?.password, SECRET, "reads with no migration yet");
    assert.deepEqual(pm.storedSecrets(), { sealed: 0, plaintext: 2 });
    assert.equal(pm.sealStoredSecrets(), 2);
    assert.deepEqual(pm.storedSecrets(), { sealed: 2, plaintext: 0 });

    // Sealed but not purged: this is the state B29 is about.
    const walBeforePurge = holdsSecret(`${dbPath}-wal`) || holdsSecret(dbPath);
    assert.ok(walBeforePurge, "an UPDATE alone leaves the old value on disk");
    pm.purgeOldValues();

    // While the database is open, and again once it is closed.
    for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      assert.equal(holdsSecret(file), false, `${file} still holds the password`);
    }
    assert.equal(statSync(`${dbPath}-wal`).size, 0);
    assert.equal(pm.sealStoredSecrets(), 0, "and it is idempotent");
    pm.close();
    for (const file of [dbPath, `${dbPath}-wal`]) assert.equal(holdsSecret(file), false, file);
    assert.ok(isSealed(storedProxy(b.id).password ?? ""));
  }),
);

test(
  "the bulk pass names the profile a wrong key can't open, and changes nothing",
  withRig(({ open, storedProxy }) => {
    const pm = open({ secrets: createSecretBox(generateSecretKey()) });
    const { id } = pm.create({ name: "a", proxy: proxy() });
    pm.close();

    const legacy = new Database(join(pm["profilesRoot"], "..", "profiles.db"));
    legacy
      .prepare(`INSERT INTO profiles (id, name, tags, proxy, fingerprint, data_dir, created_at, updated_at)
                VALUES ('plain', 'p', '[]', ?, '{}', 'd', 'x', 'x')`)
      .run(JSON.stringify(proxy()));
    legacy.close();

    const wrong = open({ secrets: createSecretBox(generateSecretKey()) });
    assert.throws(() => wrong.sealStoredSecrets(), (e: unknown) => {
      assert.ok(e instanceof SecretKeyError);
      assert.match(e.message, new RegExp(id));
      return true;
    });
    assert.equal(wrong.storedSecrets().plaintext, 1, "all or nothing");
    wrong.close();
    assert.equal(storedProxy("plain").password, SECRET);
  }),
);

test(
  "rotation: every value moves to the new key, the old key opens nothing",
  withRig(({ open, dbPath, storedProxy }) => {
    const oldBox = createSecretBox(generateSecretKey());
    const newBox = createSecretBox(generateSecretKey());
    const pm = open({ secrets: oldBox });
    const a = pm.create({ name: "a", proxy: proxy() });
    const b = pm.create({ name: "b", proxy: proxy("second") });
    const stale = storedProxy(a.id).password!;

    assert.equal(pm.rotateStoredSecrets(newBox), 2);
    pm.purgeOldValues();
    assert.equal(pm.get(a.id)?.proxy?.password, SECRET, "the manager moved with it");
    assert.equal(pm.canOpenStoredSecrets(newBox), true);
    assert.equal(pm.canOpenStoredSecrets(oldBox), false);
    assert.equal(holdsSecret(dbPath, stale), false, "the old ciphertext is gone from the file");
    assert.equal(holdsSecret(`${dbPath}-wal`, stale), false);
    pm.close();

    assert.equal(newBox.open(storedProxy(b.id).password!), "second");
    assert.throws(() => oldBox.open(storedProxy(b.id).password!), SecretKeyError);
  }),
);

test(
  "a .mzar stays decrypted inside its own passphrase, and a new home seals it with its own key",
  withRig(async ({ dir, open, storedProxy }) => {
    const archive = join(dir, "out.mzar");
    const source = open({ secrets: createSecretBox(generateSecretKey()) });
    const profile = source.create({ name: "a", engine: "cloakbrowser", proxy: proxy() });
    await exportProfileToArchive(source.get(profile.id)!, "pass", archive, join(dir, "store"));
    source.delete(profile.id);
    source.close();
    assert.equal(holdsSecret(archive), false, "the archive itself is encrypted");

    const homeKey = createSecretBox(generateSecretKey());
    const target = open({ secrets: homeKey });
    const { id } = await importProfileFromArchive(target, archive, "pass", {
      profilesRoot: join(dir, "profiles"),
      extensionStoreRoot: join(dir, "store"),
      defaultEngine: "cloakbrowser",
    });
    assert.equal(target.get(id)?.proxy?.password, SECRET);
    target.close();
    assert.equal(homeKey.open(storedProxy(id).password!), SECRET);
  }),
);
