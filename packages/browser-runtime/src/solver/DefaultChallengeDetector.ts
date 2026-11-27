import type {
  ChallengeDescriptor,
  ChallengeDetectorPort,
  ChallengeFrameInfo,
  ChallengeKind,
  SolverPageReadPort,
} from "@multizen/types";
import { isChallengeKind } from "@multizen/types";

/**
 * Unwraps the evaluation result returned by Chromium CDP (`{ result: { value } }`),
 * Firefox Playwright (`{ result: { value } }`), or a direct mock return value.
 */
export function unwrapEvaluatedValue(raw: unknown): unknown {
  if (raw && typeof raw === "object" && "result" in raw) {
    const inner = (raw as { result?: unknown }).result;
    if (inner && typeof inner === "object" && "value" in inner) {
      return (inner as { value?: unknown }).value;
    }
  }
  return raw;
}

interface RawDetectedChallenge {
  kind: ChallengeKind;
  vendor?: string;
  pageUrl: string;
  pageTitle?: string;
  frame?: ChallengeFrameInfo;
  sitekey?: string;
  action?: string;
  dataS?: string;
  rqdata?: string;
  pagedata?: string;
  enterprise?: boolean;
  invisible?: boolean;
  rawAttributes?: Record<string, string>;
}

/**
 * Pure DOM inspection script executed in the isolated world.
 * Never reads or mutates `window.grecaptcha`, `window.turnstile`, `window.hcaptcha`,
 * or any main-world JS properties.
 */
