import { z } from "zod";
import { FingerprintReconcileError, type ProfileManager } from "@multizen/profile-manager";
import { MultizenError, type BrowserDriver, type MultizenErrorDetails } from "@multizen/types";

/** The `error` object of a failed tool result. Clients branch on `code`. */
export interface ToolErrorFields {
  code: string;
  message: string;
  retryable: boolean;
  hint?: string;
  details?: MultizenErrorDetails;
}

/**
 * These two predate typed errors and existing callers see INTERNAL_ERROR for a
 * stopped profile (cdpTools.test.ts pins it). Every other tool reports
 * PROFILE_NOT_RUNNING.
 */
const LEGACY_NOT_RUNNING_TOOLS: ReadonlySet<string> = new Set(["cdp_send", "cdp_send_no_safety"]);

function fromMultizenError(e: MultizenError, tool: string): ToolErrorFields {
  const legacy = e.code === "PROFILE_NOT_RUNNING" && LEGACY_NOT_RUNNING_TOOLS.has(tool);
  return {
    code: legacy ? "INTERNAL_ERROR" : e.code,
    message: e.message,
    retryable: e.retryable,
    ...(e.hint !== undefined ? { hint: e.hint } : {}),
    ...(e.details !== undefined ? { details: e.details } : {}),
  };
}

export function toToolError(e: unknown, tool: string): ToolErrorFields {
  if (e instanceof MultizenError) return fromMultizenError(e, tool);
  if (e instanceof z.ZodError || e instanceof FingerprintReconcileError) {
    return { code: "INVALID_INPUT", message: e.message, retryable: false };
  }
  // InputNotDeliveredError comes from @multizen/cdp-driver, which this package
  // does not depend on, so match it by name.
  if (e instanceof Error && e.name === "InputNotDeliveredError") {
    return fromMultizenError(new MultizenError("INPUT_NOT_DELIVERED", e.message), tool);
  }
  return {
    code: "INTERNAL_ERROR",
    message: e instanceof Error ? e.message : String(e),
    retryable: false,
  };
}

export function profileNotFound(id: string): MultizenError {
  return new MultizenError("PROFILE_NOT_FOUND", `Profile ${id} not found`);
}

export function assertProfileExists(pm: ProfileManager, id: string): void {
  if (!pm.get(id)) throw profileNotFound(id);
}

export function assertProfileRunning(driver: BrowserDriver, id: string): void {
  if (!driver.isRunning(id)) {
    throw new MultizenError(
      "PROFILE_NOT_RUNNING",
      `Profile ${id} is not running. Call launch_profile first.`,
    );
  }
}
