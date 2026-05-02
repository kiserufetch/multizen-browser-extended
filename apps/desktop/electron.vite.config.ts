import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

/**
 * Native modules and Electron itself cannot be bundled — they must be
 * marked external. Pure-JS workspace deps (@multizen/*) get bundled so
 * we can ship .ts source files without a separate build step in dev.
 */
const NATIVE_EXTERNALS = [
  "electron",
  /^node:/,
  "better-sqlite3",
  "chrome-remote-interface",
  "ws",
  "@modelcontextprotocol/sdk",
  "uuid",
  "zod",
];

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        external: NATIVE_EXTERNALS,
        input: { index: resolve(__dirname, "src/main/index.ts") },
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        external: ["electron"],
        input: { index: resolve(__dirname, "src/preload/index.ts") },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/renderer/index.html") },
      },
    },
    resolve: {
      alias: {
        "@": resolve(__dirname, "src/renderer/src"),
      },
    },
  },
});
