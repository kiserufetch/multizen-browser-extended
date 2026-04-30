import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ProfileManager } from "@multizen/profile-manager";
import type { LaunchedProfile, ProfileId } from "@multizen/types";

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
  click(profileId: ProfileId, target: string): Promise<{ ok: true }>;
  type(profileId: ProfileId, target: string, text: string): Promise<{ ok: true }>;
  extract(profileId: ProfileId, query: string): Promise<{ result: unknown }>;
  screenshot(profileId: ProfileId): Promise<{ pngBase64: string }>;
}

export interface MultizenMcpServerOptions {
  profileManager: ProfileManager;
  browserDriver: BrowserDriver;
}

const ProfileIdSchema = z.object({ profile_id: z.string().min(1) });
const NavigateSchema = ProfileIdSchema.extend({ url: z.string().url() });
const ClickSchema = ProfileIdSchema.extend({ target: z.string().min(1) });
const TypeSchema = ProfileIdSchema.extend({
  target: z.string().min(1),
  text: z.string(),
});
const ExtractSchema = ProfileIdSchema.extend({ query: z.string().min(1) });
const CreateProfileSchema = z.object({
  name: z.string().min(1),
  notes: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export function createMultizenMcpServer(opts: MultizenMcpServerOptions): Server {
  const { profileManager, browserDriver } = opts;

  const server = new Server(
    { name: "multizen", version: "0.2.0-pre" },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "list_profiles",
        description:
          "List all browser profiles available on this machine. Returns id, name, tags, last opened, and running state.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "create_profile",
        description: "Create a new browser profile with sensible default fingerprint.",
        inputSchema: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string", description: "Human-readable name" },
            notes: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
          },
        },
      },
      {
        name: "launch_profile",
        description:
          "Launch a profile in patched Chromium. Returns CDP endpoint for further automation. Idempotent: if already running, returns existing endpoint.",
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
          "Click an element. 'target' can be a CSS selector or a natural-language description ('the Sign In button').",
        inputSchema: {
          type: "object",
          required: ["profile_id", "target"],
          properties: {
            profile_id: { type: "string" },
            target: { type: "string" },
          },
        },
      },
      {
        name: "type",
        description: "Type text into an element selected by CSS selector or natural language.",
        inputSchema: {
          type: "object",
          required: ["profile_id", "target", "text"],
          properties: {
            profile_id: { type: "string" },
            target: { type: "string" },
            text: { type: "string" },
          },
        },
      },
      {
        name: "extract",
        description:
          "Extract structured data from the current page. 'query' is a natural-language description of what to extract.",
        inputSchema: {
          type: "object",
          required: ["profile_id", "query"],
          properties: {
            profile_id: { type: "string" },
            query: { type: "string" },
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
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = req.params.arguments ?? {};

    try {
      switch (name) {
        case "list_profiles": {
          const profiles = profileManager.list().map((p) => ({
            ...p,
            isRunning: browserDriver.isRunning(p.id),
          }));
          return ok({ profiles });
        }
        case "create_profile": {
          const input = CreateProfileSchema.parse(args);
          const created = profileManager.create(input);
          return ok({ id: created.id, name: created.name });
        }
        case "launch_profile": {
          const { profile_id } = ProfileIdSchema.parse(args);
          assertProfileExists(profileManager, profile_id);
          const launched = await browserDriver.launch(profile_id);
          profileManager.markOpened(profile_id);
          return ok(launched);
        }
        case "close_profile": {
          const { profile_id } = ProfileIdSchema.parse(args);
          await browserDriver.close(profile_id);
          return ok({ closed: profile_id });
        }
        case "navigate": {
          const { profile_id, url } = NavigateSchema.parse(args);
          assertProfileRunning(browserDriver, profile_id);
          const r = await browserDriver.navigate(profile_id, url);
          return ok(r);
        }
        case "click": {
          const { profile_id, target } = ClickSchema.parse(args);
          assertProfileRunning(browserDriver, profile_id);
          const r = await browserDriver.click(profile_id, target);
          return ok(r);
        }
        case "type": {
          const { profile_id, target, text } = TypeSchema.parse(args);
          assertProfileRunning(browserDriver, profile_id);
          const r = await browserDriver.type(profile_id, target, text);
          return ok(r);
        }
        case "extract": {
          const { profile_id, query } = ExtractSchema.parse(args);
          assertProfileRunning(browserDriver, profile_id);
          const r = await browserDriver.extract(profile_id, query);
          return ok(r);
        }
        case "screenshot": {
          const { profile_id } = ProfileIdSchema.parse(args);
          assertProfileRunning(browserDriver, profile_id);
          const r = await browserDriver.screenshot(profile_id);
          return ok(r);
        }
        default:
          return err("INTERNAL_ERROR", `Unknown tool: ${name}`);
      }
    } catch (e) {
      if (e instanceof z.ZodError) {
        return err("INVALID_INPUT", e.message);
      }
      const message = e instanceof Error ? e.message : String(e);
      return err("INTERNAL_ERROR", message);
    }
  });

  return server;
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
