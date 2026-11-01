import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostHttpRequest, RuntimeHost } from "./host.ts";
import { ChromiumBootstrap, windowsTarPath } from "./ChromiumBootstrap.ts";
import { CamoufoxBootstrap } from "./CamoufoxBootstrap.ts";
import { EngineRegistry } from "./engineRegistry.ts";
import { companionDir } from "./extensions/companion.ts";
import { downloadCrxById } from "./extensions/webstoreDownload.ts";
import { cacheDirForEngine, runInstall } from "./linuxSandbox.ts";

function fakeHost(overrides: Partial<RuntimeHost> = {}): RuntimeHost {
  return {
    userDataDir: () => "fake-user-data",
    resourceDir: () => null,
    fetch: () => {
      throw new Error("fetch not expected");
    },
    request: () => {
      throw new Error("request not expected");
    },
    ...overrides,
  };
}

function withTempDir<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "mz-host-"));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

/** A `request` that answers with one scripted response, recording what it was asked. */
function scriptedRequest(reply: {
  statusCode: number;
  headers?: Record<string, string>;
  body?: Buffer;
}): {
  request: RuntimeHost["request"];
  calls: { opts: unknown; headers: Record<string, string> }[];
} {
  const calls: { opts: unknown; headers: Record<string, string> }[] = [];
  const request: RuntimeHost["request"] = (opts) => {
    const call = { opts, headers: {} as Record<string, string> };
    calls.push(call);
    const req = new EventEmitter() as EventEmitter & HostHttpRequest;
    req.setHeader = (name, value) => {
      call.headers[name] = value;
    };
    req.end = () => {
      setImmediate(() => {
        const res = Object.assign(new EventEmitter(), {
          statusCode: reply.statusCode,
          headers: reply.headers ?? {},
        });
        req.emit("response", res);
        setImmediate(() => {
          if (reply.body) res.emit("data", reply.body);
          res.emit("end");
        });
      });
    };
    return req;
  };
  return { request, calls };
}

test("companionDir: null when the host has no such resource", () => {
  const asked: string[] = [];
  const host = fakeHost({
    resourceDir: (name) => {
      asked.push(name);
      return null;
    },
  });
  assert.equal(companionDir(host), null);
  assert.deepEqual(asked, ["companion"]);
});

test("companionDir: null when the resource has no manifest", async () => {
  await withTempDir((dir) => {
    assert.equal(companionDir(fakeHost({ resourceDir: () => dir })), null);
  });
});

test("companionDir: the host's dir when the manifest is there", async () => {
  await withTempDir((dir) => {
    writeFileSync(join(dir, "manifest.json"), "{}");
    assert.equal(companionDir(fakeHost({ resourceDir: () => dir })), dir);
  });
});

test("cacheDirForEngine lives under the host's user data dir", () => {
  assert.equal(
    cacheDirForEngine(fakeHost({ userDataDir: () => "root" })),
    join("root", "chromium", "cloakbrowser"),
  );
});

test("runInstall: no-script when the host has no sandbox resource", async () => {
  const asked: string[] = [];
  const host = fakeHost({
    resourceDir: (name) => {
      asked.push(name);
      return null;
    },
  });
  assert.deepEqual(await runInstall("/attach", host), { ok: false, reason: "no-script" });
  assert.deepEqual(asked, ["linux-sandbox"]);
});

test("runInstall: no-script when the resource dir lacks the installer", async () => {
  await withTempDir(async (dir) => {
    const host = fakeHost({ resourceDir: () => dir });
    assert.deepEqual(await runInstall("/attach", host), { ok: false, reason: "no-script" });
  });
});

test("EngineRegistry passes its host to the bootstraps it creates", async () => {
  await withTempDir(async (dir) => {
    const cache = join(dir, "chromium", "cloakbrowser");
    mkdirSync(join(cache, "1.2.3"), { recursive: true });
    writeFileSync(join(cache, "1.2.3", "chrome"), "");
    writeFileSync(
      join(cache, "current.json"),
      JSON.stringify({ version: "1.2.3", binaryRelative: "chrome" }),
    );

    const registry = new EngineRegistry(fakeHost({ userDataDir: () => dir }));
    assert.ok(registry.get("cloakbrowser") instanceof ChromiumBootstrap);
    assert.ok(registry.get("camoufox") instanceof CamoufoxBootstrap);

    // A cached engine resolves entirely from the host's dir: no network call.
    const status = await registry.ensure("cloakbrowser");
    assert.deepEqual(status, {
      kind: "ready",
      version: "1.2.3",
      binaryPath: join(cache, "1.2.3", "chrome"),
    });
  });
});

test("ChromiumBootstrap downloads through host.request and resumes with Range", async () => {
  await withTempDir(async (dir) => {
    const { request, calls } = scriptedRequest({
      statusCode: 206,
      headers: { "content-range": "bytes 4-7/8" },
      body: Buffer.from("5678"),
    });
    const bootstrap = new ChromiumBootstrap({ host: fakeHost({ userDataDir: () => dir, request }) });
    const outPath = join(dir, "engine.partial");
    writeFileSync(outPath, "1234");

    const download = bootstrap as unknown as {
      downloadAttempt(
        manifest: { version: string; url: string },
        outPath: string,
        allowResume: boolean,
      ): Promise<string>;
    };
    await download.downloadAttempt({ version: "1", url: "https://example.test/e" }, outPath, true);

    assert.equal(readFileSync(outPath, "utf8"), "12345678");
    assert.deepEqual(calls[0]?.opts, {
      method: "GET",
      url: "https://example.test/e",
      redirect: "follow",
    });
    assert.deepEqual(calls[0]?.headers, { Range: "bytes=4-" });
  });
});

test("downloadCrxById writes the body fetched through host.request", async () => {
  const body = Buffer.alloc(32, 7);
  const { request, calls } = scriptedRequest({ statusCode: 200, body });
  const path = await downloadCrxById("a".repeat(32), "146.0.0.0", fakeHost({ request }));
  try {
    assert.deepEqual(readFileSync(path), body);
    const opts = calls[0]?.opts as { method: string; url: string; redirect: string };
    assert.equal(opts.method, "GET");
    assert.equal(opts.redirect, "follow");
    assert.match(opts.url, /prodversion=146\.0\.0\.0/);
  } finally {
    rmSync(path, { force: true });
  }
});

test("downloadCrxById surfaces a non-2xx from host.request", async () => {
  const { request } = scriptedRequest({ statusCode: 500 });
  await assert.rejects(
    downloadCrxById("a".repeat(32), "146.0.0.0", fakeHost({ request })),
    /HTTP 500/,
  );
});

test("the engine zip on Windows goes to Windows' own tar, by path: PATH may find Git's first", () => {
  assert.equal(windowsTarPath({ SystemRoot: "D:\\Win" }), "D:\\Win\\System32\\tar.exe");
  assert.equal(windowsTarPath({}), "C:\\Windows\\System32\\tar.exe");
});
