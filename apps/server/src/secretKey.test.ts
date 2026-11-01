import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSecretBox,
  generateSecretKey,
  isSealed,
  parseSecretKey,
  ProfileManager,
  SecretKeyError,
} from "@multizen/profile-manager";
import type { ProxyConfig } from "@multizen/types";
import { runSecrets } from "./commands/secrets.ts";
import { dataPaths, UsageError } from "./config.ts";
import { openProfiles } from "./runtime.ts";
import { pendingKeyPath, SECRET_KEY_ENV, NEXT_SECRET_KEY_ENV, writeKeyFile } from "./secretKey.ts";
import { ShutdownManager } from "./shutdown.ts";

const SECRET = "hunter2-very-distinctive-password";
const proxy = (password = SECRET): ProxyConfig => ({
  type: "socks5",
  host: "proxy.test",
  port: 1080,
  username: "user-name",
  password,
});

function withDir(run: (dir: string) => void | Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "mz-key-"));
    try {
      await run(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  };
}

/** A data dir as older code or a desktop database would leave it: passwords in plaintext. */
function legacyRow(dir: string, password = SECRET): string {
  const { dbPath, profilesRoot } = dataPaths(dir);
  const pm = new ProfileManager({ dbPath, profilesRoot });
  const { id } = pm.create({ name: "legacy", proxy: proxy(password) });
  pm.close();
  return id;
}

function bytesHold(path: string, text: string): boolean {
  return existsSync(path) && readFileSync(path).includes(text);
}

/** The one sealed password of a closed data dir, as the database file holds it. */
function storedPassword(dir: string): string {
  const sealed = /mzenc:v1:[A-Za-z0-9_:-]+/.exec(readFileSync(dataPaths(dir).dbPath, "latin1"))?.[0];
  assert.ok(sealed, "no sealed value in the database file");
  return sealed;
}

/** A data dir with one sealed password, under a key it returns. */
function sealedDir(dir: string): { id: string; key: Buffer } {
  const pm = openProfiles(dir, {});
  const { id } = pm.create({ name: "sealed", proxy: proxy() });
  pm.close();
  return { id, key: parseSecretKey(readFileSync(dataPaths(dir).secretKeyPath, "utf8")) };
}

async function rotate(dir: string, env: Record<string, string | undefined> = {}): Promise<void> {
  const shutdown = new ShutdownManager({ exit: () => {} });
  try {
    await runSecrets({ action: "rotate", dataDir: dir }, shutdown, env);
  } finally {
    await shutdown.run("done", 0);
  }
}

test(
  "a fresh data dir gets a key file, and what goes in comes out, sealed on disk",
  withDir((dir) => {
    const { secretKeyPath, dbPath } = dataPaths(dir);
    const pm = openProfiles(dir, {});
    assert.equal(existsSync(secretKeyPath), true);
    assert.match(readFileSync(secretKeyPath, "utf8"), /^[0-9a-f]{64}$/);
    if (process.platform !== "win32") assert.equal(statSync(secretKeyPath).mode & 0o777, 0o600);

    const { id } = pm.create({ name: "a", proxy: proxy() });
    assert.equal(pm.get(id)?.proxy?.password, SECRET);
    pm.close();
    assert.equal(bytesHold(dbPath, SECRET), false);
    assert.equal(bytesHold(`${dbPath}-wal`, SECRET), false);

    const again = openProfiles(dir, {});
    assert.equal(again.get(id)?.proxy?.password, SECRET);
    again.close();
  }),
);

test(
  "plaintext is sealed at start, and the real DB and WAL bytes hold no trace of it",
  withDir((dir) => {
    const id = legacyRow(dir);
    const { dbPath } = dataPaths(dir);
    assert.equal(bytesHold(dbPath, SECRET), true, "the check has to be able to fail");

    const pm = openProfiles(dir, {});
    // While it is running, which is when a copy of the volume could be taken.
    assert.equal(bytesHold(dbPath, SECRET), false, "main database file");
    assert.equal(bytesHold(`${dbPath}-wal`, SECRET), false, "WAL");
    assert.equal(statSync(`${dbPath}-wal`).size, 0, "the WAL was truncated");
    assert.equal(pm.get(id)?.proxy?.password, SECRET);
    assert.deepEqual(pm.storedSecrets(), { sealed: 1, plaintext: 0 });
    pm.close();

    assert.equal(bytesHold(dbPath, SECRET), false, "after closing");
    assert.equal(bytesHold(`${dbPath}-wal`, SECRET), false, "after closing");
  }),
);

