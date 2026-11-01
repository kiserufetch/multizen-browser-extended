import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { request } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { ProfileManager } from "@multizen/profile-manager";
import { MultizenError, type Profile } from "@multizen/types";

import { ActivityLog } from "../ActivityLog.js";
import { AuthFailureLimiter } from "../auth/AuthFailureLimiter.js";
import { createPrincipal, type Principal, type ToolGroup } from "../auth/principal.js";
import { InMemoryHumanHandoff } from "../handoff.js";
import { HttpTransport } from "../HttpTransport.js";
import { MockBrowserDriver } from "../MockBrowserDriver.js";
import { ProfileMutex } from "../ProfileMutex.js";
import { PANEL_CSS, PANEL_HTML, PANEL_JS } from "./assets.js";
import { createPanelRoute } from "./panelRoutes.js";
import { PanelSessions } from "./panelSessions.js";

const MARKER = "TYPED-MARKER-Пароль-42";

function token(name: string, groups: ToolGroup[], profiles: "*" | string[] = "*"): Principal {
  return createPrincipal({ id: name, name, full: false, tools: { groups, names: [] }, profiles });
}

/** A mock with the things a real browser answers with, on demand. */
class PanelDriver extends MockBrowserDriver {
  frameCalls = 0;
  captureError: unknown = null;
  inputError: unknown = null;
  inputBarrier: Promise<void> | null = null;

  override async captureFrame(profileId: string) {
    this.frameCalls += 1;
    if (this.captureError) throw this.captureError;
    return super.captureFrame(profileId);
  }

  override async dispatchInput(profileId: string, event: Parameters<MockBrowserDriver["dispatchInput"]>[1]) {
    await this.inputBarrier;
    if (this.inputError) throw this.inputError;
    return super.dispatchInput(profileId, event);
  }

  override async listTabs(): Promise<unknown> {
    return {
      targetInfos: [
        { targetId: "T1", type: "page", title: "<b>one</b>", url: "http://site/1" },
        { targetId: "T2", type: "page", title: "popup", url: "http://site/2" },
        { targetId: "W", type: "service_worker", url: "http://site/w.js" },
        { targetId: "PR", type: "page", subtype: "prerender", url: "http://site/pr" },
      ],
      activeTargetId: "T1",
    };
  }

  activated: string[] = [];
  override async activateTab(_p: string, targetId: string): Promise<unknown> {
    if (targetId === "missing") throw new MultizenError("TAB_NOT_FOUND", "no");
    this.activated.push(targetId);
    return {};
  }
}

let port = 0;
let http: HttpTransport;
let driver: PanelDriver;
let handoff: InMemoryHumanHandoff;
let mutex: ProfileMutex;
let sessions: PanelSessions;
let tokens: Map<string, Principal>;
let log: ActivityLog;
let dataDir: string;

const ORIGIN = (): string => `http://127.0.0.1:${port}`;
/** Each test starts past any window of failures an earlier one left. */
const limiterClock = { now: 1_000_000 };

before(async () => {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  port = (probe.address() as AddressInfo).port;
  await new Promise((resolve) => probe.close(resolve));
  dataDir = mkdtempSync(join(tmpdir(), "mz-panel-"));
  handoff = new InMemoryHumanHandoff();
  driver = new PanelDriver();
  mutex = new ProfileMutex();
  sessions = new PanelSessions();
  tokens = new Map();
  log = new ActivityLog();
  http = new HttpTransport({
    port,
    authToken: "mcp-bearer",
    publicRoutes: [
      createPanelRoute({
        handoff,
        driver,
        mutex,
        profiles: {
          get: (id: string) => ({ id, dataDir, name: `name of ${id}` }) as Profile,
        } as unknown as ProfileManager,
        sessions,
        authenticateToken: (value) => tokens.get(value) ?? null,
        principalById: (id) => [...tokens.values()].find((p) => p.id === id) ?? null,
        limiter: new AuthFailureLimiter({ limit: 3, now: () => limiterClock.now }),
        secureCookie: false,
        activityLog: log,
      }),
    ],
    createServer: () => new Server({ name: "x", version: "0" }, { capabilities: {} }),
  });
  await http.start();
});

after(async () => {
  await http.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  limiterClock.now += 120_000;
  for (const p of handoff.pending()) handoff.abortById(p.handoffId);
  tokens.clear();
  tokens.set("op-token", token("op", ["operator"]));
  tokens.set("scoped-token", token("scoped", ["operator"], ["q"]));
  tokens.set("agent-token", token("agent", ["read", "act"]));
  driver.humanInput.length = 0;
  driver.captureError = null;
  driver.inputError = null;
  driver.inputBarrier = null;
  driver.frameCalls = 0;
  await driver.launch("p");
  await driver.launch("q");
});

interface Res {
  status: number;
  headers: Record<string, any>;
  body: Buffer;
  json(): any;
}

