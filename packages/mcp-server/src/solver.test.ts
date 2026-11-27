import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ProfileManager } from "@multizen/profile-manager";
import type {
  CaptchaSolverPort,
  SolverNetworkContext,
  SolverOutcome,
  SolverSettings,
  SolverTask,
} from "@multizen/types";
import { MockBrowserDriver } from "./MockBrowserDriver.js";
import { createMultizenMcpServer } from "./server.js";
import { createSharedMcpState } from "./sharedState.js";
import {
  createSolverRoute,
  HttpWebhookSolverAdapter,
  SolverWebhookSessions,
} from "./solver/HttpWebhookSolverAdapter.js";
import { HttpTransport } from "./HttpTransport.js";

function withTempProfiles(
  run: (pm: ProfileManager, dir: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "mz-solver-test-"));
  const pm = new ProfileManager({
    dbPath: join(dir, "profiles.db"),
    profilesRoot: join(dir, "profiles"),
  });
  return run(pm, dir).finally(() => {
    pm.close();
    rmSync(dir, { recursive: true, force: true });
  });
}

async function callToolJson(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; data: Record<string, unknown> }> {
  const res = await client.callTool({ name, arguments: args });
  const text = ((res.content as Array<{ type: string; text?: string }>)[0]?.text ?? "{}") as string;
  return {
    isError: Boolean(res.isError),
    data: JSON.parse(text) as Record<string, unknown>,
  };
}

test("ProxyExposureMode policy: bridge exposes local SOCKS5 bridge without raw proxy credentials", async () => {
  await withTempProfiles(async (pm) => {
    const profile = pm.create({
      name: "proxied-profile",
      proxy: {
        type: "socks5",
        host: "proxy.example.net",
        port: 1080,
        username: "secret_user",
        password: "top_secret_password",
      },
    });
    const driver = new MockBrowserDriver();
    await driver.launch(profile.id);

    const seenNetworks: SolverNetworkContext[] = [];
    const mockPort: CaptchaSolverPort = {
      id: "mock-port",
      name: "Mock Port",
      capabilities: { kinds: ["turnstile", "unknown"], modes: ["token"] },
      solve: async (task: SolverTask): Promise<SolverOutcome> => {
        seenNetworks.push(task.network);
        return {
          status: "solved",
          mode: "token",
          tokenPayload: { token: "tok_ok" },
        };
      },
    };

    let currentExposure: SolverSettings["proxyExposure"] = "bridge";
    const shared = createSharedMcpState();
    const { server } = createMultizenMcpServer({
      profileManager: pm,
      browserDriver: driver,
      shared,
      solverPort: mockPort,
      solverSettings: () => ({
        enabled: true,
        adapter: "module",
        fallbackPolicy: "solver-then-human",
        proxyExposure: currentExposure,
        allowMainWorldJs: false,
        timeoutMs: 30_000,
      }),
      getBridgeInfo: (id) => ({
        type: "socks5",
        host: "127.0.0.1",
        port: 55111,
        url: `socks5://127.0.0.1:55111`,
      }),
    });

    const [cTrans, sTrans] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1.0.0" });
    await server.connect(sTrans);
    await client.connect(cTrans);

    // 1. Default "bridge": bridgeProxy is provided, upstreamProxy (with password) is absent.
    const r1 = await callToolJson(client, "solve_captcha", {
      profile_id: profile.id,
      kind: "turnstile",
      sitekey: "0x4AAA",
    });
    assert.equal(r1.isError, false);
    assert.equal(r1.data.status, "solved");
    assert.equal(seenNetworks.length, 1);
    assert.equal(seenNetworks[0]!.bridgeProxy?.url, "socks5://127.0.0.1:55111");
    assert.equal(seenNetworks[0]!.upstreamProxy, undefined);
    assert.doesNotMatch(JSON.stringify(seenNetworks[0]), /top_secret_password/);

    // 2. "raw": upstreamProxy is provided alongside bridgeProxy.
    currentExposure = "raw";
    const r2 = await callToolJson(client, "solve_captcha", {
      profile_id: profile.id,
      kind: "turnstile",
      sitekey: "0x4AAA",
    });
    assert.equal(r2.isError, false);
    assert.equal(seenNetworks[1]!.upstreamProxy?.password, "top_secret_password");

    // 3. "none": neither bridgeProxy nor upstreamProxy is exposed.
    currentExposure = "none";
    await callToolJson(client, "solve_captcha", {
      profile_id: profile.id,
      kind: "turnstile",
      sitekey: "0x4AAA",
    });
    assert.equal(seenNetworks[2]!.bridgeProxy, undefined);
    assert.equal(seenNetworks[2]!.upstreamProxy, undefined);

    await client.close();
  });
});

