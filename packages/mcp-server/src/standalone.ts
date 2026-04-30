/**
 * Standalone runner for the MCP server.
 *
 * Used both for `yarn mcp:dev` (development) and as the entry point in
 * `bin/multizen-mcp.js` so an MCP client like Cursor or Claude Desktop
 * can spawn it via stdio without launching the desktop app.
 *
 * In standalone mode the browser driver is the MockBrowserDriver — useful
 * for protocol tests but not for real browser work. The desktop app embeds
 * the same MCP server with the real Chromium-backed driver.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ProfileManager } from "@multizen/profile-manager";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

import { createMultizenMcpServer } from "./server.js";
import { MockBrowserDriver } from "./MockBrowserDriver.js";

async function main(): Promise<void> {
  const dataRoot = join(homedir(), ".multizen");
  mkdirSync(dataRoot, { recursive: true });

  const profileManager = new ProfileManager({
    dbPath: join(dataRoot, "profiles.db"),
    profilesRoot: join(dataRoot, "profiles"),
  });

  const browserDriver = new MockBrowserDriver();
  const server = createMultizenMcpServer({ profileManager, browserDriver });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Keep process alive until stdio closes
  process.on("SIGINT", () => {
    profileManager.close();
    process.exit(0);
  });
}

main().catch((e) => {
  process.stderr.write(`MCP server crashed: ${String(e)}\n`);
  process.exit(1);
});
