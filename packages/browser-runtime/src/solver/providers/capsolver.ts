import type {
  CaptchaSolverPort,
  ChallengeDescriptor,
  ProxyConfig,
  SolverNetworkContext,
  SolverOutcome,
  SolverPagePort,
  SolverTask,
} from "@multizen/types";
import type { SolverModuleContext } from "../moduleLoader.js";

export interface CapSolverAdapterOptions {
  apiKey: string;
  /** Default: https://api.capsolver.com */
  apiBaseUrl?: string;
  /** Polling interval in ms for getTaskResult. Default: 2000 */
  pollIntervalMs?: number;
  /** Optional CapSolver developer appId. */
  appId?: string;
  /** Custom fetch implementation for testing. */
  fetchImpl?: typeof fetch;
}

interface CapSolverApiResponse {
  errorId: number;
  errorCode?: string;
  errorDescription?: string;
  balance?: number;
  taskId?: string;
  status?: "idle" | "processing" | "ready" | "failed";
  solution?: {
    token?: string;
    gRecaptchaResponse?: string;
    captcha_output?: string;
    pass_token?: string;
    userAgent?: string;
    cookie?: string;
    [key: string]: unknown;
  };
}

function isUsableRemoteProxy(proxy?: ProxyConfig): proxy is ProxyConfig {
  if (!proxy) return false;
  const host = proxy.host.trim().toLowerCase();
  return host !== "127.0.0.1" && host !== "localhost" && host !== "::1" && !host.startsWith("127.");
}

function formatCapSolverProxyFields(proxy: ProxyConfig): Record<string, unknown> {
  return {
    proxyType: proxy.type,
    proxyAddress: proxy.host,
    proxyPort: proxy.port,
    ...(proxy.username ? { proxyLogin: proxy.username } : {}),
    ...(proxy.password ? { proxyPassword: proxy.password } : {}),
  };
}

export function buildCapSolverTask(
  challenge: ChallengeDescriptor,
  network: SolverNetworkContext,
): Record<string, unknown> | null {
  const proxy = isUsableRemoteProxy(network.upstreamProxy) ? network.upstreamProxy : undefined;
  const proxyFields = proxy ? formatCapSolverProxyFields(proxy) : null;
  const suffix = proxyFields ? "" : "ProxyLess";

  switch (challenge.kind) {
    case "turnstile": {
      if (!challenge.sitekey) return null;
      const metadata: Record<string, string> = {};
      if (challenge.action) metadata.action = challenge.action;
      if (challenge.pagedata) metadata.cdata = challenge.pagedata;
      return {
        type: "AntiTurnstileTaskProxyLess",
        websiteURL: challenge.pageUrl,
        websiteKey: challenge.sitekey,
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      };
    }

    case "recaptcha_v2": {
      if (!challenge.sitekey) return null;
      if (challenge.enterprise) {
        return {
          type: `ReCaptchaV2EnterpriseTask${suffix}`,
          websiteURL: challenge.pageUrl,
          websiteKey: challenge.sitekey,
          ...(challenge.dataS ? { enterprisePayload: { s: challenge.dataS } } : {}),
          ...(challenge.invisible ? { isInvisible: true } : {}),
          ...(proxyFields ?? {}),
        };
      }
      return {
        type: `ReCaptchaV2Task${suffix}`,
        websiteURL: challenge.pageUrl,
        websiteKey: challenge.sitekey,
        ...(challenge.dataS ? { recaptchaDataSValue: challenge.dataS } : {}),
        ...(challenge.invisible ? { isInvisible: true } : {}),
        ...(proxyFields ?? {}),
      };
    }

    case "recaptcha_v3": {
      if (!challenge.sitekey) return null;
      const typeBase = challenge.enterprise
        ? "ReCaptchaV3EnterpriseTask"
        : "ReCaptchaV3Task";
      return {
        type: `${typeBase}${suffix}`,
        websiteURL: challenge.pageUrl,
        websiteKey: challenge.sitekey,
        pageAction: challenge.action || "verify",
        ...(proxyFields ?? {}),
      };
    }

    case "hcaptcha": {
      if (!challenge.sitekey) return null;
      return {
        type: `HCaptchaTask${suffix}`,
        websiteURL: challenge.pageUrl,
        websiteKey: challenge.sitekey,
        ...(challenge.invisible ? { isInvisible: true } : {}),
        ...(challenge.rqdata ? { enterprisePayload: { rqdata: challenge.rqdata } } : {}),
        userAgent: network.fingerprint.userAgent,
        ...(proxyFields ?? {}),
      };
    }

    case "geetest": {
      const gt = challenge.sitekey ?? challenge.rawAttributes?.["data-gt"];
      const captchaId = challenge.rawAttributes?.["data-captcha-id"] ?? challenge.sitekey;
      const challengeCode = challenge.rawAttributes?.["data-challenge"];
      if (!gt && !captchaId) return null;
      if (challengeCode && gt) {
        return {
          type: `GeeTestTask${suffix}`,
          websiteURL: challenge.pageUrl,
          gt,
          challenge: challengeCode,
          ...(proxyFields ?? {}),
        };
      }
      return {
        type: `GeeTestTask${suffix}`,
        websiteURL: challenge.pageUrl,
        captchaId: captchaId ?? gt,
        ...(proxyFields ?? {}),
      };
    }

    case "arkose": {
      if (!challenge.sitekey) return null;
      const subdomain = challenge.rawAttributes?.["data-surl"];
      const blob = challenge.rqdata ?? challenge.pagedata;
      return {
        type: "FunCaptchaTaskProxyLess",
        websiteURL: challenge.pageUrl,
        websitePublicKey: challenge.sitekey,
        ...(subdomain ? { funcaptchaApiJSSubdomain: subdomain } : {}),
        ...(blob ? { data: JSON.stringify({ blob }) } : {}),
        userAgent: network.fingerprint.userAgent,
      };
    }

    case "datadome": {
      const captchaUrl = challenge.frame?.url ?? challenge.rawAttributes?.["data-src"];
      if (!captchaUrl || !proxyFields) return null;
      return {
        type: "DataDomeSliderTask",
        websiteURL: challenge.pageUrl,
        captchaUrl,
        userAgent: network.fingerprint.userAgent,
        ...proxyFields,
      };
    }

    default:
      return null;
  }
}

