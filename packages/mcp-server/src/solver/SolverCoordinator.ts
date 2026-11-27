import { randomUUID } from "node:crypto";
import { reducedUserAgent, type ProfileManager } from "@multizen/profile-manager";
import {
  isChallengeKind,
  isProxyExposureMode,
  isSolverAdapterKind,
  isSolverFallbackPolicy,
  isSolverStrategy,
  MultizenError,
  resolveEngine,
  type ApplyTokenResult,
  type BrowserDriver,
  type BrowserEngine,
  type CaptchaSolverPort,
  type ChallengeDescriptor,
  type ChallengeDetectorPort,
  type ChallengeFrameInfo,
  type ChallengeFrameInspection,
  type ChallengeKind,
  type CapturedFrame,
  type DriverAction,
  type HumanInputEvent,
  type Profile,
  type ProfileId,
  type ProxyExposureMode,
  type SolverAdapterKind,
  type SolverFallbackPolicy,
  type SolverNetworkContext,
  type SolverOutcome,
  type SolverPagePort,
  type SolverPageReadPort,
  type SolverSettings,
  type SolverStrategy,
  type SolverTask,
  type SolverTaskRecord,
  type SolverTokenPayload,
} from "@multizen/types";
import type { ActivityLog } from "../ActivityLog.js";
import type { HumanHandoff } from "../handoff.js";
import { HttpWebhookSolverAdapter, SolverWebhookSessions } from "./HttpWebhookSolverAdapter.js";
import { createCloudProviderSolverPort, isCloudSolverProviderKind } from "./providers.js";

const DEFAULT_SOLVER_TIMEOUT_MS = 120_000;
const TASK_TOMBSTONE_TTL_MS = 60 * 60_000;
const MAX_TASK_TOMBSTONES = 500;

export const DEFAULT_SOLVER_CONFIG: SolverSettings = {
  enabled: false,
  adapter: "none",
  fallbackPolicy: "solver-then-human",
  strategy: "auto",
  proxyExposure: "bridge",
  allowMainWorldJs: false,
  timeoutMs: DEFAULT_SOLVER_TIMEOUT_MS,
};

const DEFAULT_POST_SOLVE_VERIFY_TIMEOUT_MS = 2_500;
const DEFAULT_POST_SOLVE_VERIFY_INTERVAL_MS = 400;

function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Aborted"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function unwrapEvaluatedValue(raw: unknown): unknown {
  if (raw && typeof raw === "object" && "result" in raw) {
    const inner = (raw as { result?: unknown }).result;
    if (inner && typeof inner === "object" && "value" in inner) {
      return (inner as { value?: unknown }).value;
    }
  }
  return raw;
}

const ISOLATED_DETECT_EXPRESSION = `(() => {
  const pageUrl = location.href;
  const pageTitle = document.title || undefined;
  const readAttrs = (el) => {
    const out = {};
    if (!el || !el.attributes) return out;
    const allow = [
      "id", "class", "data-sitekey", "data-turnstile-sitekey", "data-hcaptcha-sitekey",
      "data-action", "data-s", "data-rqdata", "data-pagedata", "data-callback",
      "data-size", "data-theme", "data-gt", "data-challenge", "data-pkey"
    ];
    for (const name of allow) {
      const val = el.getAttribute(name);
      if (val !== null && val !== "") out[name] = String(val).slice(0, 512);
    }
    return out;
  };
  const isVisible = (el) => {
    if (!el || typeof window.getComputedStyle !== "function") return true;
    let cur = el;
    while (cur && cur.nodeType === 1) {
      const style = window.getComputedStyle(cur);
      if (style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity || "1") === 0) {
        return false;
      }
      cur = cur.parentElement;
    }
    return true;
  };
  const rectOf = (el) => {
    if (!el || typeof el.getBoundingClientRect !== "function") return undefined;
    if (!isVisible(el)) return undefined;
    const r = el.getBoundingClientRect();
    if (!r || (r.width === 0 && r.height === 0)) return undefined;
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  };
  const parseUrlParams = (urlStr) => {
    try {
      const u = new URL(urlStr, pageUrl);
      const params = new URLSearchParams(u.search);
      if (u.hash && u.hash.includes("=")) {
        const hashParams = new URLSearchParams(u.hash.replace(/^#/, ""));
        for (const [k, v] of hashParams.entries()) {
          if (!params.has(k)) params.set(k, v);
        }
      }
      return { url: u.href, origin: u.origin, params };
    } catch {
      return null;
    }
  };

  let kind = null;
  let vendor = undefined;
  let sitekey = undefined;
  let action = undefined;
  let dataS = undefined;
  let rqdata = undefined;
  let pagedata = undefined;
  let enterprise = undefined;
  let invisible = undefined;
  let frame = undefined;
  let bestFrameArea = -1;
  let rawAttributes = {};

  const considerFrame = (candidate) => {
    const area = candidate.bounds ? candidate.bounds.width * candidate.bounds.height : 0;
    if (!frame || area > bestFrameArea) {
      frame = candidate;
      bestFrameArea = area;
    }
  };

  for (const ifr of Array.from(document.querySelectorAll("iframe"))) {
    const rawSrc = ifr.getAttribute("src") || "";
    if (!rawSrc) continue;
    const parsed = parseUrlParams(rawSrc);
    const srcLower = rawSrc.toLowerCase();
    const bounds = rectOf(ifr);
    const isCrossOrigin = parsed ? parsed.origin !== location.origin : true;
    if (srcLower.includes("challenges.cloudflare.com") || srcLower.includes("turnstile")) {
      kind = "turnstile";
      vendor = "cloudflare-turnstile";
      const match = rawSrc.match(/(0x[0-9a-zA-Z_-]{10,})/);
      if (match && !sitekey) sitekey = match[1];
      considerFrame({ url: parsed ? parsed.url : rawSrc, isCrossOrigin, ...(bounds ? { bounds } : {}) });
      rawAttributes = { ...rawAttributes, ...readAttrs(ifr) };
      continue;
    }
    if (srcLower.includes("hcaptcha.com")) {
      kind = "hcaptcha";
      vendor = "hcaptcha";
      const sk = (parsed && (parsed.params.get("sitekey") || parsed.params.get("id"))) || undefined;
      if (sk && !sitekey) sitekey = sk;
      if (parsed && parsed.params.get("size") === "invisible") invisible = true;
      considerFrame({ url: parsed ? parsed.url : rawSrc, isCrossOrigin, ...(bounds ? { bounds } : {}) });
      rawAttributes = { ...rawAttributes, ...readAttrs(ifr) };
      continue;
    }
    if (srcLower.includes("google.com/recaptcha") || srcLower.includes("recaptcha.net/recaptcha")) {
      const isEnt = srcLower.includes("/enterprise");
      const sizeParam = parsed ? parsed.params.get("size") : null;
      if (!kind) {
        kind = sizeParam === "invisible" && srcLower.includes("anchor") ? "recaptcha_v3" : "recaptcha_v2";
      }
      vendor = isEnt ? "google-recaptcha-enterprise" : "google-recaptcha";
      enterprise = isEnt;
      if (sizeParam === "invisible") invisible = true;
      const sk = (parsed && parsed.params.get("k")) || undefined;
      if (sk && !sitekey) sitekey = sk;
      considerFrame({ url: parsed ? parsed.url : rawSrc, isCrossOrigin, ...(bounds ? { bounds } : {}) });
      rawAttributes = { ...rawAttributes, ...readAttrs(ifr) };
      continue;
    }
    if (srcLower.includes("arkoselabs.com") || srcLower.includes("funcaptcha.com")) {
      kind = "arkose";
      vendor = "arkose-funcaptcha";
      const sk = (parsed && (parsed.params.get("pk") || parsed.params.get("pkey"))) || undefined;
      if (sk && !sitekey) sitekey = sk;
      considerFrame({ url: parsed ? parsed.url : rawSrc, isCrossOrigin, ...(bounds ? { bounds } : {}) });
      rawAttributes = { ...rawAttributes, ...readAttrs(ifr) };
      continue;
    }
    if (srcLower.includes("captcha-delivery.com") || srcLower.includes("datadome")) {
      kind = "datadome";
      vendor = "datadome";
      considerFrame({ url: parsed ? parsed.url : rawSrc, isCrossOrigin, ...(bounds ? { bounds } : {}) });
      rawAttributes = { ...rawAttributes, ...readAttrs(ifr) };
      continue;
    }
    if (srcLower.includes("geetest.com")) {
      kind = "geetest";
      vendor = "geetest";
      considerFrame({ url: parsed ? parsed.url : rawSrc, isCrossOrigin, ...(bounds ? { bounds } : {}) });
      rawAttributes = { ...rawAttributes, ...readAttrs(ifr) };
      continue;
    }
  }

  const containers = Array.from(
    document.querySelectorAll(
      ".cf-turnstile, .g-recaptcha, .h-captcha, [data-sitekey], [data-turnstile-sitekey], [data-hcaptcha-sitekey], [data-gt], [data-pkey], #challenge-form, #cf-challenge-running"
    )
  );
  for (const el of containers) {
    rawAttributes = { ...readAttrs(el), ...rawAttributes };
    const cls = (el.getAttribute("class") || "").toLowerCase();
    const sk =
      el.getAttribute("data-sitekey") ||
      el.getAttribute("data-turnstile-sitekey") ||
      el.getAttribute("data-hcaptcha-sitekey") ||
      el.getAttribute("data-gt") ||
      el.getAttribute("data-pkey");
    if (sk && !sitekey) sitekey = sk;
    if (el.getAttribute("data-action") && !action) action = el.getAttribute("data-action");
    if (el.getAttribute("data-s") && !dataS) dataS = el.getAttribute("data-s");
    if (el.getAttribute("data-rqdata") && !rqdata) rqdata = el.getAttribute("data-rqdata");
    if (el.getAttribute("data-pagedata") && !pagedata) pagedata = el.getAttribute("data-pagedata");
    if (el.getAttribute("data-size") === "invisible") invisible = true;
    if (!kind) {
      if (cls.includes("cf-turnstile") || el.hasAttribute("data-turnstile-sitekey") || el.id === "challenge-form" || el.id === "cf-challenge-running") {
        kind = "turnstile";
        vendor = "cloudflare-turnstile";
      } else if (cls.includes("h-captcha") || el.hasAttribute("data-hcaptcha-sitekey")) {
        kind = "hcaptcha";
        vendor = "hcaptcha";
      } else if (el.hasAttribute("data-gt") || cls.includes("geetest")) {
        kind = "geetest";
        vendor = "geetest";
      } else if (el.hasAttribute("data-pkey")) {
        kind = "arkose";
        vendor = "arkose-funcaptcha";
      } else if (cls.includes("g-recaptcha") || el.hasAttribute("data-sitekey")) {
        kind = invisible ? "recaptcha_v3" : "recaptcha_v2";
        vendor = "google-recaptcha";
      }
    }
  }

  if (!kind) return JSON.stringify(null);
  return JSON.stringify({
    kind,
    ...(vendor ? { vendor } : {}),
    pageUrl,
    ...(pageTitle ? { pageTitle } : {}),
    ...(frame ? { frame } : {}),
    ...(sitekey ? { sitekey } : {}),
    ...(action ? { action } : {}),
    ...(dataS ? { dataS } : {}),
    ...(rqdata ? { rqdata } : {}),
    ...(pagedata ? { pagedata } : {}),
    ...(enterprise !== undefined ? { enterprise } : {}),
    ...(invisible !== undefined ? { invisible } : {}),
    ...(Object.keys(rawAttributes).length > 0 ? { rawAttributes } : {}),
  });
})()`;