test("request_human(kind:'captcha') routes through solver port first, suppresses human webhook on solve, and falls back to human on failure", async () => {
  await withTempProfiles(async (pm) => {
    const profile = pm.create({ name: "handoff-solver" });
    const driver = new MockBrowserDriver();
    await driver.launch(profile.id);

    let nextOutcome: SolverOutcome = {
      status: "solved",
      mode: "token",
      tokenPayload: { token: "auto-solved-token" },
    };
    const mockPort: CaptchaSolverPort = {
      id: "auto-solver",
      name: "Auto Solver",
      capabilities: { kinds: ["turnstile", "unknown"], modes: ["token"] },
      solve: async () => nextOutcome,
    };

    const shared = createSharedMcpState();
    const humanNotifiedIds: string[] = [];
    shared.handoff.onChange((pending) => {
      for (const item of pending) {
        if (!item.solverActive && !humanNotifiedIds.includes(item.handoffId)) {
          humanNotifiedIds.push(item.handoffId);
        }
      }
    });

    const { server } = createMultizenMcpServer({
      profileManager: pm,
      browserDriver: driver,
      shared,
      handoffGate: true,
      solverPort: mockPort,
      solverSettings: {
        enabled: true,
        adapter: "module",
        fallbackPolicy: "solver-then-human",
        proxyExposure: "bridge",
        allowMainWorldJs: false,
        timeoutMs: 30_000,
      },
    });

    const [cTrans, sTrans] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1.0.0" });
    await server.connect(sTrans);
    await client.connect(cTrans);

    // Case 1: Solver succeeds -> handoff settles as resumed by solver:auto-solver, human never notified.
    const req1 = await callToolJson(client, "request_human", {
      profile_id: profile.id,
      kind: "captcha",
      reason: "Turnstile on login",
    });
    assert.equal(req1.isError, false);
    assert.equal(req1.data.solver_active, true);
    const handoffId1 = String(req1.data.handoff_id);

    const wait1 = await callToolJson(client, "wait_for_human", {
      profile_id: profile.id,
      handoff_id: handoffId1,
      timeout_ms: 5_000,
    });
    assert.equal(wait1.isError, false);
    assert.equal(wait1.data.resumed, true);
    assert.equal(wait1.data.settled_by, "solver:auto-solver");
    assert.equal(humanNotifiedIds.includes(handoffId1), false);

    // Case 2: Solver fails -> seamlessly transitions same handoffId to human waiting and fires human notification.
    nextOutcome = {
      status: "failed",
      reason: "Upstream solver balance zero",
    };
    const req2 = await callToolJson(client, "request_human", {
      profile_id: profile.id,
      kind: "captcha",
      reason: "Arkose challenge",
    });
    const handoffId2 = String(req2.data.handoff_id);

    // Give the background transition a tick to settle into human fallback.
    await new Promise((r) => setTimeout(r, 40));

    const status2 = await callToolJson(client, "get_human_status", {
      profile_id: profile.id,
      handoff_id: handoffId2,
    });
    assert.equal(status2.data.status, "pending");
    assert.equal(status2.data.solver_active, false);
    assert.equal(status2.data.solver_fallback_reason, "Upstream solver balance zero");
    assert.equal(humanNotifiedIds.includes(handoffId2), true);

    // While pending for human (or solver), agent page writes are blocked with HUMAN_IN_CONTROL.
    const clickDuringHandoff = await callToolJson(client, "click", {
      profile_id: profile.id,
      selector: "#submit",
    });
    assert.equal(clickDuringHandoff.isError, true);
    assert.equal((clickDuringHandoff.data.error as { code?: string })?.code, "HUMAN_IN_CONTROL");

    await client.close();
  });
});

