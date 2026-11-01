import { renameSync } from "node:fs";
import { acquireServerLock } from "@multizen/browser-runtime";
import { createSecretBox, generateSecretKey } from "@multizen/profile-manager";
import { dataPaths, UsageError, type Env, type SecretsCommand } from "../config.ts";
import { log } from "../log.ts";
import { openProfiles } from "../runtime.ts";
import {
  NEXT_SECRET_KEY_ENV,
  pendingKeyPath,
  SECRET_KEY_ENV,
  takeKeyFromEnv,
  writeKeyFile,
} from "../secretKey.ts";
import type { ShutdownManager } from "../shutdown.ts";

/**
 * Re-encrypts every proxy password under a new key. Holds the data dir's lock, since a
 * running server has the old key in memory and would go on writing with it.
 */
export async function runSecrets(
  command: SecretsCommand,
  shutdown: ShutdownManager,
  env: Env = process.env,
): Promise<void> {
  const keyInEnv = Boolean(env[SECRET_KEY_ENV]);
  const nextFromEnv = takeKeyFromEnv(NEXT_SECRET_KEY_ENV, env);
  if (keyInEnv && !nextFromEnv) {
    throw new UsageError(
      `The current key comes from ${SECRET_KEY_ENV}, so the new one has to as well: ` +
        `set ${NEXT_SECRET_KEY_ENV}, then change ${SECRET_KEY_ENV} to that value afterwards.`,
    );
  }

  const lock = await acquireServerLock(command.dataDir, { mode: "cli" });
  shutdown.add("lock", () => lock.release());
  const profiles = openProfiles(command.dataDir, env);
  shutdown.add("profiles", () => profiles.close());

  const next = nextFromEnv ?? generateSecretKey();
  const { secretKeyPath } = dataPaths(command.dataDir);
  if (!keyInEnv) writeKeyFile(pendingKeyPath(secretKeyPath), next);
  const rotated = profiles.rotateStoredSecrets(createSecretBox(next));
  // The old ciphertext would still open with the old key, which is why one rotates.
  profiles.purgeOldValues();
  if (!keyInEnv) renameSync(pendingKeyPath(secretKeyPath), secretKeyPath);

  log.info("secret key rotated", {
    passwords: rotated,
    key: keyInEnv ? `in ${NEXT_SECRET_KEY_ENV}: move it to ${SECRET_KEY_ENV}` : secretKeyPath,
  });
}