export class BuiltinChallengeDetector implements ChallengeDetectorPort {
  async detect(
    page: SolverPageReadPort,
    hint?: Partial<ChallengeDescriptor>,
  ): Promise<ChallengeDescriptor | null> {
    const now = new Date().toISOString();
    let detected: Partial<ChallengeDescriptor> | null = null;
    try {
      const raw = await page.evaluateIsolatedJs(ISOLATED_DETECT_EXPRESSION);
      const value = unwrapEvaluatedValue(raw);
      if (typeof value === "string" && value !== "null") {
        const parsed = JSON.parse(value) as Partial<ChallengeDescriptor> | null;
        if (parsed && isChallengeKind(parsed.kind)) detected = parsed;
      } else if (value && typeof value === "object" && "kind" in value) {
        const obj = value as Partial<ChallengeDescriptor>;
        if (isChallengeKind(obj.kind)) detected = obj;
      }
    } catch {
      // Fall back to hint when isolated evaluation is unavailable.
    }

    if (!detected && (!hint || !hint.kind)) return null;

    let fallbackUrl = hint?.pageUrl ?? "about:blank";
    let fallbackTitle = hint?.pageTitle;
    if (!detected?.pageUrl && !hint?.pageUrl) {
      try {
        const ext = (await page.extract()) as { result?: { url?: string; title?: string } };
        if (ext?.result?.url) fallbackUrl = ext.result.url;
        if (ext?.result?.title) fallbackTitle = ext.result.title;
      } catch {
        // ignore
      }
    }

    const kind: ChallengeKind =
      hint?.kind && isChallengeKind(hint.kind)
        ? hint.kind
        : detected?.kind && isChallengeKind(detected.kind)
          ? detected.kind
          : "unknown";

    const frame: ChallengeFrameInfo | undefined = hint?.frame ?? detected?.frame;
    const rawAttributes =
      hint?.rawAttributes || detected?.rawAttributes
        ? { ...detected?.rawAttributes, ...hint?.rawAttributes }
        : undefined;

    return {
      kind,
      pageUrl: hint?.pageUrl ?? detected?.pageUrl ?? fallbackUrl,
      detectedAt: now,
      ...(hint?.pageTitle ?? detected?.pageTitle ?? fallbackTitle
        ? { pageTitle: hint?.pageTitle ?? detected?.pageTitle ?? fallbackTitle }
        : {}),
      ...(hint?.vendor ?? detected?.vendor ? { vendor: hint?.vendor ?? detected?.vendor } : {}),
      ...(frame ? { frame } : {}),
      ...(hint?.sitekey ?? detected?.sitekey ? { sitekey: hint?.sitekey ?? detected?.sitekey } : {}),
      ...(hint?.action ?? detected?.action ? { action: hint?.action ?? detected?.action } : {}),
      ...(hint?.dataS ?? detected?.dataS ? { dataS: hint?.dataS ?? detected?.dataS } : {}),
      ...(hint?.rqdata ?? detected?.rqdata ? { rqdata: hint?.rqdata ?? detected?.rqdata } : {}),
      ...(hint?.pagedata ?? detected?.pagedata
        ? { pagedata: hint?.pagedata ?? detected?.pagedata }
        : {}),
      ...((hint?.enterprise ?? detected?.enterprise) !== undefined
        ? { enterprise: hint?.enterprise ?? detected?.enterprise }
        : {}),
      ...((hint?.invisible ?? detected?.invisible) !== undefined
        ? { invisible: hint?.invisible ?? detected?.invisible }
        : {}),
      ...(rawAttributes ? { rawAttributes } : {}),
    };
  }
}

