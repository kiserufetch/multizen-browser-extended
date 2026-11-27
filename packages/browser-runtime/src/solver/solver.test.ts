import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MultizenError, type BrowserDriver, type HumanInputEvent } from "@multizen/types";
import { DefaultChallengeDetector } from "./DefaultChallengeDetector.ts";
import { createSolverPagePort } from "./solverPagePort.ts";
import { loadModuleSolverPort } from "./moduleLoader.ts";
import {
  buildCapSolverTask,
  buildTwoCaptchaTask,
  CapSolverAdapter,
  createCloudProviderSolverPort,
  RuCaptchaAdapter,
  TwoCaptchaAdapter,
} from "./providers/index.ts";

function stubDriver(overrides: Partial<BrowserDriver> = {}): BrowserDriver {
  return {
    launch: async (id) => ({ id, cdpEndpoint: "", pid: 1, startedAt: "" }),
    close: async () => {},
    isRunning: () => true,
    navigate: async (_id, url) => ({ url }),
    click: async () => ({ ok: true }),
    type: async () => ({ ok: true }),
    clickRef: async () => ({ ok: true }),
    typeRef: async () => ({ ok: true }),
    extract: async () => ({ result: { url: "https://example.com/login", title: "Login" } }),
    screenshot: async () => ({ pngBase64: "" }),
    cdpSend: async () => ({}),
    evaluateJs: async () => ({ result: { value: null } }),
    evaluateIsolatedJs: async () => ({ result: { value: null } }),
    getCookies: async () => ({ cookies: [] }),
    setCookies: async () => ({ ok: true }),
    listTabs: async () => ({ targetInfos: [] }),
    newTab: async () => ({ targetId: "t1" }),
    activateTab: async () => ({ ok: true }),
    closeTab: async () => ({ ok: true }),
    performAction: async () => ({ ok: true }),
    listDownloads: async () => [],
    getDownload: async () => null,
    deleteDownload: async () => false,
    setDialogPolicy: async () => ({ ok: true }),
    listDialogs: async () => [],
    handleDialog: async () => ({ ok: true }),
    captureFrame: async () => ({
      jpeg: new Uint8Array([1, 2, 3]),
      viewport: { width: 1280, height: 720 },
      targetId: "t1",
      url: "https://example.com",
    }),
    dispatchInput: async () => {},
    ...overrides,
  };
}

test("DefaultChallengeDetector parses isolated-world detection output and merges hints", async () => {
  const detector = new DefaultChallengeDetector();
  const driver = stubDriver({
    evaluateIsolatedJs: async () => ({
      result: {
        value: JSON.stringify({
          kind: "turnstile",
          vendor: "cloudflare-turnstile",
          pageUrl: "https://example.com/checkout",
          pageTitle: "Verify",
          sitekey: "0x4AAAAAAABBBBB",
          action: "checkout",
        }),
      },
    }),
  });
  const port = createSolverPagePort({
    profileId: "p1",
    engine: "cloakbrowser",
    driver,
    allowMainWorldJs: false,
  });

  const challenge = await detector.detect(port, { rqdata: "rq-123" });
  assert.ok(challenge);
  assert.equal(challenge.kind, "turnstile");
  assert.equal(challenge.sitekey, "0x4AAAAAAABBBBB");
  assert.equal(challenge.action, "checkout");
  assert.equal(challenge.rqdata, "rq-123");
  assert.equal(challenge.pageUrl, "https://example.com/checkout");
});

