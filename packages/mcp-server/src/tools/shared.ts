import { z } from "zod";
import type { ProfileManager } from "@multizen/profile-manager";
import type { BrowserDriver } from "@multizen/types";
import type { Principal } from "../auth/principal.js";
import type { HumanHandoff } from "../handoff.js";
import type { LeaseRegistry } from "../LeaseRegistry.js";

/** Largest file `upload_file` takes as base64 and `get_download` returns inline. */
export const DEFAULT_MAX_INLINE_FILE_BYTES = 16 * 1024 * 1024;

/** What a tool handler can reach. The `dispatch` switch passes its own deps. */
export interface ToolContext {
  profileManager: ProfileManager;
  browserDriver: BrowserDriver;
  handoff: HumanHandoff;
  leases: LeaseRegistry;
  /** Who is making this call. */
  caller: { principal: Principal; sessionId: string };
  /** A directory `upload_file` may read from, besides the profile's own uploads dir. */
  uploadsRoot?: string;
  maxInlineFileBytes?: number;
  /** A handoff stops agents here: see `handoffGate` in MultizenMcpServerOptions. */
  handoffGate?: boolean;
  /** Where a download too large to send inline can be fetched from, without a trailing slash. */
  downloadsBaseUrl?: string;
}

/** A tool defined outside the `dispatch` switch, so upstream edits there don't collide. */
export interface ExtensionTool {
  definition: { name: string; description: string; inputSchema: Record<string, unknown> };
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

export const ProfileIdSchema = z.object({ profile_id: z.string().min(1) });