const INSPECT_CHALLENGE_FRAME_EXPRESSION = `(() => {
  const frameBounds =
    typeof __mzFrameBounds !== "undefined" && __mzFrameBounds
      ? __mzFrameBounds
      : {
          x: 0,
          y: 0,
          width: window.innerWidth || 400,
          height: window.innerHeight || 600,
        };

  const isVisible = (el) => {
    if (!el || typeof el.getBoundingClientRect !== "function") return false;
    const r = el.getBoundingClientRect();
    if (!r || r.width <= 2 || r.height <= 2) return false;
    if (typeof window.getComputedStyle === "function") {
      const st = window.getComputedStyle(el);
      if (st.display === "none" || st.visibility === "hidden" || parseFloat(st.opacity) === 0) {
        return false;
      }
    }
    return true;
  };

  const toRootBox = (el) => {
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(frameBounds.x + r.x),
      y: Math.round(frameBounds.y + r.y),
      width: Math.round(r.width),
      height: Math.round(r.height),
    };
  };

  const promptEl = document.querySelector(
    ".prompt-text, .task-prompt, [class*='prompt-text'], h2.prompt-text, [id*='prompt-text']"
  );
  const promptText =
    promptEl && promptEl.textContent ? promptEl.textContent.trim().replace(/\\s+/g, " ") : undefined;

  const exampleCandidates = Array.from(
    document.querySelectorAll(
      ".example-image .image, .challenge-example .image, .challenge-example img, .prompt-image, [class*='example'] .image, [class*='example'] img, .challenge-header"
    )
  ).filter((el) => {
    if (!isVisible(el)) return false;
    const r = el.getBoundingClientRect();
    return Boolean(r && r.width >= 24 && r.height >= 24);
  });
  const exampleBounds =
    exampleCandidates.length > 0 ? toRootBox(exampleCandidates[0]) : undefined;

  const errorEl = document.querySelector(
    ".display-error, .error-text, [class*='display-error']"
  );
  const errorText =
    errorEl && isVisible(errorEl) && errorEl.textContent
      ? errorEl.textContent.trim()
      : undefined;

  const submitEl = document.querySelector(
    ".button-submit, .verify-button, [class*='button-submit']"
  );
  const submitButtonBounds = submitEl && isVisible(submitEl) ? toRootBox(submitEl) : undefined;
  const submitButtonText =
    submitEl && submitEl.textContent ? submitEl.textContent.trim() : undefined;

  const hasTileGraphicLoaded = (node) => {
    const checkBg = (el) => {
      if (!el || typeof window.getComputedStyle !== "function") return false;
      const bg = window.getComputedStyle(el).backgroundImage || "";
      if (!bg || bg === "none") return false;
      if (/url\\(\\s*["']?\\s*["']?\\s*\\)/i.test(bg)) return false;
      return /url\\(/i.test(bg);
    };
    if (checkBg(node)) return true;
    const bgChild = node.querySelector(".image, [style*='background-image']");
    if (bgChild && checkBg(bgChild)) return true;
    const img = node.querySelector("img");
    if (img && img.complete && img.naturalWidth > 0) return true;
    const canvas = node.querySelector("canvas");
    if (canvas && isVisible(canvas)) return true;
    return false;
  };

  const tileNodes = Array.from(
    document.querySelectorAll(".task-image, .image-wrapper, [class*='task-image'], .challenge-item")
  ).filter(isVisible);

  if (tileNodes.length >= 4) {
    const loadedCount = tileNodes.filter(hasTileGraphicLoaded).length;
    if (loadedCount < tileNodes.length) {
      return JSON.stringify({
        frameBounds,
        ...(promptText ? { promptText } : {}),
        ...(exampleBounds ? { exampleBounds } : {}),
        ...(submitButtonBounds ? { submitButtonBounds } : {}),
        ...(submitButtonText ? { submitButtonText } : {}),
        ...(errorText ? { errorText } : {}),
        loading: true,
        isVisible: true,
      });
    }
    const tileBounds = tileNodes.map((node, index) => ({
      index,
      ...toRootBox(node),
    }));
    const sigParts = tileNodes.map((node) => {
      const imgEl = node.querySelector(".image, img, [style*='background-image']") || node;
      const st =
        typeof window.getComputedStyle === "function" ? window.getComputedStyle(imgEl) : null;
      return (st && st.backgroundImage) || imgEl.getAttribute("src") || imgEl.getAttribute("style") || "";
    });
    return JSON.stringify({
      frameBounds,
      ...(promptText ? { promptText } : {}),
      ...(exampleBounds ? { exampleBounds } : {}),
      challengeType: "grid",
      tileBounds,
      ...(submitButtonBounds ? { submitButtonBounds } : {}),
      ...(submitButtonText ? { submitButtonText } : {}),
      ...(errorText ? { errorText } : {}),
      roundSignature: (promptText || "") + "|" + sigParts.join(","),
      isVisible: true,
    });
  }

  const canvasNodes = Array.from(
    document.querySelectorAll(".task-grid canvas, .challenge-container canvas, .challenge-view canvas, canvas")
  ).filter((c) => isVisible(c) && c.getBoundingClientRect().width >= 100 && c.getBoundingClientRect().height >= 100);

  if (canvasNodes.length > 0) {
    const canvasEl = canvasNodes[0];
    return JSON.stringify({
      frameBounds,
      ...(promptText ? { promptText } : {}),
      ...(exampleBounds ? { exampleBounds } : {}),
      challengeType: "canvas",
      canvasBounds: toRootBox(canvasEl),
      ...(submitButtonBounds ? { submitButtonBounds } : {}),
      ...(submitButtonText ? { submitButtonText } : {}),
      ...(errorText ? { errorText } : {}),
      roundSignature: (promptText || "") + "|canvas:" + canvasEl.width + "x" + canvasEl.height,
      isVisible: true,
    });
  }

  const checkboxEl = document.querySelector("#checkbox, [role='checkbox'], .check");
  if (checkboxEl && isVisible(checkboxEl)) {
    const checked =
      checkboxEl.getAttribute("aria-checked") === "true" ||
      checkboxEl.classList.contains("checked");
    return JSON.stringify({
      frameBounds,
      challengeType: "checkbox",
      checkboxBounds: toRootBox(checkboxEl),
      checkboxChecked: checked,
      isVisible: true,
    });
  }

  return JSON.stringify({
    frameBounds,
    ...(promptText ? { promptText } : {}),
    ...(exampleBounds ? { exampleBounds } : {}),
    isVisible: Boolean(promptText || submitButtonBounds),
  });
})()`;

function buildMainWorldCallbackScript(token: string, callbackName?: string | null): string {
  const cfg = JSON.stringify({ token, callbackName: callbackName ?? null });
  return `(() => {
    const { token, callbackName } = ${cfg};
    const invoked = [];

    if (callbackName && /^[A-Za-z_$][A-Za-z0-9_$.]*$/.test(callbackName)) {
      try {
        const parts = callbackName.split(".");
        let ctx = window;
        let fn = window;
        for (const p of parts) {
          ctx = fn;
          fn = fn != null ? fn[p] : undefined;
        }
        if (typeof fn === "function") {
          fn.call(ctx, token);
          invoked.push("global:" + callbackName);
        }
      } catch {}
    }

    if (invoked.length === 0) {
      const callbackPropNames = ["onVerify", "onSuccess", "callback", "onChange", "onComplete", "onToken"];
      const anchorSelectors = [
        ".h-captcha",
        ".cf-turnstile",
        ".g-recaptcha",
        "[data-sitekey]",
        "[data-hcaptcha-sitekey]",
        "[data-turnstile-sitekey]",
        "iframe[src*='hcaptcha.com']",
        "iframe[src*='challenges.cloudflare.com']",
        "iframe[src*='recaptcha']"
      ];
      const visited = new Set();
      const tryInvokeFromProps = (props, sourceLabel) => {
        if (!props || typeof props !== "object") return false;
        for (const propName of callbackPropNames) {
          if (typeof props[propName] === "function") {
            try {
              props[propName](token);
              invoked.push(sourceLabel + ":" + propName);
              return true;
            } catch {}
          }
        }
        return false;
      };

      for (const sel of anchorSelectors) {
        if (invoked.length > 0) break;
        for (const startEl of Array.from(document.querySelectorAll(sel))) {
          if (invoked.length > 0) break;
          let el = startEl;
          let depth = 0;
          while (el && depth < 10 && invoked.length === 0) {
            if (!visited.has(el)) {
              visited.add(el);
              const keys = Object.keys(el);
              for (const k of keys) {
                if (k.startsWith("__reactProps$")) {
                  if (tryInvokeFromProps(el[k], "reactProps")) break;
                }
                if (k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")) {
                  let fiber = el[k];
                  let fDepth = 0;
                  while (fiber && fDepth < 15) {
                    if (tryInvokeFromProps(fiber.memoizedProps || fiber.pendingProps, "reactFiber")) {
                      break;
                    }
                    fiber = fiber.return;
                    fDepth++;
                  }
                  if (invoked.length > 0) break;
                }
              }
            }
            el = el.parentElement;
            depth++;
          }
        }
      }
    }

    return JSON.stringify({ invoked: invoked.length > 0, targets: invoked });
  })()`;
}

