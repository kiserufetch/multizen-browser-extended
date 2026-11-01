import { test } from "node:test";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ProfileManager } from "@multizen/profile-manager";

import { LOGGED_ARGS } from "./ActivityLog.js";
import {
  createPrincipal,
  FULL_PRINCIPAL,
  principalFrom,
  TOOL_GROUPS,
  type Principal,
  type ToolGroup,
} from "./auth/principal.js";
import { MockBrowserDriver } from "./MockBrowserDriver.js";
import { createMultizenMcpServer, TOOL_DEFINITIONS } from "./server.js";
import { runGated, visibleTools } from "./toolGate.js";
import { policedToolNames, policyFor } from "./toolPolicy.js";
import { EXTENSION_DEFS } from "./tools/index.js";

const ALL_DEFINED = [...TOOL_DEFINITIONS, ...EXTENSION_DEFS].map((d) => d.name);

/** Spec decision 2, verbatim. */
const SPEC_GROUPS: Record<ToolGroup, string[]> = {
  read: [
    "list_profiles",
    "extract",
    "screenshot",
    "list_tabs",
    "get_human_status",
    "list_downloads",
    "list_dialogs",
    "list_fingerprint_options",
    "probe_fingerprint",
  ],
  act: [
    "navigate",
    "click",
    "type",
    "click_ref",
    "type_ref",
    "press_key",
    "hover",
    "select_option",
    "scroll",
    "upload_file",
    "get_download",
    "handle_dialog",
    "set_dialog_policy",
    "evaluate_js",
    "wait_for_selector",
    "wait_for_navigation",
    "wait_for_load",
    "get_cookies",
    "set_cookies",
    "new_tab",
    "activate_tab",
    "close_tab",
    "launch_profile",
    "close_profile",
    "request_human",
    "wait_for_human",
    "acquire_profile",
    "renew_profile",
    "release_profile",
  ],
  "profile-admin": ["create_profile", "update_profile", "delete_profile"],
  raw: ["cdp_send", "cdp_send_no_safety"],
  operator: ["resume_human"],
};

function limited(groups: ToolGroup[], extra: Partial<Principal> = {}): Principal {
  return {
    ...createPrincipal({
      id: "t_1",
      name: "limited",
      full: false,
      tools: { groups, names: [] },
      profiles: "*",
    }),
    ...extra,
  };
}

async function connect(
  principal?: Principal,
): Promise<{ client: Client; driver: MockBrowserDriver }> {
  const driver = new MockBrowserDriver();
  const { server } = createMultizenMcpServer({
    profileManager: { list: () => [] } as unknown as ProfileManager,
    browserDriver: driver,
    principal,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, driver };
}

async function errorCode(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const res = await client.callTool({ name, arguments: args });
  assert.equal(res.isError, true, `${name} should have failed`);
  const text = (res.content as Array<{ text: string }>)[0]!.text;
  return (JSON.parse(text) as { error: { code: string } }).error.code;
}

test("every defined tool has a policy, and every policy a defined tool", () => {
  const defined = new Set(ALL_DEFINED);
  assert.equal(defined.size, ALL_DEFINED.length, "a tool name is defined twice");
  assert.deepEqual(
    ALL_DEFINED.filter((name) => !policyFor(name)),
    [],
  );
  assert.deepEqual(
    policedToolNames().filter((name) => !defined.has(name)),
    [],
  );
});

test("every policy states all four annotation hints as booleans", () => {
  for (const name of policedToolNames()) {
    const { annotations } = policyFor(name)!;
    assert.deepEqual(
      Object.keys(annotations).sort(),
      ["destructiveHint", "idempotentHint", "openWorldHint", "readOnlyHint"],
      name,
    );
    for (const value of Object.values(annotations)) assert.equal(typeof value, "boolean", name);
    if (annotations.readOnlyHint) assert.equal(annotations.destructiveHint, false, name);
  }
});

test("the groups are the table in spec decision 2, nothing more and nothing less", () => {
  for (const group of TOOL_GROUPS) {
    const actual = policedToolNames().filter((name) => policyFor(name)!.group === group);
    assert.deepEqual(actual.sort(), [...SPEC_GROUPS[group]].sort(), group);
  }
});

test("the human gate: a handoff must not stop what ends it or what keeps a lease alive", () => {
  assert.equal(policyFor("close_profile")!.humanGate, "allow");
  assert.equal(policyFor("delete_profile")!.humanGate, "block");
  for (const name of ["acquire_profile", "renew_profile", "release_profile"]) {
    assert.equal(policyFor(name)!.humanGate, "allow", name);
  }
  for (const name of ["extract", "screenshot", "get_cookies"]) {
    assert.equal(policyFor(name)!.humanGate, "allow-unless-sensitive", name);
  }
  for (const name of ["evaluate_js", "cdp_send", "cdp_send_no_safety"]) {
    assert.equal(policyFor(name)!.humanGate, "block", `${name} counts as an action`);
  }
});

test("lock classes: a wait polls, and nothing a stuck operation needs ever queues", () => {
  for (const name of ["wait_for_selector", "wait_for_navigation", "wait_for_load"]) {
    assert.equal(policyFor(name)!.lock, "iteration", name);
  }
  for (const name of ["close_profile", "handle_dialog", "request_human", "wait_for_human"]) {
    assert.equal(policyFor(name)!.lock, "none", name);
  }
  assert.equal(policyFor("navigate")!.urlArg, "url");
  assert.equal(policyFor("new_tab")!.urlArg, "url");
});

test("the activity log allowlist covers every tool", () => {
  assert.deepEqual([...LOGGED_ARGS.keys()].sort(), [...policedToolNames()].sort());
});

// ── default deny ─────────────────────────────────────────────────────────────

test("a tool with no policy is invisible and refused, even to a full principal", async () => {
  const unlisted = { name: "tool_with_no_policy", inputSchema: {} };
  assert.deepEqual(visibleTools([unlisted], FULL_PRINCIPAL), []);

  let ran = false;
  await assert.rejects(
    runGated(unlisted.name, {}, { principal: FULL_PRINCIPAL }, async () => {
      ran = true;
    }),
    { code: "FORBIDDEN" },
  );
  assert.equal(ran, false);
});

test("names from Object.prototype are unknown tools too, over the wire", async () => {
  const { client } = await connect();
  for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty", "made_up"]) {
    assert.equal(await errorCode(client, name, {}), "FORBIDDEN", name);
    assert.equal(policyFor(name), null, name);
  }
  await client.close();
});