function send(
  method: string,
  path: string,
  opts: { cookie?: string; origin?: string | null; type?: string | null; body?: unknown; host?: string } = {},
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const headers: Record<string, string> = {};
    if (opts.cookie) headers.cookie = opts.cookie;
    if (opts.host) headers.host = opts.host;
    if (method === "POST") {
      const origin = opts.origin === undefined ? ORIGIN() : opts.origin;
      const type = opts.type === undefined ? "application/json" : opts.type;
      if (origin) headers.origin = origin;
      if (type) headers["content-type"] = type;
    }
    if (payload !== undefined) headers["content-length"] = String(Buffer.byteLength(payload));
    const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks);
        resolve({
          status: res.statusCode!,
          headers: res.headers,
          body,
          json: () => JSON.parse(body.toString("utf8")),
        });
      });
    });
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function cookieFrom(res: Res): string {
  const header = (res.headers["set-cookie"] as string[])[0]!;
  return header.split(";")[0]!;
}

async function login(tokenValue = "op-token"): Promise<string> {
  const res = await send("POST", "/panel/api/login", { body: { token: tokenValue } });
  assert.equal(res.status, 200, res.body.toString());
  return cookieFrom(res);
}

const input = (cookie: string, id: string, events: unknown[]): Promise<Res> =>
  send("POST", `/panel/api/handoffs/${id}/input`, { cookie, body: { events } });

const key = (action: "down" | "up", code = "KeyA", text?: string) => ({
  kind: "key",
  action,
  key: "a",
  code,
  keyCode: 65,
  modifiers: 0,
  ...(text ? { text } : {}),
});

// ── headers and static assets ────────────────────────────────────────────────

