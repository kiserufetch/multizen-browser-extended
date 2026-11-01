import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { acquireServerLock } from "@multizen/browser-runtime";
import {
  archiveFileName,
  exportProfileToArchive,
  importProfileFromArchive,
} from "@multizen/profile-manager";
import { SettingsStore, defaultSettingsPath } from "@multizen/settings-store";
import { dataPaths, UsageError, type Env, type ProfileCommand } from "../config.ts";
import { log } from "../log.ts";
import { openProfiles } from "../runtime.ts";
import type { ShutdownManager } from "../shutdown.ts";

/** From a file or the environment, never a flag: argv shows up in process lists. */
function readPassphrase(file: string | undefined, env: Env): string {
  const passphrase = file
    ? readFileSync(file, "utf8").replace(/\r?\n$/, "")
    : env.MULTIZEN_ARCHIVE_PASSPHRASE;
  if (!passphrase) {
    throw new UsageError("Give the passphrase with --passphrase-file or MULTIZEN_ARCHIVE_PASSPHRASE");
  }
  return passphrase;
}

/** Export or import one profile. Holds the data dir's lock, so a running server's
 *  browsers can't be writing the files being archived. */
export async function runProfile(
  command: ProfileCommand,
  shutdown: ShutdownManager,
  env: Env = process.env,
): Promise<void> {
  const passphrase = readPassphrase(command.passphraseFile, env);
  const lock = await acquireServerLock(command.dataDir, { mode: "cli" });
  shutdown.add("lock", () => lock.release());

  const profileManager = openProfiles(command.dataDir);
  shutdown.add("profiles", () => profileManager.close());
  const { profilesRoot, extensionStoreRoot } = dataPaths(command.dataDir);

  if (command.action === "export") {
    const profile = profileManager.get(command.profileId);
    if (!profile) throw new UsageError(`Profile ${command.profileId} not found`);
    const outPath = resolve(command.outPath ?? archiveFileName(profile));
    await exportProfileToArchive(profile, passphrase, outPath, extensionStoreRoot);
    log.info("profile exported", { profile: profile.id, path: outPath });
    return;
  }

  const settings = await new SettingsStore(defaultSettingsPath(command.dataDir)).load();
  const { id, unavailableEngine } = await importProfileFromArchive(
    profileManager,
    command.archivePath,
    passphrase,
    {
      profilesRoot,
      extensionStoreRoot,
      defaultEngine: command.defaultEngine ?? settings.browserEngine,
    },
  );
  if (unavailableEngine !== undefined) {
    log.warn("the archive's engine is not available here; the profile runs on the default engine", {
      profile: id,
      engine: unavailableEngine,
    });
  }
  log.info("profile imported", { profile: id });
}
