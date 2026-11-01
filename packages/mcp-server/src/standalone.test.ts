import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const BIN = join(PACKAGE_ROOT, "bin", "multizen-mcp.js");

test("without --mock it explains how to run the real server, exits 2, leaves stdout empty", () => {
  const res = spawnSync(process.execPath, [BIN], {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(res.status, 2, res.stderr);
  assert.equal(res.stdout, "");
  assert.match(res.stderr, /multizen-server\.cjs stdio/);
  assert.match(res.stderr, /--mock/);
});

test("with --mock a real stdio client gets the tool list", async () => {
  const home = mkdtempSync(join(tmpdir(), "mz-standalone-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN, "--mock"],
    cwd: PACKAGE_ROOT,
    // The mock keeps its database under the home directory.
    env: { HOME: home, USERPROFILE: home },
    stderr: "pipe",
  });
  const client = new Client({ name: "standalone-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.ok(tools.some((t) => t.name === "list_profiles"));
  } finally {
    await client.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