test("SolverPagePort enforces allowMainWorldJs and active lifecycle guard", async () => {
  let active = true;
  let isolatedCalls = 0;
  let mainCalls = 0;
  const driver = stubDriver({
    evaluateIsolatedJs: async () => {
      isolatedCalls++;
      return {
        result: {
          value: JSON.stringify({
            applied: true,
            appliedCount: 1,
            matchedSelectors: ['textarea[name="cf-turnstile-response"]'],
            callbackName: "onTurnstileSuccess",
          }),
        },
      };
    },
    evaluateJs: async () => {
      mainCalls++;
      return { result: { value: true } };
    },
  });

  const restrictedPort = createSolverPagePort({
    profileId: "p1",
    engine: "cloakbrowser",
    driver,
    allowMainWorldJs: false,
    isActive: () => active,
  });

  await assert.rejects(
    () => restrictedPort.evaluateMainWorldJs("window.secret"),
    (e: unknown) => e instanceof MultizenError && e.code === "FORBIDDEN",
  );
  assert.equal(mainCalls, 0);

  const tokenRes = await restrictedPort.applyToken({ token: "tok_123" });
  assert.equal(tokenRes.applied, true);
  assert.equal(isolatedCalls, 1);
  // Because allowMainWorldJs is false, the main-world callback must NOT be invoked.
  assert.equal(mainCalls, 0);

  // Once the task is settled/inactive, all port calls are rejected.
  active = false;
  await assert.rejects(
    () => restrictedPort.extract(),
    (e: unknown) => e instanceof MultizenError && e.code === "FORBIDDEN",
  );
});

