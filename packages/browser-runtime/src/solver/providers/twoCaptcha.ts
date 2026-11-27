import type {
  CaptchaSolverPort,
  ChallengeDescriptor,
  ProxyConfig,
  SolverNetworkContext,
  SolverOutcome,
  SolverPagePort,
  SolverTask,
} from "@multizen/types";
import {
  runHCaptchaInteractive,
  type InteractiveCanvasInput,
  type InteractiveGridInput,
  type InteractiveVisionClassifier,
} from "../HCaptchaInteractiveRunner.js";
import type { SolverModuleContext } from "../moduleLoader.js";

export interface TwoCaptchaAdapterOptions {
  apiKey: string;
  /** Default: https://api.2captcha.com (or https://api.rucaptcha.com for RuCaptcha) */
  apiBaseUrl?: string;
  /** Polling interval in ms for getTaskResult. Default: 3000 */
  pollIntervalMs?: number;
  /** Optional developer softId. */
  softId?: number;
  /** Custom fetch implementation for testing. */
  fetchImpl?: typeof fetch;
  /** Timing multiplier for interactive clicks (default 1; set 0 in unit tests). */
  interactiveDelayScale?: number;
}

interface TwoCaptchaApiResponse {
  errorId: number;
  errorCode?: string;
  errorDescription?: string;
  balance?: number;
  taskId?: number | string;
  status?: "processing" | "ready";
  solution?: {
    token?: string;
    gRecaptchaResponse?: string;
    pass_token?: string;
    captcha_output?: string;
    userAgent?: string;
    click?: number[] | string;
    coordinates?: Array<{ x: number; y: number }>;
    [key: string]: unknown;
  };
}

function isUsableRemoteProxy(proxy?: ProxyConfig): proxy is ProxyConfig {
  if (!proxy) return false;
  const host = proxy.host.trim().toLowerCase();
  return host !== "127.0.0.1" && host !== "localhost" && host !== "::1" && !host.startsWith("127.");
}

function formatTwoCaptchaProxyFields(proxy: ProxyConfig): Record<string, unknown> {
  return {
    proxyType: proxy.type,
    proxyAddress: proxy.host,
    proxyPort: proxy.port,
    ...(proxy.username ? { proxyLogin: proxy.username } : {}),
    ...(proxy.password ? { proxyPassword: proxy.password } : {}),
  };
}

