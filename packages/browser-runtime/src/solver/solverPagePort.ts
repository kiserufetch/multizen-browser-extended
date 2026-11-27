import {
  MultizenError,
  type ApplyTokenResult,
  type BrowserDriver,
  type BrowserEngine,
  type CapturedFrame,
  type ChallengeFrameInspection,
  type DriverAction,
  type HumanInputEvent,
  type ProfileId,
  type SolverPagePort,
  type SolverTokenPayload,
} from "@multizen/types";
import { unwrapEvaluatedValue } from "./DefaultChallengeDetector.ts";

export interface CreateSolverPagePortOptions {
  profileId: ProfileId;
  engine: BrowserEngine;
  driver: BrowserDriver;
  allowMainWorldJs: boolean;
  /** Returns true while the solver task owns the profile; false once settled or canceled. */
  isActive?: () => boolean;
}

const DEFAULT_TOKEN_SELECTORS = [
  'textarea[name="cf-turnstile-response"]',
  'input[name="cf-turnstile-response"]',
  'textarea[name="g-recaptcha-response"]',
  'textarea[name="h-captcha-response"]',
  'textarea[id*="g-recaptcha-response"]',
  'textarea[id*="h-captcha-response"]',
  'input[name="g-recaptcha-response"]',
  'input[name="h-captcha-response"]',
];

export function buildIsolatedTokenApplyScript(payload: SolverTokenPayload): string {
  const selectors = payload.targetSelector
    ? [payload.targetSelector]
    : DEFAULT_TOKEN_SELECTORS;
  const serialized = JSON.stringify({
    token: payload.token,
    selectors,
    extraFields: payload.extraFields ?? {},
    triggerEvents: payload.triggerCallback !== false,
  });
  return `(() => {
    const cfg = ${serialized};
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
      const nodes = Array.from(document.querySelectorAll(sel));
      for (const el of nodes) {
        setField(el, cfg.token);
        matchedSelectors.push(sel);
      }
    }

    for (const [fieldName, fieldVal] of Object.entries(cfg.extraFields || {})) {
      const nodes = Array.from(
        document.querySelectorAll(
          "input[name=" + JSON.stringify(fieldName) + "], textarea[name=" + JSON.stringify(fieldName) + "]"
        )
      );
      for (const el of nodes) {
        setField(el, String(fieldVal));
        matchedSelectors.push(fieldName);
      }
    }

    let callbackName = null;
    const cbNode = document.querySelector("[data-callback]");
    if (cbNode) callbackName = cbNode.getAttribute("data-callback");

    return JSON.stringify({
      applied: appliedCount > 0,
      appliedCount,
      matchedSelectors,
      callbackName,
    });
  })()`;
}

/**
 * Main-world callback invoker used ONLY when `allowMainWorldJs === true`.
 * First checks the named `[data-callback]` global function; if absent, traverses
 * React Fiber / React Props (`__reactFiber$*`, `__reactProps$*`, `__reactInternalInstance$*`)
 * on the captcha containers and iframe parent chains to invoke `onVerify` / `onSuccess` / `callback`.
 */
export function buildMainWorldCallbackScript(
  token: string,
  callbackName?: string | null,
): string {
  const safeToken = JSON.stringify(token);
  const safeCb =
    callbackName && /^[A-Za-z_$][A-Za-z0-9_$.]*$/.test(callbackName)
      ? JSON.stringify(callbackName)
      : "null";
  return `(() => {
    const token = ${safeToken};
    const cbName = ${safeCb};
    if (cbName) {
      const fn = globalThis[cbName];
      if (typeof fn === "function") {
        fn(token);
        return JSON.stringify({ invoked: true, source: "global:" + cbName });
      }
    }

    const candidates = Array.from(
      document.querySelectorAll(
        'iframe[src*="hcaptcha.com"], iframe[src*="recaptcha"], iframe[src*="turnstile"], iframe[src*="challenges.cloudflare.com"], .h-captcha, .g-recaptcha, .cf-turnstile, [data-sitekey]'
      )
    );
    const propNames = ["onVerify", "onSuccess", "callback", "onChange", "onComplete", "onToken"];
    const visited = new Set();

    const tryPropsObj = (props, label) => {
      if (!props || typeof props !== "object") return null;
      for (const name of propNames) {
        if (typeof props[name] === "function") {
          props[name](token);
          return label + "." + name;
        }
      }
      return null;
    };

    for (const startEl of candidates) {
      let el = startEl;
      for (let depth = 0; el && depth < 10; depth++, el = el.parentElement) {
        if (visited.has(el)) continue;
        visited.add(el);
        const keys = Object.keys(el);
        for (const k of keys) {
          if (k.startsWith("__reactProps$")) {
            const hit = tryPropsObj(el[k], "reactProps");
            if (hit) return JSON.stringify({ invoked: true, source: hit });
          }
          if (k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")) {
            let fiber = el[k];
            for (let fDepth = 0; fiber && fDepth < 12; fDepth++, fiber = fiber.return) {
              const hit = tryPropsObj(fiber.memoizedProps || fiber.pendingProps, "reactFiber");
              if (hit) return JSON.stringify({ invoked: true, source: hit });
            }
          }
        }
      }
    }
    return JSON.stringify({ invoked: false });
  })()`;
}

/**
 * Isolated-world script evaluated inside a child challenge iframe (e.g. `newassets.hcaptcha.com`).
 * Uses `__mzFrameBounds` injected by `CdpSession.evaluateIsolatedJs` / `FirefoxBrowserDriver.evaluateIsolatedJs`
 * to return all tile, canvas, checkbox, and submit button bounds in root-viewport CSS pixels.
 */