test("loadModuleSolverPort dynamically loads a valid ESM solver module", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mz-solver-mod-"));
  try {
    const modPath = join(dir, "customSolver.mjs");
    writeFileSync(
      modPath,
      `export function createSolverPort(ctx) {
        return {
          id: "custom-esm",
          name: "Custom ESM Solver",
          capabilities: { kinds: ["turnstile"], modes: ["token"] },
          async solve(task) {
            return {
              status: "solved",
              mode: "token",
              tokenPayload: { token: "solved-for-" + task.challenge.sitekey + "-" + (ctx.apiKey || "nokey") }
            };
          }
        };
      }`,
      "utf8",
    );
    const port = await loadModuleSolverPort(modPath, { apiKey: "k99" });
    assert.equal(port.id, "custom-esm");
    assert.deepEqual(port.capabilities.kinds, ["turnstile"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CapSolverAdapter, TwoCaptchaAdapter and RuCaptchaAdapter: createTask -> getTaskResult -> applyToken + healthcheck", async () => {
  const sampleNetwork = {
    profileId: "p1",
    engine: "cloakbrowser" as const,
    fingerprint: {
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/146.0.0.0",
      platform: "Win32" as const,
      clientHints: {
        secChUa: '"Chromium";v="146", "Google Chrome";v="146"',
        secChUaPlatform: "Windows",
        secChUaPlatformVersion: "15.0.0",
        secChUaArch: "x86" as const,
        secChUaBitness: "64" as const,
        secChUaMobile: "?0" as const,
        secChUaModel: "",
        secChUaFullVersionList: '"Chromium";v="146.0.0.0"',
      },
      locale: "en-US",
      languages: ["en-US", "en"],
      acceptLanguage: "en-US,en;q=0.9",
      timezone: "America/New_York",
      screen: { width: 1920, height: 1080 },
      dpr: 1,
    },
     upstreamProxy: {
      type: "socks5" as const,
      host: "198.51.100.10",
      port: 1080,
      username: "u1",
      password: "p1",
    },
  };

  const turnstileChallenge = {
    kind: "turnstile" as const,
    pageUrl: "https://example.com/verify",
    sitekey: "0x4AAAAAAABBBBB",
    action: "login",
    pagedata: "cdata-xyz",
    detectedAt: new Date().toISOString(),
  };

  // Verify task builders for CapSolver & 2Captcha/RuCaptcha
  const capTask = buildCapSolverTask(turnstileChallenge, sampleNetwork);
  assert.deepEqual(capTask, {
    type: "AntiTurnstileTaskProxyLess",
    websiteURL: "https://example.com/verify",
    websiteKey: "0x4AAAAAAABBBBB",
    metadata: { action: "login", cdata: "cdata-xyz" },
  });

  const twoTask = buildTwoCaptchaTask(turnstileChallenge, sampleNetwork);
  assert.deepEqual(twoTask, {
    type: "TurnstileTask",
    websiteURL: "https://example.com/verify",
    websiteKey: "0x4AAAAAAABBBBB",
    action: "login",
    data: "cdata-xyz",
    pagedata: "cdata-xyz",
    userAgent: sampleNetwork.fingerprint.userAgent,
    proxyType: "socks5",
    proxyAddress: "198.51.100.10",
    proxyPort: 1080,
    proxyLogin: "u1",
    proxyPassword: "p1",
  });

  // Test all three providers through their full lifecycle
  for (const kind of ["capsolver", "2captcha", "rucaptcha"] as const) {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    let pollCount = 0;

    const adapter = createCloudProviderSolverPort(kind, {
      apiKey: `key-${kind}`,
      pollIntervalMs: 10,
      fetchImpl: async (url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        calls.push({ url: String(url), body });
        if (String(url).endsWith("/getBalance")) {
          return new Response(JSON.stringify({ errorId: 0, balance: 12.34 }), { status: 200 });
        }
        if (String(url).endsWith("/createTask")) {
          return new Response(
            JSON.stringify({ errorId: 0, taskId: `task-${kind}-1` }),
            { status: 200 },
          );
        }
        if (String(url).endsWith("/getTaskResult")) {
          pollCount++;
          if (pollCount < 2) {
            return new Response(
              JSON.stringify({ errorId: 0, status: "processing" }),
              { status: 200 },
            );
          }
          return new Response(
            JSON.stringify({
              errorId: 0,
              status: "ready",
              solution: { token: `solved-token-${kind}` },
            }),
            { status: 200 },
          );
        }
        throw new Error(`Unexpected URL ${String(url)}`);
      },
    });

    assert.equal(adapter.id, kind);
    const health = await adapter.healthcheck!();
    assert.equal(health.ok, true);
    assert.equal(health.details?.balance, 12.34);

    let appliedToken = "";
    const driver = stubDriver({
      evaluateIsolatedJs: async (_id, expr) => {
        if (expr.includes("solved-token-" + kind)) {
          appliedToken = `solved-token-${kind}`;
        }
        return {
          result: {
            value: JSON.stringify({
              applied: true,
              appliedCount: 1,
              matchedSelectors: ['textarea[name="cf-turnstile-response"]'],
            }),
          },
        };
      },
    });

    const page = createSolverPagePort({
      profileId: "p1",
      engine: "cloakbrowser",
      driver,
      allowMainWorldJs: false,
    });

    const now = Date.now();
    const outcome = await adapter.solve(
      {
        taskId: "t-1",
        profileId: "p1",
        challenge: turnstileChallenge,
        network: sampleNetwork,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 5_000).toISOString(),
      },
      page,
      new AbortController().signal,
    );

    assert.equal(outcome.status, "solved");
    if (outcome.status === "solved") {
      assert.equal(outcome.tokenPayload?.token, `solved-token-${kind}`);
      assert.ok(outcome.notes?.includes(`provider=${kind}`));
    }
    assert.equal(appliedToken, `solved-token-${kind}`);
  }

  assert.ok(new CapSolverAdapter({ apiKey: "k" }) instanceof CapSolverAdapter);
  assert.ok(new TwoCaptchaAdapter({ apiKey: "k" }) instanceof TwoCaptchaAdapter);
  assert.ok(new RuCaptchaAdapter({ apiKey: "k" }) instanceof RuCaptchaAdapter);
});

test("SolverPagePort applyToken discovers React Fiber / __reactProps$ callbacks when allowMainWorldJs is true", async () => {
  let capturedMainWorldScript = "";
  const driver = stubDriver({
    evaluateIsolatedJs: async () => ({
      result: {
        value: JSON.stringify({
          applied: true,
          appliedCount: 1,
          matchedSelectors: ['textarea[name="h-captcha-response"]'],
          callbackName: null,
        }),
      },
    }),
    evaluateJs: async (_id, expr) => {
      capturedMainWorldScript = expr;
      return {
        result: {
          value: JSON.stringify({
            invoked: true,
            targets: ["reactFiber:onVerify"],
          }),
        },
      };
    },
  });

  const port = createSolverPagePort({
    profileId: "p1",
    engine: "cloakbrowser",
    driver,
    allowMainWorldJs: true,
  });

  const res = await port.applyToken({ token: "P1_eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9" });
  assert.equal(res.applied, true);
  assert.equal(res.textareaUpdated, true);
  assert.equal(res.callbackInvoked, true);
  assert.match(res.details ?? "", /reactFiber:onVerify/);
  assert.match(capturedMainWorldScript, /__reactFiber\$/);
  assert.match(capturedMainWorldScript, /__reactProps\$/);
});

test("Interactive visual hCaptcha runner: TwoCaptcha GridTask / CoordinatesTask and CapSolver HCaptchaClassification click tiles and submit", async () => {
  const sampleNetwork = {
    profileId: "p1",
    engine: "cloakbrowser" as const,
    fingerprint: {
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/146.0.0.0",
      platform: "Win32" as const,
      clientHints: {
        secChUa: '"Chromium";v="146", "Google Chrome";v="146"',
        secChUaPlatform: "Windows",
        secChUaPlatformVersion: "15.0.0",
        secChUaArch: "x86" as const,
        secChUaBitness: "64" as const,
        secChUaMobile: "?0" as const,
        secChUaModel: "",
        secChUaFullVersionList: '"Chromium";v="146.0.0.0"',
      },
      locale: "en-US",
      languages: ["en-US", "en"],
      acceptLanguage: "en-US,en;q=0.9",
      timezone: "America/New_York",
      screen: { width: 1280, height: 720 },
      dpr: 1,
    },
  };

  const hcaptchaInteractiveChallenge = {
    kind: "hcaptcha" as const,
    pageUrl: "https://discord.com/register",
    sitekey: "a9b5fb07-92ff-493f-86fe-352a2803b3df",
    frame: {
      url: "https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=challenge",
      isCrossOrigin: true,
      bounds: { x: 440, y: 80, width: 400, height: 600 },
    },
    detectedAt: new Date().toISOString(),
  };

  const makeGridTiles = () =>
    Array.from({ length: 9 }, (_, i) => ({
      index: i,
      x: 460 + (i % 3) * 120,
      y: 200 + Math.floor(i / 3) * 120,
      width: 110,
      height: 110,
    }));

  // 1. TwoCaptcha GridTask (1-based click indices [2, 5, 9]) -> clicks 3 tiles + submit -> modal disappears
  {
    const taskPayloads: Array<Record<string, unknown>> = [];
    const adapter = new TwoCaptchaAdapter({
      apiKey: "2c-key",
      pollIntervalMs: 5,
      interactiveDelayScale: 0,
      fetchImpl: async (url, init) => {
        const body = JSON.parse(String(init?.body)) as { task?: Record<string, unknown> };
        if (String(url).endsWith("/createTask") && body.task) {
          taskPayloads.push(body.task);
          return new Response(
            JSON.stringify({
              errorId: 0,
              taskId: "grid-1",
              status: "ready",
              solution: { click: [2, 5, 9] },
            }),
            { status: 200 },
          );
        }
        throw new Error(`Unexpected URL ${String(url)}`);
      },
    });

    assert.deepEqual(adapter.capabilities.modes, ["token", "interactive"]);

    let inspectedCount = 0;
    const dispatchedInputs: HumanInputEvent[] = [];
    const driver = stubDriver({
      cdpSend: async (_id, method) => {
        if (method === "Page.captureScreenshot") {
          return { data: Buffer.from("fake-cropped-grid-jpeg").toString("base64") };
        }
        return {};
      },
      evaluateIsolatedJs: async (_id, _expr, opts) => {
        if (opts?.frameUrlPattern) {
          inspectedCount++;
          if (inspectedCount === 1) {
            return {
              result: {
                value: JSON.stringify({
                  frameBounds: hcaptchaInteractiveChallenge.frame.bounds,
                  challengeType: "grid",
                  promptText: "Please click each image containing a bicycle",
                  tileBounds: makeGridTiles(),
                  submitButtonBounds: { x: 720, y: 610, width: 90, height: 36 },
                  submitButtonText: "Verify",
                  roundSignature: "round-1",
                  isVisible: true,
                }),
              },
            };
          }
          // After submit, challenge frame is gone!
          return { result: { value: "null" } };
        }
        return { result: { value: "null" } };
      },
      dispatchInput: async (_id, ev) => {
        dispatchedInputs.push(ev);
      },
    });

    const page = createSolverPagePort({
      profileId: "p1",
      engine: "cloakbrowser",
      driver,
      allowMainWorldJs: false,
    });

    const now = Date.now();
    const outcome = await adapter.solve(
      {
        taskId: "t-grid",
        profileId: "p1",
        strategy: "auto",
        challenge: hcaptchaInteractiveChallenge,
        network: sampleNetwork,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 10_000).toISOString(),
      },
      page,
      new AbortController().signal,
    );

    assert.equal(outcome.status, "solved");
    assert.equal(outcome.mode, "interactive");
    assert.equal(taskPayloads.length, 1);
    assert.equal(taskPayloads[0]!.type, "GridTask");
    assert.equal(taskPayloads[0]!.rows, 3);
    assert.equal(taskPayloads[0]!.columns, 3);
    assert.equal(taskPayloads[0]!.comment, "Please click each image containing a bicycle");
    // 3 tiles + 1 submit button = 4 clicks (each click emits move, down, up = 12 events)
    const mouseDowns = dispatchedInputs.filter((e) => e.kind === "mouse" && e.action === "down");
    assert.equal(mouseDowns.length, 4);
  }

  // 2. CapSolver HCaptchaClassification (boolean objects array) + canvas coordinate click
  {
    const capPayloads: Array<Record<string, unknown>> = [];
    const capAdapter = new CapSolverAdapter({
      apiKey: "cs-key",
      pollIntervalMs: 5,
      interactiveDelayScale: 0,
      fetchImpl: async (url, init) => {
        const body = JSON.parse(String(init?.body)) as { task?: Record<string, unknown> };
        if (String(url).endsWith("/createTask") && body.task) {
          capPayloads.push(body.task);
          return new Response(
            JSON.stringify({
              errorId: 0,
              taskId: "cls-1",
              status: "ready",
              solution: {
                objects: [true, false, true, false, false, false, false, false, true],
              },
            }),
            { status: 200 },
          );
        }
        throw new Error(`Unexpected URL ${String(url)}`);
      },
    });

    assert.deepEqual(capAdapter.capabilities.modes, ["token", "interactive"]);

    let round = 0;
    const clicks: Array<{ x?: number; y?: number }> = [];
    const driver = stubDriver({
      cdpSend: async (_id, method) => {
        if (method === "Page.captureScreenshot") {
          return { data: Buffer.from("fake-tile").toString("base64") };
        }
        return {};
      },
      evaluateIsolatedJs: async (_id, _expr, opts) => {
        if (opts?.frameUrlPattern) {
          round++;
          if (round === 1) {
            return {
              result: {
                value: JSON.stringify({
                  frameBounds: hcaptchaInteractiveChallenge.frame.bounds,
                  challengeType: "grid",
                  promptText: "Please click each image containing a motorbus",
                  tileBounds: makeGridTiles(),
                  submitButtonBounds: { x: 720, y: 610, width: 90, height: 36 },
                  submitButtonText: "Verify",
                  roundSignature: "round-1",
                  isVisible: true,
                }),
              },
            };
          }
          return { result: { value: "null" } };
        }
        return { result: { value: "null" } };
      },
      dispatchInput: async (_id, ev) => {
        if (ev.kind === "mouse" && ev.action === "down") {
          clicks.push({ x: ev.x, y: ev.y });
        }
      },
    });

    const page = createSolverPagePort({
      profileId: "p1",
      engine: "cloakbrowser",
      driver,
      allowMainWorldJs: false,
    });

    const now = Date.now();
    const outcome = await capAdapter.solve(
      {
        taskId: "t-cap-cls",
        profileId: "p1",
        strategy: "interactive-only",
        challenge: hcaptchaInteractiveChallenge,
        network: sampleNetwork,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 10_000).toISOString(),
      },
      page,
      new AbortController().signal,
    );

    assert.equal(outcome.status, "solved");
    assert.equal(outcome.mode, "interactive");
    assert.equal(capPayloads.length, 1);
    assert.equal(capPayloads[0]!.type, "HCaptchaClassification");
    assert.equal((capPayloads[0]!.queries as string[]).length, 9);
    // 3 matching tiles (indices 0, 2, 8) + 1 submit click = 4 clicks
    assert.equal(clicks.length, 4);
  }
});
