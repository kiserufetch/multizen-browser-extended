import type { SolverModuleContext } from "../moduleLoader.js";
import {
  TwoCaptchaCompatibleAdapter,
  type TwoCaptchaAdapterOptions,
} from "./twoCaptcha.js";

export type RuCaptchaAdapterOptions = TwoCaptchaAdapterOptions;

export class RuCaptchaAdapter extends TwoCaptchaCompatibleAdapter {
  constructor(opts: RuCaptchaAdapterOptions) {
    super(
      {
        id: "rucaptcha",
        name: "RuCaptcha",
        defaultBaseUrl: "https://api.rucaptcha.com",
      },
      opts,
    );
  }
}

export function createRuCaptchaAdapter(opts: RuCaptchaAdapterOptions): RuCaptchaAdapter {
  return new RuCaptchaAdapter(opts);
}

export function createSolverPort(ctx: SolverModuleContext): RuCaptchaAdapter {
  const apiBaseUrl =
    typeof ctx.options?.apiBaseUrl === "string" ? ctx.options.apiBaseUrl : undefined;
  const pollIntervalMs =
    typeof ctx.options?.pollIntervalMs === "number" ? ctx.options.pollIntervalMs : undefined;
  const softId = typeof ctx.options?.softId === "number" ? ctx.options.softId : undefined;
  return new RuCaptchaAdapter({
    apiKey: ctx.apiKey ?? "",
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
    ...(pollIntervalMs ? { pollIntervalMs } : {}),
    ...(softId !== undefined ? { softId } : {}),
  });
}