test("everything under /panel carries the strict headers, with no external resource anywhere", async () => {
  for (const path of ["/panel", "/panel/", "/panel/app.js", "/panel/app.css", "/panel/favicon.svg", "/panel/nope", "/panel/api/me"]) {
    const res = await send("GET", path);
    const csp = res.headers["content-security-policy"] as string;
    assert.equal(
      csp,
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      path,
    );
    assert.equal(res.headers["x-content-type-options"], "nosniff", path);
    assert.equal(res.headers["referrer-policy"], "no-referrer", path);
    assert.equal(res.headers["cache-control"], "no-store", path);
  }
  for (const asset of [PANEL_HTML, PANEL_JS, PANEL_CSS]) {
    assert.doesNotMatch(asset, /https?:\/\/(?!www\.w3\.org)/, "nothing is fetched from elsewhere");
    assert.doesNotMatch(asset, /@import|url\(/);
  }
  assert.doesNotMatch(PANEL_HTML, /<style|style=|onclick=|<script>/, "CSP would refuse anything inline");
});

test("the shell holds no data, and needs no sign-in", async () => {
  const { handoff: h } = { handoff };
  const { id } = h.request("p", "SECRET-REASON");
  const page = await send("GET", "/panel");
  assert.equal(page.status, 200);
  assert.match(page.headers["content-type"], /text\/html/);
  assert.doesNotMatch(page.body.toString(), /SECRET-REASON|name of p/);
  const script = await send("GET", "/panel/app.js");
  assert.match(script.headers["content-type"], /javascript/);
  assert.doesNotMatch(script.body.toString(), new RegExp(id));
  h.abortById(id);
});

test("the page's script parses, and puts nothing into the DOM as markup", () => {
  assert.doesNotThrow(() => new Script(PANEL_JS));
  for (const sink of [/innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\.write/, /\beval\(/, /new Function/, /srcdoc/, /\.href\s*=/]) {
    assert.doesNotMatch(PANEL_JS, sink);
  }
  assert.match(PANEL_JS, /textContent/);
});

test("only GET on the static routes; anything else under /panel is 404", async () => {
  assert.equal((await send("POST", "/panel/app.js", { body: {} })).status, 405);
  assert.equal((await send("GET", "/panel/secret")).status, 404);
});

test("a foreign Host never reaches the panel", async () => {
  const res = await send("GET", "/panel", { host: "evil.test" });
  assert.notEqual(res.status, 200);
  assert.doesNotMatch(res.body.toString(), /app\.js/);
});

// ── sign-in ──────────────────────────────────────────────────────────────────

test("a token with operator gets a session cookie with the right flags", async () => {
  const res = await send("POST", "/panel/api/login", { body: { token: "op-token" } });
  assert.equal(res.status, 200);
  assert.equal(res.json().name, "op");
  const [header] = res.headers["set-cookie"] as string[];
  assert.match(header!, /^mz_panel=[A-Za-z0-9_-]{43}; /);
  assert.match(header!, /; HttpOnly/);
  assert.match(header!, /; SameSite=Strict/);
  assert.match(header!, /; Path=\/panel/);
  assert.doesNotMatch(header!, /; Secure/, "over plain HTTP here");
  const me = await send("GET", "/panel/api/me", { cookie: cookieFrom(res) });
  assert.equal(me.status, 200);
});

test("over TLS or an https public URL the cookie is Secure", async () => {
  const route = createPanelRoute({
    handoff,
    driver,
    mutex,
    profiles: { get: () => null } as unknown as ProfileManager,
    sessions: new PanelSessions(),
    authenticateToken: () => token("op", ["operator"]),
    principalById: () => null,
    secureCookie: true,
  });
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const securePort = (probe.address() as AddressInfo).port;
  await new Promise((resolve) => probe.close(resolve));
  const secure = new HttpTransport({
    port: securePort,
    authToken: "x",
    publicRoutes: [route],
    createServer: () => new Server({ name: "x", version: "0" }, { capabilities: {} }),
  });
  await secure.start();
  try {
    const res = await new Promise<Res>((resolve, reject) => {
      const payload = JSON.stringify({ token: "anything" });
      const req = request(
        {
          host: "127.0.0.1",
          port: securePort,
          path: "/panel/api/login",
          method: "POST",
          headers: {
            origin: `http://127.0.0.1:${securePort}`,
            "content-type": "application/json",
            "content-length": String(payload.length),
          },
        },
        (r) => {
          r.resume();
          r.on("end", () =>
            resolve({ status: r.statusCode!, headers: r.headers, body: Buffer.alloc(0), json: () => ({}) }),
          );
        },
      );
      req.on("error", reject);
      req.end(payload);
    });
    assert.match((res.headers["set-cookie"] as string[])[0]!, /; Secure/);
  } finally {
    await secure.stop();
  }
});

test("a token without operator is refused, however valid", async () => {
  const res = await send("POST", "/panel/api/login", { body: { token: "agent-token" } });
  assert.equal(res.status, 403);
  assert.equal(res.headers["set-cookie"], undefined);
});

test("wrong tokens run into the limiter; the right one still gets in", async () => {
  const route = async (body: unknown): Promise<Res> => send("POST", "/panel/api/login", { body });
  const statuses: number[] = [];
  for (let i = 0; i < 5; i++) statuses.push((await route({ token: `wrong-${i}` })).status);
  assert.deepEqual(statuses.slice(0, 3), [401, 401, 401]);
  assert.deepEqual(statuses.slice(3), [429, 429]);
  const limited = await route({ token: "nope" });
  assert.ok(Number(limited.headers["retry-after"]) >= 1);
  assert.equal((await route({ token: "op-token" })).status, 200);
});

test("every POST needs an allowed Origin and a JSON content type", async () => {
  const cookie = await login();
  const { id } = handoff.request("p", "x");
  const paths = [
    "/panel/api/login",
    "/panel/api/logout",
    `/panel/api/handoffs/${id}/input`,
    `/panel/api/handoffs/${id}/resume`,
    `/panel/api/handoffs/${id}/abort`,
    `/panel/api/handoffs/${id}/activate-tab`,
    `/panel/api/handoffs/${id}/dialog`,
    `/panel/api/handoffs/${id}/file-chooser`,
    `/panel/api/handoffs/${id}/take-control`,
  ];
  for (const path of paths) {
    assert.equal((await send("POST", path, { cookie, origin: null, body: {} })).status, 403, `${path} no origin`);
    assert.equal(
      (await send("POST", path, { cookie, origin: "http://evil.test", body: {} })).status,
      403,
      `${path} foreign origin`,
    );
    assert.equal(
      (await send("POST", path, { cookie, type: "text/plain", body: {} })).status,
      415,
      `${path} form-like body`,
    );
    assert.equal(
      (await send("POST", path, { cookie, type: "application/x-www-form-urlencoded", body: {} })).status,
      415,
      path,
    );
  }
  assert.equal(handoff.get(id)?.status, "pending", "none of that did anything");
  handoff.abortById(id);
});

test("a one-time code signs in once, by a redirect that drops it, within its time", async () => {
  const code = sessions.mintCode("op");
  const first = await send("GET", `/panel/login?code=${encodeURIComponent(code)}`);
  assert.equal(first.status, 302);
  assert.equal(first.headers.location, "/panel", "the code is gone from the address");
  const cookie = cookieFrom(first);
  assert.equal((await send("GET", "/panel/api/me", { cookie })).status, 200);

  const again = await send("GET", `/panel/login?code=${encodeURIComponent(code)}`);
  assert.equal(again.status, 302);
  assert.equal(again.headers["set-cookie"], undefined, "one shot");

  const clock = { now: 1_000_000 };
  const local = new PanelSessions({ now: () => clock.now });
  const late = local.mintCode("op");
  clock.now += 60_000;
  assert.equal(local.redeemCode(late), null, "60 s");
  const inTime = local.mintCode("op");
  clock.now += 59_000;
  assert.equal(local.redeemCode(inTime), "op");
});

test("a session ends after 30 idle minutes, and after 8 hours however active", () => {
  const clock = { now: 0 };
  const local = new PanelSessions({ now: () => clock.now });
  const idle = local.create("op");
  clock.now += 29 * 60_000;
  assert.ok(local.find(idle), "still inside");
  clock.now += 29 * 60_000;
  assert.ok(local.find(idle), "activity keeps it going");
  clock.now += 30 * 60_000;
  assert.equal(local.find(idle), null);

  const started = clock.now;
  const active = local.create("op");
  while (clock.now - started < 8 * 3_600_000 - 29 * 60_000) {
    clock.now += 29 * 60_000;
    assert.ok(local.find(active), "activity keeps it going, up to the limit");
  }
  clock.now = started + 8 * 3_600_000;
  assert.equal(local.find(active), null, "absolute limit");
});

test("revoking a token kicks its panel out on the next request, and clears the cookie", async () => {
  const cookie = await login();
  assert.equal((await send("GET", "/panel/api/handoffs", { cookie })).status, 200);
  tokens.delete("op-token");
  const res = await send("GET", "/panel/api/handoffs", { cookie });
  assert.equal(res.status, 401);
  assert.match((res.headers["set-cookie"] as string[])[0]!, /Max-Age=0/);
  tokens.set("op-token", token("op", ["operator"]));
  assert.equal((await send("GET", "/panel/api/handoffs", { cookie })).status, 401, "the session is gone");
});

test("losing the operator group ends the panel too", async () => {
  const cookie = await login();
  tokens.set("op-token", token("op", ["read"]));
  assert.equal((await send("GET", "/panel/api/me", { cookie })).status, 401);
});

test("signing out ends the session", async () => {
  const cookie = await login();
  assert.equal((await send("POST", "/panel/api/logout", { cookie })).status, 200);
  assert.equal((await send("GET", "/panel/api/me", { cookie })).status, 401);
});

test("the cookie authorizes the panel only: not /mcp, not anything else", async () => {
  const cookie = await login();
  assert.equal((await send("POST", "/mcp", { cookie, body: {} })).status, 401);
  assert.equal((await send("GET", "/healthz", { cookie })).status, 401);
});

test("a Bearer token doesn't authorize the panel's API", async () => {
  const res = await new Promise<number>((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path: "/panel/api/handoffs", headers: { authorization: "Bearer mcp-bearer" } },
      (r) => {
        r.resume();
        resolve(r.statusCode!);
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(res, 401);
});

// ── the list, and scope ──────────────────────────────────────────────────────

test("the list shows what's pending, within the token's profiles", async () => {
  const onP = handoff.request("p", "for p", { kind: "captcha" });
  const onQ = handoff.request("q", "for q", { kind: "2fa" });
  const all = (await send("GET", "/panel/api/handoffs", { cookie: await login() })).json();
  assert.deepEqual(all.handoffs.map((h: { id: string }) => h.id).sort(), [onP.id, onQ.id].sort());
  const item = all.handoffs.find((h: { id: string }) => h.id === onP.id);
  assert.equal(item.kind, "captcha");
  assert.equal(item.reason, "for p");
  assert.equal(item.profileName, "name of p");
  assert.equal(typeof item.expiresAt, "string");

  const scoped = (await send("GET", "/panel/api/handoffs", { cookie: await login("scoped-token") })).json();
  assert.deepEqual(scoped.handoffs.map((h: { id: string }) => h.id), [onQ.id]);
});

test("outside a token's profiles a handoff doesn't exist", async () => {
  const { id } = handoff.request("p", "x");
  const cookie = await login("scoped-token");
  for (const [method, action] of [
    ["GET", "frame"],
    ["GET", "state"],
    ["POST", "input"],
    ["POST", "resume"],
    ["POST", "abort"],
  ] as const) {
    const res = await send(method, `/panel/api/handoffs/${id}/${action}`, {
      cookie,
      ...(method === "POST" ? { body: { events: [key("down")] } } : {}),
    });
    assert.equal(res.status, 404, action);
  }
  assert.equal(handoff.get(id)?.status, "pending");
  assert.equal(driver.frameCalls, 0);
  assert.equal(driver.humanInput.length, 0);
});

test("no session, no API", async () => {
  const { id } = handoff.request("p", "x");
  for (const path of ["handoffs", `handoffs/${id}/frame`, `handoffs/${id}/state`, "me"]) {
    assert.equal((await send("GET", `/panel/api/${path}`)).status, 401, path);
  }
  assert.equal((await send("POST", `/panel/api/handoffs/${id}/resume`, { body: {} })).status, 401);
  assert.equal(handoff.get(id)?.status, "pending");
});

// ── frames ───────────────────────────────────────────────────────────────────

test("a frame is a JPEG, sized and uncached, only for a pending handoff", async () => {
  const cookie = await login();
  const { id } = handoff.request("p", "x");
  const res = await send("GET", `/panel/api/handoffs/${id}/frame`, { cookie });
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-type"], "image/jpeg");
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(res.body[0], 0xff);
  assert.equal(res.body[1], 0xd8);
  assert.equal(res.headers["x-frame-width"], "1");

  handoff.resumeById(id);
  const before = driver.frameCalls;
  const gone = await send("GET", `/panel/api/handoffs/${id}/frame`, { cookie });
  assert.equal(gone.status, 409);
  assert.equal(gone.json().status, "resumed");
  assert.equal(driver.frameCalls, before, "nothing is captured for a handoff that's over");
});

test("however fast a client asks, the browser is asked at most five times a second", async () => {
  const cookie = await login();
  const { id } = handoff.request("p", "x");
  await Promise.all(
    Array.from({ length: 10 }, () => send("GET", `/panel/api/handoffs/${id}/frame`, { cookie })),
  );
  assert.equal(driver.frameCalls, 1);
  await new Promise((resolve) => setTimeout(resolve, 220));
  await send("GET", `/panel/api/handoffs/${id}/frame`, { cookie });
  assert.equal(driver.frameCalls, 2);
  handoff.abortById(id);
});

test("no frame is captured with nobody polling", async () => {
  const { id } = handoff.request("p", "x");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(driver.frameCalls, 0);
  handoff.abortById(id);
});

test("DIALOG_OPEN on capture answers with the dialog, for the panel to show", async () => {
  const cookie = await login();
  const { id } = handoff.request("p", "x");
  driver.openDialogs.set("p", [
    { id: "d1", type: "prompt", message: "<img src=x onerror=alert(1)>", openedAt: "now" },
  ]);
  driver.captureError = new MultizenError("DIALOG_OPEN", "a dialog");
  const res = await send("GET", `/panel/api/handoffs/${id}/frame`, { cookie });
  assert.equal(res.status, 423);
  assert.equal(res.json().error, "dialog_open");
  assert.equal(res.json().dialogs[0].message, "<img src=x onerror=alert(1)>");
  driver.openDialogs.delete("p");
  handoff.abortById(id);
});

test("a capture that times out says so, and doesn't take the panel down", async () => {
  const cookie = await login();
  const { id } = handoff.request("p", "x");
  driver.captureError = new MultizenError("TIMEOUT", "stuck");
  assert.equal((await send("GET", `/panel/api/handoffs/${id}/frame`, { cookie })).status, 504);
  driver.captureError = new Error("private detail");
  const other = await send("GET", `/panel/api/handoffs/${id}/frame`, { cookie });
  assert.equal(other.status, 500);
  assert.doesNotMatch(other.body.toString(), /private detail/);
  handoff.abortById(id);
});

// ── input ────────────────────────────────────────────────────────────────────

test("input reaches the driver in order; non-ASCII text arrives whole", async () => {
  const cookie = await login();
  const { id } = handoff.request("p", "x");
  const res = await input(cookie, id, [
    { kind: "mouse", action: "move", x: 0.5, y: 0.5, button: "none", buttons: 0 },
    { kind: "mouse", action: "down", x: 0.5, y: 0.5, button: "left", buttons: 1, clickCount: 1 },
    { kind: "mouse", action: "up", x: 0.5, y: 0.5, button: "left", buttons: 0, clickCount: 1 },
    { kind: "wheel", x: 0.5, y: 0.5, deltaX: 0, deltaY: 120 },
    { kind: "text", text: "Привет 你好 🎉" },
    { kind: "key", action: "down", key: "Enter", code: "Enter", keyCode: 13, modifiers: 0, text: "\r" },
    { kind: "key", action: "up", key: "Enter", code: "Enter", keyCode: 13, modifiers: 0 },
  ]);
  assert.equal(res.status, 200);
  const events = driver.humanInput.map((i) => i.event);
  assert.deepEqual(events.map((e) => e.kind), ["mouse", "mouse", "mouse", "wheel", "text", "key", "key"]);
  assert.equal((events[4] as { text: string }).text, "Привет 你好 🎉");
  handoff.abortById(id);
});

test("malformed input is refused whole, and what it held isn't echoed", async () => {
  const cookie = await login();
  const { id } = handoff.request("p", "x");
  for (const bad of [
    { events: [] },
    { events: [{ kind: "mouse", action: "move", x: 2, y: 0, button: "none", buttons: 0 }] },
    { events: [{ kind: "script", code: MARKER }] },
    { events: Array.from({ length: 300 }, () => key("down")) },
    { nope: true },
  ]) {
    const res = await send("POST", `/panel/api/handoffs/${id}/input`, { cookie, body: bad });
    assert.equal(res.status, 400);
    assert.doesNotMatch(res.body.toString(), new RegExp(MARKER));
  }
  assert.equal(driver.humanInput.length, 0);
  handoff.abortById(id);
});

test("input for a handoff that's over is 409 and reaches nothing", async () => {
  const cookie = await login();
  for (const end of ["resumeById", "abortById"] as const) {
    const { id } = handoff.request("p", "x");
    handoff[end](id);
    const res = await input(cookie, id, [key("down")]);
    assert.equal(res.status, 409);
    assert.equal(res.json().error, "not_pending");
  }
  assert.equal(driver.humanInput.length, 0);
});

test("input waits its turn behind an agent's operation, under the same lock", async () => {
  const cookie = await login();
  const { id } = handoff.request("p", "x");
  let open = (): void => {};
  const holding = mutex.run(
    "p",
    () =>
      new Promise<void>((resolve) => {
        open = resolve;
      }),
  );
  const pending = input(cookie, id, [key("down")]);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(driver.humanInput.length, 0, "nothing lands in the middle of it");
  open();
  await holding;
  assert.equal((await pending).status, 200);
  assert.equal(driver.humanInput.length, 1);
  handoff.abortById(id);
});

test("expiry while a person is mid-input: nothing queued fires after, and nothing stays pressed", async () => {
  const shortLived = new InMemoryHumanHandoff({ defaultTtlMs: 60 });
  const localDriver = new PanelDriver();
  await localDriver.launch("p");
  const localMutex = new ProfileMutex();
  const localSessions = new PanelSessions();
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const localPort = (probe.address() as AddressInfo).port;
  await new Promise((resolve) => probe.close(resolve));
  const local = new HttpTransport({
    port: localPort,
    authToken: "x",
    publicRoutes: [
      createPanelRoute({
        handoff: shortLived,
        driver: localDriver,
        mutex: localMutex,
        profiles: { get: () => ({ dataDir, name: "n" }) } as unknown as ProfileManager,
        sessions: localSessions,
        authenticateToken: () => null,
        principalById: () => token("op", ["operator"]),
        secureCookie: false,
      }),
    ],
    createServer: () => new Server({ name: "x", version: "0" }, { capabilities: {} }),
  });
  await local.start();
  const post = (path: string, cookie: string, body: unknown): Promise<number> =>
    new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const req = request(
        {
          host: "127.0.0.1",
          port: localPort,
          path,
          method: "POST",
          headers: {
            cookie,
            origin: `http://127.0.0.1:${localPort}`,
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(payload)),
          },
        },
        (r) => {
          r.resume();
          r.on("end", () => resolve(r.statusCode!));
        },
      );
      req.on("error", reject);
      req.end(payload);
    });
  try {
    const cookie = `mz_panel=${localSessions.create("op")}`;
    const { id } = shortLived.request("p", "x");
    // A key goes down, and a click is on its way, behind an agent's operation.
    assert.equal(await post(`/panel/api/handoffs/${id}/input`, cookie, { events: [key("down", "ShiftLeft")] }), 200);
    let open = (): void => {};
    const holding = localMutex.run(
      "p",
      () =>
        new Promise<void>((resolve) => {
          open = resolve;
        }),
    );
    const queued = post(`/panel/api/handoffs/${id}/input`, cookie, {
      events: [{ kind: "mouse", action: "down", x: 0.1, y: 0.1, button: "left", buttons: 1, clickCount: 1 }],
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(shortLived.get(id)?.status, "expired");
    open();
    await holding;
    assert.equal(await queued, 409, "it saw the handoff had ended when its turn came");
    await new Promise((resolve) => setTimeout(resolve, 30));

    const events = localDriver.humanInput.map((i) => i.event);
    assert.deepEqual(
      events.map((e) => (e.kind === "key" ? `${e.kind} ${e.action}` : `${e.kind} ${(e as { action?: string }).action}`)),
      ["key down", "key up"],
      "the key came back up, and the click never fired",
    );
    assert.equal(await post(`/panel/api/handoffs/${id}/input`, cookie, { events: [key("down")] }), 409);
  } finally {
    await local.stop();
  }
});

test("a handoff ending with a button down lets it go, before an agent can act", async () => {
  const cookie = await login();
  const { id } = handoff.request("p", "x");
  const down = { kind: "mouse", action: "down", x: 0.2, y: 0.3, button: "left", buttons: 1, clickCount: 1 };
  assert.equal((await input(cookie, id, [down])).status, 200);
  handoff.resumeById(id);
  await mutex.run("p", async () => {
    const events = driver.humanInput.map((i) => i.event);
    assert.equal(events.length, 2, "the release got in line first");
    assert.deepEqual(events[1], { ...down, action: "up", buttons: 0 });
  });
});

test("one input owner at a time; another can take control, and the owner is recorded", async () => {
  const alice = await login();
  tokens.set("bob-token", token("bob", ["operator"]));
  const bob = await login("bob-token");
  const { id } = handoff.request("p", "x");
  log.removeAllListeners();

  assert.equal((await input(alice, id, [key("down")])).status, 200);
  const refused = await input(bob, id, [key("down", "KeyB")]);
  assert.equal(refused.status, 409);
  assert.equal(refused.json().error, "input_owned");
  assert.equal(refused.json().owner, "op");

  const state = (await send("GET", `/panel/api/handoffs/${id}/state`, { cookie: bob })).json();
  assert.equal(state.otherOwner, "op");
  const own = (await send("GET", `/panel/api/handoffs/${id}/state`, { cookie: alice })).json();
  assert.equal(own.otherOwner, null);

  assert.equal((await send("POST", `/panel/api/handoffs/${id}/take-control`, { cookie: bob, body: {} })).status, 200);
  assert.equal(driver.humanInput.at(-1)?.event.kind, "key", "the old owner's key is let go");
  assert.equal((driver.humanInput.at(-1)!.event as { action: string }).action, "up");
  assert.equal((await input(bob, id, [key("down", "KeyB")])).status, 200);
  assert.equal((await input(alice, id, [key("down")])).status, 409);

  const lifecycle = log.recent().filter((e) => e.tool === "handoff.control");
  assert.deepEqual(lifecycle.slice(-2).map((e) => e.actor), ["op", "bob"]);
  handoff.abortById(id);
});

test("input hits an open dialog: 423, with the dialog", async () => {
  const cookie = await login();
  const { id } = handoff.request("p", "x");
  driver.openDialogs.set("p", [{ id: "d1", type: "alert", message: "hi", openedAt: "now" }]);
  driver.inputError = new MultizenError("DIALOG_OPEN", "a dialog");
  const res = await input(cookie, id, [key("down")]);
  assert.equal(res.status, 423);
  assert.equal(res.json().dialogs[0].id, "d1");
  driver.openDialogs.delete("p");
  handoff.abortById(id);
});

// ── state, tabs, dialogs, files ──────────────────────────────────────────────

test("state lists real tabs with the active one, leaving out workers and prerenders", async () => {
  const cookie = await login();
  const { id } = handoff.request("p", "x");
  const state = (await send("GET", `/panel/api/handoffs/${id}/state`, { cookie })).json();
  assert.deepEqual(
    state.tabs.map((t: { targetId: string; active: boolean }) => [t.targetId, t.active]),
    [
      ["T1", true],
      ["T2", false],
    ],
  );
  assert.equal(state.tabs[0].title, "<b>one</b>", "as data: the page puts it in the DOM as text");
  handoff.abortById(id);
});

test("activate-tab switches, says when a tab is gone, and 409s once the handoff is over", async () => {
  const cookie = await login();
  const { id } = handoff.request("p", "x");
  const path = `/panel/api/handoffs/${id}/activate-tab`;
  assert.equal((await send("POST", path, { cookie, body: { target_id: "T2" } })).status, 200);
  assert.deepEqual(driver.activated.slice(-1), ["T2"]);
  assert.equal((await send("POST", path, { cookie, body: { target_id: "missing" } })).status, 404);
  handoff.resumeById(id);
  assert.equal((await send("POST", path, { cookie, body: { target_id: "T2" } })).status, 409);
});

test("a dialog is answered with its prompt text, which goes nowhere else", async () => {
  const cookie = await login();
  const { id } = handoff.request("p", "x");
  driver.openDialogs.set("p", [{ id: "d1", type: "prompt", message: "name?", openedAt: "now" }]);
  const state = (await send("GET", `/panel/api/handoffs/${id}/state`, { cookie })).json();
  assert.equal(state.dialogs[0].message, "name?");
  const res = await send("POST", `/panel/api/handoffs/${id}/dialog`, {
    cookie,
    body: { dialog_id: "d1", action: "accept", prompt_text: MARKER },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(driver.openDialogs.get("p"), []);
  assert.doesNotMatch(JSON.stringify(log.recent()), new RegExp(MARKER));
  handoff.abortById(id);
});

test("a file goes to the inbox under a safe name, by upload_file's rules, and to the chooser", async () => {
  const cookie = await login();
  const { id } = handoff.request("p", "x");
  const chooser = { id: "c1", multiple: false, targetId: "T1", openedAt: "now" };
  driver.fileChoosers.set("p", [chooser]);
  assert.deepEqual(
    (await send("GET", `/panel/api/handoffs/${id}/state`, { cookie })).json().fileChoosers,
    [chooser],
  );
  const path = `/panel/api/handoffs/${id}/file-chooser`;
  const data = Buffer.from("file body").toString("base64");
  assert.equal(
    (await send("POST", path, {
      cookie,
      body: { chooser_id: "c1", files: [{ file_name: "a.txt", data_base64: data }, { file_name: "b.txt", data_base64: data }] },
    })).status,
    400,
    "a single-file chooser takes one",
  );
  assert.equal(
    (await send("POST", path, {
      cookie,
      body: { chooser_id: "c1", files: [{ file_name: "x", data_base64: "not base64!" }] },
    })).status,
    400,
  );
  const res = await send("POST", path, {
    cookie,
    body: { chooser_id: "c1", files: [{ file_name: "..\\..\\evil.txt", data_base64: data }] },
  });
  assert.equal(res.status, 200);
  const [answer] = driver.chooserAnswers;
  assert.equal(answer!.chooserId, "c1");
  const stored = answer!.paths[0]!;
  assert.ok(stored.startsWith(join(dataDir, "uploads", ".inbox")), stored);
  assert.equal(stored.split(/[\\/]/).pop(), "evil.txt");
  assert.equal(readFileSync(stored, "utf8"), "file body");
  assert.ok(statSync(stored).isFile());

  driver.fileChoosers.set("p", [chooser]);
  assert.equal((await send("POST", path, { cookie, body: { chooser_id: "c1", cancel: true } })).status, 200);
  assert.deepEqual(driver.fileChoosers.get("p"), []);
  assert.equal(
    (await send("POST", path, { cookie, body: { chooser_id: "nope", files: [{ file_name: "x", data_base64: data }] } })).status,
    400,
  );
  handoff.abortById(id);
});

test("too large a file is 413, and nothing is written", async () => {
  const route = createPanelRoute({
    handoff,
    driver,
    mutex,
    profiles: { get: () => ({ dataDir, name: "n" }) } as unknown as ProfileManager,
    sessions,
    authenticateToken: () => null,
    principalById: () => token("op", ["operator"]),
    secureCookie: false,
    maxUploadBytes: 4,
  });
  assert.equal(typeof route, "function");
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const localPort = (probe.address() as AddressInfo).port;
  await new Promise((resolve) => probe.close(resolve));
  const local = new HttpTransport({
    port: localPort,
    authToken: "x",
    publicRoutes: [route],
    createServer: () => new Server({ name: "x", version: "0" }, { capabilities: {} }),
  });
  await local.start();
  try {
    const { id } = handoff.request("p", "x");
    driver.fileChoosers.set("p", [{ id: "c1", multiple: false, targetId: "T1", openedAt: "now" }]);
    const before = driver.chooserAnswers.length;
    const payload = JSON.stringify({
      chooser_id: "c1",
      files: [{ file_name: "x", data_base64: Buffer.alloc(32).toString("base64") }],
    });
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: localPort,
          path: `/panel/api/handoffs/${id}/file-chooser`,
          method: "POST",
          headers: {
            cookie: `mz_panel=${sessions.create("op")}`,
            origin: `http://127.0.0.1:${localPort}`,
            "content-type": "application/json",
            "content-length": String(payload.length),
          },
        },
        (r) => {
          r.resume();
          resolve(r.statusCode!);
        },
      );
      req.on("error", reject);
      req.end(payload);
    });
    assert.equal(status, 413);
    assert.equal(driver.chooserAnswers.length, before);
    handoff.abortById(id);
  } finally {
    await local.stop();
  }
});

// ── resume, abort, actors ────────────────────────────────────────────────────

test("Resume and Abort end the handoff with who did it; a second press is 409", async () => {
  const cookie = await login();
  for (const [action, status] of [
    ["resume", "resumed"],
    ["abort", "aborted"],
  ] as const) {
    const { id } = handoff.request("p", "x");
    const path = `/panel/api/handoffs/${id}/${action}`;
    assert.equal((await send("POST", path, { cookie, body: {} })).status, 200);
    const record = handoff.get(id)!;
    assert.equal(record.status, status);
    assert.equal(record.settledBy, "op");
    assert.equal((await send("POST", path, { cookie, body: {} })).status, 409);
  }
});

test("an unknown handoff is 404", async () => {
  const cookie = await login();
  assert.equal((await send("GET", "/panel/api/handoffs/nope/frame", { cookie })).status, 404);
});

// ── what never gets written down ─────────────────────────────────────────────

test("input, frames and typed text never reach the activity log or this process's output", async () => {
  const written: string[] = [];
  const realStdout = process.stdout.write.bind(process.stdout);
  const realStderr = process.stderr.write.bind(process.stderr);
  const spy = (real: typeof process.stdout.write) =>
    ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      written.push(String(chunk));
      return (real as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write;
  process.stdout.write = spy(realStdout);
  process.stderr.write = spy(realStderr);
  try {
    const cookie = await login();
    const { id } = handoff.request("p", "x");
    await input(cookie, id, [
      { kind: "text", text: MARKER },
      { kind: "key", action: "down", key: "ф", code: "KeyA", keyCode: 65, modifiers: 0, text: MARKER.slice(0, 8) },
    ]);
    const frame = await send("GET", `/panel/api/handoffs/${id}/frame`, { cookie });
    await send("POST", `/panel/api/handoffs/${id}/dialog`, {
      cookie,
      body: { action: "accept", prompt_text: MARKER },
    });
    const everything = JSON.stringify(log.recent()) + written.join("");
    assert.doesNotMatch(everything, new RegExp(MARKER));
    assert.doesNotMatch(everything, new RegExp(frame.body.toString("base64").slice(0, 32).replace(/[+/]/g, ".")));
    handoff.abortById(id);
  } finally {
    process.stdout.write = realStdout;
    process.stderr.write = realStderr;
  }
});

test("the panel's server code has no logging of its own to leak through", () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts") || file === "assets.ts") continue;
    const source = readFileSync(join(dir, file), "utf8");
    assert.doesNotMatch(source, /console\.\w|process\.std(out|err)|\blog\.(debug|info|warn|error)/, file);
  }
  const route = readFileSync(join(dir, "panelRoutes.ts"), "utf8");
  // The one activity record it writes carries the profile and the actor, nothing else.
  const records = [...route.matchAll(/recordLifecycle\(([\s\S]*?)\);/g)].map((m) => m[1]!);
  assert.equal(records.length, 1);
  assert.doesNotMatch(records[0]!, /event|text|frame|jpeg|body/);
});