export const ISOLATED_CHALLENGE_DETECT_SCRIPT = `(() => {
  const pageUrl = location.href;
  const pageTitle = document.title || undefined;

  const readAttrs = (el) => {
    const out = {};
    if (!el || !el.attributes) return out;
    const allow = [
      "id",
      "class",
      "data-sitekey",
      "data-turnstile-sitekey",
      "data-hcaptcha-sitekey",
      "data-action",
      "data-s",
      "data-rqdata",
      "data-pagedata",
      "data-callback",
      "data-size",
      "data-theme",
      "data-gt",
      "data-challenge",
      "data-pkey",
    ];
    for (const name of allow) {
      const val = el.getAttribute(name);
      if (val !== null && val !== "") out[name] = String(val).slice(0, 512);
    }
    return out;
  };

  const rectOf = (el) => {
    if (!el || typeof el.getBoundingClientRect !== "function") return undefined;
    const r = el.getBoundingClientRect();
    if (!r || (r.width === 0 && r.height === 0)) return undefined;
    return {
      x: Math.round(r.x),
      y: Math.round(r.y),
      width: Math.round(r.width),
      height: Math.round(r.height),
    };
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
      return { url: u.href, origin: u.origin, pathname: u.pathname, params };
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
  let rawAttributes = {};

  // 1. Inspect iframes for known challenge providers
  const iframes = Array.from(document.querySelectorAll("iframe"));
  for (const ifr of iframes) {
    const rawSrc = ifr.getAttribute("src") || "";
    if (!rawSrc) continue;
    const parsed = parseUrlParams(rawSrc);
    const srcLower = rawSrc.toLowerCase();
    const bounds = rectOf(ifr);
    let isCrossOrigin = true;
    try {
      isCrossOrigin = parsed ? parsed.origin !== location.origin : true;
    } catch {
      isCrossOrigin = true;
    }

    if (srcLower.includes("challenges.cloudflare.com") || srcLower.includes("turnstile")) {
      kind = "turnstile";
      vendor = "cloudflare-turnstile";
      const match = rawSrc.match(/(0x[0-9a-zA-Z_-]{10,})/);
      if (match) sitekey = match[1];
      frame = { url: parsed ? parsed.url : rawSrc, isCrossOrigin, ...(bounds ? { bounds } : {}) };
      rawAttributes = { ...rawAttributes, ...readAttrs(ifr) };
      break;
    }
    if (srcLower.includes("hcaptcha.com")) {
      kind = "hcaptcha";
      vendor = "hcaptcha";
      sitekey = (parsed && (parsed.params.get("sitekey") || parsed.params.get("id"))) || undefined;
      if (parsed && parsed.params.get("size") === "invisible") invisible = true;
      frame = { url: parsed ? parsed.url : rawSrc, isCrossOrigin, ...(bounds ? { bounds } : {}) };
      rawAttributes = { ...rawAttributes, ...readAttrs(ifr) };
      break;
    }
    if (srcLower.includes("google.com/recaptcha") || srcLower.includes("recaptcha.net/recaptcha")) {
      const isEnt = srcLower.includes("/enterprise");
      const sizeParam = parsed ? parsed.params.get("size") : null;
      const isV3 = sizeParam === "invisible" && srcLower.includes("anchor");
      kind = isV3 ? "recaptcha_v3" : "recaptcha_v2";
      vendor = isEnt ? "google-recaptcha-enterprise" : "google-recaptcha";
      enterprise = isEnt;
      if (sizeParam === "invisible") invisible = true;
      sitekey = (parsed && parsed.params.get("k")) || undefined;
      frame = { url: parsed ? parsed.url : rawSrc, isCrossOrigin, ...(bounds ? { bounds } : {}) };
      rawAttributes = { ...rawAttributes, ...readAttrs(ifr) };
      break;
    }
    if (srcLower.includes("arkoselabs.com") || srcLower.includes("funcaptcha.com")) {
      kind = "arkose";
      vendor = "arkose-funcaptcha";
      sitekey = (parsed && (parsed.params.get("pk") || parsed.params.get("pkey"))) || undefined;
      frame = { url: parsed ? parsed.url : rawSrc, isCrossOrigin, ...(bounds ? { bounds } : {}) };
      rawAttributes = { ...rawAttributes, ...readAttrs(ifr) };
      break;
    }
    if (srcLower.includes("captcha-delivery.com") || srcLower.includes("datadome")) {
      kind = "datadome";
      vendor = "datadome";
      frame = { url: parsed ? parsed.url : rawSrc, isCrossOrigin, ...(bounds ? { bounds } : {}) };
      rawAttributes = { ...rawAttributes, ...readAttrs(ifr) };
      break;
    }
    if (srcLower.includes("geetest.com")) {
      kind = "geetest";
      vendor = "geetest";
      frame = { url: parsed ? parsed.url : rawSrc, isCrossOrigin, ...(bounds ? { bounds } : {}) };
      rawAttributes = { ...rawAttributes, ...readAttrs(ifr) };
      break;
    }
  }

  // 2. Inspect widget containers for sitekey and extra attributes
  const containers = Array.from(
    document.querySelectorAll(
      ".cf-turnstile, .g-recaptcha, .h-captcha, [data-sitekey], [data-turnstile-sitekey], [data-hcaptcha-sitekey], [data-gt], [data-pkey], #challenge-form, #cf-challenge-running"
    )
  );
  for (const el of containers) {
    const attrs = readAttrs(el);
    rawAttributes = { ...attrs, ...rawAttributes };
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

/**
 * Default stealth-safe challenge detector.
 * Runs exclusively in the isolated world of the active tab and merges any caller-supplied hints.
 */
export class DefaultChallengeDetector implements ChallengeDetectorPort {
  async detect(
    page: SolverPageReadPort,
    hint?: Partial<ChallengeDescriptor>,
  ): Promise<ChallengeDescriptor | null> {
    const now = new Date().toISOString();
    let detected: RawDetectedChallenge | null = null;
    try {
      const raw = await page.evaluateIsolatedJs(ISOLATED_CHALLENGE_DETECT_SCRIPT);
      const value = unwrapEvaluatedValue(raw);
      if (typeof value === "string" && value !== "null") {
        const parsed = JSON.parse(value) as RawDetectedChallenge | null;
        if (parsed && isChallengeKind(parsed.kind)) {
          detected = parsed;
        }
      } else if (value && typeof value === "object" && "kind" in value) {
        const obj = value as RawDetectedChallenge;
        if (isChallengeKind(obj.kind)) detected = obj;
      }
    } catch {
      // Fallback to hint if isolated evaluation fails (e.g. blank page or mock driver).
    }

    if (!detected && (!hint || !hint.kind)) {
      return null;
    }

    let fallbackUrl = hint?.pageUrl ?? "about:blank";
    let fallbackTitle = hint?.pageTitle;
    if (!detected && !hint?.pageUrl) {
      try {
        const ext = (await page.extract()) as { result?: { url?: string; title?: string } };
        if (ext?.result?.url) fallbackUrl = ext.result.url;
        if (ext?.result?.title) fallbackTitle = ext.result.title;
      } catch {
        // ignore
      }
    }

    const base: ChallengeDescriptor = {
      kind: hint?.kind && isChallengeKind(hint.kind) ? hint.kind : (detected?.kind ?? "unknown"),
      pageUrl: hint?.pageUrl ?? detected?.pageUrl ?? fallbackUrl,
      detectedAt: now,
      ...(hint?.pageTitle ?? detected?.pageTitle ?? fallbackTitle
        ? { pageTitle: hint?.pageTitle ?? detected?.pageTitle ?? fallbackTitle }
        : {}),
      ...(hint?.vendor ?? detected?.vendor ? { vendor: hint?.vendor ?? detected?.vendor } : {}),
      ...(hint?.frame ?? detected?.frame ? { frame: hint?.frame ?? detected?.frame } : {}),
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
      ...(hint?.rawAttributes || detected?.rawAttributes
        ? { rawAttributes: { ...detected?.rawAttributes, ...hint?.rawAttributes } }
        : {}),
    };
    return base;
  }
}
