import { test } from "node:test";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMultizenMcpServer } from "./server.js";
import { MockBrowserDriver } from "./MockBrowserDriver.js";
import { generateFingerprint, type ProfileManager } from "@multizen/profile-manager";
import type {
  BrowserEngine,
  CreateProfileInput,
  Profile,
  ProfileId,
  UpdateProfileInput,
} from "@multizen/types";

/**
 * The per-profile engine through the MCP profile tools: create_profile pins the
 * app default when no engine is given, update_profile refuses an engine change
 * on a running profile, and list_profiles reports the effective engine. The
 * profile manager is an in-memory stand-in that stores `engine` verbatim (as
 * the SQLite one does: unset → NULL → follows the default).
 */

class FakeProfileManager {
  readonly rows = new Map<ProfileId, Profile>();
  private seq = 0;

  list() {
    return [...this.rows.values()].map((p) => ({
      id: p.id,
      name: p.name,
      tags: p.tags,
      isRunning: false,
      engine: p.engine,
      displayMode: p.displayMode,
    }));
  }
  get(id: ProfileId): Profile | null {
    return this.rows.get(id) ?? null;
  }
  create(input: CreateProfileInput): Profile {
    const id = `p${++this.seq}`;
    const now = new Date().toISOString();
    const profile: Profile = {
      id,
      name: input.name,
      tags: input.tags ?? [],
      fingerprint: { ...generateFingerprint(), ...input.fingerprint },
      engine: input.engine,
      displayMode: input.displayMode,
      dataDir: `/tmp/${id}`,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(id, profile);
    return profile;
  }
  update(id: ProfileId, patch: UpdateProfileInput): Profile {
    const existing = this.rows.get(id);
    if (!existing) throw new Error(`Profile ${id} not found`);
    const merged: Profile = {
      ...existing,
      name: patch.name ?? existing.name,
      engine: patch.engine === null ? undefined : (patch.engine ?? existing.engine),
      displayMode: patch.displayMode === null ? undefined : (patch.displayMode ?? existing.displayMode),
    };
    this.rows.set(id, merged);
    return merged;
  }
  /** Insert a row as an older build left it (engine possibly NULL). */
  seed(id: ProfileId, engine: BrowserEngine | undefined): void {
    const now = new Date().toISOString();
    this.rows.set(id, {
      id,
      name: id,
      tags: [],
      fingerprint: generateFingerprint(),
      engine,
      dataDir: `/tmp/${id}`,
      createdAt: now,
      updatedAt: now,
    });
  }
}

interface Harness {
  client: Client;
  pm: FakeProfileManager;
  driver: MockBrowserDriver;
  setDefault: (e: BrowserEngine) => void;
}

async function connect(opts: { withDefault?: boolean } = { withDefault: true }): Promise<Harness> {
  const pm = new FakeProfileManager();
  const driver = new MockBrowserDriver();
  let defaultEngine: BrowserEngine = "camoufox";
  const { server } = createMultizenMcpServer({
    profileManager: pm as unknown as ProfileManager,
    browserDriver: driver,
    ...(opts.withDefault ? { getDefaultEngine: () => defaultEngine } : {}),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, pm, driver, setDefault: (e) => (defaultEngine = e) };
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; parsed: any }> {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ text: string }>)[0]?.text ?? "";
  return { isError: res.isError === true, parsed: JSON.parse(text) };
}

test("create_profile and update_profile advertise an engine enum of the roster", async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  for (const name of ["create_profile", "update_profile"]) {
    const props = (tools.find((t) => t.name === name)!.inputSchema as any).properties;
    assert.deepEqual(props.engine.enum, ["cloakbrowser", "camoufox"], name);
  }
  await client.close();
});

test("create_profile with no engine pins the app default at creation", async () => {
  const { client, pm, setDefault } = await connect();
  const { isError, parsed } = await call(client, "create_profile", { name: "a" });
  assert.equal(isError, false);
  assert.equal(parsed.engine, "camoufox");
  assert.equal(pm.get(parsed.id)?.engine, "camoufox", "stored pinned, not NULL");

  // A later default change must not move the profile.
  setDefault("cloakbrowser");
  const list = await call(client, "list_profiles", {});
  assert.equal(list.parsed.profiles[0].engine, "camoufox");
  await client.close();
});

test("create_profile without a getDefaultEngine option pins CloakBrowser", async () => {
  const { client, pm } = await connect({ withDefault: false });
  const { parsed } = await call(client, "create_profile", { name: "a" });
  assert.equal(pm.get(parsed.id)?.engine, "cloakbrowser");
  await client.close();
});

test("create_profile honours an explicit engine and rejects one outside the roster", async () => {
  const { client, pm } = await connect();
  const ok = await call(client, "create_profile", { name: "a", engine: "cloakbrowser" });
  assert.equal(ok.isError, false);
  assert.equal(pm.get(ok.parsed.id)?.engine, "cloakbrowser");

  const bad = await call(client, "create_profile", { name: "b", engine: "cft" });
  assert.equal(bad.isError, true);
  assert.equal(bad.parsed.error.code, "INVALID_INPUT");
  assert.equal(pm.rows.size, 1, "the invalid call created nothing");
  await client.close();
});