export function buildScopedSolverPagePort(opts: {
  profileId: ProfileId;
  engine: BrowserEngine;
  driver: BrowserDriver;
  allowMainWorldJs: boolean;
  isActive?: () => boolean;
}): SolverPagePort {
  const { profileId, engine, driver, allowMainWorldJs } = opts;
  const assertActive = (): void => {
    if (opts.isActive && !opts.isActive()) {
      throw new MultizenError(
        "FORBIDDEN",
        `Solver task on profile ${profileId} is no longer active.`,
      );
    }
  };

  const evaluateIsolatedJs = async (
    expression: string,
    evalOpts?: { frameUrlPattern?: string },
  ): Promise<unknown> => {
    assertActive();
    if (driver.evaluateIsolatedJs) return driver.evaluateIsolatedJs(profileId, expression, evalOpts);
    return driver.evaluateJs(profileId, expression);
  };

  const evaluateMainWorldJs = async (expression: string): Promise<unknown> => {
    assertActive();
    if (!allowMainWorldJs) {
      throw new MultizenError(
        "FORBIDDEN",
        "Main-world JS evaluation is disabled for this solver port (allowMainWorldJs is false).",
      );
    }
    return driver.evaluateJs(profileId, expression);
  };

  const inspectChallengeFrame = async (
    frameUrlPattern = "hcaptcha.com",
  ): Promise<ChallengeFrameInspection | null> => {
    assertActive();
    try {
      const raw = await evaluateIsolatedJs(INSPECT_CHALLENGE_FRAME_EXPRESSION, {
        frameUrlPattern,
      });
      const value = unwrapEvaluatedValue(raw);
      let parsed: ChallengeFrameInspection | null = null;
      if (typeof value === "string" && value !== "null") {
        parsed = JSON.parse(value) as ChallengeFrameInspection | null;
      } else if (value && typeof value === "object" && "frameBounds" in value) {
        parsed = value as ChallengeFrameInspection;
      }
      if (!parsed || !parsed.frameBounds) return null;
      return parsed;
    } catch {
      // Frame may not exist or may have detached.
    }
    return null;
  };

  const captureRegionBase64 = async (bounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): Promise<string> => {
    assertActive();
    if (
      bounds &&
      bounds.width > 0 &&
      bounds.height > 0 &&
      engine === "cloakbrowser" &&
      driver.cdpSend
    ) {
      try {
        const res = (await driver.cdpSend(
          profileId,
          "Page.captureScreenshot",
          {
            format: "jpeg",
            quality: 85,
            clip: {
              x: Math.max(0, Math.round(bounds.x)),
              y: Math.max(0, Math.round(bounds.y)),
              width: Math.max(1, Math.round(bounds.width)),
              height: Math.max(1, Math.round(bounds.height)),
              scale: 1,
            },
          },
          undefined,
          { safe: true },
        )) as { data?: string };
        if (res && typeof res.data === "string" && res.data.length > 0) {
          return res.data;
        }
      } catch {
        // Fall back to full frame capture below.
      }
    }
    const frame = await driver.captureFrame(profileId, { quality: 85 });
    return Buffer.from(frame.jpeg).toString("base64");
  };

  const applyToken = async (
    payload: SolverTokenPayload,
  ): Promise<ApplyTokenResult> => {
    assertActive();
    const selectors = payload.targetSelector
      ? [payload.targetSelector]
      : [
          'textarea[name="cf-turnstile-response"]',
          'input[name="cf-turnstile-response"]',
          'textarea[name="g-recaptcha-response"]',
          'textarea[name="h-captcha-response"]',
          'textarea[id*="g-recaptcha-response"]',
          'textarea[id*="h-captcha-response"]',
          'input[name="g-recaptcha-response"]',
          'input[name="h-captcha-response"]',
        ];
    const cfgJson = JSON.stringify({
      token: payload.token,
      selectors,
      extraFields: payload.extraFields ?? {},
      triggerEvents: payload.triggerCallback !== false,
    });
    const raw = await evaluateIsolatedJs(`(() => {
      const cfg = ${cfgJson};
      let appliedCount = 0;
      const matchedSelectors = [];
      const setField = (el, val) => {
        el.value = val;
        el.setAttribute("value", val);
        if (cfg.triggerEvents) {
          el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
        appliedCount++;
      };
      for (const sel of cfg.selectors) {
        for (const el of Array.from(document.querySelectorAll(sel))) {
          setField(el, cfg.token);
          matchedSelectors.push(sel);
        }
      }
      for (const [k, v] of Object.entries(cfg.extraFields || {})) {
        const nodes = Array.from(document.querySelectorAll("input[name=" + JSON.stringify(k) + "], textarea[name=" + JSON.stringify(k) + "]"));
        for (const el of nodes) {
          setField(el, String(v));
          matchedSelectors.push(k);
        }
      }
      const cbNode = document.querySelector("[data-callback]");
      const callbackName = cbNode ? cbNode.getAttribute("data-callback") : null;
      return JSON.stringify({ applied: appliedCount > 0, matchedSelectors, callbackName });
    })()`);
    const value = unwrapEvaluatedValue(raw);
    let parsed: { applied: boolean; matchedSelectors?: string[]; callbackName?: string | null } = {
      applied: false,
    };
    if (typeof value === "string") {
      try {
        parsed = JSON.parse(value) as typeof parsed;
      } catch {
        parsed = { applied: false };
      }
    } else if (value && typeof value === "object" && "applied" in value) {
      parsed = value as typeof parsed;
    }

    let callbackInvoked = false;
    let callbackTargets: string[] = [];
    if (payload.triggerCallback !== false && allowMainWorldJs) {
      try {
        const cbRaw = await driver.evaluateJs(
          profileId,
          buildMainWorldCallbackScript(payload.token, parsed.callbackName),
        );
        const cbVal = unwrapEvaluatedValue(cbRaw);
        if (typeof cbVal === "string") {
          const cbParsed = JSON.parse(cbVal) as { invoked?: boolean; targets?: string[] };
          callbackInvoked = Boolean(cbParsed.invoked);
          callbackTargets = cbParsed.targets ?? [];
        } else if (typeof cbVal === "boolean") {
          callbackInvoked = cbVal;
        }
      } catch {
        // ignore
      }
    }

    const textareaUpdated = Boolean(parsed.applied);
    const cbDesc =
      callbackTargets.length > 0
        ? callbackTargets.join(", ")
        : parsed.callbackName ?? "callback";

    return {
      applied: Boolean(textareaUpdated || callbackInvoked),
      textareaUpdated,
      callbackInvoked,
      details: parsed.matchedSelectors?.length
        ? `Updated ${parsed.matchedSelectors.join(", ")}${callbackInvoked ? ` + callback (${cbDesc})` : " (no callback invoked)"}`
        : callbackInvoked
          ? `Invoked callback (${cbDesc})`
          : "No matching token input elements found on page",
    };
  };

  return {
    profileId,
    engine,
    extract: async () => {
      assertActive();
      return driver.extract(profileId);
    },
    captureFrame: async (frameOpts?: { quality?: number }): Promise<CapturedFrame> => {
      assertActive();
      return driver.captureFrame(profileId, frameOpts);
    },
    listTabs: async () => {
      assertActive();
      return driver.listTabs(profileId);
    },
    getCookies: async (urls?: string[]) => {
      assertActive();
      return driver.getCookies(profileId, urls);
    },
    setCookies: async (cookies: unknown[]) => {
      assertActive();
      return driver.setCookies(profileId, cookies);
    },
    dispatchInput: async (event: HumanInputEvent) => {
      assertActive();
      return driver.dispatchInput(profileId, event);
    },
    clickRef: async (ref: string) => {
      assertActive();
      return driver.clickRef(profileId, ref);
    },
    typeRef: async (ref: string, text: string) => {
      assertActive();
      return driver.typeRef(profileId, ref, text);
    },
    performAction: async (action: DriverAction) => {
      assertActive();
      return driver.performAction(profileId, action);
    },
    evaluateIsolatedJs,
    evaluateMainWorldJs,
    inspectChallengeFrame,
    captureRegionBase64,
    applyToken,
  };
}