export function buildTwoCaptchaTask(
  challenge: ChallengeDescriptor,
  network: SolverNetworkContext,
): Record<string, unknown> | null {
  const proxy = isUsableRemoteProxy(network.upstreamProxy) ? network.upstreamProxy : undefined;
  const proxyFields = proxy ? formatTwoCaptchaProxyFields(proxy) : null;
  const suffix = proxyFields ? "" : "Proxyless";

  switch (challenge.kind) {
    case "turnstile": {
      if (!challenge.sitekey) return null;
      return {
        type: `TurnstileTask${suffix}`,
        websiteURL: challenge.pageUrl,
        websiteKey: challenge.sitekey,
        ...(challenge.action ? { action: challenge.action } : {}),
        ...(challenge.pagedata ? { data: challenge.pagedata, pagedata: challenge.pagedata } : {}),
        userAgent: network.fingerprint.userAgent,
        ...(proxyFields ?? {}),
      };
    }

    case "recaptcha_v2": {
      if (!challenge.sitekey) return null;
      if (challenge.enterprise) {
        return {
          type: `RecaptchaV2EnterpriseTask${suffix}`,
          websiteURL: challenge.pageUrl,
          websiteKey: challenge.sitekey,
          ...(challenge.dataS ? { enterprisePayload: { s: challenge.dataS } } : {}),
          ...(challenge.invisible ? { isInvisible: true } : {}),
          userAgent: network.fingerprint.userAgent,
          ...(proxyFields ?? {}),
        };
      }
      return {
        type: `RecaptchaV2Task${suffix}`,
        websiteURL: challenge.pageUrl,
        websiteKey: challenge.sitekey,
        ...(challenge.dataS ? { recaptchaDataSValue: challenge.dataS } : {}),
        ...(challenge.invisible ? { isInvisible: true } : {}),
        userAgent: network.fingerprint.userAgent,
        ...(proxyFields ?? {}),
      };
    }

    case "recaptcha_v3": {
      if (!challenge.sitekey) return null;
      return {
        type: "RecaptchaV3TaskProxyless",
        websiteURL: challenge.pageUrl,
        websiteKey: challenge.sitekey,
        pageAction: challenge.action || "verify",
        minScore: 0.7,
        ...(challenge.enterprise ? { isEnterprise: true } : {}),
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
          version: 3,
          userAgent: network.fingerprint.userAgent,
          ...(proxyFields ?? {}),
        };
      }
      return {
        type: `GeeTestTask${suffix}`,
        websiteURL: challenge.pageUrl,
        version: 4,
        initParameters: { captcha_id: captchaId ?? gt },
        userAgent: network.fingerprint.userAgent,
        ...(proxyFields ?? {}),
      };
    }

    case "arkose": {
      if (!challenge.sitekey) return null;
      const subdomain = challenge.rawAttributes?.["data-surl"];
      const blob = challenge.rqdata ?? challenge.pagedata;
      return {
        type: `FunCaptchaTask${suffix}`,
        websiteURL: challenge.pageUrl,
        websitePublicKey: challenge.sitekey,
        ...(subdomain ? { funcaptchaApiJSSubdomain: subdomain } : {}),
        ...(blob ? { data: JSON.stringify({ blob }) } : {}),
        userAgent: network.fingerprint.userAgent,
        ...(proxyFields ?? {}),
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

function hasOpenInteractiveChallengeFrame(challenge: ChallengeDescriptor): boolean {
  const b = challenge.frame?.bounds;
  return Boolean(b && b.width >= 200 && b.height >= 200);
}

export class TwoCaptchaCompatibleAdapter
  implements CaptchaSolverPort, InteractiveVisionClassifier
{
  readonly id: string;
  readonly name: string;
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
    modes: ["token", "interactive"],
  };

  private readonly apiKey: string;
  private readonly apiBaseUrl: string;
  private readonly pollIntervalMs: number;
  private readonly softId?: number;
  private readonly fetchImpl: typeof fetch;
  private readonly interactiveDelayScale: number;

  constructor(
    meta: { id: string; name: string; defaultBaseUrl: string },
    opts: TwoCaptchaAdapterOptions,
  ) {
    this.id = meta.id;
    this.name = meta.name;
    this.apiKey = opts.apiKey.trim();
    this.apiBaseUrl = (opts.apiBaseUrl ?? meta.defaultBaseUrl).replace(/\/+$/, "");
    this.pollIntervalMs = Math.max(10, opts.pollIntervalMs ?? 3_000);
    this.softId = opts.softId;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.interactiveDelayScale = opts.interactiveDelayScale ?? 1;
  }

  canSolve(challenge: ChallengeDescriptor, network: SolverNetworkContext): boolean {
    if (!this.apiKey) return false;
    if (challenge.kind === "hcaptcha" && hasOpenInteractiveChallengeFrame(challenge)) {
      return true;
    }
    return buildTwoCaptchaTask(challenge, network) !== null;
  }

  async solveGrid(input: InteractiveGridInput, signal: AbortSignal): Promise<number[]> {
    const solution = await this.executeRawTask(
      {
        type: "GridTask",
        body: input.imageBase64,
        comment: input.promptText,
        rows: input.rows,
        columns: input.columns,
        ...(input.instructionsImageBase64
          ? { imgInstructions: input.instructionsImageBase64 }
          : {}),
      },
      signal,
    );
    const click = solution.click;
    if (Array.isArray(click)) {
      return click
        .map((n) => Number(n))
        .filter((n) => Number.isInteger(n) && n >= 1);
    }
    if (typeof click === "string") {
      return click
        .replace(/^click:/i, "")
        .split(/[\/,;\s]+/)
        .map((s) => Number(s))
        .filter((n) => Number.isInteger(n) && n >= 1);
    }
    return [];
  }

  async solveCoordinates(
    input: InteractiveCanvasInput,
    signal: AbortSignal,
  ): Promise<Array<{ x: number; y: number }>> {
    const solution = await this.executeRawTask(
      {
        type: "CoordinatesTask",
        body: input.imageBase64,
        comment: input.promptText,
        ...(input.instructionsImageBase64
          ? { imgInstructions: input.instructionsImageBase64 }
          : {}),
      },
      signal,
    );
    const coords = solution.coordinates;
    if (Array.isArray(coords)) {
      return coords
        .map((pt) => ({ x: Number(pt.x), y: Number(pt.y) }))
        .filter((pt) => Number.isFinite(pt.x) && Number.isFinite(pt.y));
    }
    return [];
  }

  async solveInteractive(
    _taskInfo: SolverTask,
    page: SolverPagePort,
    signal: AbortSignal,
  ): Promise<SolverOutcome> {
    if (!this.apiKey) {
      return {
        status: "failed",
        reason: `${this.name} API key is not configured`,
        retryable: false,
      };
    }
    return runHCaptchaInteractive({
      page,
      classifier: this,
      signal,
      delayScale: this.interactiveDelayScale,
    });
  }

  async solve(
    taskInfo: SolverTask,
    page: SolverPagePort,
    signal: AbortSignal,
  ): Promise<SolverOutcome> {
    if (!this.apiKey) {
      return {
        status: "failed",
        reason: `${this.name} API key is not configured`,
        retryable: false,
      };
    }

    const strategy = taskInfo.strategy ?? "auto";
    const openInteractiveModal = hasOpenInteractiveChallengeFrame(taskInfo.challenge);
    if (
      strategy === "interactive-only" ||
      (strategy === "auto" &&
        taskInfo.challenge.kind === "hcaptcha" &&
        (openInteractiveModal || !taskInfo.challenge.sitekey))
    ) {
      return this.solveInteractive(taskInfo, page, signal);
    }

    const task = buildTwoCaptchaTask(taskInfo.challenge, taskInfo.network);
    if (!task) {
      if (
        strategy !== "token-only" &&
        taskInfo.challenge.kind === "hcaptcha" &&
        page.inspectChallengeFrame
      ) {
        return this.solveInteractive(taskInfo, page, signal);
      }
      return {
        status: "unsupported",
        reason: `${this.name} does not support ${taskInfo.challenge.kind} with the detected parameters`,
      };
    }

    try {
      const expiresMs = Date.parse(taskInfo.expiresAt);
      const timeoutMs = Number.isFinite(expiresMs)
        ? Math.max(1_000, expiresMs - Date.now())
        : 120_000;
      const { providerTaskId, solution } = await this.executeRawTaskWithId(
        task,
        signal,
        timeoutMs,
      );
      return await this.finalizeSolution(page, providerTaskId, solution);
    } catch (e) {
      if (signal.aborted) {
        return { status: "failed", reason: `${this.name} request aborted`, retryable: false };
      }
      return {
        status: "failed",
        reason: (e as Error).message,
        retryable: true,
      };
    }
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

  private async executeRawTask(
    task: Record<string, unknown>,
    signal: AbortSignal,
    timeoutMs = 60_000,
  ): Promise<NonNullable<TwoCaptchaApiResponse["solution"]>> {
    const { solution } = await this.executeRawTaskWithId(task, signal, timeoutMs);
    return solution;
  }

  private async executeRawTaskWithId(
    task: Record<string, unknown>,
    signal: AbortSignal,
    timeoutMs = 120_000,
  ): Promise<{
    providerTaskId: string;
    solution: NonNullable<TwoCaptchaApiResponse["solution"]>;
  }> {
    const createData = await this.postJson(
      "/createTask",
      {
        clientKey: this.apiKey,
        ...(this.softId !== undefined ? { softId: this.softId } : {}),
        task,
      },
      signal,
    );

    if (createData.errorId !== 0) {
      throw new Error(
        createData.errorDescription ??
          createData.errorCode ??
          `${this.name} errorId ${createData.errorId}`,
      );
    }

    if (createData.status === "ready" && createData.solution) {
      return {
        providerTaskId: String(createData.taskId ?? "sync"),
        solution: createData.solution,
      };
    }

    const providerTaskId = createData.taskId;
    if (providerTaskId === undefined || providerTaskId === null || providerTaskId === "") {
      throw new Error(`${this.name} createTask returned no taskId`);
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal.aborted) {
        throw new Error(`${this.name} polling aborted`);
      }
      await sleepWithSignal(this.pollIntervalMs, signal);
      if (signal.aborted) {
        throw new Error(`${this.name} polling aborted`);
      }

      const pollData = await this.postJson(
        "/getTaskResult",
        {
          clientKey: this.apiKey,
          taskId: providerTaskId,
        },
        signal,
      );

      if (pollData.errorId !== 0) {
        throw new Error(
          pollData.errorDescription ??
            pollData.errorCode ??
            `${this.name} errorId ${pollData.errorId}`,
        );
      }

      if (pollData.status === "ready" && pollData.solution) {
        return {
          providerTaskId: String(providerTaskId),
          solution: pollData.solution,
        };
      }
    }

    throw new Error(`${this.name} timed out waiting for getTaskResult`);
  }

  private async finalizeSolution(
    page: SolverPagePort,
    providerTaskId: string,
    solution: NonNullable<TwoCaptchaApiResponse["solution"]>,
  ): Promise<SolverOutcome> {
    const token =
      solution.token ??
      solution.gRecaptchaResponse ??
      solution.pass_token ??
      solution.captcha_output;
    if (typeof token !== "string" || token.length === 0) {
      return {
        status: "failed",
        reason: `${this.name} returned a ready status without a token`,
        retryable: false,
      };
    }
    await page.applyToken({ token });
    return {
      status: "solved",
      mode: "token",
      tokenPayload: { token },
      notes: `provider=${this.id} taskId=${providerTaskId}`,
    };
  }

  private async postJson(
    path: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<TwoCaptchaApiResponse> {
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
    let parsed: TwoCaptchaApiResponse;
    try {
      parsed = JSON.parse(text) as TwoCaptchaApiResponse;
    } catch {
      throw new Error(`Invalid JSON from ${this.name} (HTTP ${res.status})`);
    }
    return parsed;
  }
}

export class TwoCaptchaAdapter extends TwoCaptchaCompatibleAdapter {
  constructor(opts: TwoCaptchaAdapterOptions) {
    super(
      {
        id: "2captcha",
        name: "2Captcha",
        defaultBaseUrl: "https://api.2captcha.com",
      },
      opts,
    );
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

export function createTwoCaptchaAdapter(opts: TwoCaptchaAdapterOptions): TwoCaptchaAdapter {
  return new TwoCaptchaAdapter(opts);
}

export function createSolverPort(ctx: SolverModuleContext): TwoCaptchaAdapter {
  const apiBaseUrl =
    typeof ctx.options?.apiBaseUrl === "string" ? ctx.options.apiBaseUrl : undefined;
  const pollIntervalMs =
    typeof ctx.options?.pollIntervalMs === "number" ? ctx.options.pollIntervalMs : undefined;
  const softId = typeof ctx.options?.softId === "number" ? ctx.options.softId : undefined;
  return new TwoCaptchaAdapter({
    apiKey: ctx.apiKey ?? "",
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
    ...(pollIntervalMs ? { pollIntervalMs } : {}),
    ...(softId !== undefined ? { softId } : {}),
  });
}