test(
  "the old bytes go even if an earlier start sealed them and died before the purge",
  withDir((dir) => {
    const id = legacyRow(dir);
    const { dbPath, profilesRoot, secretKeyPath } = dataPaths(dir);
    const key = generateSecretKey();
    writeKeyFile(secretKeyPath, key);
    const crashed = new ProfileManager({ dbPath, profilesRoot, secrets: createSecretBox(key) });
    assert.equal(crashed.sealStoredSecrets(), 1);
    crashed.close();

    const pm = openProfiles(dir, {});
    assert.equal(pm.get(id)?.proxy?.password, SECRET);
    assert.equal(bytesHold(dbPath, SECRET), false);
    assert.equal(bytesHold(`${dbPath}-wal`, SECRET), false);
    pm.close();
  }),
);

test(
  "the environment's key wins, in hex or base64, leaves the environment, and writes no file",
  withDir((dir) => {
    const key = generateSecretKey();
    for (const form of [key.toString("hex"), key.toString("base64")]) {
      const env = { [SECRET_KEY_ENV]: form, OTHER: "kept" };
      const pm = openProfiles(dir, env);
      pm.create({ name: "a", proxy: proxy() });
      pm.close();
      assert.deepEqual(env, { OTHER: "kept" });
    }
    assert.equal(existsSync(dataPaths(dir).secretKeyPath), false);

    const reopened = openProfiles(dir, { [SECRET_KEY_ENV]: key.toString("hex") });
    assert.equal(reopened.list().length, 2);
    reopened.close();
  }),
);

test(
  "a key in the environment that isn't one is refused, with no part of it in the message",
  withDir((dir) => {
    const env = { [SECRET_KEY_ENV]: "not-a-real-key-value" };
    assert.throws(
      () => openProfiles(dir, env),
      (e: unknown) => {
        assert.ok(e instanceof SecretKeyError);
        assert.equal(e.message.includes("not-a-real-key-value"), false);
        return true;
      },
    );
    assert.deepEqual(env, {}, "gone from the environment either way");
  }),
);

test(
  "encrypted values with no key: a clear error, and no new key to hide the problem",
  withDir((dir) => {
    sealedDir(dir);
    const { secretKeyPath, dbPath } = dataPaths(dir);
    rmSync(secretKeyPath);
    assert.throws(
      () => openProfiles(dir, {}),
      (e: unknown) => {
        assert.ok(e instanceof SecretKeyError);
        assert.match(e.message, /1 proxy password/);
        assert.match(e.message, /MULTIZEN_SECRET_KEY/);
        assert.ok(e.message.includes(secretKeyPath));
        assert.ok(e.message.includes(dbPath));
        return true;
      },
    );
    assert.equal(existsSync(secretKeyPath), false);
  }),
);

test(
  "the wrong key: refused at start, naming the profile, with nothing changed",
  withDir((dir) => {
    const { id } = sealedDir(dir);
    const before = storedPassword(dir);
    writeKeyFile(dataPaths(dir).secretKeyPath, generateSecretKey());
    assert.throws(() => openProfiles(dir, {}), new RegExp(id));
    assert.equal(storedPassword(dir), before);
  }),
);