export interface EffectiveProfileSolverPolicy {
  enabled: boolean;
  adapter: SolverAdapterKind;
  port: CaptchaSolverPort | null;
  fallbackPolicy: SolverFallbackPolicy;
  strategy: SolverStrategy;
  proxyExposure: ProxyExposureMode;
  allowMainWorldJs: boolean;
  timeoutMs: number;
  hasApiKey: boolean;
  apiBaseUrl?: string;
  webhookUrl?: string;
  hasWebhookSecret: boolean;
}

export interface AdHocSolverSpec {
  adapter: SolverAdapterKind;
  apiKey?: string;
  apiBaseUrl?: string;
  webhookUrl?: string;
  webhookSecret?: string;
  interactiveDelayScale?: number;
}

export interface SolverCoordinatorOptions {
  handoff: HumanHandoff;
  getSolverPort?: () => CaptchaSolverPort | null;
  getSolverSettings?: () => SolverSettings;
  onUpdateSettings?: (settings: SolverSettings, port: CaptchaSolverPort | null) => Promise<void> | void;
  detector?: ChallengeDetectorPort;
  getBridgeInfo?: (profileId: ProfileId) => SolverNetworkContext["bridgeProxy"] | null;
  activityLog?: ActivityLog;
  webhookSessions?: SolverWebhookSessions;
  callbackBaseUrl?: () => string;
  fetchImpl?: typeof fetch;
  postSolveVerifyTimeoutMs?: number;
  postSolveVerifyIntervalMs?: number;
  interactiveDelayScale?: number;
}

interface ActiveTaskEntry {
  record: SolverTaskRecord;
  controller: AbortController;
  promise: Promise<SolverTaskRecord>;
  waiters: Set<() => void>;
}

export class SolverCoordinator {
  private readonly handoff: HumanHandoff;
  private getSolverPortFn: () => CaptchaSolverPort | null;
  private getSolverSettingsFn: () => SolverSettings;
  private onUpdateSettingsFn?: (
    settings: SolverSettings,
    port: CaptchaSolverPort | null,
  ) => Promise<void> | void;
  private readonly detector: ChallengeDetectorPort;
  private getBridgeInfoFn?: (profileId: ProfileId) => SolverNetworkContext["bridgeProxy"] | null;
  private activityLog?: ActivityLog;
  private webhookSessions: SolverWebhookSessions;
  private callbackBaseUrlFn: () => string;
  private fetchImpl?: typeof fetch;
  private postSolveVerifyTimeoutMs: number;
  private postSolveVerifyIntervalMs: number;
  private interactiveDelayScale?: number;

  private runtimeSettingsOverride: SolverSettings | null = null;
  private runtimePortOverride: CaptchaSolverPort | null = null;
  private hasRuntimeOverride = false;

  private readonly activeByProfile = new Map<ProfileId, ActiveTaskEntry>();
  private readonly tombstones = new Map<string, { record: SolverTaskRecord; endedAtMs: number }>();

  constructor(opts: SolverCoordinatorOptions) {
    this.handoff = opts.handoff;
    this.getSolverPortFn = opts.getSolverPort ?? (() => null);
    this.getSolverSettingsFn = opts.getSolverSettings ?? (() => DEFAULT_SOLVER_CONFIG);
    this.onUpdateSettingsFn = opts.onUpdateSettings;
    this.detector = opts.detector ?? new BuiltinChallengeDetector();
    this.getBridgeInfoFn = opts.getBridgeInfo;
    this.activityLog = opts.activityLog;
    this.webhookSessions = opts.webhookSessions ?? new SolverWebhookSessions();
    this.callbackBaseUrlFn = opts.callbackBaseUrl ?? (() => "http://127.0.0.1:7777");
    this.fetchImpl = opts.fetchImpl;
    this.postSolveVerifyTimeoutMs =
      opts.postSolveVerifyTimeoutMs ?? DEFAULT_POST_SOLVE_VERIFY_TIMEOUT_MS;
    this.postSolveVerifyIntervalMs =
      opts.postSolveVerifyIntervalMs ?? DEFAULT_POST_SOLVE_VERIFY_INTERVAL_MS;
    this.interactiveDelayScale = opts.interactiveDelayScale;

    // When a handoff ends externally (browser closed, operator resumed/aborted), cancel its solver task.
    this.handoff.onTransition((record) => {
      if (record.status !== "pending") {
        const active = this.activeByProfile.get(record.profileId);
        if (active && active.record.handoffId === record.id) {
          active.controller.abort();
        }
      }
    });
  }

  configure(opts: Partial<Omit<SolverCoordinatorOptions, "handoff">>): void {
    if (opts.getSolverPort !== undefined) this.getSolverPortFn = opts.getSolverPort;
    if (opts.getSolverSettings !== undefined) this.getSolverSettingsFn = opts.getSolverSettings;
    if (opts.onUpdateSettings !== undefined) this.onUpdateSettingsFn = opts.onUpdateSettings;
    if (opts.getBridgeInfo !== undefined) this.getBridgeInfoFn = opts.getBridgeInfo;
    if (opts.activityLog !== undefined) this.activityLog = opts.activityLog;
    if (opts.webhookSessions !== undefined) this.webhookSessions = opts.webhookSessions;
    if (opts.callbackBaseUrl !== undefined) this.callbackBaseUrlFn = opts.callbackBaseUrl;
    if (opts.fetchImpl !== undefined) this.fetchImpl = opts.fetchImpl;
    if (opts.postSolveVerifyTimeoutMs !== undefined) {
      this.postSolveVerifyTimeoutMs = opts.postSolveVerifyTimeoutMs;
    }
    if (opts.postSolveVerifyIntervalMs !== undefined) {
      this.postSolveVerifyIntervalMs = opts.postSolveVerifyIntervalMs;
    }
    if (opts.interactiveDelayScale !== undefined) {
      this.interactiveDelayScale = opts.interactiveDelayScale;
    }
  }

  createAdHocPort(spec: AdHocSolverSpec): CaptchaSolverPort | null {
    if (isCloudSolverProviderKind(spec.adapter) && spec.apiKey) {
      const delayScale = spec.interactiveDelayScale ?? this.interactiveDelayScale;
      return createCloudProviderSolverPort(spec.adapter, {
        apiKey: spec.apiKey,
        ...(spec.apiBaseUrl ? { apiBaseUrl: spec.apiBaseUrl } : {}),
        ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
        ...(delayScale !== undefined ? { interactiveDelayScale: delayScale } : {}),
      });
    }
    if (spec.adapter === "webhook" && spec.webhookUrl) {
      return new HttpWebhookSolverAdapter({
        webhookUrl: spec.webhookUrl,
        ...(spec.webhookSecret ? { webhookSecret: spec.webhookSecret } : {}),
        ...(spec.apiKey ? { apiKey: spec.apiKey } : {}),
        callbackBaseUrl: this.callbackBaseUrlFn,
        sessions: this.webhookSessions,
        ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
      });
    }
    return null;
  }

