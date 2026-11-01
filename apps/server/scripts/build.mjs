import { rmSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Bundles the server into `dist/`. Workspace packages are inlined; everything
 * third-party stays external and must be a direct dependency of this app (native
 * modules need node_modules anyway, and bundling CJS into ESM breaks `require`).
 * Splitting keeps `import("./FirefoxBrowserDriver.ts")` lazy, so camoufox-js and
 * playwright-core stay out of Chromium-only startup.
 */
export async function build({ outdir = "dist" } = {}) {
  // Chunk names carry content hashes, so a rebuild would otherwise pile up old ones.
  rmSync(join(APP_ROOT, outdir), { recursive: true, force: true });
  const result = await esbuild.build({
    absWorkingDir: APP_ROOT,
    entryPoints: ["src/cli.ts"],
    outdir,
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "node",
    target: "node22",
    sourcemap: true,
    metafile: true,
    logLevel: "warning",
    plugins: [
      {
        name: "externalize-third-party",
        setup(b) {
          b.onResolve({ filter: /.*/ }, (a) => {
            if (
              a.kind === "entry-point" ||
              a.path.startsWith(".") ||
              isAbsolute(a.path) ||
              a.path.startsWith("@multizen/")
            ) {
              return undefined;
            }
            return { path: a.path, external: true };
          });
        },
      },
    ],
  });
  return result.metafile;
}

if (process.argv[1] && resolve(process.argv[1]) === join(APP_ROOT, "scripts", "build.mjs")) {
  await build();
}
