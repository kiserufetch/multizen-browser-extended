import type { CaptchaSolverPort } from "@multizen/types";
import {
  buildCapSolverTask,
  CapSolverAdapter,
  createCapSolverAdapter,
  type CapSolverAdapterOptions,
} from "./capsolver.js";
import {
  createRuCaptchaAdapter,
  RuCaptchaAdapter,
  type RuCaptchaAdapterOptions,
} from "./ruCaptcha.js";
import {
  buildTwoCaptchaTask,
  createTwoCaptchaAdapter,
  TwoCaptchaAdapter,
  TwoCaptchaCompatibleAdapter,
  type TwoCaptchaAdapterOptions,
} from "./twoCaptcha.js";

export {
  buildCapSolverTask,
  buildTwoCaptchaTask,
  CapSolverAdapter,
  createCapSolverAdapter,
  createRuCaptchaAdapter,
  createTwoCaptchaAdapter,
  RuCaptchaAdapter,
  TwoCaptchaAdapter,
  TwoCaptchaCompatibleAdapter,
  type CapSolverAdapterOptions,
  type RuCaptchaAdapterOptions,
  type TwoCaptchaAdapterOptions,
};

export type CloudSolverProviderKind = "capsolver" | "2captcha" | "rucaptcha";

export function isCloudSolverProviderKind(value: unknown): value is CloudSolverProviderKind {
  return value === "capsolver" || value === "2captcha" || value === "rucaptcha";
}

export interface CloudSolverProviderOptions {
  apiKey: string;
  apiBaseUrl?: string;
  pollIntervalMs?: number;
  fetchImpl?: typeof fetch;
}

export function createCloudProviderSolverPort(
  kind: CloudSolverProviderKind,
  opts: CloudSolverProviderOptions,
): CaptchaSolverPort {
  switch (kind) {
    case "capsolver":
      return new CapSolverAdapter(opts);
    case "2captcha":
      return new TwoCaptchaAdapter(opts);
    case "rucaptcha":
      return new RuCaptchaAdapter(opts);
  }
}
