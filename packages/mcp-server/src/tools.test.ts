import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ProfileManager } from "@multizen/profile-manager";
import type { DownloadFile, Profile } from "@multizen/types";

import { InMemoryHumanHandoff } from "./handoff.js";
import { MockBrowserDriver } from "./MockBrowserDriver.js";
import { createMultizenMcpServer } from "./server.js";
import { resolveAllowedFile, safeUploadName, windowsPathProblem } from "./tools/interaction.js";

const DIRS: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mz-tools-"));
  DIRS.push(dir);
  return dir;
}
after(() => {
  for (const dir of DIRS)
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

interface Harness {
  client: Client;
  driver: MockBrowserDriver;
  handoff: InMemoryHumanHandoff;
  dataDir: string;
}

async function connect(
  opts: { uploadsRoot?: string; maxInlineFileBytes?: number; running?: boolean } = {},
): Promise<Harness> {
  const dataDir = tempDir();
  const driver = new MockBrowserDriver();
  if (opts.running !== false) await driver.launch("p");
  const handoff = new InMemoryHumanHandoff();
  const { server } = createMultizenMcpServer({
    profileManager: {
      get: (id: string) => (id === "p" ? ({ id, dataDir } as Profile) : null),
    } as unknown as ProfileManager,
    browserDriver: driver,
    handoff,
    uploadsRoot: opts.uploadsRoot,
    maxInlineFileBytes: opts.maxInlineFileBytes,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, driver, handoff, dataDir };
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; parsed: any }> {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ text: string }>)[0]?.text ?? "";
  return { isError: res.isError === true, parsed: JSON.parse(text) };
}

async function assertCode(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  code: string,
): Promise<any> {
  const { isError, parsed } = await call(client, name, args);
  assert.equal(isError, true, `${name} should have failed: ${JSON.stringify(parsed)}`);
  assert.equal(parsed.error.code, code, JSON.stringify(parsed.error));
  return parsed.error;
}

const b64 = (text: string): string => Buffer.from(text).toString("base64");

// ── interaction ──────────────────────────────────────────────────────────────

test("press_key reaches the driver, with and without a target", async () => {
  const { client, driver } = await connect();
  await call(client, "press_key", { profile_id: "p", key: "Enter" });
  await call(client, "press_key", { profile_id: "p", key: "Control+A", ref: "e1" });
  await call(client, "press_key", { profile_id: "p", key: "Tab", selector: "#a" });
  assert.deepEqual(
    driver.actions.map((a) => a.action),
    [
      { type: "press_key", key: "Enter" },
      { type: "press_key", key: "Control+A", target: { ref: "e1" } },
      { type: "press_key", key: "Tab", target: { selector: "#a" } },
    ],
  );
  await client.close();
});

test("hover, select_option and scroll send one action each", async () => {
  const { client, driver } = await connect();
  await call(client, "hover", { profile_id: "p", ref: "e1" });
  await call(client, "select_option", { profile_id: "p", selector: "#s", label: "Two" });
  await call(client, "select_option", { profile_id: "p", ref: "e2", index: 0 });
  await call(client, "scroll", { profile_id: "p", delta_y: 300 });
  await call(client, "scroll", { profile_id: "p", ref: "e3" });
  assert.deepEqual(
    driver.actions.map((a) => a.action),
    [
      { type: "hover", target: { ref: "e1" } },
      { type: "select_option", target: { selector: "#s" }, label: "Two" },
      { type: "select_option", target: { ref: "e2" }, index: 0 },
      { type: "scroll", deltaY: 300 },
      { type: "scroll", target: { ref: "e3" } },
    ],
  );
  await client.close();
});

test("a target is exactly what the tool asks for", async () => {
  const { client, driver } = await connect();
  const both = { profile_id: "p", ref: "e1", selector: "#a" };
  await assertCode(client, "press_key", { ...both, key: "Enter" }, "INVALID_INPUT");
  await assertCode(client, "hover", both, "INVALID_INPUT");
  await assertCode(client, "hover", { profile_id: "p" }, "INVALID_INPUT");
  await assertCode(client, "scroll", { ...both, delta_y: 1 }, "INVALID_INPUT");
  await assertCode(client, "scroll", { profile_id: "p" }, "INVALID_INPUT");
  await assertCode(client, "select_option", { profile_id: "p", ref: "e1" }, "INVALID_INPUT");
  await assertCode(
    client,
    "select_option",
    { profile_id: "p", ref: "e1", value: "a", index: 1 },
    "INVALID_INPUT",
  );
  await assertCode(client, "press_key", { profile_id: "p", key: "" }, "INVALID_INPUT");
  await assertCode(
    client,
    "upload_file",
    { profile_id: "p", files: [{ file_name: "a" }] },
    "INVALID_INPUT",
  );
  assert.deepEqual(driver.actions, []);
  await client.close();
});

test("the new page tools need a running profile", async () => {
  const { client } = await connect({ running: false });
  const calls: Array<[string, Record<string, unknown>]> = [
    ["press_key", { key: "Enter" }],
    ["hover", { ref: "e1" }],
    ["select_option", { ref: "e1", value: "a" }],
    ["scroll", { delta_y: 1 }],
    ["upload_file", { ref: "e1", files: [{ file_name: "a", data_base64: "" }] }],
    ["list_downloads", {}],
    ["get_download", { download_id: "d" }],
    ["set_dialog_policy", { mode: "manual" }],
    ["list_dialogs", {}],
    ["handle_dialog", { action: "accept" }],
  ];
  for (const [name, args] of calls) {
    await assertCode(client, name, { profile_id: "p", ...args }, "PROFILE_NOT_RUNNING");
  }
  await client.close();
});

// ── upload_file ──────────────────────────────────────────────────────────────

test("base64 lands in the profile's inbox under a uuid, and the driver gets that path", async () => {
  const { client, driver, dataDir } = await connect();
  const { isError, parsed } = await call(client, "upload_file", {
    profile_id: "p",
    ref: "e1",
    files: [{ file_name: "report.pdf", data_base64: b64("hello") }],
  });
  assert.equal(isError, false, JSON.stringify(parsed));
  assert.deepEqual(parsed, { ok: true, files: [{ file_name: "report.pdf", size_bytes: 5 }] });
  assert.equal(JSON.stringify(parsed).includes(dataDir), false, "no host path reaches the agent");

  const action = driver.actions[0]!.action;
  assert.equal(action.type, "upload_file");
  if (action.type !== "upload_file") return;
  assert.deepEqual(action.target, { ref: "e1" });
  const inbox = join(dataDir, "uploads", ".inbox");
  const [name] = readdirSync(inbox);
  assert.match(name!, /^[0-9a-f-]{36}-report\.pdf$/);
  assert.deepEqual(action.paths, [join(inbox, name!)]);
  assert.equal(readFileSync(action.paths[0]!, "utf8"), "hello");
  await client.close();
});

test("a hostile name given with base64 stays inside the inbox", async () => {
  const { client, driver, dataDir } = await connect();
  for (const file_name of [
    "../../../evil.exe",
    "..\\..\\evil.exe",
    "a:b.txt",
    "C:\\x\\y.txt",
    "..",
    "NUL",
  ]) {
    const { isError } = await call(client, "upload_file", {
      profile_id: "p",
      selector: "#f",
      files: [{ file_name, data_base64: b64("x") }],
    });
    assert.equal(isError, false, file_name);
  }
  const inbox = join(dataDir, "uploads", ".inbox");
  assert.equal(readdirSync(inbox).length, 6);
  for (const entry of driver.actions) {
    if (entry.action.type !== "upload_file") continue;
    assert.ok(entry.action.paths[0]!.startsWith(inbox), entry.action.paths[0]);
  }
  assert.deepEqual(readdirSync(dataDir), ["uploads"]);
  await client.close();
});

test("file_name alone reads from the uploads dir, relative or absolute", async () => {
  const { client, driver, dataDir } = await connect();
  const uploads = join(dataDir, "uploads");
  mkdirSync(join(uploads, "sub"), { recursive: true });
  writeFileSync(join(uploads, "sub", "a.txt"), "abc");
  for (const file_name of ["sub/a.txt", join(uploads, "sub", "a.txt")]) {
    const { isError, parsed } = await call(client, "upload_file", {
      profile_id: "p",
      ref: "e1",
      files: [{ file_name }],
    });
    assert.equal(isError, false, JSON.stringify(parsed));
    assert.equal(parsed.files[0].size_bytes, 3);
  }
  assert.equal(driver.actions.length, 2);
  await client.close();
});

test("the configured uploads root works as well, and nothing beyond it", async () => {
  const root = tempDir();
  writeFileSync(join(root, "shared.txt"), "shared");
  const outside = tempDir();
  writeFileSync(join(outside, "secret.txt"), "secret");

  const { client, driver } = await connect({ uploadsRoot: root });
  const ok = await call(client, "upload_file", {
    profile_id: "p",
    ref: "e1",
    files: [{ file_name: "shared.txt" }],
  });
  assert.equal(ok.isError, false, JSON.stringify(ok.parsed));
  await assertCode(
    client,
    "upload_file",
    { profile_id: "p", ref: "e1", files: [{ file_name: join(outside, "secret.txt") }] },
    "FILE_NOT_ALLOWED",
  );
  assert.equal(driver.actions.length, 1);
  await client.close();
});

test("traversal, a missing file and a directory are all FILE_NOT_ALLOWED", async () => {
  const { client, driver, dataDir } = await connect();
  const uploads = join(dataDir, "uploads");
  mkdirSync(join(uploads, "dir"), { recursive: true });
  writeFileSync(join(dataDir, "Cookies"), "secret");
  for (const file_name of [
    "../Cookies",
    "..\\Cookies",
    join(dataDir, "Cookies"),
    "missing.txt",
    "dir",
    ".",
  ]) {
    const error = await assertCode(
      client,
      "upload_file",
      { profile_id: "p", ref: "e1", files: [{ file_name }] },
      "FILE_NOT_ALLOWED",
    );
    assert.equal(String(error.message).includes(uploads), false, "the host path stays private");
  }
  assert.deepEqual(driver.actions, []);
  await client.close();
});

test("a symlink or junction inside the uploads dir can't lead out of it", async () => {
  const { client, dataDir } = await connect();
  const uploads = join(dataDir, "uploads");
  mkdirSync(uploads, { recursive: true });
  const outside = tempDir();
  writeFileSync(join(outside, "secret.txt"), "secret");
  // A junction needs no privilege on Windows; on POSIX this type is ignored.
  symlinkSync(outside, join(uploads, "link"), "junction");
  await assertCode(
    client,
    "upload_file",
    { profile_id: "p", ref: "e1", files: [{ file_name: "link/secret.txt" }] },
    "FILE_NOT_ALLOWED",
  );
  await client.close();
});

test("Windows forms are refused before any path is looked at", async () => {
  for (const name of [
    "\\\\server\\share\\a.txt",
    "//server/share/a.txt",
    "\\\\?\\C:\\a.txt",
    "\\\\.\\pipe\\x",
    "a.txt:stream",
    "a.txt::$DATA",
    "C:\\uploads\\a.txt:stream",
    "CON",
    "nul.txt",
    "sub\\COM1.log",
    "LPT9",
    "COM¹",
    "con .txt",
    "CONOUT$",
    "a.txt.",
    "a.txt ",
  ]) {
    assert.ok(windowsPathProblem(name), name);
    await assert.rejects(
      resolveAllowedFile(name, [tempDir()], "win32"),
      { code: "FILE_NOT_ALLOWED" },
      name,
    );
  }
  for (const name of [
    "a.txt",
    "sub\\a.txt",
    "C:\\uploads\\a.txt",
    "console.txt",
    "..\\a.txt",
    "a..b",
  ]) {
    assert.equal(windowsPathProblem(name), null, name);
  }
});

test("safeUploadName leaves one plain name, keeping the extension of a long one", () => {
  assert.equal(safeUploadName("report.pdf"), "report.pdf");
  assert.equal(safeUploadName("../../evil.exe"), "evil.exe");
  assert.equal(safeUploadName("C:\\x\\y.txt"), "y.txt");
  assert.equal(safeUploadName("a:b*c?.txt"), "a_b_c_.txt");
  assert.equal(safeUploadName("name. "), "name");
  assert.equal(safeUploadName(".hidden"), "hidden");
  assert.equal(safeUploadName(".."), "upload");
  assert.equal(safeUploadName(""), "upload");
  const long = safeUploadName(`${"x".repeat(500)}.pdf`);
  assert.equal(long.length, 120);
  assert.ok(long.endsWith(".pdf"));
});

test("over the limit is FILE_TOO_LARGE, counted across the files, and nothing is written", async () => {
  const { client, driver, dataDir } = await connect({ maxInlineFileBytes: 10 });
  const error = await assertCode(
    client,
    "upload_file",
    {
      profile_id: "p",
      ref: "e1",
      files: [
        { file_name: "a", data_base64: b64("123456") },
        { file_name: "b", data_base64: b64("123456") },
      ],
    },
    "FILE_TOO_LARGE",
  );
  assert.equal(error.details.max_bytes, 10);
  assert.equal(error.retryable, false);
  assert.equal(existsSync(join(dataDir, "uploads")), false);
  assert.deepEqual(driver.actions, []);

  const exact = await call(client, "upload_file", {
    profile_id: "p",
    ref: "e1",
    files: [{ file_name: "a", data_base64: b64("1234567890") }],
  });
  assert.equal(exact.isError, false, JSON.stringify(exact.parsed));
  await client.close();
});

test("one bad file refuses the whole batch before anything is written", async () => {
  const { client, driver, dataDir } = await connect();
  await assertCode(
    client,
    "upload_file",
    {
      profile_id: "p",
      ref: "e1",
      files: [{ file_name: "good", data_base64: b64("x") }, { file_name: "../missing" }],
    },
    "FILE_NOT_ALLOWED",
  );
  await assertCode(
    client,
    "upload_file",
    { profile_id: "p", ref: "e1", files: [{ file_name: "a", data_base64: "not base64!" }] },
    "INVALID_INPUT",
  );
  assert.equal(existsSync(join(dataDir, "uploads")), false);
  assert.deepEqual(driver.actions, []);
  await client.close();
});

test("when the driver refuses the upload, its inbox files go too", async () => {
  const { client, driver, dataDir } = await connect();
  driver.performAction = async () => {
    throw new Error("no such element");
  };
  await assertCode(
    client,
    "upload_file",
    { profile_id: "p", ref: "e1", files: [{ file_name: "a", data_base64: b64("x") }] },
    "INTERNAL_ERROR",
  );
  assert.deepEqual(readdirSync(join(dataDir, "uploads", ".inbox")), []);
  await client.close();
});

// ── downloads ────────────────────────────────────────────────────────────────

function download(overrides: Partial<DownloadFile>): DownloadFile {
  return {
    id: "d1",
    fileName: "a.zip",
    url: "https://example.com/a.zip",
    state: "completed",
    bytesReceived: 5,
    bytesTotal: 5,
    startedAt: "2026-10-31T00:00:00.000Z",
    path: null,
    ...overrides,
  };
}

test("list_downloads and get_download never show a host path", async () => {
  const { client, driver, dataDir } = await connect();
  const path = join(dataDir, "a.zip");
  writeFileSync(path, "hello");
  driver.downloads.set("p", [download({ path })]);

  const list = await call(client, "list_downloads", { profile_id: "p" });
  assert.equal(list.parsed.downloads[0].id, "d1");
  assert.equal("path" in list.parsed.downloads[0], false);

  const got = await call(client, "get_download", { profile_id: "p", download_id: "d1" });
  assert.equal(got.parsed.data_base64, b64("hello"));
  assert.equal(got.parsed.fileName, "a.zip");
  assert.equal("path" in got.parsed, false);
  await client.close();
});

test("get_download: unfinished returns the state, too large and unknown are errors", async () => {
  const { client, driver, dataDir } = await connect({ maxInlineFileBytes: 3 });
  const path = join(dataDir, "big.zip");
  writeFileSync(path, "hello");
  driver.downloads.set("p", [
    download({ id: "busy", state: "in_progress", path: null }),
    download({ id: "big", path }),
  ]);

  const busy = await call(client, "get_download", { profile_id: "p", download_id: "busy" });
  assert.equal(busy.isError, false);
  assert.equal(busy.parsed.state, "in_progress");
  assert.equal("data_base64" in busy.parsed, false);

  const big = await assertCode(
    client,
    "get_download",
    { profile_id: "p", download_id: "big" },
    "FILE_TOO_LARGE",
  );
  assert.deepEqual(big.details, { size_bytes: 5, max_bytes: 3 });

  await assertCode(
    client,
    "get_download",
    { profile_id: "p", download_id: "nope" },
    "INVALID_INPUT",
  );
  await client.close();
});

// ── dialogs ──────────────────────────────────────────────────────────────────

test("set_dialog_policy, list_dialogs and handle_dialog reach the driver", async () => {
  const { client, driver } = await connect();
  const set = await call(client, "set_dialog_policy", {
    profile_id: "p",
    mode: "auto",
    prompt: "accept",
    prompt_text: "yes",
  });
  assert.equal(set.isError, false);
  assert.deepEqual(driver.dialogPolicies.get("p"), {
    mode: "auto",
    prompt: "accept",
    promptText: "yes",
  });

  driver.openDialogs.set("p", [
    { id: "a", type: "alert", message: "first", openedAt: "t" },
    { id: "b", type: "prompt", message: "second", openedAt: "t" },
  ]);
  const listed = await call(client, "list_dialogs", { profile_id: "p" });
  assert.deepEqual(
    listed.parsed.dialogs.map((d: { id: string }) => d.id),
    ["a", "b"],
  );

  await call(client, "handle_dialog", { profile_id: "p", action: "accept", dialog_id: "b" });
  await call(client, "handle_dialog", { profile_id: "p", action: "dismiss" });
  assert.deepEqual(driver.openDialogs.get("p"), []);

  await assertCode(client, "set_dialog_policy", { profile_id: "p", mode: "nope" }, "INVALID_INPUT");
  await assertCode(client, "handle_dialog", { profile_id: "p" }, "INVALID_INPUT");
  await client.close();
});

// ── leases and handoff status ────────────────────────────────────────────────

test("lease tools refuse with a typed error instead of pretending", async () => {
  const { client } = await connect({ running: false });
  const calls: Array<[string, Record<string, unknown>]> = [
    ["acquire_profile", {}],
    ["renew_profile", { lease_id: "l" }],
    ["release_profile", {}],
  ];
  for (const [name, args] of calls) {
    const error = await assertCode(
      client,
      name,
      { profile_id: "p", ...args },
      "UNSUPPORTED_ON_ENGINE",
    );
    assert.equal(error.retryable, false);
    assert.match(String(error.message), new RegExp(name));
    await assertCode(client, name, { profile_id: "ghost", ...args }, "PROFILE_NOT_FOUND");
  }
  await assertCode(client, "renew_profile", { profile_id: "p" }, "INVALID_INPUT");
  await client.close();
});

test("get_human_status reports a pending handoff without blocking", async () => {
  const { client, handoff } = await connect();
  const none = await call(client, "get_human_status", { profile_id: "p" });
  assert.deepEqual(none.parsed, { pending: false, status: "none" });

  handoff.request("p", "solve CAPTCHA");
  const pending = await call(client, "get_human_status", { profile_id: "p" });
  assert.equal(pending.parsed.pending, true);
  assert.equal(pending.parsed.status, "pending");
  assert.equal(pending.parsed.reason, "solve CAPTCHA");
  assert.equal(typeof pending.parsed.since, "string");

  handoff.resume("p");
  const done = await call(client, "get_human_status", { profile_id: "p" });
  assert.equal(done.parsed.pending, false);
  await client.close();
});

// ── the mock's frame and input surface ───────────────────────────────────────

test("the mock implements the frame and input surface of the driver", async () => {
  const driver = new MockBrowserDriver();
  await driver.launch("p");
  const frame = await driver.captureFrame("p");
  assert.equal(frame.jpeg[0], 0xff);
  assert.equal(frame.jpeg[1], 0xd8);
  await driver.dispatchInput("p", { kind: "text", text: "x" });
  assert.equal(driver.humanInput.length, 1);
  assert.ok(driver.runningInfo("p")!.pid > 0);
  assert.equal(driver.runningInfo("nope"), null);
  assert.equal(driver.hasOpenDialog("p"), false);
});
