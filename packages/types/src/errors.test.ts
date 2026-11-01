import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MULTIZEN_ERROR_CODES, MultizenError, type MultizenErrorCode } from "./index.js";

test("every code from the spec, the addendum and the input check is defined exactly once", () => {
  const expected: MultizenErrorCode[] = [
    // spec
    "INVALID_INPUT",
    "INTERNAL_ERROR",
    "PROFILE_NOT_FOUND",
    "PROFILE_NOT_RUNNING",
    "PROFILE_ALREADY_RUNNING",
    "ELEMENT_NOT_FOUND",
    "STALE_REF",
    "ELEMENT_NOT_VISIBLE",
    "TIMEOUT",
    "NAVIGATION_FAILED",
    "TAB_NOT_FOUND",
    "DIALOG_OPEN",
    "UNSUPPORTED_ON_ENGINE",
    "HUMAN_IN_CONTROL",
    "PROFILE_LEASED",
    "BROWSER_LIMIT_REACHED",
    "FORBIDDEN",
    "EGRESS_BLOCKED",
    "FILE_NOT_ALLOWED",
    "FILE_TOO_LARGE",
    // addendum
    "LAUNCH_FAILED",
    "GEO_MISMATCH",
    "ENGINE_NOT_READY",
    "DISPLAY_UNAVAILABLE",
    "SANDBOX_UNAVAILABLE",
    "HANDOFF_NOT_FOUND",
    "LEASE_INVALID",
    "RATE_LIMITED",
    "SESSION_LIMIT",
    // input delivery check
    "INPUT_NOT_DELIVERED",
  ];
  assert.deepEqual([...MULTIZEN_ERROR_CODES].sort(), [...expected].sort());
  assert.equal(new Set(MULTIZEN_ERROR_CODES).size, MULTIZEN_ERROR_CODES.length);
});

test("MultizenError carries code, message and the Error identity", () => {
  const e = new MultizenError("STALE_REF", "ref 5 is gone");
  assert.ok(e instanceof Error);
  assert.ok(e instanceof MultizenError);
  assert.equal(e.name, "MultizenError");
  assert.equal(e.code, "STALE_REF");
  assert.equal(e.message, "ref 5 is gone");
  assert.equal(e.hint, undefined);
  assert.equal(e.details, undefined);
});

test("retryable defaults by code and an explicit option overrides it", () => {
  const retryable: MultizenErrorCode[] = [
    "TIMEOUT",
    "HUMAN_IN_CONTROL",
    "PROFILE_LEASED",
    "BROWSER_LIMIT_REACHED",
    "ENGINE_NOT_READY",
    "RATE_LIMITED",
    "SESSION_LIMIT",
    "INPUT_NOT_DELIVERED",
  ];
  for (const code of MULTIZEN_ERROR_CODES) {
    assert.equal(new MultizenError(code, "x").retryable, retryable.includes(code), code);
  }
  assert.equal(new MultizenError("TIMEOUT", "x", { retryable: false }).retryable, false);
  assert.equal(new MultizenError("INVALID_INPUT", "x", { retryable: true }).retryable, true);
});

test("hint and details pass through, including details.retry_after_ms", () => {
  const e = new MultizenError("RATE_LIMITED", "slow down", {
    hint: "wait and repeat the call",
    details: { retry_after_ms: 1500, scope: "token" },
  });
  assert.equal(e.hint, "wait and repeat the call");
  assert.equal(e.details?.retry_after_ms, 1500);
  assert.equal(e.details?.scope, "token");
});

test("the seam files stay free of node: imports, because the renderer imports this package", () => {
  for (const file of ["./errors.ts", "./driver.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /from\s+["']node:/, file);
  }
});
