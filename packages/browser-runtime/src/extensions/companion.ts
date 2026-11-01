import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeHost } from "../host.ts";

/**
 * Absolute path to the bundled first-party "companion" extension (the one that
 * injects the "Add to MultiZen" button on Web Store pages). It is loaded into
 * every profile via --load-extension and is never part of a profile's
 * user-visible extension list.
 *
 *   packaged: <resources>/companion   (electron-builder extraResources)
 *   dev:      apps/desktop/resources/companion
 *
 * Returns null if it can't be located (loading just proceeds without it).
 */
export function companionDir(host: RuntimeHost): string | null {
  const dir = host.resourceDir("companion");
  if (dir && existsSync(join(dir, "manifest.json"))) return dir;
  return null;
}
