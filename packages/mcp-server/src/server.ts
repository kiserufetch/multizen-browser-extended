import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ProfileManager } from "@multizen/profile-manager";
import {
  reconcileFingerprint,
  generateFingerprint,
  deviceCatalog,
  localeCatalog,
} from "@multizen/profile-manager";
import type {
  LaunchedProfile,
  ProfileId,
  FingerprintConfig,
  UpdateProfileInput,
  CreateProfileInput,
} from "@multizen/types";
import { ActivityLog } from "./ActivityLog.js";

/**
 * BrowserDriver is the surface that the MCP server delegates real
 * browser work to. The desktop app implements it on top of patched
 * Chromium + CDP. The standalone dev mode implements a mock so the
 * MCP server can be exercised without a browser.
 */
export interface BrowserDriver {
  launch(profileId: ProfileId): Promise<LaunchedProfile>;
  close(profileId: ProfileId): Promise<void>;
  isRunning(profileId: ProfileId): boolean;
  navigate(profileId: ProfileId, url: string): Promise<{ url: string }>;
  click(profileId: ProfileId, selector: string): Promise<{ ok: true }>;
  type(profileId: ProfileId, selector: string, text: string): Promise<{ ok: true }>;
  extract(profileId: ProfileId): Promise<{ result: unknown }>;
  screenshot(profileId: ProfileId): Promise<{ pngBase64: string }>;
}

export interface MultizenMcpServerOptions {
  profileManager: ProfileManager;
  browserDriver: BrowserDriver;
  /** Optional activity log; if not provided, a fresh one is created */
  activityLog?: ActivityLog;
}

export interface MultizenMcpServer {
  server: Server;
  activityLog: ActivityLog;
}

const ProfileIdSchema = z.object({ profile_id: z.string().min(1) });
const NavigateSchema = ProfileIdSchema.extend({ url: z.string().url() });
const ClickSchema = ProfileIdSchema.extend({ selector: z.string().min(1) });
const TypeSchema = ProfileIdSchema.extend({
  selector: z.string().min(1),
  text: z.string(),
});
const ExtractSchema = ProfileIdSchema;

/** Real device families a fingerprint can impersonate. Mirrors the
 *  `DeviceFamily` union in @multizen/types; call `list_fingerprint_options`
 *  for the human-readable catalog. */
const DEVICE_FAMILIES = [
  "macbook-pro-14-m3",
  "macbook-pro-14-m3-pro",
  "macbook-pro-16-m3-pro",
  "macbook-air-13-m3",
  "imac-24-m3",
  "windows-laptop-intel",
  "windows-laptop-nvidia",
  "windows-desktop-nvidia",
  "linux-desktop-intel",
] as const;

const ProxySchema = z.object({
  type: z.enum(["http", "socks5"]),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  username: z.string().optional(),
  password: z.string().optional(),
});

/**
 * User-facing fingerprint knobs. We deliberately do NOT accept the raw
 * `FingerprintConfig` (userAgent, clientHints, webgl, …): those surfaces must
 * stay mutually coherent or detection vendors flag the mismatch. Instead the
 * caller picks high-level dimensions and `reconcileFingerprint` derives a
 * coherent config from them.
 */
const FingerprintInputSchema = z
  .object({
    device: z.enum(DEVICE_FAMILIES).optional(),
    localeId: z.string().min(1).optional(),
    timezone: z.string().min(1).optional(),
    screen: z
      .object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
      .optional(),
    hardwareConcurrency: z.number().int().positive().optional(),
    deviceMemory: z.number().positive().optional(),
  })
  .strict();

const CreateProfileSchema = z.object({
  name: z.string().min(1),
  notes: z.string().optional(),
  tags: z.array(z.string()).optional(),
  proxy: ProxySchema.optional(),
  fingerprint: FingerprintInputSchema.optional(),
});

const UpdateProfileSchema = ProfileIdSchema.extend({
  name: z.string().min(1).optional(),
  notes: z.string().optional(),
  tags: z.array(z.string()).optional(),
  // `null` clears the proxy; omitted leaves it untouched.
  proxy: ProxySchema.nullable().optional(),
  fingerprint: FingerprintInputSchema.optional(),
});

