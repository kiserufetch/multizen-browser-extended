/**
 * Standalone runner for the MCP server.
 *
 * Used both for `yarn mcp:dev` (development) and as the entry point in
 * `bin/multizen-mcp.js`.
 *
 * In standalone mode the browser driver is the MockBrowserDriver — useful
 * for protocol tests but not for real browser work, so it runs only with an
 * explicit `--mock`. Real browsers come from `multizen-server` (apps/server) or
 * the desktop app, which embed the same MCP server.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ProfileManager } from "@multizen/profile-manager";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

import { createMultizenMcpServer } from "./server.js";
import { MockBrowserDriver } from "./MockBrowserDriver.js";

const REAL_SERVER_HINT = `multizen-mcp only runs a mock browser driver, and only with --mock.

For real browsers, run the MultiZen server:
  corepack yarn workspace @multizen/server build
  node apps/server/bin/multizen-server.js stdio
or over HTTP:
  node apps/server/bin/multizen-server.js serve

Or connect to the MCP port of the running desktop app (Settings > MCP).
`;

async function main(): Promise<void> {
  // Stderr: an MCP client that spawned this reads stdout as JSON-RPC.
  if (!process.argv.includes("--mock")) {
    process.stderr.write(REAL_SERVER_HINT);
    process.exit(2);
  }

  const dataRoot = join(homedir(), ".multizen");
  mkdirSync(dataRoot, { recursive: true });

  const profileManager = new ProfileManager({
    dbPath: join(dataRoot, "profiles.db"),
    profilesRoot: join(dataRoot, "profiles"),
  });

  const browserDriver = new MockBrowserDriver();
  const { server, activityLog } = createMultizenMcpServer({ profileManager, browserDriver });

  // Pipe activity events to stderr in standalone mode (stdout is reserved for MCP transport)
  activityLog.on("event", (e) => {
    if (e.status !== "pending") {
      process.stderr.write(
        `[mcp] ${e.tool} (${e.status}, ${e.durationMs ?? 0}ms) ${e.summary ?? ""}\n`,
      );
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.on("SIGINT", () => {
    profileManager.close();
    process.exit(0);
  });
}

main().catch((e) => {
  process.stderr.write(`MCP server crashed: ${String(e)}\n`);
  process.exit(1);
});
