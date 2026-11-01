import { app, net } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HostHttpRequest, RuntimeHost } from "@multizen/browser-runtime";

/**
 * Where a bundled resource lives.
 *
 *   packaged: <resources>/<name>   (electron-builder extraResources)
 *   dev:      apps/desktop/resources/<dir>
 *
 * The packaged sandbox dir is named linux-sandbox, the dev dir resources/linux:
 * asymmetric on purpose, see builder config.
 */
function resourceCandidate(name: "companion" | "linux-sandbox"): string {
  if (app.isPackaged) return join(process.resourcesPath, name);
  // import.meta.url resolves to out/main/index.js at runtime → up to
  // apps/desktop, then resources/<dir>.
  return join(
    fileURLToPath(new URL(".", import.meta.url)),
    "../../resources",
    name === "linux-sandbox" ? "linux" : name,
  );
}

/** The browser runtime's host on the desktop: Electron paths and `net`. */
export const electronHost: RuntimeHost = {
  userDataDir: () => app.getPath("userData"),
  resourceDir: (name) => {
    const dir = resourceCandidate(name);
    return existsSync(dir) ? dir : null;
  },
  fetch: (url, init) => net.fetch(url, init),
  request: (opts) => net.request(opts) as HostHttpRequest,
};