test("HttpWebhookSolverAdapter and /solver/v1/tasks/:taskId/* interactive callback flow + ephemeral token revocation", async () => {
  await withTempProfiles(async (pm) => {
    const profile = pm.create({ name: "webhook-profile" });
    const driver = new MockBrowserDriver();
    await driver.launch(profile.id);

    const sessions = new SolverWebhookSessions();
    const shared = createSharedMcpState();
    let baseUrl = "http://127.0.0.1:0";
    let capturedSessionToken = "";
    let capturedTaskEndpoint = "";

    const adapter = new HttpWebhookSolverAdapter({
      webhookUrl: "https://solver.example.test/hook",
      webhookSecret: "hmac-secret-123",
      callbackBaseUrl: () => baseUrl,
      sessions,
      fetchImpl: async (_url, init) => {
        const payload = JSON.parse(String(init?.body)) as {
          endpoints: { baseUrl: string; sessionToken: string };
        };
        capturedTaskEndpoint = payload.endpoints.baseUrl;
        capturedSessionToken = payload.endpoints.sessionToken;

        // Drive the interactive callback routes asynchronously as an external microservice would.
        setImmediate(async () => {
          const authHeader = {
            authorization: `Bearer ${capturedSessionToken}`,
            "content-type": "application/json",
          };
          const frameRes = await fetch(`${capturedTaskEndpoint}/frame?format=json`, {
            headers: { authorization: `Bearer ${capturedSessionToken}` },
          });
          assert.equal(frameRes.status, 200);

          const inputRes = await fetch(`${capturedTaskEndpoint}/input`, {
            method: "POST",
            headers: authHeader,
            body: JSON.stringify({
              kind: "mouse",
              action: "down",
              x: 0.5,
              y: 0.5,
              button: "left",
              buttons: 1,
            }),
          });
          assert.equal(inputRes.status, 200);

          const settleRes = await fetch(`${capturedTaskEndpoint}/settle`, {
            method: "POST",
            headers: authHeader,
            body: JSON.stringify({
              status: "solved",
              mode: "interactive",
            }),
          });
          assert.equal(settleRes.status, 200);
        });

        return new Response(JSON.stringify({ status: "accepted" }), { status: 202 });
      },
    });

    const createServer = () =>
      createMultizenMcpServer({
        profileManager: pm,
        browserDriver: driver,
        shared,
        solverPort: adapter,
        solverSettings: {
          enabled: true,
          adapter: "webhook",
          webhookUrl: "https://solver.example.test/hook",
          fallbackPolicy: "solver-only",
          proxyExposure: "bridge",
          allowMainWorldJs: false,
          timeoutMs: 15_000,
        },
      }).server;

    const port = await new Promise<number>((resolve, reject) => {
      const s = createNetServer();
      s.once("error", reject);
      s.listen(0, "127.0.0.1", () => {
        const addr = s.address();
        const p = typeof addr === "object" && addr ? addr.port : 0;
        s.close(() => resolve(p));
      });
    });
    baseUrl = `http://127.0.0.1:${port}`;
    const transport = new HttpTransport({
      port,
      host: "127.0.0.1",
      authToken: "owner-secret",
      createServer,
      publicRoutes: [createSolverRoute(sessions)],
    });
    await transport.start();

    try {
      const mcpServer = createServer();
      const [cTrans, sTrans] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "t", version: "1.0.0" });
      await mcpServer.connect(sTrans);
      await client.connect(cTrans);

      const solveRes = await callToolJson(client, "solve_captcha", {
        profile_id: profile.id,
        kind: "turnstile",
      });
      assert.equal(solveRes.isError, false);
      assert.equal(solveRes.data.status, "solved");
      assert.equal(driver.humanInput.length, 1);

      // Once settled, the ephemeral sessionToken must be immediately revoked (401).
      const afterSettleRes = await fetch(`${capturedTaskEndpoint}/frame`, {
        headers: { authorization: `Bearer ${capturedSessionToken}` },
      });
      assert.equal(afterSettleRes.status, 401);

      await client.close();
    } finally {
      await transport.stop();
    }
  });
});