export function createMultizenMcpServer(opts: MultizenMcpServerOptions): MultizenMcpServer {
  const { profileManager, browserDriver } = opts;
  const activityLog = opts.activityLog ?? new ActivityLog();

  const server = new Server(
    { name: "multizen", version: "0.2.11" },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = req.params.arguments ?? {};
    const event = activityLog.startCall(name, args);
    const startedAt = Date.now();

    try {
      const result = await dispatch(name, args, { profileManager, browserDriver });
      activityLog.finish(event, "ok", summarize(result), startedAt);
      return ok(result);
    } catch (e) {
      const message = e instanceof z.ZodError ? e.message : e instanceof Error ? e.message : String(e);
      const code = e instanceof z.ZodError ? "INVALID_INPUT" : "INTERNAL_ERROR";
      activityLog.finish(event, "error", message, startedAt);
      return err(code, message);
    }
  });

  return { server, activityLog };
}

interface DispatchDeps {
  profileManager: ProfileManager;
  browserDriver: BrowserDriver;
}

async function dispatch(
  name: string,
  args: Record<string, unknown>,
  deps: DispatchDeps,
): Promise<unknown> {
  const { profileManager, browserDriver } = deps;
  switch (name) {
    case "list_profiles": {
      const profiles = profileManager.list().map((p) => ({
        ...p,
        isRunning: browserDriver.isRunning(p.id),
      }));
      return { profiles };
    }
    case "create_profile": {
      const input = CreateProfileSchema.parse(args);
      const createInput: CreateProfileInput = {
        name: input.name,
        notes: input.notes,
        tags: input.tags,
        proxy: input.proxy,
      };
      if (input.fingerprint) {
        // Seed from a fresh coherent fingerprint, then apply the caller's
        // high-level knobs so the result stays internally consistent.
        createInput.fingerprint = reconcileFingerprint(
          generateFingerprint(),
          input.fingerprint,
        );
      }
      const created = profileManager.create(createInput);
      return {
        id: created.id,
        name: created.name,
        proxy: created.proxy,
        fingerprint: fingerprintSummary(created.fingerprint),
      };
    }
    case "update_profile": {
      const input = UpdateProfileSchema.parse(args);
      const existing = profileManager.get(input.profile_id);
      if (!existing) throw new Error(`Profile ${input.profile_id} not found`);

      const patch: UpdateProfileInput = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.notes !== undefined) patch.notes = input.notes;
      if (input.tags !== undefined) patch.tags = input.tags;
      // `proxy: null` clears it, `proxy: {…}` sets it, omitted leaves as-is.
      if (input.proxy !== undefined) patch.proxy = input.proxy;
      if (input.fingerprint !== undefined) {
        patch.fingerprint = reconcileFingerprint(existing.fingerprint, input.fingerprint);
      }

      const updated = profileManager.update(input.profile_id, patch);
      return {
        id: updated.id,
        name: updated.name,
        tags: updated.tags,
        proxy: updated.proxy,
        fingerprint: fingerprintSummary(updated.fingerprint),
        // Surface the caveat: a live browser keeps the old proxy/fingerprint.
        appliesOnNextLaunch: browserDriver.isRunning(input.profile_id),
      };
    }
    case "delete_profile": {
      const { profile_id } = ProfileIdSchema.parse(args);
      assertProfileExists(profileManager, profile_id);
      // Close first so Chromium releases the data dir before we remove it
      // (on Windows a live handle would otherwise block the rmSync).
      if (browserDriver.isRunning(profile_id)) {
        await browserDriver.close(profile_id);
      }
      profileManager.delete(profile_id);
      return { deleted: profile_id };
    }
    case "list_fingerprint_options": {
      return {
        devices: deviceCatalog(),
        locales: localeCatalog(),
      };
    }
    case "launch_profile": {
      const { profile_id } = ProfileIdSchema.parse(args);
      assertProfileExists(profileManager, profile_id);
      // ChromiumBrowserDriver.launch() handles markOpened internally so
      // every entry-point (UI, MCP, palette) gets the same timestamp.
      const launched = await browserDriver.launch(profile_id);
      return launched;
    }
    case "close_profile": {
      const { profile_id } = ProfileIdSchema.parse(args);
      await browserDriver.close(profile_id);
      return { closed: profile_id };
    }
    case "navigate": {
      const { profile_id, url } = NavigateSchema.parse(args);
      assertProfileRunning(browserDriver, profile_id);
      return await browserDriver.navigate(profile_id, url);
    }
    case "click": {
      const { profile_id, selector } = ClickSchema.parse(args);
      assertProfileRunning(browserDriver, profile_id);
      return await browserDriver.click(profile_id, selector);
    }
    case "type": {
      const { profile_id, selector, text } = TypeSchema.parse(args);
      assertProfileRunning(browserDriver, profile_id);
      return await browserDriver.type(profile_id, selector, text);
    }
    case "extract": {
      const { profile_id } = ExtractSchema.parse(args);
      assertProfileRunning(browserDriver, profile_id);
      return await browserDriver.extract(profile_id);
    }
    case "screenshot": {
      const { profile_id } = ProfileIdSchema.parse(args);
      assertProfileRunning(browserDriver, profile_id);
      return await browserDriver.screenshot(profile_id);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

const PROXY_JSON_SCHEMA = {
  type: "object",
  description: "Per-profile proxy. DNS is resolved remotely via a local SOCKS5 bridge.",
  required: ["type", "host", "port"],
  properties: {
    type: { type: "string", enum: ["http", "socks5"] },
    host: { type: "string" },
    port: { type: "integer", minimum: 1, maximum: 65535 },
    username: { type: "string" },
    password: { type: "string" },
  },
} as const;

const FINGERPRINT_JSON_SCHEMA = {
  type: "object",
  description:
    "High-level fingerprint dimensions. The server derives a coherent UA / Client-Hints / WebGL / locale story from these — raw surfaces cannot be set individually. All fields optional; omitted ones keep their current/coherent value.",
  properties: {
    device: {
      type: "string",
      enum: [...DEVICE_FAMILIES],
      description: "Device family to impersonate (see list_fingerprint_options).",
    },
    localeId: {
      type: "string",
      description: "Locale group id, e.g. 'en-US', 'de-DE' (see list_fingerprint_options).",
    },
    timezone: {
      type: "string",
      description: "IANA timezone; must belong to the chosen locale, else snapped to a valid one.",
    },
    screen: {
      type: "object",
      required: ["width", "height"],
      properties: {
        width: { type: "integer", minimum: 1 },
        height: { type: "integer", minimum: 1 },
      },
    },
    hardwareConcurrency: { type: "integer", minimum: 1 },
    deviceMemory: { type: "number", minimum: 1 },
  },
} as const;

const TOOL_DEFINITIONS = [
  {
    name: "list_profiles",
    description:
      "List all browser profiles available on this machine. Returns id, name, tags, last opened, and running state.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_profile",
    description:
      "Create a new browser profile. Only `name` is required; a coherent default fingerprint is generated. Optionally pass a `proxy` and/or high-level `fingerprint` knobs to set them at creation time. Call list_fingerprint_options for valid device families and locale ids.",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", description: "Human-readable name" },
        notes: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        proxy: PROXY_JSON_SCHEMA,
        fingerprint: FINGERPRINT_JSON_SCHEMA,
      },
    },
  },
  {
    name: "launch_profile",
    description:
      "Launch a profile in patched Chromium. Returns CDP endpoint. Idempotent: returns existing endpoint if already running.",
    inputSchema: {
      type: "object",
      required: ["profile_id"],
      properties: { profile_id: { type: "string" } },
    },
  },
  {
    name: "close_profile",
    description: "Close a running profile. Cookies and state remain on disk.",
    inputSchema: {
      type: "object",
      required: ["profile_id"],
      properties: { profile_id: { type: "string" } },
    },
  },
  {
    name: "navigate",
    description: "Navigate the profile's browser to a URL. Waits for page load.",
    inputSchema: {
      type: "object",
      required: ["profile_id", "url"],
      properties: {
        profile_id: { type: "string" },
        url: { type: "string", format: "uri" },
      },
    },
  },
  {
    name: "click",
    description:
      "Click an element by CSS selector. The selector must be precise — call extract first to inspect the page accessibility tree, then derive a selector from it.",
    inputSchema: {
      type: "object",
      required: ["profile_id", "selector"],
      properties: {
        profile_id: { type: "string" },
        selector: {
          type: "string",
          description: "CSS selector, e.g. 'button[type=submit]' or 'input[name=email]'",
        },
      },
    },
  },
  {
    name: "type",
    description: "Type text into an input element by CSS selector.",
    inputSchema: {
      type: "object",
      required: ["profile_id", "selector", "text"],
      properties: {
        profile_id: { type: "string" },
        selector: { type: "string", description: "CSS selector for the input element" },
        text: { type: "string" },
      },
    },
  },
  {
    name: "extract",
    description:
      "Snapshot the current page: returns the URL, title, and a trimmed accessibility tree. The calling LLM is responsible for parsing this into whatever structured data it needs. MultiZen does not call any external API.",
    inputSchema: {
      type: "object",
      required: ["profile_id"],
      properties: {
        profile_id: { type: "string" },
      },
    },
  },
  {
    name: "screenshot",
    description: "Capture a PNG screenshot of the current viewport. Returns base64.",
    inputSchema: {
      type: "object",
      required: ["profile_id"],
      properties: { profile_id: { type: "string" } },
    },
  },
  {
    name: "update_profile",
    description:
      "Update an existing profile's name, notes, tags, proxy, and/or fingerprint. Every field is optional — only the ones you pass change. Set `proxy` to null to remove the proxy. Fingerprint changes are reconciled for coherence. If the profile is running, changes apply on the next launch (response includes appliesOnNextLaunch).",
    inputSchema: {
      type: "object",
      required: ["profile_id"],
      properties: {
        profile_id: { type: "string" },
        name: { type: "string" },
        notes: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        proxy: {
          description: "Proxy object to set, or null to clear. Omit to leave unchanged.",
          anyOf: [PROXY_JSON_SCHEMA, { type: "null" }],
        },
        fingerprint: FINGERPRINT_JSON_SCHEMA,
      },
    },
  },
  {
    name: "delete_profile",
    description:
      "Permanently delete a profile and its on-disk data (cookies, Chromium state, installed extensions). Closes the browser first if it's running. This cannot be undone.",
    inputSchema: {
      type: "object",
      required: ["profile_id"],
      properties: { profile_id: { type: "string" } },
    },
  },
  {
    name: "list_fingerprint_options",
    description:
      "List the valid fingerprint building blocks: device families (with their real screen sizes) and locale groups (locale, country, plausible timezones). Use these values for the `device`, `localeId`, `timezone`, and `screen` fields of create_profile / update_profile.",
    inputSchema: { type: "object", properties: {} },
  },
];

/** Trim a full FingerprintConfig down to the human-meaningful dimensions
 *  the caller can actually reason about / set. */
function fingerprintSummary(fp: FingerprintConfig): {
  device: string;
  locale: string;
  timezone: string;
  screen: { width: number; height: number };
  userAgent: string;
} {
  return {
    device: fp.device,
    locale: fp.locale,
    timezone: fp.timezone,
    screen: fp.screen,
    userAgent: fp.userAgent,
  };
}

function summarize(result: unknown): string {
  if (typeof result === "string") return result.slice(0, 200);
  if (result && typeof result === "object") {
    const keys = Object.keys(result).slice(0, 5).join(", ");
    return `keys: ${keys}`;
  }
  return String(result);
}

function ok(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function err(code: string, message: string) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error: { code, message } }),
      },
    ],
  };
}

function assertProfileExists(pm: ProfileManager, id: string): void {
  const p = pm.get(id);
  if (!p) throw new Error(`Profile ${id} not found`);
}

function assertProfileRunning(driver: BrowserDriver, id: string): void {
  if (!driver.isRunning(id)) {
    throw new Error(`Profile ${id} is not running. Call launch_profile first.`);
  }
}
