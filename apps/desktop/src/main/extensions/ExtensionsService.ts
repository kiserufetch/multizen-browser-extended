import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ProfileManager } from "@multizen/profile-manager";
import type { ExtensionConfig, Profile } from "@multizen/types";
import { unpackToStore } from "./crxPipeline.ts";
import { gcEntry } from "./extensionStore.ts";
import { downloadCrxById, parseExtensionId } from "./webstoreDownload.ts";

interface ExtensionsServiceDeps {
  profileManager: ProfileManager;
  /** Root of the shared extension store, e.g. `<userData>/data/extension-store`. */
  extensionStoreRoot: string;
  /** Live engine version (e.g. CloakBrowser "145.0.7632.109.2") for the CRX endpoint. */
  engineVersion: () => string;
}

/**
 * Extension management. Installs land ONCE in a shared, content/identity-
 * addressed store (`extensionStoreRoot/<id>/<version>/`) and profiles hold
 * lightweight references — so the same extension across N profiles costs ~1×
 * disk, not N×. Extension *state* (logins/chrome.storage) stays per-profile via
 * Chromium's per-user-data-dir, so isolation is unchanged.
 *
 * Legacy per-profile installs (from before this feature) keep working and are
 * migrated opportunistically when re-installed.
 */
export class ExtensionsService {
  private readonly pm: ProfileManager;
  private readonly storeRoot: string;
  private readonly engineVersion: () => string;

  constructor(deps: ExtensionsServiceDeps) {
    this.pm = deps.profileManager;
    this.storeRoot = deps.extensionStoreRoot;
    this.engineVersion = deps.engineVersion;
  }

  list(profileId: string): ExtensionConfig[] {
    return this.pm.get(profileId)?.extensions ?? [];
  }

  /** Install from a local .crx / .zip / unpacked folder. */
  async installFromFile(profileId: string, sourcePath: string): Promise<ExtensionConfig> {
    const profile = this.requireProfile(profileId);
    const isDir = (await stat(sourcePath)).isDirectory();
    const cfg = await unpackToStore({
      source: sourcePath,
      storeRoot: this.storeRoot,
      origin: isDir ? "folder" : "file",
    });
    await this.persist(profile, cfg);
    return cfg;
  }

  /** Install by Chrome Web Store URL or bare ID. */
  async installFromWebStore(profileId: string, urlOrId: string): Promise<ExtensionConfig> {
    const profile = this.requireProfile(profileId);
    const id = parseExtensionId(urlOrId);
    const crxPath = await downloadCrxById(id, this.engineVersion());
    try {
      const cfg = await unpackToStore({
        source: crxPath,
        storeRoot: this.storeRoot,
        origin: "web-store",
      });
      await this.persist(profile, cfg);
      return cfg;
    } finally {
      await rm(crxPath, { force: true }).catch(() => {});
    }
  }

  async remove(profileId: string, extId: string): Promise<void> {
    const profile = this.requireProfile(profileId);
    const cfg = (profile.extensions ?? []).find((e) => e.id === extId);
    const next = (profile.extensions ?? []).filter((e) => e.id !== extId);
    this.pm.update(profileId, { extensions: next });
    if (cfg) await this.reclaim(profile, cfg);
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
   * Append (or replace by id) the new extension on the profile, then reclaim the
   * prior install if it's no longer used. Re-installing a legacy per-profile
   * item this way migrates it to the shared store and drops the old copy.
   */
  private async persist(profile: Profile, cfg: ExtensionConfig): Promise<void> {
    // Re-read immediately before the read-modify-write: install does a long
    // await (CRX download / unpack) on a profile snapshot, during which another
    // op (a second install, the companion, a toggle) may have rewritten the
    // extensions column. better-sqlite3 is synchronous, so get→update with no
    // await between is atomic and won't clobber that concurrent write.
    const fresh = this.pm.get(profile.id) ?? profile;
    const prior = (fresh.extensions ?? []).find((e) => e.id === cfg.id);
    const next = (fresh.extensions ?? []).filter((e) => e.id !== cfg.id);
    next.push(cfg);
    this.pm.update(fresh.id, { extensions: next });
    // Reclaim the prior copy if it pointed somewhere different (changed version,
    // or a legacy per-profile dir being superseded by a shared entry).
    if (prior && (prior.scope !== cfg.scope || prior.version !== cfg.version || prior.dir !== cfg.dir)) {
      await this.reclaim(fresh, prior);
    }
  }

  /**
   * Free the storage a (now-unreferenced) extension reference used: a legacy
   * per-profile dir is always safe to delete; a shared entry is GC'd only if no
   * other profile still references that id+version.
   */
  private async reclaim(profile: Profile, cfg: ExtensionConfig): Promise<void> {
    if (cfg.scope === "shared") {
      const allRefs = this.pm.allExtensionRefs().map((r) => r.ext);
      await gcEntry(this.storeRoot, cfg.id, cfg.version, allRefs);
    } else if (cfg.dir) {
      await rm(join(profile.dataDir, cfg.dir), { recursive: true, force: true }).catch(() => {});
    }
  }
}
