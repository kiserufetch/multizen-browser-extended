import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ProfileManager } from "@multizen/profile-manager";

import { MockBrowserDriver } from "./MockBrowserDriver.js";
import { createMultizenMcpServer } from "./server.js";

/**
 * Clients and desktop configs in the field were written against this surface.
 * testdata/tools-list.baseline.json is tools/list as it stood before the server
 * mode work: everything in it must stay callable with the same arguments. Do not
 * regenerate it to make this test pass; adding a tool or an optional argument
 * doesn't need that.
 */
interface BaselineTool {
  name: string;
  inputSchema: Schema;
}
type Schema = Record<string, unknown>;

const BASELINE = JSON.parse(
  readFileSync(new URL("./testdata/tools-list.baseline.json", import.meta.url), "utf8"),
) as BaselineTool[];

async function currentTools(): Promise<Map<string, Schema>> {
  const { server } = createMultizenMcpServer({
    profileManager: {} as unknown as ProfileManager,
    browserDriver: new MockBrowserDriver(),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  await client.close();
  return new Map(tools.map((t) => [t.name, t.inputSchema as Schema]));
}

/**
 * The first problem that would break a client written against `before`, or null.
 * Descriptions are prose and free to change. New optional properties and new enum
 * values are additions; a new required property or a narrower type is not.
 */
function incompatibility(before: Schema, after: Schema, at: string): string | null {
  for (const [key, value] of Object.entries(before)) {
    if (key === "description") continue;
    const next = after[key];
    if (key === "properties") {
      const props = value as Record<string, Schema>;
      const nextProps = (next ?? {}) as Record<string, Schema>;
      for (const [prop, schema] of Object.entries(props)) {
        if (!nextProps[prop]) return `${at}.${prop} is gone`;
        const inner = incompatibility(schema, nextProps[prop]!, `${at}.${prop}`);
        if (inner) return inner;
      }
    } else if (key === "required") {
      const old = new Set(value as string[]);
      const added = ((next ?? []) as string[]).filter((name) => !old.has(name));
      if (added.length > 0) return `${at} newly requires ${added.join(", ")}`;
    } else if (key === "enum") {
      const allowed = new Set((next ?? []) as unknown[]);
      const lost = (value as unknown[]).filter((v) => !allowed.has(v));
      if (lost.length > 0) return `${at} no longer accepts ${lost.join(", ")}`;
    } else if (key === "items") {
      const inner = incompatibility(value as Schema, (next ?? {}) as Schema, `${at}[]`);
      if (inner) return inner;
    } else if (key === "anyOf") {
      const options = (next ?? []) as Schema[];
      for (const option of value as Schema[]) {
        const fits = options.some((o) => incompatibility(option, o, at) === null);
        if (!fits) return `${at} lost the option ${JSON.stringify(option)}`;
      }
    } else if (JSON.stringify(value) !== JSON.stringify(next)) {
      return `${at}.${key} changed from ${JSON.stringify(value)} to ${JSON.stringify(next)}`;
    }
  }
  return null;
}

test("the baseline is the surface as captured: 30 tools", () => {
  assert.equal(BASELINE.length, 30);
  assert.ok(BASELINE.some((t) => t.name === "cdp_send_no_safety"));
});

test("every baseline tool is still there with a compatible input schema", async () => {
  const current = await currentTools();
  for (const { name, inputSchema } of BASELINE) {
    const schema = current.get(name);
    assert.ok(schema, `tool ${name} disappeared from tools/list`);
    assert.equal(incompatibility(inputSchema, schema, name), null);
  }
});

test("the comparison catches the changes that would break a client", () => {
  const before: Schema = {
    type: "object",
    required: ["a"],
    properties: {
      a: { type: "string", description: "old text" },
      b: { type: "string", enum: ["x", "y"] },
      c: { anyOf: [{ type: "boolean" }, { type: "null" }] },
      d: { type: "array", items: { type: "string" } },
    },
  };
  const same = JSON.parse(JSON.stringify(before)) as Schema;
  assert.equal(incompatibility(before, same, "t"), null);

  const change = (mutate: (s: any) => void): string | null => {
    const copy = JSON.parse(JSON.stringify(before));
    mutate(copy);
    return incompatibility(before, copy, "t");
  };
  assert.equal(
    change((s) => (s.properties.a.description = "new text")),
    null,
    "prose may change",
  );
  assert.equal(
    change((s) => (s.properties.z = { type: "string" })),
    null,
    "an optional addition is fine",
  );
  assert.equal(
    change((s) => s.properties.b.enum.push("z")),
    null,
    "a new enum value is fine",
  );
  assert.match(change((s) => delete s.properties.a)!, /t\.a is gone/);
  assert.match(change((s) => s.required.push("b"))!, /newly requires b/);
  assert.match(change((s) => (s.properties.a.type = "number"))!, /t\.a\.type changed/);
  assert.match(change((s) => (s.properties.b.enum = ["x"]))!, /no longer accepts y/);
  assert.match(change((s) => (s.properties.c.anyOf = [{ type: "boolean" }]))!, /lost the option/);
  assert.match(change((s) => (s.properties.d.items.type = "number"))!, /t\.d\[\]\.type changed/);
});
