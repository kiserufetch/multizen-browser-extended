import { test } from "node:test";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ProfileManager } from "@multizen/profile-manager";

import { ActivityLog, LOGGED_ARGS } from "./ActivityLog.js";
import { MockBrowserDriver } from "./MockBrowserDriver.js";
import { createMultizenMcpServer } from "./server.js";

const SECRET = "SECRET-VALUE-xyz";

function logged(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  return new ActivityLog().startCall(tool, args).args;
}

test("what must never be logged isn't, on any tool that takes it", () => {
  const calls: Array<[string, Record<string, unknown>]> = [
    [
      "upload_file",
      { profile_id: "p", ref: "e1", files: [{ file_name: "a", data_base64: SECRET }] },
    ],
    ["acquire_profile", { profile_id: "p", lease_id: SECRET }],
    ["renew_profile", { profile_id: "p", lease_id: SECRET }],
    ["release_profile", { profile_id: "p", lease_id: SECRET }],
    ["evaluate_js", { profile_id: "p", expression: SECRET }],
    ["cdp_send", { profile_id: "p", method: "Runtime.evaluate", params: { expression: SECRET } }],
    ["cdp_send_no_safety", { profile_id: "p", method: "Runtime.evaluate", params: { x: SECRET } }],
    ["handle_dialog", { profile_id: "p", action: "accept", prompt_text: SECRET }],
    ["set_dialog_policy", { profile_id: "p", mode: "auto", prompt_text: SECRET }],
    ["type", { profile_id: "p", selector: "#a", text: SECRET }],
    ["type_ref", { profile_id: "p", ref: "e1", text: SECRET }],
    ["set_cookies", { profile_id: "p", cookies: [{ name: "a", value: SECRET }] }],
    [
      "create_profile",
      { name: "n", proxy: { type: "http", host: "h", port: 1, password: SECRET } },
    ],
    ["create_profile", { name: "n", seed: SECRET, entropy: SECRET, notes: SECRET }],
    [
      "update_profile",
      { profile_id: "p", proxy: { type: "http", host: "h", port: 1, username: SECRET } },
    ],
  ];
  for (const [tool, args] of calls) {
    assert.equal(JSON.stringify(logged(tool, args)).includes(SECRET), false, tool);
  }
});

test("the keys that are logged still say what happened", () => {
  assert.deepEqual(logged("type", { profile_id: "p", selector: "#a", text: "hunter2" }), {
    profile_id: "p",
    selector: "#a",
    text: "[7 chars]",
  });
  assert.deepEqual(logged("navigate", { profile_id: "p", url: "https://example.com/" }), {
    profile_id: "p",
    url: "https://example.com/",
  });
  assert.deepEqual(logged("cdp_send", { profile_id: "p", method: "Page.reload", params: {} }), {
    profile_id: "p",
    method: "Page.reload",
  });
  assert.deepEqual(
    logged("upload_file", {
      profile_id: "p",
      ref: "e1",
      files: [{ file_name: "a.pdf", data_base64: "x" }],
    }),
    { profile_id: "p", ref: "e1", files: ["a.pdf"] },
  );
  assert.deepEqual(
    logged("set_cookies", { profile_id: "p", cookies: [{ name: "c", value: "v", domain: "d" }] }),
    { profile_id: "p", cookies: [{ name: "c", value: "***", domain: "d" }] },
  );
  assert.deepEqual(
    logged("create_profile", {
      name: "n",
      proxy: { type: "http", host: "h", port: 1, password: "x" },
    }),
    { name: "n", proxy: { type: "http", host: "h", port: 1, hasAuth: true } },
  );
});

test("an argument nobody allowed, or a tool nobody listed, logs nothing", () => {
  assert.deepEqual(logged("navigate", { profile_id: "p", brand_new_argument: SECRET }), {
    profile_id: "p",
  });
  assert.deepEqual(logged("tool_with_no_entry", { a: SECRET, profile_id: "p" }), {});
  assert.deepEqual(logged("constructor", { a: SECRET }), {});
  // The feed still knows the profile, from outside the args.
  assert.equal(
    new ActivityLog().startCall("tool_with_no_entry", { profile_id: "p" }).profileId,
    "p",
  );
});

test("the length cap holds for strings, lists and nesting", () => {
  const long = "x".repeat(10_000);
  const { url } = logged("navigate", { profile_id: "p", url: long }) as { url: string };
  assert.ok(url.length < 250);
  assert.ok(url.endsWith("[10000 chars]"));

  const { urls } = logged("get_cookies", {
    profile_id: "p",
    urls: Array.from({ length: 500 }, () => long),
  }) as { urls: string[] };
  assert.equal(urls.length, 20);
  assert.ok(urls[0]!.length < 250);

  const { selector } = logged("click", {
    profile_id: "p",
    selector: { a: { b: { c: { d: 1 } } } },
  }) as {
    selector: unknown;
  };
  assert.deepEqual(selector, { a: { b: { c: "[…]" } } });
});

test("a real tools/call logs through the allowlist", async () => {
  const driver = new MockBrowserDriver();
  await driver.launch("p");
  const activityLog = new ActivityLog();
  const { server } = createMultizenMcpServer({
    profileManager: {} as unknown as ProfileManager,
    browserDriver: driver,
    activityLog,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  await client.callTool({
    name: "evaluate_js",
    arguments: { profile_id: "p", expression: SECRET },
  });
  await client.callTool({
    name: "handle_dialog",
    arguments: { profile_id: "p", action: "dismiss", prompt_text: SECRET },
  });
  assert.equal(JSON.stringify(activityLog.recent()).includes(SECRET), false);
  assert.ok(LOGGED_ARGS.size > 0);
  await client.close();
});

test("a failed call says its code beside its message", async () => {
  const driver = new MockBrowserDriver();
  await driver.launch("p");
  driver.evaluateJs = async () => {
    throw new Error(SECRET);
  };
  const activityLog = new ActivityLog();
  const { server } = createMultizenMcpServer({
    profileManager: {} as unknown as ProfileManager,
    browserDriver: driver,
    activityLog,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  await client.callTool({ name: "evaluate_js", arguments: { profile_id: "p", expression: "1" } });
  await client.close();
  const event = activityLog.recent().at(-1)!;
  assert.equal(event.status, "error");
  assert.equal(event.errorCode, "INTERNAL_ERROR");
  assert.equal(event.summary, SECRET, "the desktop's feed keeps it");
});

test("display_mode reaches the activity feed on the tools that take it", () => {
  const log = new ActivityLog();
  assert.equal(log.startCall("launch_profile", { profile_id: "p", display_mode: "headless" }).args.display_mode, "headless");
  assert.equal(log.startCall("create_profile", { name: "n", display_mode: "xvfb" }).args.display_mode, "xvfb");
  assert.equal(log.startCall("update_profile", { profile_id: "p", display_mode: null }).args.display_mode, null);
});