export class CapSolverAdapter implements CaptchaSolverPort {
  readonly id = "capsolver";
  readonly name = "CapSolver";
  readonly capabilities: CaptchaSolverPort["capabilities"] = {
    kinds: [
      "turnstile",
      "recaptcha_v2",
      "recaptcha_v3",
      "hcaptcha",
      "geetest",
      "arkose",
      "datadome",
    ],
    modes: ["token"],
  };

  private readonly apiKey: string;
  private readonly apiBaseUrl: string;
  private readonly pollIntervalMs: number;
  private readonly appId?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: CapSolverAdapterOptions) {
    this.apiKey = opts.apiKey.trim();
    this.apiBaseUrl = (opts.apiBaseUrl ?? "https://api.capsolver.com").replace(/\/+$/, "");
    this.pollIntervalMs = Math.max(250, opts.pollIntervalMs ?? 2_000);
    this.appId = opts.appId;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  canSolve(challenge: ChallengeDescriptor, network: SolverNetworkContext): boolean {
    if (!this.apiKey) return false;
    return buildCapSolverTask(challenge, network) !== null;
  }

  async solve(
    taskInfo: SolverTask,
    page: SolverPagePort,
    signal: AbortSignal,
  ): Promise<SolverOutcome> {
    if (!this.apiKey) {
      return {
        status: "failed",
        reason: "CapSolver API key is not configured",
        retryable: false,
      };
    }

    const task = buildCapSolverTask(taskInfo.challenge, taskInfo.network);
    if (!task) {
      return {
        status: "unsupported",
        reason: `CapSolver does not support ${taskInfo.challenge.kind} with the detected parameters`,
      };
    }

    let createData: CapSolverApiResponse;
    try {
      createData = await this.postJson(
        "/createTask",
        {
          clientKey: this.apiKey,
          ...(this.appId ? { appId: this.appId } : {}),
          task,
        },
        signal,
      );
    } catch (e) {
      if (signal.aborted) {
        return { status: "failed", reason: "CapSolver request aborted", retryable: false };
      }
      return {
        status: "failed",
        reason: `CapSolver createTask error: ${(e as Error).message}`,
        retryable: true,
      };
    }

    if (createData.errorId !== 0) {
      return {
        status: "failed",
        reason:
          createData.errorDescription ??
          createData.errorCode ??
          `CapSolver errorId ${createData.errorId}`,
        retryable: false,
      };
    }

    if (createData.status === "ready" && createData.solution) {
      return this.finalizeSolution(page, createData.taskId ?? "sync", createData.solution);
    }

    const providerTaskId = createData.taskId;
    if (!providerTaskId) {
      return {
        status: "failed",
        reason: "CapSolver createTask returned no taskId",
        retryable: false,
      };
    }

    const expiresMs = Date.parse(taskInfo.expiresAt);
    const deadline = Number.isFinite(expiresMs) ? expiresMs : Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (signal.aborted) {
        return { status: "failed", reason: "CapSolver polling aborted", retryable: false };
      }
      await sleepWithSignal(this.pollIntervalMs, signal);
      if (signal.aborted) {
        return { status: "failed", reason: "CapSolver polling aborted", retryable: false };
      }

      let pollData: CapSolverApiResponse;
      try {
        pollData = await this.postJson(
          "/getTaskResult",
          {
            clientKey: this.apiKey,
            taskId: providerTaskId,
          },
          signal,
        );
      } catch (e) {
        if (signal.aborted) {
          return { status: "failed", reason: "CapSolver polling aborted", retryable: false };
        }
        return {
          status: "failed",
          reason: `CapSolver getTaskResult error: ${(e as Error).message}`,
          retryable: true,
        };
      }

      if (pollData.errorId !== 0) {
        return {
          status: "failed",
          reason:
            pollData.errorDescription ??
            pollData.errorCode ??
            `CapSolver errorId ${pollData.errorId}`,
          retryable: false,
        };
      }

      if (pollData.status === "ready" && pollData.solution) {
        return this.finalizeSolution(page, providerTaskId, pollData.solution);
      }
      if (pollData.status === "failed") {
        return {
          status: "failed",
          reason: pollData.errorDescription ?? "CapSolver task failed",
          retryable: true,
        };
      }
    }

    return {
      status: "failed",
      reason: "CapSolver timed out waiting for getTaskResult",
      retryable: true,
    };
  }

  async healthcheck(): Promise<{
    ok: boolean;
    latencyMs?: number;
    details?: Record<string, unknown>;
  }> {
    if (!this.apiKey) {
      return { ok: false, details: { error: "API key is empty" } };
    }
    const started = Date.now();
    try {
      const res = await this.postJson("/getBalance", { clientKey: this.apiKey });
      const latencyMs = Date.now() - started;
      if (res.errorId !== 0) {
        return {
          ok: false,
          latencyMs,
          details: {
            errorCode: res.errorCode,
            errorDescription: res.errorDescription,
          },
        };
      }
      return {
        ok: true,
        latencyMs,
        details: { balance: res.balance },
      };
    } catch (e) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        details: { error: (e as Error).message },
      };
    }
  }

  private async finalizeSolution(
    page: SolverPagePort,
    providerTaskId: string,
    solution: NonNullable<CapSolverApiResponse["solution"]>,
  ): Promise<SolverOutcome> {
    const token =
      solution.token ??
      solution.gRecaptchaResponse ??
      solution.captcha_output ??
      solution.pass_token;
    if (typeof token !== "string" || token.length === 0) {
      return {
        status: "failed",
        reason: "CapSolver returned a ready status without a token",
        retryable: false,
      };
    }
    await page.applyToken({ token });
    return {
      status: "solved",
      mode: "token",
      tokenPayload: { token },
      notes: `provider=capsolver taskId=${providerTaskId}`,
    };
  }

  private async postJson(
    path: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CapSolverApiResponse> {
    const res = await this.fetchImpl(`${this.apiBaseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    const text = await res.text();
    let parsed: CapSolverApiResponse;
    try {
      parsed = JSON.parse(text) as CapSolverApiResponse;
    } catch {
      throw new Error(`Invalid JSON from CapSolver (HTTP ${res.status})`);
    }
    return parsed;
  }
}

function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function createCapSolverAdapter(opts: CapSolverAdapterOptions): CapSolverAdapter {
  return new CapSolverAdapter(opts);
}

export function createSolverPort(ctx: SolverModuleContext): CapSolverAdapter {
  const apiBaseUrl =
    typeof ctx.options?.apiBaseUrl === "string" ? ctx.options.apiBaseUrl : undefined;
  const pollIntervalMs =
    typeof ctx.options?.pollIntervalMs === "number" ? ctx.options.pollIntervalMs : undefined;
  const appId = typeof ctx.options?.appId === "string" ? ctx.options.appId : undefined;
  return new CapSolverAdapter({
    apiKey: ctx.apiKey ?? "",
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
    ...(pollIntervalMs ? { pollIntervalMs } : {}),
    ...(appId ? { appId } : {}),
  });
}
