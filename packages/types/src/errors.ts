/**
 * Every error code a tool call can report. Clients branch on these strings, so
 * they are a stable API: add new ones, never rename.
 */
export const MULTIZEN_ERROR_CODES = [
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
  "LAUNCH_FAILED",
  "GEO_MISMATCH",
  "ENGINE_NOT_READY",
  "DISPLAY_UNAVAILABLE",
  "SANDBOX_UNAVAILABLE",
  "HANDOFF_NOT_FOUND",
  "LEASE_INVALID",
  "RATE_LIMITED",
  "SESSION_LIMIT",
  "INPUT_NOT_DELIVERED",
] as const;

export type MultizenErrorCode = (typeof MULTIZEN_ERROR_CODES)[number];

/** Codes where the same call can succeed later with no change by the caller. */
const RETRYABLE_BY_DEFAULT: ReadonlySet<MultizenErrorCode> = new Set<MultizenErrorCode>([
  "TIMEOUT",
  "HUMAN_IN_CONTROL",
  "PROFILE_LEASED",
  "BROWSER_LIMIT_REACHED",
  "ENGINE_NOT_READY",
  "RATE_LIMITED",
  "SESSION_LIMIT",
  "INPUT_NOT_DELIVERED",
]);

export interface MultizenErrorDetails {
  /** How long to wait before retrying, when the server knows. */
  retry_after_ms?: number;
  [key: string]: unknown;
}

export interface MultizenErrorOptions {
  /** Overrides the code's default. */
  retryable?: boolean;
  hint?: string;
  details?: MultizenErrorDetails;
}

/**
 * The typed error of the agent-facing surface. Lives here (no `node:` imports)
 * because the renderer imports this package too.
 */
export class MultizenError extends Error {
  readonly code: MultizenErrorCode;
  readonly retryable: boolean;
  readonly hint?: string;
  readonly details?: MultizenErrorDetails;

  constructor(code: MultizenErrorCode, message: string, opts: MultizenErrorOptions = {}) {
    super(message);
    this.name = "MultizenError";
    this.code = code;
    this.retryable = opts.retryable ?? RETRYABLE_BY_DEFAULT.has(code);
    if (opts.hint !== undefined) this.hint = opts.hint;
    if (opts.details !== undefined) this.details = opts.details;
  }
}