test("Zero-preconfig MCP self-service: configure_solver, get_solver_balance, get_solver_status, and inline solve_captcha", async () => {
  await withTempProfiles(async (pm) => {
    const profile = pm.create({ name: "zero-preconfig-profile" });
    const driver = new MockBrowserDriver();
    await driver.launch(profile.id);

    const apiCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const shared = createSharedMcpState({
      solverOptions: {
        fetchImpl: async (url, init) => {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          apiCalls.push({ url: String(url), body });
          if (String(url).endsWith("/getBalance")) {
            return new Response(
              JSON.stringify({
                errorId: 0,
                balance: body.clientKey === "ru-inline-key" ? 500.25 : 42.75,
              }),
              { status: 200 },
            );
          }
          if (String(url).endsWith("/createTask")) {
            return new Response(
              JSON.stringify({
                errorId: 0,
                taskId: "t-cloud-1",
                status: "ready",
                solution: { token: `tok-for-${String(body.clientKey)}` },
              }),
              { status: 200 },
            );
          }
          throw new Error(`Unexpected URL ${String(url)}`);
        },
      },
    });

    // Notice: createMultizenMcpServer is started with ZERO solver pre-configuration!
    const { server } = createMultizenMcpServer({
      profileManager: pm,
      browserDriver: driver,
      shared,
    });
    const [cTrans, sTrans] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1.0.0" });
    await server.connect(sTrans);
    await client.connect(cTrans);

    // 1. Inspect global status without profile_id -> initially unconfigured
    const initialStatus = await callToolJson(client, "get_solver_status", {});
    assert.equal(initialStatus.isError, false);
    assert.equal(initialStatus.data.scope, "global");
    assert.equal(initialStatus.data.configured, false);

    // 2. Check ad-hoc balance on RuCaptcha before saving anything
    const adHocBalance = await callToolJson(client, "get_solver_balance", {
      adapter: "rucaptcha",
      api_key: "ru-inline-key",
    });
    assert.equal(adHocBalance.isError, false);
    assert.equal(adHocBalance.data.ok, true);
    assert.equal(adHocBalance.data.adapter_id, "rucaptcha");
    assert.equal(adHocBalance.data.balance, 500.25);

    // 3. Configure global CapSolver via MCP with verify: true
    const cfgRes = await callToolJson(client, "configure_solver", {
      adapter: "capsolver",
      api_key: "cs-global-key",
      fallback_policy: "solver-then-human",
      verify: true,
    });
    assert.equal(cfgRes.isError, false);
    assert.equal(cfgRes.data.scope, "global");
    assert.equal(cfgRes.data.configured, true);
    assert.equal(cfgRes.data.adapter_id, "capsolver");
    assert.equal(cfgRes.data.has_api_key, true);
    // Secret key must never be echoed back
    assert.equal("api_key" in cfgRes.data, false);
    assert.equal((cfgRes.data.health as { balance?: number })?.balance, 42.75);

    // 4. Solve CAPTCHA using the newly configured global CapSolver
    const solveGlobal = await callToolJson(client, "solve_captcha", {
      profile_id: profile.id,
      kind: "turnstile",
      sitekey: "0x4AAAAAAABBBBB",
    });
    assert.equal(solveGlobal.isError, false);
    assert.equal(solveGlobal.data.status, "solved");
    assert.equal(solveGlobal.data.adapter_id, "capsolver");

    // 5. Solve CAPTCHA with an inline one-shot 2Captcha provider & key override
    const solveInline = await callToolJson(client, "solve_captcha", {
      profile_id: profile.id,
      kind: "recaptcha_v2",
      sitekey: "6Lc_sitekey",
      adapter: "2captcha",
      api_key: "2c-oneshot-key",
    });
    assert.equal(solveInline.isError, false);
    assert.equal(solveInline.data.status, "solved");
    assert.equal(solveInline.data.adapter_id, "2captcha");

    // 6. Configure per-profile RuCaptcha override via configure_solver({ profile_id })
    const profCfg = await callToolJson(client, "configure_solver", {
      profile_id: profile.id,
      adapter: "rucaptcha",
      api_key: "ru-inline-key",
      verify: true,
    });
    assert.equal(profCfg.isError, false);
    assert.equal(profCfg.data.scope, "profile");
    assert.equal(profCfg.data.adapter_id, "rucaptcha");
    assert.equal((profCfg.data.health as { balance?: number })?.balance, 500.25);

    const profBalance = await callToolJson(client, "get_solver_balance", {
      profile_id: profile.id,
    });
    assert.equal(profBalance.data.adapter_id, "rucaptcha");
    assert.equal(profBalance.data.balance, 500.25);

    await client.close();
  });
});
