import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { ProfileManager } from "@multizen/profile-manager";
import type { DownloadFile, Profile } from "@multizen/types";

import { createPrincipal, type Principal, type ToolGroup } from "./auth/principal.js";
import { createDownloadRoute } from "./downloadRoute.js";
import { HttpTransport } from "./HttpTransport.js";
import { MockBrowserDriver } from "./MockBrowserDriver.js";

const DIR = mkdtempSync(join(tmpdir(), "mz-dlroute-"));
const FILE = join(DIR, "stored.bin");
const CONTENT = "<html><script>alert(1)</script>";

let port = 0;
let http: HttpTransport;

function token(name: string, groups: ToolGroup[], profiles: "*" | string[] = "*"): Principal {
  return createPrincipal({ id: name, name, full: false, tools: { groups, names: [] }, profiles });
}

const TOKENS: Record<string, Principal> = {
  agent: token("agent", ["read", "act"]),
  reader: token("reader", ["read"]),
  scoped: token("scoped", ["act"], ["other"]),
};

const record = (overrides: Partial<DownloadFile>): DownloadFile => ({
  id: "d1",
  fileName: 'отчёт "x".html',
  url: "http://site/x",
  state: "completed",
  bytesReceived: CONTENT.length,
  bytesTotal: CONTENT.length,
  startedAt: "2026-10-31T00:00:00.000Z",
  path: FILE,
  ...overrides,
});

before(async () => {
  writeFileSync(FILE, CONTENT);
  const driver = new MockBrowserDriver();
  driver.downloads.set("p", [
    record({}),
    record({ id: "busy", state: "in_progress", path: null }),
    record({ id: "gone", path: null }),
  ]);
  const profiles = {
    get: (id: string) => (id === "p" || id === "other" ? ({ id } as Profile) : null),
  } as unknown as ProfileManager;

  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  port = (probe.address() as AddressInfo).port;
  await new Promise((resolve) => probe.close(resolve));

  http = new HttpTransport({
    port,
    authenticate: (req) =>
      TOKENS[(req.headers.authorization ?? "").replace(/^Bearer /, "")] ?? null,
    authedRoutes: [createDownloadRoute({ driver, profiles })],
    createServer: () => new Server({ name: "x", version: "0" }, { capabilities: {} }),
  });
  await http.start();
});

after(async () => {
  await http.stop();
  rmSync(DIR, { recursive: true, force: true });
});

function get(
  path: string,
  headers: Record<string, string> = {},
  method = "GET",
): Promise<{ status: number; headers: Record<string, any>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let body = "";
      res.on("data", (c: Buffer) => (body += c.toString("utf8")));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("a bearer token gets the file, as an attachment nothing will render", async () => {
  const res = await get("/files/downloads/p/d1", { authorization: "Bearer agent" });
  assert.equal(res.status, 200);
  assert.equal(res.body, CONTENT);
  assert.equal(res.headers["content-type"], "application/octet-stream");
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.match(res.headers["content-security-policy"], /sandbox/);
  assert.match(res.headers["content-disposition"], /^attachment;/);
  assert.match(res.headers["content-disposition"], /filename\*=UTF-8''/);
  assert.doesNotMatch(res.headers["content-disposition"], /[^\x20-\x7e]/, "a header stays ASCII");
  assert.equal(res.headers["content-length"], String(CONTENT.length));
  assert.equal(res.headers["cache-control"], "no-store");
});

test("no token, a wrong one, or a panel cookie gets nothing", async () => {
  assert.equal((await get("/files/downloads/p/d1")).status, 401);
  assert.equal((await get("/files/downloads/p/d1", { authorization: "Bearer nope" })).status, 401);
  assert.equal((await get("/files/downloads/p/d1", { cookie: "mz_panel=anything" })).status, 401);
});

test("a token without get_download is refused; one outside the profile's scope sees nothing", async () => {
  assert.equal((await get("/files/downloads/p/d1", { authorization: "Bearer reader" })).status, 403);
  assert.equal((await get("/files/downloads/p/d1", { authorization: "Bearer scoped" })).status, 404);
});

test("only a finished file that still exists, under an id the tracker issued", async () => {
  const auth = { authorization: "Bearer agent" };
  assert.equal((await get("/files/downloads/p/busy", auth)).status, 404);
  assert.equal((await get("/files/downloads/p/gone", auth)).status, 404);
  assert.equal((await get("/files/downloads/p/unknown", auth)).status, 404);
  assert.equal((await get("/files/downloads/ghost/d1", auth)).status, 404);
  assert.equal((await get("/files/downloads/p/..%2F..%2Fstored.bin", auth)).status, 404);
  assert.equal((await get("/files/downloads/p/%E0%A4%A", auth)).status, 400);
});

test("only GET", async () => {
  const res = await get("/files/downloads/p/d1", { authorization: "Bearer agent" }, "POST");
  assert.equal(res.status, 405);
});

test("a wrong Host gets no file, whatever the token", async () => {
  const res = await get("/files/downloads/p/d1", { authorization: "Bearer agent", host: "evil.test" });
  assert.notEqual(res.status, 200);
});