test("list_profiles resolves an unpinned (legacy NULL) row to the default", async () => {
  const { client, pm } = await connect();
  pm.seed("legacy", undefined);
  const { parsed } = await call(client, "list_profiles", {});
  assert.equal(parsed.profiles[0].engine, "camoufox");
  await client.close();
});

test("update_profile changes the engine of a stopped profile", async () => {
  const { client, pm } = await connect();
  pm.seed("p", "cloakbrowser");
  const { isError, parsed } = await call(client, "update_profile", {
    profile_id: "p",
    engine: "camoufox",
  });
  assert.equal(isError, false);
  assert.equal(parsed.engine, "camoufox");
  assert.equal(pm.get("p")?.engine, "camoufox");
  await client.close();
});

test("update_profile refuses an engine change on a running profile and saves nothing", async () => {
  const { client, pm, driver } = await connect();
  pm.seed("p", "cloakbrowser");
  await driver.launch("p");
  const { isError, parsed } = await call(client, "update_profile", {
    profile_id: "p",
    name: "renamed",
    engine: "camoufox",
  });
  assert.equal(isError, true);
  assert.match(parsed.error.message, /stop the profile/i);
  assert.match(parsed.error.message, /close_profile/);
  assert.equal(pm.get("p")?.engine, "cloakbrowser");
  assert.equal(pm.get("p")?.name, "p", "the rest of the patch was not applied either");
  await client.close();
});

test("update_profile on a running profile accepts its current engine", async () => {
  const { client, pm, driver } = await connect();
  pm.seed("pinned", "cloakbrowser");
  pm.seed("legacy", undefined); // follows the default, camoufox
  await driver.launch("pinned");
  await driver.launch("legacy");

  const a = await call(client, "update_profile", {
    profile_id: "pinned",
    name: "x",
    engine: "cloakbrowser",
  });
  assert.equal(a.isError, false);
  assert.equal(pm.get("pinned")?.name, "x");

  const b = await call(client, "update_profile", { profile_id: "legacy", engine: "camoufox" });
  assert.equal(b.isError, false, "matches the effective engine, so it is not a change");
  assert.equal(pm.get("legacy")?.engine, "camoufox");
  await client.close();
});

test("update_profile rejects a null engine (unpinning) via Zod", async () => {
  const { client, pm } = await connect();
  pm.seed("p", "cloakbrowser");
  const { isError, parsed } = await call(client, "update_profile", {
    profile_id: "p",
    engine: null,
  });
  assert.equal(isError, true);
  assert.equal(parsed.error.code, "INVALID_INPUT");
  assert.equal(pm.get("p")?.engine, "cloakbrowser");
  await client.close();
});

// ── display_mode ─────────────────────────────────────────────────────────────

const MODES = ["headed", "xvfb", "headless"];

test("create_profile, update_profile and launch_profile advertise display_mode", async () => {
  const { client, close } = await connectDisplay();
  try {
    const { tools } = await client.listTools();
    const props = (name: string): Record<string, any> =>
      (tools.find((t) => t.name === name)!.inputSchema as { properties: Record<string, any> }).properties;
    assert.deepEqual(props("create_profile").display_mode.enum, MODES);
    assert.deepEqual(props("launch_profile").display_mode.enum, MODES);
    assert.deepEqual(
      props("update_profile").display_mode.anyOf.map((o: { enum?: string[]; type: string }) => o.enum ?? o.type),
      [MODES, "null"],
    );
    for (const name of ["create_profile", "update_profile", "launch_profile"]) {
      const required = (tools.find((t) => t.name === name)!.inputSchema as { required?: string[] }).required;
      assert.equal(required?.includes("display_mode") ?? false, false, name);
    }
  } finally {
    await close();
  }
});

test("display_mode round trip: create, list, update, launch, list while running", async () => {
  const { client, close, driver } = await connectDisplay();
  try {
    const created = parsed(await client.callTool({
      name: "create_profile",
      arguments: { name: "a", display_mode: "headless" },
    }));
    assert.equal(created.displayMode, "headless");
    const id = created.id as string;

    const listed = async (): Promise<Record<string, unknown>> =>
      (parsed(await client.callTool({ name: "list_profiles", arguments: {} })).profiles as Array<Record<string, unknown>>)[0]!;
    assert.equal((await listed()).displayMode, "headless");
    assert.equal((await listed()).runningDisplayMode, null, "stopped");

    const updated = parsed(await client.callTool({
      name: "update_profile",
      arguments: { profile_id: id, display_mode: "headed" },
    }));
    assert.equal(updated.displayMode, "headed");
    assert.equal((await listed()).displayMode, "headed");

    const launched = parsed(await client.callTool({
      name: "launch_profile",
      arguments: { profile_id: id, display_mode: "headless" },
    }));
    assert.equal(launched.displayMode, "headless", "the launch's own wins over the saved");
    assert.equal(driver.runningDisplayMode(id), "headless");
    const running = await listed();
    assert.equal(running.displayMode, "headed", "the saved mode is untouched");
    assert.equal(running.runningDisplayMode, "headless");

    await client.callTool({ name: "close_profile", arguments: { profile_id: id } });
    const cleared = parsed(await client.callTool({
      name: "update_profile",
      arguments: { profile_id: id, display_mode: null },
    }));
    assert.equal(cleared.displayMode, null);
    assert.equal((await listed()).displayMode, undefined);
  } finally {
    await close();
  }
});

