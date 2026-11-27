import { z } from "zod";
import {
  CHALLENGE_KINDS,
  MultizenError,
  PROFILE_SOLVER_MODES,
  PROXY_EXPOSURE_MODES,
  SOLVER_ADAPTER_KINDS,
  SOLVER_FALLBACK_POLICIES,
  type CaptchaSolverPort,
  type ChallengeDescriptor,
  type ProfileSolverConfig,
  type SolverTaskRecord,
} from "@multizen/types";
import type { Principal } from "../auth/principal.js";
import { assertProfileExists, assertProfileRunning } from "../errorMapping.js";
import { ProfileIdSchema, type ExtensionTool } from "./shared.js";

function principalAllowsProfile(principal: Principal, profileId: string): boolean {
  return principal.profiles === "*" || principal.profiles.includes(profileId);
}

const DEFAULT_WAIT_MS = 50_000;
const MAX_WAIT_MS = 55_000;

const MCP_CONFIGURABLE_ADAPTERS = [
  "none",
  "capsolver",
  "2captcha",
  "rucaptcha",
  "webhook",
] as const;

const INLINE_SOLVER_ADAPTERS = [
  "capsolver",
  "2captcha",
  "rucaptcha",
  "webhook",
] as const;

const ConfigureSolverSchema = z.object({
  profile_id: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  mode: z.enum(PROFILE_SOLVER_MODES).optional(),
  adapter: z.enum(MCP_CONFIGURABLE_ADAPTERS).optional(),
  api_key: z.string().optional(),
  api_base_url: z.string().url().optional(),
  webhook_url: z.string().url().optional(),
  webhook_secret: z.string().optional(),
  fallback_policy: z.enum(SOLVER_FALLBACK_POLICIES).optional(),
  proxy_exposure: z.enum(PROXY_EXPOSURE_MODES).optional(),
  allow_main_world_js: z.boolean().optional(),
  timeout_ms: z.number().int().positive().optional(),
  verify: z.boolean().optional(),
});

const GetSolverBalanceSchema = z.object({
  profile_id: z.string().min(1).optional(),
  adapter: z.enum(["capsolver", "2captcha", "rucaptcha", "webhook"] as const).optional(),
  api_key: z.string().min(1).optional(),
  api_base_url: z.string().url().optional(),
  webhook_url: z.string().url().optional(),
  webhook_secret: z.string().optional(),
});

const DetectCaptchaSchema = ProfileIdSchema.extend({
  kind: z.enum(CHALLENGE_KINDS).optional(),
  sitekey: z.string().min(1).optional(),
});

const SolveCaptchaSchema = ProfileIdSchema.extend({
  kind: z.enum(CHALLENGE_KINDS).optional(),
  sitekey: z.string().min(1).optional(),
  action: z.string().min(1).optional(),
  data_s: z.string().min(1).optional(),
  rqdata: z.string().min(1).optional(),
  reason: z.string().min(1).optional(),
  adapter: z.enum(INLINE_SOLVER_ADAPTERS).optional(),
  api_key: z.string().min(1).optional(),
  api_base_url: z.string().url().optional(),
  webhook_url: z.string().url().optional(),
  webhook_secret: z.string().optional(),
  proxy_exposure: z.enum(PROXY_EXPOSURE_MODES).optional(),
  allow_main_world_js: z.boolean().optional(),
  fallback_to_human: z.boolean().optional(),
  wait: z.boolean().optional(),
  timeout_ms: z.number().int().positive().optional(),
});

const SolverStatusSchema = z.object({
  profile_id: z.string().min(1).optional(),
  task_id: z.string().min(1).optional(),
  include_balance: z.boolean().optional(),
});

const CancelSolverSchema = ProfileIdSchema.extend({
  task_id: z.string().min(1).optional(),
  handoff_to_human: z.boolean().optional(),
});

function formatTaskRecord(record: SolverTaskRecord): Record<string, unknown> {
  return {
    task_id: record.taskId,
    ...(record.handoffId ? { handoff_id: record.handoffId } : {}),
    profile_id: record.profileId,
    adapter_id: record.adapterId,
    challenge_kind: record.challengeKind,
    status: record.status,
    created_at: record.createdAt,
    expires_at: record.expiresAt,
    ...(record.reason !== undefined ? { reason: record.reason } : {}),
    ...(record.error !== undefined ? { error: record.error } : {}),
    ...(record.settledAt !== undefined ? { settled_at: record.settledAt } : {}),
  };
}

