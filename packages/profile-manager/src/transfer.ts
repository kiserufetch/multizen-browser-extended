import { join } from "node:path";
import type { BrowserEngine, Profile, ProfileId } from "@multizen/types";
import { isBrowserEngine } from "@multizen/types";
import { exportProfile, importProfile } from "./archive.js";
import type { ProfileManager } from "./ProfileManager.js";

/** Default file name of a profile's archive: its name with path-hostile runs replaced. */
export function archiveFileName(profile: Pick<Profile, "name">): string {
  return `${profile.name.replace(/[^a-z0-9-_]+/gi, "_")}.mzar`;
}

/**
 * Export a profile to an encrypted archive. Bundles the profile's shared-store
 * extensions so importing on another machine restores the extension code too,
 * not just a dangling reference.
 */
export async function exportProfileToArchive(
  profile: Profile,
  passphrase: string,
  outPath: string,
  extensionStoreRoot: string,
): Promise<void> {
  const extensions = (profile.extensions ?? [])
    .filter((e) => e.scope === "shared")
    .map((e) => ({
      id: e.id,
      version: e.version,
      dir: join(extensionStoreRoot, e.id, e.version || "0"),
    }));
  await exportProfile(profile, passphrase, outPath, { extensions });
}

export interface ImportFromArchiveOptions {
  profilesRoot: string;
  extensionStoreRoot: string;
  /** What an archive with no usable engine gets pinned to. */
  defaultEngine: BrowserEngine;
}

export interface ImportedArchive {
  id: ProfileId;
  /** The archive's engine when this build can't run it; the caller tells the user. */
  unavailableEngine?: string;
}

/**
 * Restore an archive to disk and insert its profile. Never overwrites: if the
 * archive's id already exists here, importProfile mints a fresh id + dataDir.
 */
export async function importProfileFromArchive(
  profileManager: ProfileManager,
  archivePath: string,
  passphrase: string,
  opts: ImportFromArchiveOptions,
): Promise<ImportedArchive> {
  // Restore the full user-data-dir to disk. The returned Profile carries every
  // field (extensions, icon, startUrl, searchProvider, fingerprint, proxy) and
  // its dataDir points at the restored files.
  const restored = await importProfile(archivePath, passphrase, opts.profilesRoot, {
    idTaken: (id) => Boolean(profileManager.get(id)),
    // Restore bundled (v2) extensions into the shared store so they work on this
    // machine without the user re-adding them.
    extensionStoreRoot: opts.extensionStoreRoot,
  });
  // If the archive recorded an engine this build can't run (a legacy "cft"
  // export, or a newer engine), clear it so the profile resolves to the default
  // at launch instead of handing the registry an unknown engine.
  const recordedEngine: unknown = restored.engine;
  let unavailableEngine: string | undefined;
  if (recordedEngine !== undefined && !isBrowserEngine(recordedEngine)) {
    restored.engine = undefined;
    unavailableEngine = String(recordedEngine);
  }
  // Pin an unset engine (cleared above, or an archive that never recorded one) to
  // the current default, like profile creation, so a later change of the default
  // can't move it onto another engine's empty data dir.
  restored.engine ??= opts.defaultEngine;
  // Insert the row verbatim so the DB entry points at the restored files (the old
  // create()-based path minted a new id/dataDir and orphaned the cookies/logins
  // that were just restored).
  const inserted = profileManager.insertImported(restored);
  return { id: inserted.id, unavailableEngine };
}
