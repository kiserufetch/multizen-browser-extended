import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { ToolGroup } from "./auth/principal.js";

/** All four MCP hints, always explicit: a client's defaults assume the worst. */
export type ToolHints = Required<
  Pick<ToolAnnotations, "readOnlyHint" | "destructiveHint" | "idempotentHint" | "openWorldHint">
>;

/**
 * What a tool may do while a human holds the profile. `allow-unless-sensitive`
 * blocks during a `2fa` or `login` handoff, whose page shows what the human types.
 */
export type HumanGate = "block" | "allow" | "allow-unless-sensitive";

export interface ToolPolicy {
  group: ToolGroup;
  annotations: ToolHints;
  /** `profile`: the call's `profile_id` must be within the principal's profiles. */
  scope: "none" | "profile";
  /** `iteration` holds the profile per poll, `none` never queues behind an operation. */
  lock: "op" | "iteration" | "none";
  humanGate: HumanGate;
  /** The argument holding a URL the browser will open. */
  urlArg?: string;
  /** The argument holding a proxy the browser, and this process, will connect to. */
  proxyArg?: string;
  /** Ends the profile for everyone queued: they are told so rather than left to wait. */
  preempts?: boolean;
  /** Checks a lease itself, because a holder that reconnected has to get through. */
  ownLeaseCheck?: boolean;
  /** Makes something no list of profiles could already name, so it takes `profiles: "*"`. */
  needsAllProfiles?: boolean;
}

function hints(
  readOnlyHint: boolean,
  destructiveHint: boolean,
  idempotentHint: boolean,
  openWorldHint: boolean,
): ToolHints {
  return { readOnlyHint, destructiveHint, idempotentHint, openWorldHint };
}

/** Reads state the server or browser holds; no page or remote site is involved. */
const LOCAL_READ = hints(true, false, true, false);
/** Reads a live page: page scripts can observe it, nothing changes on purpose. */
const PAGE_READ = hints(true, false, true, true);
/** Local state changes that lose nothing. */
const LOCAL_CHANGE = hints(false, false, true, false);
/** Anything a click can do: submit, delete, buy. Never idempotent. */
const PAGE_ACTION = hints(false, true, false, true);

const unlocked = { lock: "none", humanGate: "allow" } as const;
const pageRead = { scope: "profile", lock: "op", humanGate: "allow" } as const;
const pageWrite = { scope: "profile", lock: "op", humanGate: "block" } as const;

/**
 * One entry per tool, TOOL_DEFINITIONS and tools/* alike. A tool missing from this
 * table is invisible and refused, however privileged the caller (default deny).
 * Groups follow spec decision 2.
 */