export const INSPECT_CHALLENGE_FRAME_SCRIPT = `(() => {
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
    ".prompt-text, .task-prompt, [class*='prompt-text'], h2.prompt-text"
  );
  const promptText =
    promptEl && promptEl.textContent ? promptEl.textContent.trim().replace(/\\s+/g, " ") : undefined;

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

  const tileNodes = Array.from(
    document.querySelectorAll(".task-image, .image-wrapper, [class*='task-image']")
  ).filter(isVisible);

  if (tileNodes.length >= 4) {
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
    document.querySelectorAll(".task-grid canvas, .challenge-container canvas, canvas")
  ).filter((c) => isVisible(c) && c.getBoundingClientRect().width >= 100 && c.getBoundingClientRect().height >= 100);

  if (canvasNodes.length > 0) {
    const canvasEl = canvasNodes[0];
    return JSON.stringify({
      frameBounds,
      ...(promptText ? { promptText } : {}),
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
    isVisible: Boolean(promptText || submitButtonBounds),
  });
})()`;

export function parseChallengeFrameInspection(raw: unknown): ChallengeFrameInspection | null {
  const value = unwrapEvaluatedValue(raw);
  let parsed: ChallengeFrameInspection | null = null;
  if (typeof value === "string" && value !== "null") {
    try {
      parsed = JSON.parse(value) as ChallengeFrameInspection | null;
    } catch {
      return null;
    }
  } else if (value && typeof value === "object" && "frameBounds" in value) {
    parsed = value as ChallengeFrameInspection;
  }
  if (!parsed || !parsed.frameBounds) return null;
  return parsed;
}

export function createSolverPagePort(opts: CreateSolverPagePortOptions): SolverPagePort {
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
    if (driver.evaluateIsolatedJs) {
      return driver.evaluateIsolatedJs(profileId, expression, evalOpts);
    }
    return driver.evaluateJs(profileId, expression);
  };

  const evaluateMainWorldJs = async (expression: string): Promise<unknown> => {
    assertActive();
    if (!allowMainWorldJs) {
      throw new MultizenError(
        "FORBIDDEN",
        "Main-world JS evaluation is disabled for this solver port (allowMainWorldJs is false).",
        {
          hint: "Use evaluateIsolatedJs or applyToken, or enable allowMainWorldJs in solver settings.",
        },
      );
    }
    return driver.evaluateJs(profileId, expression);
  };

  const inspectChallengeFrame = async (
    frameUrlPattern = "hcaptcha.com",
  ): Promise<ChallengeFrameInspection | null> => {
    assertActive();
    try {
      const raw = await evaluateIsolatedJs(INSPECT_CHALLENGE_FRAME_SCRIPT, { frameUrlPattern });
      return parseChallengeFrameInspection(raw);
    } catch {
      return null;
    }
  };

  const captureRegionBase64 = async (bounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): Promise<string> => {
    assertActive();
    if (engine === "cloakbrowser" && bounds && bounds.width > 0 && bounds.height > 0) {
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
        )) as { data?: string } | undefined;
        if (res && typeof res.data === "string" && res.data.length > 0) {
          return res.data;
        }
      } catch {
        // Fall back to full captureFrame below.
      }
    }
    const frame = await driver.captureFrame(profileId, { quality: 85 });
    return Buffer.from(frame.jpeg).toString("base64");
  };

  const applyToken = async (payload: SolverTokenPayload): Promise<ApplyTokenResult> => {
    assertActive();
    const raw = await evaluateIsolatedJs(buildIsolatedTokenApplyScript(payload));
    const value = unwrapEvaluatedValue(raw);
    let parsed: {
      applied: boolean;
      appliedCount?: number;
      matchedSelectors?: string[];
      callbackName?: string | null;
    } = { applied: false };

    if (typeof value === "string") {
      try {
        parsed = JSON.parse(value) as typeof parsed;
      } catch {
        parsed = { applied: false };
      }
    } else if (value && typeof value === "object" && "applied" in value) {
      parsed = value as typeof parsed;
    }

    const textareaUpdated = Boolean(parsed.applied);
    let callbackInvoked = false;
    let callbackSource: string | undefined;

    if (payload.triggerCallback !== false && allowMainWorldJs) {
      try {
        const cbRaw = await driver.evaluateJs(
          profileId,
          buildMainWorldCallbackScript(payload.token, parsed.callbackName),
        );
        const cbVal = unwrapEvaluatedValue(cbRaw);
        if (typeof cbVal === "string") {
          const cbParsed = JSON.parse(cbVal) as {
            invoked?: boolean;
            source?: string;
            targets?: string[];
          };
          callbackInvoked = Boolean(cbParsed.invoked);
          callbackSource = cbParsed.source ?? cbParsed.targets?.join(", ");
        } else if (cbVal === true) {
          callbackInvoked = true;
          callbackSource = parsed.callbackName ?? "mainWorld";
        } else if (cbVal && typeof cbVal === "object" && "invoked" in cbVal) {
          callbackInvoked = Boolean((cbVal as { invoked?: boolean }).invoked);
          callbackSource = (cbVal as { source?: string }).source;
        }
      } catch {
        // Non-fatal if main-world evaluation fails.
      }
    }

    return {
      applied: Boolean(textareaUpdated || callbackInvoked),
      textareaUpdated,
      callbackInvoked,
      details: parsed.matchedSelectors?.length
        ? `Updated ${parsed.matchedSelectors.join(", ")}${
            callbackInvoked ? ` + callback (${callbackSource ?? "invoked"})` : ""
          }`
        : callbackInvoked
          ? `Invoked callback (${callbackSource ?? parsed.callbackName ?? "react"})`
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
    captureRegionBase64,
    inspectChallengeFrame,
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
    applyToken,
  };
}
