import {
  MultizenError,
  type BrowserDriver,
  type BrowserEngine,
  type CapturedFrame,
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

function buildIsolatedTokenApplyScript(payload: SolverTokenPayload): string {
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

  const evaluateIsolatedJs = async (expression: string): Promise<unknown> => {
    assertActive();
    if (driver.evaluateIsolatedJs) {
      return driver.evaluateIsolatedJs(profileId, expression);
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

  const applyToken = async (
    payload: SolverTokenPayload,
  ): Promise<{ applied: boolean; details?: string }> => {
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

    let callbackInvoked = false;
    if (
      payload.triggerCallback !== false &&
      allowMainWorldJs &&
      parsed.callbackName &&
      /^[A-Za-z_$][A-Za-z0-9_$.]*$/.test(parsed.callbackName)
    ) {
      try {
        await driver.evaluateJs(
          profileId,
          `(() => {
            const fn = globalThis[${JSON.stringify(parsed.callbackName)}];
            if (typeof fn === "function") { fn(${JSON.stringify(payload.token)}); return true; }
            return false;
          })()`,
        );
        callbackInvoked = true;
      } catch {
        // Non-fatal if widget callback is not a top-level function.
      }
    }

    return {
      applied: Boolean(parsed.applied || callbackInvoked),
      details: parsed.matchedSelectors?.length
        ? `Updated ${parsed.matchedSelectors.join(", ")}${callbackInvoked ? " + callback" : ""}`
        : callbackInvoked
          ? `Invoked callback ${parsed.callbackName}`
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
    applyToken,
  };
}