test(
  "secrets rotate: a new key file, every value moved, the old key useless",
  withDir(async (dir) => {
    const { id, key: oldKey } = sealedDir(dir);
    const { secretKeyPath, dbPath } = dataPaths(dir);
    const oldSealed = storedPassword(dir);
    assert.ok(isSealed(oldSealed));
    assert.equal(createSecretBox(oldKey).open(oldSealed), SECRET);

    await rotate(dir);

    const newKey = parseSecretKey(readFileSync(secretKeyPath, "utf8"));
    assert.notDeepEqual(newKey, oldKey);
    assert.equal(existsSync(pendingKeyPath(secretKeyPath)), false);
    assert.equal(existsSync(join(dir, "server.lock")), false);
    assert.equal(bytesHold(dbPath, oldSealed), false, "the old ciphertext left the file");
    assert.equal(bytesHold(`${dbPath}-wal`, oldSealed), false, "and the WAL");

    const newSealed = storedPassword(dir);
    assert.equal(createSecretBox(newKey).open(newSealed), SECRET);
    assert.throws(() => createSecretBox(oldKey).open(newSealed), SecretKeyError);

    const pm = openProfiles(dir, {});
    assert.equal(pm.get(id)?.proxy?.password, SECRET);
    pm.close();
  }),
);

test(
  "secrets rotate with the key in the environment: the new one has to be there too",
  withDir(async (dir) => {
    const oldKey = generateSecretKey().toString("hex");
    const newKey = generateSecretKey().toString("hex");
    const pm = openProfiles(dir, { [SECRET_KEY_ENV]: oldKey });
    const { id } = pm.create({ name: "a", proxy: proxy() });
    pm.close();

    await assert.rejects(rotate(dir, { [SECRET_KEY_ENV]: oldKey }), UsageError);

    const env = { [SECRET_KEY_ENV]: oldKey, [NEXT_SECRET_KEY_ENV]: newKey };
    await rotate(dir, env);
    assert.deepEqual(env, {}, "neither stays in the environment");
    assert.equal(existsSync(dataPaths(dir).secretKeyPath), false, "and no file appears");

    assert.throws(() => openProfiles(dir, { [SECRET_KEY_ENV]: oldKey }), new RegExp(id));
    const moved = openProfiles(dir, { [SECRET_KEY_ENV]: newKey });
    assert.equal(moved.get(id)?.proxy?.password, SECRET);
    moved.close();
  }),
);

test(
  "a rotation that died before its transaction: the old key stands and the new one goes",
  withDir((dir) => {
    const { id, key } = sealedDir(dir);
    const { secretKeyPath } = dataPaths(dir);
    writeKeyFile(pendingKeyPath(secretKeyPath), generateSecretKey());

    const pm = openProfiles(dir, {});
    assert.equal(pm.get(id)?.proxy?.password, SECRET);
    pm.close();
    assert.equal(existsSync(pendingKeyPath(secretKeyPath)), false);
    assert.deepEqual(parseSecretKey(readFileSync(secretKeyPath, "utf8")), key);
  }),
);

test(
  "a rotation that died after its transaction: the new key is the key",
  withDir((dir) => {
    const { id, key } = sealedDir(dir);
    const { dbPath, profilesRoot, secretKeyPath } = dataPaths(dir);
    const next = generateSecretKey();
    writeKeyFile(pendingKeyPath(secretKeyPath), next);
    const dying = new ProfileManager({ dbPath, profilesRoot, secrets: createSecretBox(key) });
    dying.rotateStoredSecrets(createSecretBox(next));
    dying.close();

    const pm = openProfiles(dir, {});
    assert.equal(pm.get(id)?.proxy?.password, SECRET);
    pm.close();
    assert.equal(existsSync(pendingKeyPath(secretKeyPath)), false);
    assert.deepEqual(parseSecretKey(readFileSync(secretKeyPath, "utf8")), next);
  }),
);

test(
  "a key file that holds no key refuses the start rather than being replaced",
  withDir((dir) => {
    const { secretKeyPath } = dataPaths(dir);
    legacyRow(dir);
    writeFileSync(secretKeyPath, "garbage");
    assert.throws(() => openProfiles(dir, {}), (e: unknown) => {
      assert.ok(e instanceof SecretKeyError);
      assert.ok(e.message.includes(secretKeyPath));
      return true;
    });
    assert.equal(readFileSync(secretKeyPath, "utf8"), "garbage");
  }),
);