test("launch_profile without a mode passes none down: the router decides", async () => {
  const { client, close, driver } = await connectDisplay();
  try {
    const { id } = parsed(await client.callTool({ name: "create_profile", arguments: { name: "a" } }));
    const seen: unknown[] = [];
    const original = driver.launch.bind(driver);
    driver.launch = (profileId, opts) => {
      seen.push(opts?.displayMode);
      return original(profileId, opts);
    };
    await client.callTool({ name: "launch_profile", arguments: { profile_id: id } });
    assert.deepEqual(seen, [undefined]);
  } finally {
    await close();
  }
});

test("a mode outside the roster is INVALID_INPUT on every tool that takes one", async () => {
  const { client, close } = await connectDisplay();
  try {
    const { id } = parsed(await client.callTool({ name: "create_profile", arguments: { name: "a" } }));
    for (const [name, args] of [
      ["create_profile", { name: "b", display_mode: "auto" }],
      ["update_profile", { profile_id: id, display_mode: "auto" }],
      ["launch_profile", { profile_id: id, display_mode: "auto" }],
      ["launch_profile", { profile_id: id, display_mode: null }],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true, name);
      assert.equal((parsed(result).error as { code: string }).code, "INVALID_INPUT", name);
    }
  } finally {
    await close();
  }
});

test("update_profile: a real mode change on a running profile is refused, and saves nothing", async () => {
  const { client, close, pm } = await connectDisplay();
  try {
    const { id } = parsed(await client.callTool({
      name: "create_profile",
      arguments: { name: "a", display_mode: "headed" },
    }));
    await client.callTool({ name: "launch_profile", arguments: { profile_id: id } });

    const result = await client.callTool({
      name: "update_profile",
      arguments: { profile_id: id, name: "renamed", display_mode: "headless" },
    });
    assert.equal(result.isError, true);
    assert.equal((parsed(result).error as { code: string }).code, "PROFILE_ALREADY_RUNNING");
    assert.equal(pm.get(id)!.name, "a", "nothing else was saved either");
    assert.equal(pm.get(id)!.displayMode, "headed");

    const cleared = await client.callTool({
      name: "update_profile",
      arguments: { profile_id: id, display_mode: null },
    });
    assert.equal(cleared.isError, true, "clearing a saved mode is a real change too");
  } finally {
    await close();
  }
});

test("update_profile: re-sending the current mode on a running profile saves, the autosave rule", async () => {
  const { client, close, pm } = await connectDisplay();
  try {
    const withMode = parsed(await client.callTool({
      name: "create_profile",
      arguments: { name: "a", display_mode: "headless" },
    })).id as string;
    await client.callTool({ name: "launch_profile", arguments: { profile_id: withMode } });
    const saved = await client.callTool({
      name: "update_profile",
      arguments: { profile_id: withMode, name: "renamed", display_mode: "headless" },
    });
    assert.equal(saved.isError ?? false, false);
    assert.equal(parsed(saved).appliesOnNextLaunch, true);
    assert.equal(pm.get(withMode)!.name, "renamed");

    const unset = parsed(await client.callTool({ name: "create_profile", arguments: { name: "b" } })).id as string;
    await client.callTool({ name: "launch_profile", arguments: { profile_id: unset } });
    const nulled = await client.callTool({
      name: "update_profile",
      arguments: { profile_id: unset, name: "renamed", display_mode: null },
    });
    assert.equal(nulled.isError ?? false, false, "null on an unset mode changes nothing");
    assert.equal(pm.get(unset)!.name, "renamed");
  } finally {
    await close();
  }
});

test("update_profile: a stopped profile takes any change", async () => {
  const { client, close, pm } = await connectDisplay();
  try {
    const { id } = parsed(await client.callTool({ name: "create_profile", arguments: { name: "a" } }));
    await client.callTool({ name: "update_profile", arguments: { profile_id: id, display_mode: "xvfb" } });
    assert.equal(pm.get(id as string)!.displayMode, "xvfb");
  } finally {
    await close();
  }
});

async function connectDisplay(): Promise<Harness & { close: () => Promise<void> }> {
  const harness = await connect();
  return { ...harness, close: () => harness.client.close() };
}

function parsed(result: unknown): Record<string, any> {
  const { content } = result as { content: Array<{ text: string }> };
  return JSON.parse(content[0]!.text) as Record<string, any>;
}
