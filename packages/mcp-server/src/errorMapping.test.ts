import { test } from "node:test";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MultizenError, MULTIZEN_ERROR_CODES } from "@multizen/types";
import { FingerprintReconcileError, type ProfileManager } from "@multizen/profile-manager";
import { z } from "zod";

import { toToolError } from "./errorMapping.js";
import { createMultizenMcpServer, type BrowserDriver } from "./server.js";
import { MockBrowserDriver } from "./MockBrowserDriver.js";

function inputNotDelivered(): Error {
  const e = new Error("the page received no pointer events");
  e.name = "InputNotDeliveredError";
  return e;
}

async function connect(
  driver: BrowserDriver,
  profileManager = { get: () => null } as unknown as ProfileManager,
): Promise<Client> {
  const { server } = createMultizenMcpServer({ profileManager, browserDriver: driver });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function callError(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await client.callTool({ name, arguments: args });
  assert.equal(res.isError, true, `${name} should have failed`);
  const body = JSON.parse((res.content as Array<{ text: string }>)[0]!.text) as {
    error: Record<string, unknown>;
  };
  // The shape every client already parses: one `error` object with these two.
  assert.deepEqual(Object.keys(body), ["error"]);
  assert.equal(typeof body.error.code, "string");
  assert.equal(typeof body.error.message, "string");
  return body.error;
}

test("every code a MultizenError can carry reaches the client unchanged", () => {
  for (const code of MULTIZEN_ERROR_CODES) {
    const fields = toToolError(new MultizenError(code, "m"), "navigate");
    assert.equal(fields.code, code);
    assert.equal(fields.message, "m");
    assert.equal(fields.retryable, new MultizenError(code, "m").retryable);
    assert.equal("hint" in fields, false);
    assert.equal("details" in fields, false);
  }
});

test("hint and details pass through, and a caller can override retryable", () => {
  const fields = toToolError(
    new MultizenError("TIMEOUT", "m", {
      retryable: false,
      hint: "h",
      details: { retry_after_ms: 5 },
    }),
    "navigate",
  );
  assert.deepEqual(fields, {
    code: "TIMEOUT",
    message: "m",
    retryable: false,
    hint: "h",
    details: { retry_after_ms: 5 },
  });
});

test("the errors from outside this package map to their codes", () => {
  const zod = z.object({ a: z.string() }).safeParse({});
  assert.ok(!zod.success);
  assert.equal(toToolError(zod.error, "x").code, "INVALID_INPUT");

  const reconcile = new FingerprintReconcileError("locale");
  assert.deepEqual(toToolError(reconcile, "x"), {
    code: "INVALID_INPUT",
    message: reconcile.message,
    retryable: false,
  });

  assert.deepEqual(toToolError(inputNotDelivered(), "x"), {
    code: "INPUT_NOT_DELIVERED",
    message: "the page received no pointer events",
    retryable: true,
  });

  assert.deepEqual(toToolError(new Error("boom"), "x"), {
    code: "INTERNAL_ERROR",
    message: "boom",
    retryable: false,
  });
  assert.equal(toToolError("not an error", "x").message, "not an error");
});

test("navigate on a stopped profile says PROFILE_NOT_RUNNING over the wire", async () => {
  const client = await connect(new MockBrowserDriver());
  const error = await callError(client, "navigate", {
    profile_id: "p",
    url: "https://example.com/",
  });
  assert.deepEqual(error, {
    code: "PROFILE_NOT_RUNNING",
    message: "Profile p is not running. Call launch_profile first.",
    retryable: false,
  });
  await client.close();
});

test("cdp_send* keep their historical code for a stopped profile, and only them", async () => {
  const client = await connect(new MockBrowserDriver());
  for (const name of ["cdp_send", "cdp_send_no_safety"]) {
    const error = await callError(client, name, { profile_id: "p", method: "Runtime.evaluate" });
    assert.equal(error.code, "INTERNAL_ERROR", name);
    assert.match(String(error.message), /not running/);
  }
  const typed = await callError(client, "evaluate_js", { profile_id: "p", expression: "1" });
  assert.equal(typed.code, "PROFILE_NOT_RUNNING");
  await client.close();
});

test("launch_profile and update_profile on an unknown profile say PROFILE_NOT_FOUND", async () => {
  const client = await connect(new MockBrowserDriver());
  for (const name of ["launch_profile", "update_profile", "delete_profile", "probe_fingerprint"]) {
    const error = await callError(client, name, { profile_id: "ghost" });
    assert.equal(error.code, "PROFILE_NOT_FOUND", name);
    assert.equal(error.message, "Profile ghost not found", name);
    assert.equal(error.retryable, false, name);
  }
  await client.close();
});

test("an engine change on a running profile says PROFILE_ALREADY_RUNNING", async () => {
  const driver = new MockBrowserDriver();
  await driver.launch("p");
  const profileManager = {
    get: () => ({ id: "p", engine: "cloakbrowser" }),
  } as unknown as ProfileManager;
  const client = await connect(driver, profileManager);
  const error = await callError(client, "update_profile", { profile_id: "p", engine: "camoufox" });
  assert.equal(error.code, "PROFILE_ALREADY_RUNNING");
  assert.match(String(error.message), /close_profile/);
  await client.close();
});

test("a typed error from a driver reaches the client with its hint and details", async () => {
  const driver = new MockBrowserDriver();
  driver.launch = async () => {
    throw new MultizenError("ENGINE_NOT_READY", "installing", {
      hint: "retry",
      details: { retry_after_ms: 5000 },
    });
  };
  const profileManager = { get: () => ({ id: "p" }) } as unknown as ProfileManager;
  const client = await connect(driver, profileManager);
  const error = await callError(client, "launch_profile", { profile_id: "p" });
  assert.deepEqual(error, {
    code: "ENGINE_NOT_READY",
    message: "installing",
    retryable: true,
    hint: "retry",
    details: { retry_after_ms: 5000 },
  });
  await client.close();
});

test("a wait that only ever sees a navigating page is a retryable TIMEOUT", async () => {
  const driver = new MockBrowserDriver();
  await driver.launch("p");
  driver.evaluateJs = async () => {
    throw new Error("Execution context was destroyed");
  };
  const client = await connect(driver);
  const error = await callError(client, "wait_for_load", { profile_id: "p", timeout_ms: 1 });
  assert.equal(error.code, "TIMEOUT");
  assert.equal(error.retryable, true);
  assert.match(String(error.message), /Timed out/);
  await client.close();
});
