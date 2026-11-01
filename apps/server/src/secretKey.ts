import { chmodSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import {
  createSecretBox,
  generateSecretKey,
  parseSecretKey,
  SecretKeyError,
  type ProfileManager,
} from "@multizen/profile-manager";
import type { Env } from "./config.ts";
import { log } from "./log.ts";

export const SECRET_KEY_ENV = "MULTIZEN_SECRET_KEY";
/** Only `secrets rotate` reads this, for an operator who keeps the key in the environment. */
export const NEXT_SECRET_KEY_ENV = "MULTIZEN_SECRET_KEY_NEW";

/** Written first by `secrets rotate`, renamed over the key once the database has moved. */
export function pendingKeyPath(keyPath: string): string {
  return `${keyPath}.next`;
}

/**
 * Removes it from the environment: every browser this process spawns inherits that, and
 * the key must not reach a page's renderer.
 */
export function takeKeyFromEnv(name: string, env: Env): Buffer | null {
  const value = env[name];
  delete env[name];
  return value ? parseSecretKey(value) : null;
}

/** Restricts a file that holds a secret, as far as the platform lets it. */
export function ensurePrivateFile(path: string, what: string): void {
  if (process.platform === "win32") {
    log.warn(`file modes don't apply on Windows: the ${what} relies on the directory's ACL`, { path });
    return;
  }
  if ((statSync(path).mode & 0o077) === 0) return;
  chmodSync(path, 0o600);
  log.warn(`the ${what} was readable by others; restricted to 0600`, { path });
}

export function writeKeyFile(path: string, key: Buffer): void {
  const tmp = `${path}.${process.pid}.tmp`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, key.toString("hex"), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}

function readKeyFile(path: string): Buffer | null {
  if (!existsSync(path)) return null;
  try {
    return parseSecretKey(readFileSync(path, "utf8"));
  } catch (e) {
    throw new SecretKeyError(`${path} holds no usable key: ${(e as Error).message}`, { cause: e });
  }
}

/**
 * `secrets rotate` writes the new key aside, moves the database in one transaction, then
 * renames the key into place. If it died in between, whichever key opens the data is the key.
 */
function finishInterruptedRotation(profiles: ProfileManager, keyPath: string): void {
  const pendingPath = pendingKeyPath(keyPath);
  const pending = readKeyFile(pendingPath);
  if (!pending) return;
  const current = readKeyFile(keyPath);
  const databaseMoved =
    profiles.storedSecrets().sealed > 0 &&
    !(current && profiles.canOpenStoredSecrets(createSecretBox(current))) &&
    profiles.canOpenStoredSecrets(createSecretBox(pending));
  if (databaseMoved) {
    renameSync(pendingPath, keyPath);
    log.warn("finished a key rotation that was interrupted", { path: keyPath });
  } else {
    rmSync(pendingPath, { force: true });
  }
}

/**
 * Gives the manager its key, then makes the database match it: plaintext left by older
 * code gets sealed, and the old bytes are purged from the WAL and the free pages. That
 * purge runs every start, so a crash right after sealing can't leave them behind for good.
 *
 * A key is only ever generated for a database that has nothing sealed: minting one
 * for values it can't open would hide the real problem until some profile's launch.
 */
export function unlockSecrets(
  profiles: ProfileManager,
  paths: { dbPath: string; keyPath: string },
  keyFromEnv: Buffer | null,
): void {
  const { dbPath, keyPath } = paths;
  if (!keyFromEnv) finishInterruptedRotation(profiles, keyPath);
  let key = keyFromEnv ?? readKeyFile(keyPath);
  if (key) {
    if (!keyFromEnv) ensurePrivateFile(keyPath, "secret key");
  } else {
    const { sealed } = profiles.storedSecrets();
    if (sealed > 0) {
      throw new SecretKeyError(
        `${sealed} proxy password(s) in ${dbPath} are encrypted and there is no key to open them. ` +
          `Set ${SECRET_KEY_ENV}, or restore ${keyPath}.`,
      );
    }
    key = generateSecretKey();
    writeKeyFile(keyPath, key);
    log.info("secret key created", { path: keyPath });
    ensurePrivateFile(keyPath, "secret key");
  }
  profiles.useSecrets(createSecretBox(key));

  const sealedNow = profiles.sealStoredSecrets();
  profiles.purgeOldValues();
  if (sealedNow > 0) log.info("existing proxy passwords encrypted", { count: sealedNow });
  if (!keyFromEnv && statSync(keyPath).dev === statSync(dbPath).dev) {
    log.warn(
      `the secret key is on the same volume as the database, so a copy of that volume holds both. ` +
        `Keep it elsewhere with ${SECRET_KEY_ENV}, or by making the key file a link to another volume.`,
      { path: keyPath },
    );
  }
}