  async updateGlobalSettings(patch: {
    enabled?: boolean;
    adapter?: SolverAdapterKind;
    apiKey?: string;
    apiBaseUrl?: string;
    webhookUrl?: string;
    webhookSecret?: string;
    fallbackPolicy?: SolverFallbackPolicy;
    strategy?: SolverStrategy;
    proxyExposure?: ProxyExposureMode;
    allowMainWorldJs?: boolean;
    timeoutMs?: number;
  }): Promise<{ settings: SolverSettings; port: CaptchaSolverPort | null }> {
    const current = this.getSettings();
    const adapter =
      patch.adapter !== undefined && isSolverAdapterKind(patch.adapter)
        ? patch.adapter
        : current.adapter;
    const enabled =
      patch.enabled !== undefined
        ? patch.enabled
        : patch.adapter !== undefined
          ? patch.adapter !== "none"
          : current.enabled;
    const apiKey = patch.apiKey !== undefined ? patch.apiKey.trim() : current.apiKey;
    const webhookUrl =
      patch.webhookUrl !== undefined ? patch.webhookUrl.trim() : current.webhookUrl;
    const webhookSecret =
      patch.webhookSecret !== undefined ? patch.webhookSecret : current.webhookSecret;
    const nextOptions: Record<string, unknown> = { ...(current.options ?? {}) };
    if (patch.apiBaseUrl !== undefined) {
      const trimmed = patch.apiBaseUrl.trim();
      if (trimmed) nextOptions.apiBaseUrl = trimmed;
      else delete nextOptions.apiBaseUrl;
    }

    const nextSettings: SolverSettings = {
      enabled,
      adapter,
      ...(apiKey ? { apiKey } : {}),
      ...(webhookUrl ? { webhookUrl } : {}),
      ...(webhookSecret ? { webhookSecret } : {}),
      ...(current.modulePath ? { modulePath: current.modulePath } : {}),
      fallbackPolicy:
        patch.fallbackPolicy && isSolverFallbackPolicy(patch.fallbackPolicy)
          ? patch.fallbackPolicy
          : current.fallbackPolicy,
      strategy:
        patch.strategy && isSolverStrategy(patch.strategy)
          ? patch.strategy
          : (current.strategy ?? "auto"),
      proxyExposure:
        patch.proxyExposure && isProxyExposureMode(patch.proxyExposure)
          ? patch.proxyExposure
          : current.proxyExposure,
      allowMainWorldJs:
        typeof patch.allowMainWorldJs === "boolean"
          ? patch.allowMainWorldJs
          : current.allowMainWorldJs,
      timeoutMs:
        typeof patch.timeoutMs === "number" && Number.isFinite(patch.timeoutMs) && patch.timeoutMs > 0
          ? Math.round(patch.timeoutMs)
          : current.timeoutMs,
      ...(Object.keys(nextOptions).length > 0 ? { options: nextOptions } : {}),
    };

    const prevPort = this.runtimePortOverride;
    let nextPort: CaptchaSolverPort | null = null;
    if (nextSettings.enabled && nextSettings.adapter !== "none") {
      nextPort = this.createAdHocPort({
        adapter: nextSettings.adapter,
        apiKey: nextSettings.apiKey,
        apiBaseUrl:
          typeof nextSettings.options?.apiBaseUrl === "string"
            ? nextSettings.options.apiBaseUrl
            : undefined,
        webhookUrl: nextSettings.webhookUrl,
        webhookSecret: nextSettings.webhookSecret,
      });
    }

    this.runtimeSettingsOverride = nextSettings;
    this.runtimePortOverride = nextPort;
    this.hasRuntimeOverride = true;
    await prevPort?.dispose?.().catch(() => {});
    if (this.onUpdateSettingsFn) {
      await this.onUpdateSettingsFn(nextSettings, nextPort);
    }
    return { settings: nextSettings, port: nextPort ?? this.getPort() };
  }

  getPort(): CaptchaSolverPort | null {
    if (this.hasRuntimeOverride) {
      if (this.runtimePortOverride) return this.runtimePortOverride;
      if (
        this.runtimeSettingsOverride &&
        (!this.runtimeSettingsOverride.enabled || this.runtimeSettingsOverride.adapter === "none")
      ) {
        return null;
      }
    }
    const hostPort = this.getSolverPortFn();
    if (hostPort) return hostPort;
    const settings = this.getSettings();
    if (!settings.enabled || settings.adapter === "none") return null;
    return this.createAdHocPort({
      adapter: settings.adapter,
      apiKey: settings.apiKey,
      apiBaseUrl:
        typeof settings.options?.apiBaseUrl === "string"
          ? settings.options.apiBaseUrl
          : undefined,
      webhookUrl: settings.webhookUrl,
      webhookSecret: settings.webhookSecret,
    });
  }

  getSettings(): SolverSettings {
    if (this.hasRuntimeOverride && this.runtimeSettingsOverride) {
      return this.runtimeSettingsOverride;
    }
    return this.getSolverSettingsFn();
  }

  resolvePolicy(profile: Profile | null | undefined): EffectiveProfileSolverPolicy {
    const global = this.getSettings();
    const override = profile?.solverConfig;
    const mode = override?.mode ?? "inherit";
    const adapter = override?.adapter ?? global.adapter;
    const apiKey = override?.apiKey ?? global.apiKey;
    const apiBaseUrl =
      override?.apiBaseUrl ??
      (typeof global.options?.apiBaseUrl === "string" ? global.options.apiBaseUrl : undefined);
    const webhookUrl = override?.webhookUrl ?? global.webhookUrl;
    const webhookSecret = override?.webhookSecret ?? global.webhookSecret;

    let port: CaptchaSolverPort | null = null;
    const hasProfileAdapterOverride = Boolean(
      override?.adapter ||
        override?.apiKey ||
        override?.apiBaseUrl ||
        override?.webhookUrl ||
        override?.webhookSecret,
    );
    if (hasProfileAdapterOverride) {
      if (adapter !== "none") {
        port = this.createAdHocPort({
          adapter,
          apiKey,
          apiBaseUrl,
          webhookUrl,
          webhookSecret,
        });
      }
    } else {
      port = this.getPort();
    }

    const enabledByConfig =
      mode === "enabled" ? true : mode === "disabled" ? false : global.enabled;
    const fallbackPolicy = override?.fallbackPolicy ?? global.fallbackPolicy;
    const strategy = override?.strategy ?? global.strategy ?? "auto";
    return {
      enabled: Boolean(port && enabledByConfig && fallbackPolicy !== "human-only"),
      adapter,
      port,
      fallbackPolicy,
      strategy,
      proxyExposure: override?.proxyExposure ?? global.proxyExposure,
      allowMainWorldJs: override?.allowMainWorldJs ?? global.allowMainWorldJs,
      timeoutMs: override?.timeoutMs ?? global.timeoutMs,
      hasApiKey: Boolean(apiKey),
      ...(apiBaseUrl ? { apiBaseUrl } : {}),
      ...(webhookUrl ? { webhookUrl } : {}),
      hasWebhookSecret: Boolean(webhookSecret),
    };
  }

  buildNetworkContext(
    profile: Profile,
    engine: BrowserEngine,
    proxyExposure: ProxyExposureMode,
  ): SolverNetworkContext {
    const fp = profile.fingerprint;
    const bridge =
      proxyExposure === "bridge" || proxyExposure === "raw"
        ? (this.getBridgeInfoFn?.(profile.id) ?? undefined)
        : undefined;
    const upstream =
      proxyExposure === "raw" && profile.proxy ? { ...profile.proxy } : undefined;
    return {
      profileId: profile.id,
      engine,
      fingerprint: {
        userAgent: reducedUserAgent(fp.userAgent),
        platform: fp.platform,
        clientHints: fp.clientHints,
        locale: fp.locale,
        languages: [...fp.languages],
        acceptLanguage: fp.acceptLanguage,
        timezone: fp.timezone,
        screen: { ...fp.screen },
        dpr: fp.dpr,
      },
      ...(bridge ? { bridgeProxy: bridge } : {}),
      ...(upstream ? { upstreamProxy: upstream } : {}),
      ...(profile.proxyCountry ? { proxyCountry: profile.proxyCountry } : {}),
    };
  }