// ── principals ───────────────────────────────────────────────────────────────

test("principalFrom: the transport's principal wins, then the option, then full", () => {
  const fromToken = limited(["read"]);
  const fromOption = limited(["act"]);
  const extra = { authInfo: { extra: { principal: fromToken } } };
  assert.equal(principalFrom(extra, fromOption), fromToken);
  assert.equal(principalFrom({}, fromOption), fromOption);
  assert.equal(principalFrom({ authInfo: { extra: {} } }), FULL_PRINCIPAL);
  assert.equal(principalFrom(undefined), FULL_PRINCIPAL);
});

test("panel access comes only from the operator group", () => {
  assert.equal(limited(["read", "act", "profile-admin", "raw"]).panel, false);
  assert.equal(limited(["operator"]).panel, true);
  assert.equal(FULL_PRINCIPAL.panel, true);
  assert.deepEqual([...FULL_PRINCIPAL.tools.groups].sort(), [...TOOL_GROUPS].sort());
});

test("tools/list and tools/call follow the principal's groups", async () => {
  const { client } = await connect(limited(["read"]));
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [...SPEC_GROUPS.read].sort());

  assert.equal(await errorCode(client, "click", { profile_id: "p", selector: "a" }), "FORBIDDEN");
  assert.equal(await errorCode(client, "resume_human", { profile_id: "p" }), "FORBIDDEN");
  // Refused before validation: no schema feedback on a tool it can't use.
  assert.equal(await errorCode(client, "click", {}), "FORBIDDEN");
  const allowed = await client.callTool({ name: "list_profiles", arguments: {} });
  assert.equal(allowed.isError, undefined);
  await client.close();
});

test("a single tool can be granted by name on top of the groups", async () => {
  const principal = limited(["read"], { tools: { groups: ["read"], names: ["click"] } });
  const { client } = await connect(principal);
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes("click"));
  assert.ok(!names.includes("type"));
  await client.close();
});

test("a principal scoped to some profiles can't reach the others", async () => {
  const { client, driver } = await connect(limited(["act", "read"], { profiles: ["mine"] }));
  await driver.launch("mine");
  await driver.launch("theirs");
  assert.equal(await errorCode(client, "hover", { profile_id: "theirs", ref: "e1" }), "FORBIDDEN");
  const ok = await client.callTool({ name: "hover", arguments: { profile_id: "mine", ref: "e1" } });
  assert.equal(ok.isError, undefined);
  assert.equal(driver.actions.length, 1);
  await client.close();
});

test("with no principal anywhere, a client sees every tool, as on the desktop", async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [...ALL_DEFINED].sort());
  for (const tool of tools) {
    assert.deepEqual(tool.annotations, policyFor(tool.name)!.annotations, tool.name);
  }
  await client.close();
});
