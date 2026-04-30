import { createMultizenMcpServer, type BrowserDriver } from "@multizen/mcp-server";
import type { ProfileManager } from "@multizen/profile-manager";

interface StartMcpOptions {
  profileManager: ProfileManager;
  browserDriver: BrowserDriver;
}

/**
 * Start the embedded MCP server.
 *
 * v0.2-pre: stub — wires up MCP server but doesn't yet expose it via
 * a transport (HTTP/SSE for in-process or stdio for spawned-from-MCP-client
 * mode). Wiring transport is the next milestone.
 */
export async function startMcpServer(opts: StartMcpOptions): Promise<void> {
  const server = createMultizenMcpServer(opts);
  // TODO(v0.2): expose via HTTP+SSE on localhost:7777 so external MCP
  // clients (Cursor, Claude Desktop) can connect to a running desktop
  // app, AND keep the option to spawn the standalone stdio server when
  // the desktop app is not running.
  void server;
}