  async detect(opts: {
    profile: Profile;
    defaultEngine: BrowserEngine;
    driver: BrowserDriver;
    hint?: Partial<ChallengeDescriptor>;
  }): Promise<ChallengeDescriptor | null> {
    const engine = resolveEngine(opts.profile.engine, opts.defaultEngine);
    const policy = this.resolvePolicy(opts.profile);
    const pagePort = buildScopedSolverPagePort({
      profileId: opts.profile.id,
      engine,
      driver: opts.driver,
      allowMainWorldJs: policy.allowMainWorldJs,
    });
    const detector = policy.port?.detector ?? this.detector;
    return detector.detect(pagePort, opts.hint);
  }

  activeForProfile(profileId: ProfileId): SolverTaskRecord | null {
    const entry = this.activeByProfile.get(profileId);
    return entry ? { ...entry.record } : null;
  }

  latestForProfile(profileId: ProfileId): SolverTaskRecord | null {
    const active = this.activeForProfile(profileId);
    if (active) return active;
    this.pruneTombstones();
    let latest: SolverTaskRecord | null = null;
    for (const { record } of this.tombstones.values()) {
      if (record.profileId === profileId) latest = record;
    }
    return latest ? { ...latest } : null;
  }

  getTask(taskId: string): SolverTaskRecord | null {
    for (const { record } of this.activeByProfile.values()) {
      if (record.taskId === taskId) return { ...record };
    }
    this.pruneTombstones();
    const ended = this.tombstones.get(taskId);
    return ended ? { ...ended.record } : null;
  }

  async waitForTask(taskId: string, timeoutMs: number): Promise<SolverTaskRecord | null> {
    for (const entry of this.activeByProfile.values()) {
      if (entry.record.taskId === taskId) {
        await new Promise<void>((resolve) => {
          const done = (): void => {
            entry.waiters.delete(done);
            if (timer) clearTimeout(timer);
            resolve();
          };
          entry.waiters.add(done);
          const timer = timeoutMs > 0 ? setTimeout(done, timeoutMs) : undefined;
        });
        break;
      }
    }
    return this.getTask(taskId);
  }

  /**
   * Starts a solver task on `opts.profile`, coordinating with `HumanHandoff` so that:
   * - Concurrent agent page writes are blocked (`HUMAN_IN_CONTROL`).
   * - Outbound human webhooks are suppressed while the solver port works.
   * - On failure/unsupported with `solver-then-human`, the handoff seamlessly transfers to a human.
   */
  startTask(opts: {
    profile: Profile;
    defaultEngine: BrowserEngine;
    driver: BrowserDriver;
    reason?: string;
    hint?: Partial<ChallengeDescriptor>;
    requestedBy?: string;
    keepReason?: boolean;
    fallbackToHumanOverride?: boolean;
    strategyOverride?: SolverStrategy;
    timeoutMsOverride?: number;
    portOverride?: CaptchaSolverPort;
    proxyExposureOverride?: ProxyExposureMode;
    allowMainWorldJsOverride?: boolean;
  }): { taskRecord: SolverTaskRecord; handoffId: string } {
    const { profile, driver } = opts;
    const existing = this.activeByProfile.get(profile.id);
    if (existing) {
      return {
        taskRecord: { ...existing.record },
        handoffId: existing.record.handoffId ?? "",
      };
    }

    const basePolicy = this.resolvePolicy(profile);
    const policy: EffectiveProfileSolverPolicy = {
      ...basePolicy,
      ...(opts.portOverride ? { port: opts.portOverride, enabled: true } : {}),
      ...(opts.strategyOverride ? { strategy: opts.strategyOverride } : {}),
      ...(opts.proxyExposureOverride ? { proxyExposure: opts.proxyExposureOverride } : {}),
      ...(opts.allowMainWorldJsOverride !== undefined
        ? { allowMainWorldJs: opts.allowMainWorldJsOverride }
        : {}),
    };
    const port = policy.port;
    if (!port || !policy.enabled) {
      throw new MultizenError(
        "SOLVER_NOT_CONFIGURED",
        `No active challenge solver port is configured for profile ${profile.id}.`,
        {
          hint: "Call configure_solver first, pass inline adapter + api_key to solve_captcha, or use request_human.",
        },
      );
    }

    const taskId = randomUUID();
    const now = Date.now();
    const timeoutMs = opts.timeoutMsOverride ?? policy.timeoutMs;
    const handoffRecord = this.handoff.request(
      profile.id,
      opts.reason ?? "CAPTCHA challenge",
      {
        kind: "captcha",
        ...(opts.requestedBy !== undefined ? { requestedBy: opts.requestedBy } : {}),
        ...(opts.keepReason ? { keepReason: true } : {}),
        solverActive: true,
        solverTaskId: taskId,
      },
    );

    const record: SolverTaskRecord = {
      taskId,
      handoffId: handoffRecord.id,
      profileId: profile.id,
      adapterId: port.id,
      challengeKind: opts.hint?.kind ?? "unknown",
      status: "solving",
      ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + timeoutMs).toISOString(),
    };

    const controller = new AbortController();
    const waiters = new Set<() => void>();
    const entry: ActiveTaskEntry = {
      record,
      controller,
      promise: Promise.resolve(record),
      waiters,
    };
    this.activeByProfile.set(profile.id, entry);

    this.activityLog?.recordLifecycle("solver.started", {
      profileId: profile.id,
      ...(opts.requestedBy !== undefined ? { actor: opts.requestedBy } : {}),
      summary: `${port.id}`,
    });

    entry.promise = this.executeTask({
      entry,
      port,
      policy,
      profile,
      engine: resolveEngine(profile.engine, opts.defaultEngine),
      driver,
      handoffId: handoffRecord.id,
      timeoutMs,
      ...(opts.hint ? { hint: opts.hint } : {}),
      ...(opts.fallbackToHumanOverride !== undefined
        ? { fallbackToHumanOverride: opts.fallbackToHumanOverride }
        : {}),
    });

