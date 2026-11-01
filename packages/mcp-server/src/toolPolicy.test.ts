import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MultizenError, type ProxyConfig } from "@multizen/types";
import { ProfileManager } from "@multizen/profile-manager";

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
import { createSharedMcpState } from "./sharedState.js";
import { runGated, visibleTools, type EgressGate } from "./toolGate.js";
import { leaseBinds, policedToolNames, policyFor } from "./toolPolicy.js";
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
    "delete_download",
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
  // The browser or the database answers these, not a page that may be stuck.
  for (const name of ["list_tabs", "update_profile", "list_dialogs", "acquire_profile"]) {
    assert.equal(policyFor(name)!.lock, "none", name);
  }
  assert.equal(policyFor("close_profile")!.preempts, true);
  assert.equal(policyFor("navigate")!.urlArg, "url");
  assert.equal(policyFor("new_tab")!.urlArg, "url");
});

test("a lease binds what changes a profile, not reads, and not the lease tools themselves", () => {
  const free = policedToolNames().filter((name) => !leaseBinds(policyFor(name)!));
  assert.deepEqual(free.sort(), [
    "acquire_profile",
    "extract",
    "get_cookies",
    "get_download",
    "get_human_status",
    "list_dialogs",
    "list_downloads",
    "list_fingerprint_options",
    "list_profiles",
    "list_tabs",
    "probe_fingerprint",
    "release_profile",
    "renew_profile",
    "screenshot",
    "wait_for_human",
    "wait_for_load",
    "wait_for_navigation",
    "wait_for_selector",
  ]);
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
    runGated(
      unlisted.name,
      {},
      {
        principal: FULL_PRINCIPAL,
        sessionId: "s",
        shared: createSharedMcpState(),
        driver: new MockBrowserDriver(),
      },
      async () => {
        ran = true;
      },
    ),
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

// ── egress ───────────────────────────────────────────────────────────────────

/** Refuses what names `blocked`, and notes what it was asked. */
function fakeGate(enforced = true): EgressGate & {
  urls: Array<{ url: string; proxied: boolean }>;
  proxies: Array<{ host: string; port: number }>;
} {
  const urls: Array<{ url: string; proxied: boolean }> = [];
  const proxies: Array<{ host: string; port: number }> = [];
  const refuse = (what: string): void => {
    if (what.includes("blocked")) throw new MultizenError("EGRESS_BLOCKED", `blocked: ${what}`);
  };
  return {
    enforced,
    urls,
    proxies,
    assertUrlAllowed: async (url, { proxied }) => {
      urls.push({ url, proxied });
      refuse(url);
    },
    assertProxyAllowed: async (proxy) => {
      proxies.push(proxy);
      refuse(proxy.host);
    },
  };
}

class CountingDriver extends MockBrowserDriver {
  readonly navigations: string[] = [];
  readonly cdpCalls: Array<{ method: string }> = [];
  override navigate(id: string, url: string): Promise<{ url: string }> {
    this.navigations.push(url);
    return super.navigate(id, url);
  }
  override cdpSend(id: string, method: string, ...rest: [Record<string, unknown>?, string?, { safe?: boolean }?]): Promise<unknown> {
    this.cdpCalls.push({ method });
    return super.cdpSend(id, method, ...rest);
  }
}

async function connectGated(
  egress: EgressGate | undefined,
  principal?: Principal,
): Promise<{ client: Client; driver: CountingDriver }> {
  const driver = new CountingDriver();
  const proxies: Record<string, ProxyConfig> = { proxied: { type: "socks5", host: "p", port: 1 } };
  const { server } = createMultizenMcpServer({
    profileManager: {
      list: () => [],
      get: (id: string) => ({ id, proxy: proxies[id] }),
      create: (input: { name: string }) => ({ id: "new", name: input.name, fingerprint: {} }),
      update: (id: string) => ({ id, name: "n", fingerprint: {} }),
    } as unknown as ProfileManager,
    browserDriver: driver,
    principal,
    egress,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  await driver.launch("direct");
  await driver.launch("proxied");
  return { client, driver };
}

test("navigate and new_tab: the gate answers before the driver, and knows who is proxied", async () => {
  const gate = fakeGate();
  const { client, driver } = await connectGated(gate);
  const navigations = (): number => driver.navigations.length;

  assert.equal(
    await errorCode(client, "navigate", { profile_id: "direct", url: "http://blocked/" }),
    "EGRESS_BLOCKED",
  );
  assert.equal(
    await errorCode(client, "new_tab", { profile_id: "proxied", url: "http://blocked/" }),
    "EGRESS_BLOCKED",
  );
  assert.equal(navigations(), 0);
  assert.deepEqual(gate.urls, [
    { url: "http://blocked/", proxied: false },
    { url: "http://blocked/", proxied: true },
  ]);

  const fine = await client.callTool({ name: "navigate", arguments: { profile_id: "direct", url: "http://ok/" } });
  assert.equal(fine.isError, undefined);
  assert.equal(navigations(), 1);
  const blank = await client.callTool({ name: "new_tab", arguments: { profile_id: "direct" } });
  assert.equal(blank.isError, undefined, "a new_tab with no URL opens nothing to check");
  assert.equal(gate.urls.length, 3);
  await client.close();
});

test("create_profile and update_profile: a proxy the policy refuses isn't saved", async () => {
  const gate = fakeGate();
  const { client } = await connectGated(gate);
  const blocked = { type: "socks5", host: "blocked", port: 1 };
  const fine = { type: "socks5", host: "ok", port: 1 };
  assert.equal(await errorCode(client, "create_profile", { name: "n", proxy: blocked }), "EGRESS_BLOCKED");
  assert.equal(await errorCode(client, "update_profile", { profile_id: "direct", proxy: blocked }), "EGRESS_BLOCKED");

  const created = await client.callTool({ name: "create_profile", arguments: { name: "n", proxy: fine } });
  assert.equal(created.isError, undefined);
  const updated = await client.callTool({ name: "update_profile", arguments: { profile_id: "direct", proxy: fine } });
  assert.equal(updated.isError, undefined);
  const cleared = await client.callTool({ name: "update_profile", arguments: { profile_id: "direct", proxy: null } });
  assert.equal(cleared.isError, undefined, "clearing a proxy has nothing to check");
  assert.deepEqual(
    gate.proxies.map((p) => p.host),
    ["blocked", "blocked", "ok", "ok"],
  );
  await client.close();
});

test("malformed arguments go on to the tool's own validation", async () => {
  const gate = fakeGate();
  const { client } = await connectGated(gate);
  assert.equal(await errorCode(client, "navigate", { profile_id: "direct", url: 5 }), "INVALID_INPUT");
  assert.equal(await errorCode(client, "create_profile", { name: "n", proxy: "blocked" }), "INVALID_INPUT");
  assert.equal(await errorCode(client, "create_profile", { name: "n", proxy: { host: "blocked" } }), "INVALID_INPUT");
  assert.deepEqual(gate.urls, []);
  assert.deepEqual(gate.proxies, []);
  await client.close();
});

test("a token learns nothing about the policy from a profile it can't use", async () => {
  const gate = fakeGate();
  const { client } = await connectGated(gate, limited(["act"], { profiles: ["direct"] }));
  assert.equal(await errorCode(client, "navigate", { profile_id: "proxied", url: "http://blocked/" }), "FORBIDDEN");
  assert.deepEqual(gate.urls, []);
  await client.close();
});

test("cdp_send and cdp_send_no_safety aren't gated: raw can defeat the policy, and this says so", async () => {
  const gate = fakeGate();
  const { client, driver } = await connectGated(gate);
  for (const name of ["cdp_send", "cdp_send_no_safety"]) {
    assert.equal(policyFor(name)!.urlArg, undefined, name);
    assert.equal(policyFor(name)!.proxyArg, undefined, name);
    const res = await client.callTool({
      name,
      arguments: {
        profile_id: "direct",
        method: "Target.createBrowserContext",
        params: { proxyServer: "direct://blocked" },
      },
    });
    assert.equal(res.isError, undefined, name);
  }
  assert.deepEqual(gate.urls, []);
  assert.deepEqual(gate.proxies, []);
  assert.ok(driver.cdpCalls.some((c) => c.method === "Target.createBrowserContext"));
  await client.close();
});

test("no gate, or one not enforcing: nothing is asked, as on the desktop", async () => {
  const idle = fakeGate(false);
  for (const egress of [undefined, idle]) {
    const { client } = await connectGated(egress);
    const res = await client.callTool({ name: "navigate", arguments: { profile_id: "direct", url: "http://blocked/" } });
    assert.equal(res.isError, undefined);
    await client.close();
  }
  assert.deepEqual(idle.urls, []);
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

test("list_profiles names no host path, to anyone: a real manager's listing has none", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mz-policy-"));
  const profiles = new ProfileManager({ dbPath: join(dir, "profiles.db"), profilesRoot: join(dir, "profiles") });
  t.after(() => {
    profiles.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const created = profiles.create({ name: "n", engine: "cloakbrowser" });
  profiles.update(created.id, {
    extensions: [{ id: "e", name: "x", version: "1", scope: "profile", enabled: true, dir: "ext", source: "file" }],
  });
  const { server } = createMultizenMcpServer({
    profileManager: profiles,
    browserDriver: new MockBrowserDriver(),
    principal: limited(["read"]),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const res = await client.callTool({ name: "list_profiles", arguments: {} });
  await client.close();
  const text = (res.content as Array<{ text: string }>)[0]!.text;
  assert.equal(text.includes(dir), false, text);
  assert.equal(text.includes("dataDir"), false);
  assert.equal(text.includes('"dir"'), false);
});

test("an unexpected error names no host path to a token that isn't the owner's", async () => {
  const seen = async (principal: Principal, message: string): Promise<string> => {
    const driver = new MockBrowserDriver();
    await driver.launch("p");
    driver.navigate = async () => {
      throw new Error(message);
    };
    const { server } = createMultizenMcpServer({
      profileManager: { get: () => ({ id: "p" }), list: () => [] } as unknown as ProfileManager,
      browserDriver: driver,
      principal,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const res = await client.callTool({ name: "navigate", arguments: { profile_id: "p", url: "http://x.test/" } });
    await client.close();
    const { error } = JSON.parse((res.content as Array<{ text: string }>)[0]!.text) as {
      error: { code: string; message: string };
    };
    assert.equal(error.code, "INTERNAL_ERROR");
    return error.message;
  };
  for (const [message, expected] of [
    ["ENOENT: no such file or directory, open '/data/profiles/p/x y.db'", "ENOENT: no such file or directory, open '<path>'"],
    [String.raw`EPERM: operation not permitted, rename 'C:\Users\Name Here\a' -> 'C:\Users\b'`, "EPERM: operation not permitted, rename '<path>' -> '<path>'"],
    ["failed at /data/profiles/p/db with code 5", "failed at <path> with code 5"],
    [String.raw`failed at C:\mzs\profiles\p`, "failed at <path>"],
    ["fetch http://example.test/a/b failed", "fetch http://example.test/a/b failed"],
    ["1/2 of it, and either/or", "1/2 of it, and either/or"],
  ] as const) {
    assert.equal(await seen(limited(["read", "act"]), message), expected);
  }
  const untouched = "ENOENT: no such file or directory, open '/data/profiles/p/x.db'";
  assert.equal(await seen(FULL_PRINCIPAL, untouched), untouched);
});

test("delete_download is in act, takes a lease, and is marked destructive", () => {
  const policy = policyFor("delete_download")!;
  assert.equal(policy.group, "act");
  assert.equal(policy.annotations.destructiveHint, true);
  assert.equal(leaseBinds(policy), true);
});