// prettier-ignore
const TOOL_POLICIES: Readonly<Record<string, ToolPolicy>> = {
  // read
  list_profiles: { group: "read", annotations: LOCAL_READ, scope: "none", ...unlocked },
  list_fingerprint_options: { group: "read", annotations: LOCAL_READ, scope: "none", ...unlocked },
  extract: { group: "read", annotations: PAGE_READ, ...pageRead, humanGate: "allow-unless-sensitive" },
  screenshot: { group: "read", annotations: PAGE_READ, ...pageRead, humanGate: "allow-unless-sensitive" },
  // The browser answers this, not the page, so it can't get stuck and needn't queue.
  list_tabs: { group: "read", annotations: LOCAL_READ, scope: "profile", ...unlocked },
  probe_fingerprint: { group: "read", annotations: PAGE_READ, ...pageRead },
  list_downloads: { group: "read", annotations: LOCAL_READ, scope: "profile", ...unlocked },
  // Answers the dialog an operation may be stuck behind, so it can't queue behind it.
  list_dialogs: { group: "read", annotations: LOCAL_READ, scope: "profile", ...unlocked },
  get_human_status: { group: "read", annotations: LOCAL_READ, scope: "profile", ...unlocked },

  // act
  launch_profile: { group: "act", annotations: hints(false, false, true, true), ...pageWrite },
  // Bypasses the queue and, during a handoff, ends it as aborted.
  close_profile: { group: "act", annotations: hints(false, true, true, false), scope: "profile", ...unlocked, preempts: true },
  navigate: { group: "act", annotations: hints(false, false, false, true), ...pageWrite, urlArg: "url" },
  click: { group: "act", annotations: PAGE_ACTION, ...pageWrite },
  type: { group: "act", annotations: PAGE_ACTION, ...pageWrite },
  click_ref: { group: "act", annotations: PAGE_ACTION, ...pageWrite },
  type_ref: { group: "act", annotations: PAGE_ACTION, ...pageWrite },
  press_key: { group: "act", annotations: PAGE_ACTION, ...pageWrite },
  hover: { group: "act", annotations: hints(false, false, true, true), ...pageWrite },
  select_option: { group: "act", annotations: hints(false, true, true, true), ...pageWrite },
  scroll: { group: "act", annotations: hints(false, false, false, true), ...pageWrite },
  upload_file: { group: "act", annotations: PAGE_ACTION, ...pageWrite },
  get_download: { group: "act", annotations: LOCAL_READ, scope: "profile", ...unlocked },
  handle_dialog: { group: "act", annotations: PAGE_ACTION, scope: "profile", lock: "none", humanGate: "block" },
  set_dialog_policy: { group: "act", annotations: LOCAL_CHANGE, scope: "profile", lock: "none", humanGate: "block" },
  evaluate_js: { group: "act", annotations: PAGE_ACTION, ...pageWrite },
  wait_for_selector: { group: "act", annotations: PAGE_READ, ...pageWrite, lock: "iteration" },
  wait_for_navigation: { group: "act", annotations: PAGE_READ, ...pageWrite, lock: "iteration" },
  wait_for_load: { group: "act", annotations: PAGE_READ, ...pageWrite, lock: "iteration" },
  // Session secrets, which is why it is `act` although it only reads.
  get_cookies: { group: "act", annotations: LOCAL_READ, ...pageRead, humanGate: "allow-unless-sensitive" },
  set_cookies: { group: "act", annotations: hints(false, true, true, false), ...pageWrite },
  new_tab: { group: "act", annotations: hints(false, false, false, true), ...pageWrite, urlArg: "url" },
  activate_tab: { group: "act", annotations: hints(false, false, true, false), ...pageWrite },
  close_tab: { group: "act", annotations: hints(false, true, true, false), ...pageWrite },
  request_human: { group: "act", annotations: LOCAL_CHANGE, scope: "profile", ...unlocked },
  wait_for_human: { group: "act", annotations: LOCAL_READ, scope: "profile", ...unlocked },
  // Lease TTL keeps running during a handoff, so renewal has to keep working.
  acquire_profile: { group: "act", annotations: hints(false, false, false, false), scope: "profile", ...unlocked, ownLeaseCheck: true },
  renew_profile: { group: "act", annotations: hints(false, false, false, false), scope: "profile", ...unlocked, ownLeaseCheck: true },
  release_profile: { group: "act", annotations: LOCAL_CHANGE, scope: "profile", ...unlocked, ownLeaseCheck: true },

  // profile-admin
  create_profile: { group: "profile-admin", annotations: hints(false, false, false, false), scope: "none", ...unlocked, needsAllProfiles: true, proxyArg: "proxy" },
  // Only the database: a live browser keeps what it launched with, so nothing to queue behind.
  update_profile: { group: "profile-admin", annotations: hints(false, true, true, false), ...pageWrite, lock: "none", proxyArg: "proxy" },
  delete_profile: { group: "profile-admin", annotations: hints(false, true, true, false), ...pageWrite },

  // raw
  cdp_send: { group: "raw", annotations: PAGE_ACTION, ...pageWrite },
  cdp_send_no_safety: { group: "raw", annotations: PAGE_ACTION, ...pageWrite },

  // operator
  resume_human: { group: "operator", annotations: LOCAL_CHANGE, scope: "profile", ...unlocked },
};

/** Own entries only: a tool name is caller input, and `constructor` is a name too. */
export function policyFor(tool: string): ToolPolicy | null {
  return Object.hasOwn(TOOL_POLICIES, tool) ? TOOL_POLICIES[tool]! : null;
}

/** A lease keeps others from changing a profile. Reading it disturbs nobody. */
export function leaseBinds(policy: ToolPolicy): boolean {
  return !policy.annotations.readOnlyHint && !policy.ownLeaseCheck;
}

export function policedToolNames(): string[] {
  return Object.keys(TOOL_POLICIES);
}