    return { taskRecord: { ...record }, handoffId: handoffRecord.id };
  }

  cancel(
    profileId: ProfileId,
    opts: { taskId?: string; handoffToHuman?: boolean; by?: string } = {},
  ): SolverTaskRecord | null {
    const entry = this.activeByProfile.get(profileId);
    if (!entry) return null;
    if (opts.taskId && entry.record.taskId !== opts.taskId) return null;

    const handoffId = entry.record.handoffId;
    if (opts.handoffToHuman && handoffId) {
      this.finishEntry(profileId, entry, "handed_off", "Manual takeover requested");
      this.handoff.handoffToHuman?.(handoffId, "Manual takeover requested");
      this.activityLog?.recordLifecycle("solver.handed_off", {
        profileId,
        ...(opts.by !== undefined ? { actor: opts.by } : {}),
        summary: "manual takeover",
      });
    } else {
      this.finishEntry(profileId, entry, "canceled", "Canceled by caller");
      if (handoffId) this.handoff.abortById(handoffId, opts.by ?? "solver-canceled");
      this.activityLog?.recordLifecycle("solver.canceled", {
        profileId,
        ...(opts.by !== undefined ? { actor: opts.by } : {}),
        summary: entry.record.adapterId,
      });
    }
    entry.controller.abort();
    return { ...entry.record };
  }

  private async executeTask(opts: {
    entry: ActiveTaskEntry;
    port: CaptchaSolverPort;
    policy: EffectiveProfileSolverPolicy;
    profile: Profile;
    engine: BrowserEngine;
    driver: BrowserDriver;
    handoffId: string;
    timeoutMs: number;
    hint?: Partial<ChallengeDescriptor>;
    fallbackToHumanOverride?: boolean;
  }): Promise<SolverTaskRecord> {
    const { entry, port, policy, profile, engine, driver, handoffId, timeoutMs } = opts;
    const isTaskActive = (): boolean => this.activeByProfile.get(profile.id) === entry;
    const pagePort = buildScopedSolverPagePort({
      profileId: profile.id,
      engine,
      driver,
      allowMainWorldJs: policy.allowMainWorldJs,
      isActive: isTaskActive,
    });

    const timer = setTimeout(() => entry.controller.abort(new Error("Solver timeout")), timeoutMs);
    timer.unref?.();

    const settleFailure = async (
      status: "failed" | "unsupported",
      reason: string,
      adapterFallbackPref?: boolean,
    ): Promise<SolverTaskRecord> => {
      if (!isTaskActive()) return { ...entry.record };
      const shouldFallback =
        opts.fallbackToHumanOverride !== undefined
          ? opts.fallbackToHumanOverride
          : policy.fallbackPolicy === "solver-then-human" && adapterFallbackPref !== false;

      if (shouldFallback) {
        this.finishEntry(profile.id, entry, "handed_off", reason);
        this.handoff.handoffToHuman?.(handoffId, reason);
        await driver.performAction(profile.id, { type: "bring_to_front" }).catch(() => {});
        this.activityLog?.recordLifecycle("solver.handed_off", {
          profileId: profile.id,
          actor: `solver:${port.id}`,
          summary: reason.slice(0, 120),
        });
      } else {
        this.finishEntry(profile.id, entry, status, reason);
        this.handoff.abortById(handoffId, `solver-${status}:${port.id}`);
        this.activityLog?.recordLifecycle(`solver.${status}`, {
          profileId: profile.id,
          actor: `solver:${port.id}`,
          summary: reason.slice(0, 120),
        });
      }
      return { ...entry.record };
    };

    try {
      const detector = port.detector ?? this.detector;
      const detected = await detector.detect(pagePort, opts.hint);
      const challenge: ChallengeDescriptor = detected ?? {
        kind: opts.hint?.kind ?? "unknown",
        pageUrl: opts.hint?.pageUrl ?? "about:blank",
        detectedAt: new Date().toISOString(),
        ...(opts.hint?.sitekey ? { sitekey: opts.hint.sitekey } : {}),
      };
      entry.record.challengeKind = challenge.kind;

      const network = this.buildNetworkContext(profile, engine, policy.proxyExposure);

      if (
        port.capabilities.kinds.length > 0 &&
        !port.capabilities.kinds.includes(challenge.kind) &&
        !port.capabilities.kinds.includes("unknown")
      ) {
        return await settleFailure(
          "unsupported",
          `Adapter "${port.id}" does not support challenge kind "${challenge.kind}".`,
        );
      }

      if (port.canSolve) {
        const supported = await port.canSolve(challenge, network);
        if (!supported) {
          return await settleFailure(
            "unsupported",
            `Adapter "${port.id}" declined challenge "${challenge.kind}".`,
          );
        }
      }

      const task: SolverTask = {
        taskId: entry.record.taskId,
        handoffId,
        profileId: profile.id,
        ...(entry.record.reason !== undefined ? { reason: entry.record.reason } : {}),
        strategy: policy.strategy,
        challenge,
        network,
        createdAt: entry.record.createdAt,
        expiresAt: entry.record.expiresAt,
      };

      const outcome: SolverOutcome = await port.solve(task, pagePort, entry.controller.signal);
      if (!isTaskActive()) return { ...entry.record };

      if (outcome.status === "solved") {
        let applyRes: ApplyTokenResult = {
          applied: true,
          textareaUpdated: false,
          callbackInvoked: false,
        };
        if (outcome.tokenPayload) {
          applyRes = await pagePort.applyToken(outcome.tokenPayload).catch(() => ({
            applied: false,
            textareaUpdated: false,
            callbackInvoked: false,
            details: "applyToken failed",
          }));
        }

        const hadInteractiveModal = Boolean(
          challenge.frame?.bounds &&
            challenge.frame.bounds.width >= 200 &&
            challenge.frame.bounds.height >= 200,
        );

        if (outcome.mode === "token" && hadInteractiveModal) {
          const verifyDeadline = Date.now() + this.postSolveVerifyTimeoutMs;
          let modalClosed = false;
          while (Date.now() < verifyDeadline && isTaskActive()) {
            const after = await detector.detect(pagePort).catch(() => null);
            if (
              !after ||
              after.pageUrl !== challenge.pageUrl ||
              !after.frame?.bounds ||
              after.frame.bounds.width < 200 ||
              after.frame.bounds.height < 200
            ) {
              modalClosed = true;
              break;
            }
            const remaining = verifyDeadline - Date.now();
            if (remaining <= 0) break;
            await sleepWithSignal(
              Math.min(this.postSolveVerifyIntervalMs, remaining),
              entry.controller.signal,
            );
          }

          if (!isTaskActive()) return { ...entry.record };

          if (!modalClosed) {
            const canTryInteractive =
              (policy.strategy === "auto" || policy.strategy === "token-then-interactive") &&
              port.capabilities.modes.includes("interactive");

            if (canTryInteractive) {
              const interactiveOutcome = await port.solve(
                { ...task, strategy: "interactive-only" },
                pagePort,
                entry.controller.signal,
              );
              if (!isTaskActive()) return { ...entry.record };
              if (interactiveOutcome.status === "solved") {
                if (interactiveOutcome.tokenPayload) {
                  await pagePort.applyToken(interactiveOutcome.tokenPayload).catch(() => {});
                }
                this.finishEntry(profile.id, entry, "solved");
                this.handoff.resumeById(handoffId, `solver:${port.id}`);
                this.activityLog?.recordLifecycle("solver.solved", {
                  profileId: profile.id,
                  actor: `solver:${port.id}`,
                  summary: `${challenge.kind} (interactive)`,
                });
                return { ...entry.record };
              }
              return await settleFailure(
                "failed",
                `Token applied (${applyRes.details ?? "no callback"}), but interactive ${challenge.kind} modal remained open (${interactiveOutcome.reason})`,
                interactiveOutcome.fallbackToHuman,
              );
            }

            return await settleFailure(
              "failed",
              `Token applied (${applyRes.details ?? "no callback"}), but interactive ${challenge.kind} modal remained open`,
            );
          }
        }

        this.finishEntry(profile.id, entry, "solved");
        this.handoff.resumeById(handoffId, `solver:${port.id}`);
        this.activityLog?.recordLifecycle("solver.solved", {
          profileId: profile.id,
          actor: `solver:${port.id}`,
          summary: challenge.kind,
        });
        return { ...entry.record };
      }

      return await settleFailure(outcome.status, outcome.reason, outcome.fallbackToHuman);
    } catch (e) {
      if (!isTaskActive()) return { ...entry.record };
      const msg =
        entry.controller.signal.aborted
          ? `Solver timed out after ${timeoutMs}ms`
          : e instanceof Error
            ? e.message
            : String(e);
      return await settleFailure("failed", msg);
    } finally {
      clearTimeout(timer);
    }
  }

  private finishEntry(
    profileId: ProfileId,
    entry: ActiveTaskEntry,
    status: SolverTaskRecord["status"],
    error?: string,
  ): void {
    if (this.activeByProfile.get(profileId) !== entry) return;
    this.activeByProfile.delete(profileId);
    const now = Date.now();
    entry.record.status = status;
    entry.record.settledAt = new Date(now).toISOString();
    if (error !== undefined) entry.record.error = error;
    this.tombstones.set(entry.record.taskId, {
      record: { ...entry.record },
      endedAtMs: now,
    });
    this.pruneTombstones();
    for (const wake of [...entry.waiters]) wake();
  }

  private pruneTombstones(): void {
    const cutoff = Date.now() - TASK_TOMBSTONE_TTL_MS;
    for (const [id, { endedAtMs }] of this.tombstones) {
      if (endedAtMs > cutoff && this.tombstones.size <= MAX_TASK_TOMBSTONES) break;
      this.tombstones.delete(id);
    }
  }
}