async function runPortHealthcheck(port: CaptchaSolverPort | null): Promise<{
  ok: boolean;
  adapter_id: string | null;
  adapter_name: string | null;
  balance: number | null;
  latency_ms: number | null;
  details: Record<string, unknown> | null;
}> {
  if (!port) {
    return {
      ok: false,
      adapter_id: null,
      adapter_name: null,
      balance: null,
      latency_ms: null,
      details: { error: "No solver port is configured" },
    };
  }
  if (!port.healthcheck) {
    return {
      ok: true,
      adapter_id: port.id,
      adapter_name: port.name,
      balance: null,
      latency_ms: 0,
      details: null,
    };
  }
  const h = await port.healthcheck();
  const balance = typeof h.details?.balance === "number" ? h.details.balance : null;
  return {
    ok: h.ok,
    adapter_id: port.id,
    adapter_name: port.name,
    balance,
    latency_ms: h.latencyMs ?? null,
    details: h.details ?? null,
  };
}

export const SOLVER_TOOLS: ExtensionTool[] = [
  {
    definition: {
      name: "configure_solver",
      description:
        "Configure the CAPTCHA solver port globally or for a specific profile over MCP without restarting or pre-configuring MultiZen. Supports built-in cloud providers (capsolver, 2captcha, rucaptcha) with an API key, external HTTP webhooks, or disabling the solver (none). Set verify: true to immediately test the connection and retrieve the account balance.",
      inputSchema: {
        type: "object",
        properties: {
          profile_id: {
            type: "string",
            description:
              "Optional profile_id. Omit to configure the global default solver for all profiles; pass a profile_id to configure a per-profile solver override.",
          },
          enabled: {
            type: "boolean",
            description: "Enable or disable the solver port (defaults to true when an adapter is chosen).",
          },
          mode: {
            type: "string",
            enum: [...PROFILE_SOLVER_MODES],
            description:
              "When profile_id is given: 'inherit' (follow global), 'enabled', or 'disabled'.",
          },
          adapter: {
            type: "string",
            enum: [...MCP_CONFIGURABLE_ADAPTERS],
            description: "Solver provider: 'capsolver', '2captcha', 'rucaptcha', 'webhook', or 'none'.",
          },
          api_key: {
            type: "string",
            description: "API key (clientKey) for CapSolver, 2Captcha, or RuCaptcha. Never echoed back.",
          },
          api_base_url: {
            type: "string",
            description:
              "Optional custom API base URL (defaults to https://api.capsolver.com, https://api.2captcha.com, or https://api.rucaptcha.com).",
          },
          webhook_url: {
            type: "string",
            description: "Webhook endpoint URL when adapter is 'webhook'.",
          },
          webhook_secret: {
            type: "string",
            description: "Optional HMAC secret for signing webhook requests.",
          },
          fallback_policy: {
            type: "string",
            enum: [...SOLVER_FALLBACK_POLICIES],
            description:
              "'solver-then-human' (default: try solver, fall back to human handoff), 'solver-only', or 'human-only'.",
          },
          proxy_exposure: {
            type: "string",
            enum: [...PROXY_EXPOSURE_MODES],
            description:
              "'bridge' (default: local SOCKS5 bridge without raw credentials), 'raw' (pass upstream proxy credentials to remote cloud solver), or 'none'.",
          },
          allow_main_world_js: {
            type: "boolean",
            description:
              "Allow main-world JS callback execution after token injection (default false).",
          },
          timeout_ms: {
            type: "integer",
            minimum: 1000,
            description: "Per-task solver timeout in milliseconds (default 120000).",
          },
          verify: {
            type: "boolean",
            description:
              "If true, immediately checks the solver connection and returns account balance / health.",
          },
        },
      },
    },
    handler: async (args, ctx) => {
      const input = ConfigureSolverSchema.parse(args);

      if (ctx.egress?.enforced) {
        if (input.webhook_url) {
          await ctx.egress.assertUrlAllowed(input.webhook_url, { proxied: false });
        }
        if (input.api_base_url) {
          await ctx.egress.assertUrlAllowed(input.api_base_url, { proxied: false });
        }
      }

      if (input.profile_id) {
        if (!principalAllowsProfile(ctx.caller.principal, input.profile_id)) {
          throw new MultizenError("FORBIDDEN", "Token is not permitted to access this profile");
        }
        const existing = assertProfileExists(ctx.profileManager, input.profile_id);
        const currentCfg = existing.solverConfig ?? { mode: "inherit" as const };
        const nextMode =
          input.mode ??
          (input.enabled === false || input.adapter === "none"
            ? "disabled"
            : input.enabled === true || input.adapter !== undefined
              ? "enabled"
              : currentCfg.mode);
        const nextCfg: ProfileSolverConfig = {
          ...currentCfg,
          mode: nextMode,
          ...(input.adapter !== undefined ? { adapter: input.adapter } : {}),
          ...(input.api_key !== undefined ? { apiKey: input.api_key } : {}),
          ...(input.api_base_url !== undefined ? { apiBaseUrl: input.api_base_url } : {}),
          ...(input.webhook_url !== undefined ? { webhookUrl: input.webhook_url } : {}),
          ...(input.webhook_secret !== undefined ? { webhookSecret: input.webhook_secret } : {}),
          ...(input.fallback_policy !== undefined
            ? { fallbackPolicy: input.fallback_policy }
            : {}),
          ...(input.proxy_exposure !== undefined ? { proxyExposure: input.proxy_exposure } : {}),
          ...(input.allow_main_world_js !== undefined
            ? { allowMainWorldJs: input.allow_main_world_js }
            : {}),
          ...(input.timeout_ms !== undefined ? { timeoutMs: input.timeout_ms } : {}),
        };
        const updated = ctx.profileManager.update(input.profile_id, { solverConfig: nextCfg });
        const policy = ctx.solver.resolvePolicy(updated);
        const health = input.verify ? await runPortHealthcheck(policy.port) : undefined;
        return {
          scope: "profile",
          profile_id: updated.id,
          mode: nextCfg.mode,
          enabled: policy.enabled,
          configured: Boolean(policy.port),
          adapter: policy.adapter,
          adapter_id: policy.port?.id ?? null,
          adapter_name: policy.port?.name ?? null,
          has_api_key: policy.hasApiKey,
          ...(policy.apiBaseUrl ? { api_base_url: policy.apiBaseUrl } : {}),
          ...(policy.webhookUrl ? { webhook_url: policy.webhookUrl } : {}),
          has_webhook_secret: policy.hasWebhookSecret,
          capabilities: policy.port?.capabilities ?? null,
          fallback_policy: policy.fallbackPolicy,
          proxy_exposure: policy.proxyExposure,
          allow_main_world_js: policy.allowMainWorldJs,
          timeout_ms: policy.timeoutMs,
          ...(health ? { health } : {}),
        };
      }

      if (ctx.caller.principal.profiles !== "*") {
        throw new MultizenError(
          "FORBIDDEN",
          "A profile-scoped token must pass profile_id to configure_solver.",
        );
      }

      const { settings, port } = await ctx.solver.updateGlobalSettings({
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.adapter !== undefined ? { adapter: input.adapter } : {}),
        ...(input.api_key !== undefined ? { apiKey: input.api_key } : {}),
        ...(input.api_base_url !== undefined ? { apiBaseUrl: input.api_base_url } : {}),
        ...(input.webhook_url !== undefined ? { webhookUrl: input.webhook_url } : {}),
        ...(input.webhook_secret !== undefined ? { webhookSecret: input.webhook_secret } : {}),
        ...(input.fallback_policy !== undefined
          ? { fallbackPolicy: input.fallback_policy }
          : {}),
        ...(input.proxy_exposure !== undefined ? { proxyExposure: input.proxy_exposure } : {}),
        ...(input.allow_main_world_js !== undefined
          ? { allowMainWorldJs: input.allow_main_world_js }
          : {}),
        ...(input.timeout_ms !== undefined ? { timeoutMs: input.timeout_ms } : {}),
      });

      const health = input.verify ? await runPortHealthcheck(port) : undefined;
      return {
        scope: "global",
        profile_id: null,
        enabled: settings.enabled,
        configured: Boolean(port),
        adapter: settings.adapter,
        adapter_id: port?.id ?? null,
        adapter_name: port?.name ?? null,
        has_api_key: Boolean(settings.apiKey),
        ...(typeof settings.options?.apiBaseUrl === "string"
          ? { api_base_url: settings.options.apiBaseUrl }
          : {}),
        ...(settings.webhookUrl ? { webhook_url: settings.webhookUrl } : {}),
        has_webhook_secret: Boolean(settings.webhookSecret),
        capabilities: port?.capabilities ?? null,
        fallback_policy: settings.fallbackPolicy,
        proxy_exposure: settings.proxyExposure,
        allow_main_world_js: settings.allowMainWorldJs,
        timeout_ms: settings.timeoutMs,
        ...(health ? { health } : {}),
      };
    },
  },
  {
    definition: {
      name: "get_solver_balance",
      description:
        "Query the account balance and health status of a CAPTCHA solver (CapSolver, 2Captcha, RuCaptcha, or Webhook). Can check the currently configured global solver, a profile's solver (via profile_id), or test an ad-hoc adapter + api_key before saving it.",
      inputSchema: {
        type: "object",
        properties: {
          profile_id: {
            type: "string",
            description: "Optional profile_id to check that profile's effective solver.",
          },
          adapter: {
            type: "string",
            enum: ["capsolver", "2captcha", "rucaptcha", "webhook"],
            description: "Optional provider to check ad-hoc without saving.",
          },
          api_key: {
            type: "string",
            description: "Optional API key to test ad-hoc.",
          },
          api_base_url: {
            type: "string",
            description: "Optional custom API base URL for ad-hoc check.",
          },
          webhook_url: {
            type: "string",
            description: "Optional webhook URL for ad-hoc check.",
          },
          webhook_secret: {
            type: "string",
            description: "Optional webhook HMAC secret for ad-hoc check.",
          },
        },
      },
    },
    handler: async (args, ctx) => {
      const input = GetSolverBalanceSchema.parse(args);

      if (ctx.egress?.enforced) {
        if (input.webhook_url) {
          await ctx.egress.assertUrlAllowed(input.webhook_url, { proxied: false });
        }
        if (input.api_base_url) {
          await ctx.egress.assertUrlAllowed(input.api_base_url, { proxied: false });
        }
      }

      let port: CaptchaSolverPort | null = null;
      if (input.adapter || input.api_key || input.webhook_url) {
        const baseSettings = ctx.solver.getSettings();
        const adapter = input.adapter ?? baseSettings.adapter;
        port = ctx.solver.createAdHocPort({
          adapter,
          apiKey: input.api_key ?? baseSettings.apiKey,
          apiBaseUrl:
            input.api_base_url ??
            (typeof baseSettings.options?.apiBaseUrl === "string"
              ? baseSettings.options.apiBaseUrl
              : undefined),
          webhookUrl: input.webhook_url ?? baseSettings.webhookUrl,
          webhookSecret: input.webhook_secret ?? baseSettings.webhookSecret,
        });
      } else if (input.profile_id) {
        if (!principalAllowsProfile(ctx.caller.principal, input.profile_id)) {
          throw new MultizenError("FORBIDDEN", "Token is not permitted to access this profile");
        }
        const profile = assertProfileExists(ctx.profileManager, input.profile_id);
        port = ctx.solver.resolvePolicy(profile).port;
      } else {
        port = ctx.solver.getPort();
      }

      return runPortHealthcheck(port);
    },
  },
  {
    definition: {
      name: "detect_captcha",
      description:
        "Inspect the active tab in an isolated world to detect a CAPTCHA or anti-bot challenge (Cloudflare Turnstile, reCAPTCHA v2/v3, hCaptcha, GeeTest, Arkose, DataDome) and extract its parameters (sitekey, action, data-s, rqdata, iframe info) without touching main-world globals.",
      inputSchema: {
        type: "object",
        required: ["profile_id"],
        properties: {
          profile_id: { type: "string" },
          kind: {
            type: "string",
            enum: [...CHALLENGE_KINDS],
            description: "Optional challenge kind hint",
          },
          sitekey: { type: "string", description: "Optional sitekey hint" },
        },
      },
    },
    handler: async (args, ctx) => {
      const { profile_id: id, kind, sitekey } = DetectCaptchaSchema.parse(args);
      const profile = assertProfileExists(ctx.profileManager, id);
      assertProfileRunning(ctx.browserDriver, id);
      const hint: Partial<ChallengeDescriptor> = {
        ...(kind ? { kind } : {}),
        ...(sitekey ? { sitekey } : {}),
      };
      const challenge = await ctx.solver.detect({
        profile,
        defaultEngine: ctx.getDefaultEngine ? ctx.getDefaultEngine() : "cloakbrowser",
        driver: ctx.browserDriver,
        ...(Object.keys(hint).length > 0 ? { hint } : {}),
      });
      return {
        detected: challenge !== null,
        challenge,
      };
    },
  },
  {
    definition: {
      name: "solve_captcha",
      description:
        "Delegate a CAPTCHA challenge on the active tab to the configured challenge solver port (or an inline one-shot adapter + api_key passed in this call). While solving, concurrent page actions are blocked. If wait is true (default), waits up to 55s for completion. When fallback_to_human is enabled (or solver policy is solver-then-human), an unsupported or failed challenge seamlessly falls back to human handoff.",
      inputSchema: {
        type: "object",
        required: ["profile_id"],
        properties: {
          profile_id: { type: "string" },
          kind: {
            type: "string",
            enum: [...CHALLENGE_KINDS],
            description: "Optional challenge kind hint",
          },
          sitekey: { type: "string", description: "Optional sitekey override" },
          action: { type: "string", description: "Optional action parameter" },
          data_s: { type: "string", description: "Optional data-s parameter" },
          rqdata: { type: "string", description: "Optional rqdata parameter" },
          reason: { type: "string", description: "Context or reason for the challenge" },
          adapter: {
            type: "string",
            enum: [...INLINE_SOLVER_ADAPTERS],
            description:
              "Optional one-shot solver provider ('capsolver', '2captcha', 'rucaptcha', 'webhook') to use for this call even if MultiZen has no pre-configured solver.",
          },
          api_key: {
            type: "string",
            description: "Optional one-shot API key for the provider.",
          },
          api_base_url: {
            type: "string",
            description: "Optional one-shot custom API base URL.",
          },
          webhook_url: {
            type: "string",
            description: "Optional one-shot webhook URL when adapter is 'webhook'.",
          },
          webhook_secret: {
            type: "string",
            description: "Optional one-shot webhook HMAC secret.",
          },
          proxy_exposure: {
            type: "string",
            enum: [...PROXY_EXPOSURE_MODES],
            description: "Optional one-shot proxy exposure override ('bridge', 'raw', 'none').",
          },
          allow_main_world_js: {
            type: "boolean",
            description: "Optional one-shot allowMainWorldJs override.",
          },
          fallback_to_human: {
            type: "boolean",
            description: "Override the profile/server fallback-to-human policy for this call",
          },
          wait: {
            type: "boolean",
            description: "Wait for the solver task to finish (default true, up to 55s)",
          },
          timeout_ms: {
            type: "integer",
            minimum: 1,
            description: "Wait budget in ms (capped at 55000 per call)",
          },
        },
      },
    },
    handler: async (args, ctx) => {
      const input = SolveCaptchaSchema.parse(args);
      const profile = assertProfileExists(ctx.profileManager, input.profile_id);
      assertProfileRunning(ctx.browserDriver, input.profile_id);

      if (ctx.egress?.enforced) {
        if (input.webhook_url) {
          await ctx.egress.assertUrlAllowed(input.webhook_url, { proxied: false });
        }
        if (input.api_base_url) {
          await ctx.egress.assertUrlAllowed(input.api_base_url, { proxied: false });
        }
      }

      const policy = ctx.solver.resolvePolicy(profile);
      let inlinePort: CaptchaSolverPort | null = null;
      if (input.adapter || input.api_key || input.webhook_url) {
        const globalSettings = ctx.solver.getSettings();
        const effectiveAdapter = input.adapter ?? policy.adapter;
        inlinePort = ctx.solver.createAdHocPort({
          adapter: effectiveAdapter,
          apiKey: input.api_key ?? profile.solverConfig?.apiKey ?? globalSettings.apiKey,
          apiBaseUrl: input.api_base_url ?? policy.apiBaseUrl,
          webhookUrl: input.webhook_url ?? policy.webhookUrl,
          webhookSecret:
            input.webhook_secret ??
            profile.solverConfig?.webhookSecret ??
            globalSettings.webhookSecret,
        });
      }

      const activePort = inlinePort ?? (policy.enabled ? policy.port : null);
      if (!activePort) {
        const shouldFallback =
          input.fallback_to_human !== undefined
            ? input.fallback_to_human
            : policy.fallbackPolicy === "solver-then-human";
        if (shouldFallback) {
          const record = ctx.handoff.request(
            profile.id,
            input.reason ?? "CAPTCHA challenge (no solver port configured)",
            {
              kind: "captcha",
              requestedBy: ctx.caller.principal.name,
              ...(ctx.handoffGate ? { keepReason: true } : {}),
            },
          );
          await ctx.browserDriver
            .performAction(profile.id, { type: "bring_to_front" })
            .catch(() => {});
          return {
            status: "handed_off",
            handoff_id: record.id,
            solver_configured: false,
            expires_at: record.expiresAt,
            note: "No solver port is active for this profile; challenge was handed off to a human operator.",
          };
        }
        throw new MultizenError(
          "SOLVER_NOT_CONFIGURED",
          `No active challenge solver port is configured for profile ${profile.id}.`,
          {
            hint: "Call configure_solver({ adapter: 'capsolver' | '2captcha' | 'rucaptcha', api_key: '...' }), pass adapter + api_key inline to solve_captcha, or pass fallback_to_human: true.",
          },
        );
      }

      const hint: Partial<ChallengeDescriptor> = {
        ...(input.kind ? { kind: input.kind } : {}),
        ...(input.sitekey ? { sitekey: input.sitekey } : {}),
        ...(input.action ? { action: input.action } : {}),
        ...(input.data_s ? { dataS: input.data_s } : {}),
        ...(input.rqdata ? { rqdata: input.rqdata } : {}),
      };

      const { taskRecord, handoffId } = ctx.solver.startTask({
        profile,
        defaultEngine: ctx.getDefaultEngine ? ctx.getDefaultEngine() : "cloakbrowser",
        driver: ctx.browserDriver,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        ...(Object.keys(hint).length > 0 ? { hint } : {}),
        requestedBy: ctx.caller.principal.name,
        ...(ctx.handoffGate ? { keepReason: true } : {}),
        ...(input.fallback_to_human !== undefined
          ? { fallbackToHumanOverride: input.fallback_to_human }
          : {}),
        ...(inlinePort ? { portOverride: inlinePort } : {}),
        ...(input.proxy_exposure ? { proxyExposureOverride: input.proxy_exposure } : {}),
        ...(input.allow_main_world_js !== undefined
          ? { allowMainWorldJsOverride: input.allow_main_world_js }
          : {}),
      });

      if (input.wait === false) {
        return {
          ...formatTaskRecord(taskRecord),
          handoff_id: handoffId,
        };
      }

      const waitBudget = Math.min(input.timeout_ms ?? DEFAULT_WAIT_MS, MAX_WAIT_MS);
      const settled = (await ctx.solver.waitForTask(taskRecord.taskId, waitBudget)) ?? taskRecord;

      if (settled.status === "unsupported") {
        throw new MultizenError(
          "SOLVER_UNSUPPORTED_CHALLENGE",
          settled.error ?? `Challenge kind "${settled.challengeKind}" is not supported by ${settled.adapterId}.`,
          { details: { task_id: settled.taskId, challenge_kind: settled.challengeKind } },
        );
      }
      if (settled.status === "failed") {
        throw new MultizenError(
          "SOLVER_FAILED",
          settled.error ?? `Solver port "${settled.adapterId}" failed to solve the challenge.`,
          { details: { task_id: settled.taskId, challenge_kind: settled.challengeKind } },
        );
      }

      return {
        ...formatTaskRecord(settled),
        timedOut: settled.status === "solving",
      };
    },
  },
  {
    definition: {
      name: "get_solver_status",
      description:
        "Inspect the global or profile-specific CAPTCHA solver configuration, supported challenge kinds, active or latest task status, and optionally query the live account balance.",
      inputSchema: {
        type: "object",
        properties: {
          profile_id: {
            type: "string",
            description:
              "Optional profile_id. Omit to inspect the global solver configuration; provide to inspect that profile's effective solver policy and active/latest task.",
          },
          task_id: { type: "string", description: "Optional task_id from solve_captcha" },
          include_balance: {
            type: "boolean",
            description: "If true, also calls the provider's healthcheck / getBalance endpoint.",
          },
        },
      },
    },
    handler: async (args, ctx) => {
      const {
        profile_id: id,
        task_id: taskId,
        include_balance: includeBalance,
      } = SolverStatusSchema.parse(args);

      if (id !== undefined) {
        if (!principalAllowsProfile(ctx.caller.principal, id)) {
          throw new MultizenError("FORBIDDEN", "Token is not permitted to access this profile");
        }
        const profile = assertProfileExists(ctx.profileManager, id);
        const policy = ctx.solver.resolvePolicy(profile);
        const record = taskId ? ctx.solver.getTask(taskId) : ctx.solver.latestForProfile(id);
        if (taskId && (!record || record.profileId !== id)) {
          throw new MultizenError("INVALID_INPUT", `No solver task ${taskId} on profile ${id}.`);
        }
        const health = includeBalance ? await runPortHealthcheck(policy.port) : undefined;
        return {
          scope: "profile",
          profile_id: id,
          mode: profile.solverConfig?.mode ?? "inherit",
          configured: Boolean(policy.port),
          enabled: policy.enabled,
          adapter: policy.adapter,
          adapter_id: policy.port?.id ?? null,
          adapter_name: policy.port?.name ?? null,
          has_api_key: policy.hasApiKey,
          ...(policy.apiBaseUrl ? { api_base_url: policy.apiBaseUrl } : {}),
          ...(policy.webhookUrl ? { webhook_url: policy.webhookUrl } : {}),
          has_webhook_secret: policy.hasWebhookSecret,
          capabilities: policy.port?.capabilities ?? null,
          fallback_policy: policy.fallbackPolicy,
          proxy_exposure: policy.proxyExposure,
          allow_main_world_js: policy.allowMainWorldJs,
          timeout_ms: policy.timeoutMs,
          available_adapters: [...SOLVER_ADAPTER_KINDS],
          active: record?.status === "solving",
          task: record ? formatTaskRecord(record) : null,
          ...(health ? { health, balance: health.balance } : {}),
        };
      }

      const settings = ctx.solver.getSettings();
      const port = ctx.solver.getPort();
      const record = taskId ? ctx.solver.getTask(taskId) : null;
      if (taskId && !record) {
        throw new MultizenError("INVALID_INPUT", `No solver task ${taskId} found.`);
      }
      const health = includeBalance ? await runPortHealthcheck(port) : undefined;
      return {
        scope: "global",
        profile_id: null,
        configured: Boolean(port),
        enabled: settings.enabled,
        adapter: settings.adapter,
        adapter_id: port?.id ?? null,
        adapter_name: port?.name ?? null,
        has_api_key: Boolean(settings.apiKey),
        ...(typeof settings.options?.apiBaseUrl === "string"
          ? { api_base_url: settings.options.apiBaseUrl }
          : {}),
        ...(settings.webhookUrl ? { webhook_url: settings.webhookUrl } : {}),
        has_webhook_secret: Boolean(settings.webhookSecret),
        capabilities: port?.capabilities ?? null,
        fallback_policy: settings.fallbackPolicy,
        proxy_exposure: settings.proxyExposure,
        allow_main_world_js: settings.allowMainWorldJs,
        timeout_ms: settings.timeoutMs,
        available_adapters: [...SOLVER_ADAPTER_KINDS],
        active: record?.status === "solving",
        task: record ? formatTaskRecord(record) : null,
        ...(health ? { health, balance: health.balance } : {}),
      };
    },
  },
  {
    definition: {
      name: "cancel_solver",
      description:
        "Cancel an active challenge solver task on a profile. Set handoff_to_human: true to immediately transfer the challenge to a human operator instead of aborting.",
      inputSchema: {
        type: "object",
        required: ["profile_id"],
        properties: {
          profile_id: { type: "string" },
          task_id: { type: "string", description: "Optional task_id to match" },
          handoff_to_human: {
            type: "boolean",
            description: "If true, transitions the challenge to human handoff instead of aborting",
          },
        },
      },
    },
    handler: async (args, ctx) => {
      const { profile_id: id, task_id: taskId, handoff_to_human: toHuman } =
        CancelSolverSchema.parse(args);
      assertProfileExists(ctx.profileManager, id);
      const canceled = ctx.solver.cancel(id, {
        ...(taskId ? { taskId } : {}),
        ...(toHuman !== undefined ? { handoffToHuman: toHuman } : {}),
        by: ctx.caller.principal.name,
      });
      return {
        canceled: canceled !== null,
        task: canceled ? formatTaskRecord(canceled) : null,
      };
    },
  },
];
