import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ProfileManager } from "@multizen/profile-manager";
import type { ExtensionConfig, Profile } from "@multizen/types";
import { unpackToProfile } from "./crxPipeline.ts";
import { downloadCrxById, parseExtensionId } from "./webstoreDownload.ts";

interface ExtensionsServiceDeps {
  profileManager: ProfileManager;
  /** Live engine version (e.g. CloakBrowser "145.0.7632.109.2") for the CRX endpoint. */
  engineVersion: () => string;
}

/**
 * Per-profile extension management: acquire (file/folder/web-store) → unpack
 * under the profile's dataDir → persist on the profile. Mirrors how proxy /
 * fingerprint live on the profile.
 */
export class ExtensionsService {
  private readonly pm: ProfileManager;
  private readonly engineVersion: () => string;

  constructor(deps: ExtensionsServiceDeps) {
    this.pm = deps.profileManager;
    this.engineVersion = deps.engineVersion;
  }

  list(profileId: string): ExtensionConfig[] {
    return this.pm.get(profileId)?.extensions ?? [];
  }

  /** Install from a local .crx / .zip / unpacked folder. */
  async installFromFile(profileId: string, sourcePath: string): Promise<ExtensionConfig> {
    const profile = this.requireProfile(profileId);
    const isDir = (await stat(sourcePath)).isDirectory();
    const cfg = await unpackToProfile({
      source: sourcePath,
      profileDataDir: profile.dataDir,
      origin: isDir ? "folder" : "file",
    });
    this.persist(profile, cfg);
    return cfg;
  }

  /** Install by Chrome Web Store URL or bare ID. */
  async installFromWebStore(profileId: string, urlOrId: string): Promise<ExtensionConfig> {
    const profile = this.requireProfile(profileId);
    const id = parseExtensionId(urlOrId);
    const crxPath = await downloadCrxById(id, this.engineVersion());
    try {
      const cfg = await unpackToProfile({
        source: crxPath,
        profileDataDir: profile.dataDir,
        origin: "web-store",
      });
      this.persist(profile, cfg);
      return cfg;
    } finally {
      await rm(crxPath, { force: true }).catch(() => {});
    }
  }

  remove(profileId: string, extId: string): void {
    const profile = this.requireProfile(profileId);
    const cfg = (profile.extensions ?? []).find((e) => e.id === extId);
    const next = (profile.extensions ?? []).filter((e) => e.id !== extId);
    this.pm.update(profileId, { extensions: next });
    if (cfg) {
      void rm(join(profile.dataDir, cfg.dir), { recursive: true, force: true }).catch(() => {});
    }
  }

  setEnabled(profileId: string, extId: string, enabled: boolean): void {
    const profile = this.requireProfile(profileId);
    const next = (profile.extensions ?? []).map((e) =>
      e.id === extId ? { ...e, enabled } : e,
    );
    this.pm.update(profileId, { extensions: next });
  }

  // ─── internals ──────────────────────────────────────────────────────

  private requireProfile(profileId: string): Profile {
    const p = this.pm.get(profileId);
    if (!p) throw new Error(`Profile ${profileId} not found`);
    return p;
  }

  /**
   * Append (or replace by id) the new extension on the profile. Re-installing
   * the same id swaps the directory and drops the stale one.
   */
  private persist(profile: Profile, cfg: ExtensionConfig): void {
    const prior = (profile.extensions ?? []).find((e) => e.id === cfg.id);
    const next = (profile.extensions ?? []).filter((e) => e.id !== cfg.id);
    next.push(cfg);
    this.pm.update(profile.id, { extensions: next });
    if (prior && prior.dir !== cfg.dir) {
      void rm(join(profile.dataDir, prior.dir), { recursive: true, force: true }).catch(
        () => {},
      );
    }
  }
}
