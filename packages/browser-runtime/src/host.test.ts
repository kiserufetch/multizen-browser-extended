import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostHttpRequest, RuntimeHost } from "./host.ts";
import { ChromiumBootstrap, pinnedCloakBrowserManifest, windowsTarPath } from "./ChromiumBootstrap.ts";
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

const PIN = pinnedCloakBrowserManifest();

test("every hash a server trusts is a whole sha-256, of a pin that is known", () => {
  for (const asset of [
    "cloakbrowser-windows-x64.zip",
    "cloakbrowser-linux-x64.tar.gz",
    "cloakbrowser-darwin-arm64.tar.gz",
    "cloakbrowser-darwin-x64.tar.gz",
  ]) {
    const manifest = pinnedCloakBrowserManifest(asset);
    assert.match(manifest.sha256, /^[0-9a-f]{64}$/, asset);
    assert.match(manifest.url, new RegExp(`^https://github\\.com/CloakHQ/CloakBrowser/releases/download/chromium-v${manifest.version.replaceAll(".", "\\.")}/${asset}$`));
  }
});

test("a pinned install fails closed on a platform with no verified build", () => {
  // That release has no such asset, so nothing could be checked against it.
  assert.throws(() => pinnedCloakBrowserManifest("cloakbrowser-linux-arm64.tar.gz"), /no pinned, verified/);
  assert.throws(() => pinnedCloakBrowserManifest("cloakbrowser-plan9.zip"), /no pinned, verified/);
});

function pinnedBootstrap(dir: string, reply: { statusCode: number; body?: Buffer }): {
  bootstrap: ChromiumBootstrap;
  calls: Array<{ opts: unknown; headers: Record<string, string> }>;
} {
  const { request, calls } = scriptedRequest(reply);
  return {
    calls,
    bootstrap: new ChromiumBootstrap({
      engine: "cloakbrowser",
      host: fakeHost({ userDataDir: () => dir, request }),
      pinned: true,
      retryDelayMs: 0,
    }),
  };
}

test("a pinned install asks for the pin, and a download that doesn't match leaves nothing installed", async () => {
  await withTempDir(async (dir) => {
    const fetched: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((url: string) => {
      fetched.push(String(url));
      throw new Error("a pinned install asks nobody what is newest");
    }) as typeof fetch;
    try {
      const { bootstrap, calls } = pinnedBootstrap(dir, { statusCode: 200, body: Buffer.from("not the engine") });
      await assert.rejects(bootstrap.ensure(), /checksum mismatch.*expected 4a12bcde95fa|checksum mismatch.*expected b213795cb32c|checksum mismatch/);
      assert.deepEqual(fetched, []);
      assert.equal((calls[0]!.opts as { url: string }).url, PIN.url);
      assert.equal(calls.length, 5, "retried, as any download is");
      const status = bootstrap.getStatus();
      assert.equal(status.kind, "error");
      assert.match((status as { message: string }).message, /checksum mismatch/);
      assert.equal(existsSync(join(dir, "chromium", "cloakbrowser", "current.json")), false);
      assert.equal(existsSync(join(dir, "chromium", "cloakbrowser", PIN.version)), false);
      assert.throws(() => bootstrap.resolveBinaryPath());
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

function plantInstall(dir: string, fields: { version: string; sha256?: string }): string {
  const cache = join(dir, "chromium", "cloakbrowser");
  mkdirSync(join(cache, fields.version), { recursive: true });
  writeFileSync(join(cache, fields.version, "chrome"), "");
  writeFileSync(join(cache, "current.json"), JSON.stringify({ ...fields, binaryRelative: "chrome" }));
  return join(cache, fields.version, "chrome");
}

test("an install of the pin, with its hash on record, is taken as it is", async () => {
  await withTempDir(async (dir) => {
    const binaryPath = plantInstall(dir, { version: PIN.version, sha256: PIN.sha256 });
    const { bootstrap, calls } = pinnedBootstrap(dir, { statusCode: 500 });
    assert.deepEqual(await bootstrap.ensure(), { kind: "ready", version: PIN.version, binaryPath });
    assert.deepEqual(calls, []);
  });
});

for (const [name, fields] of [
  ["another version", { version: "999.0.0.0", sha256: PIN.sha256 }],
  ["no hash on record", { version: PIN.version }],
  ["another hash", { version: PIN.version, sha256: "0".repeat(64) }],
] as const) {
  test(`a pinned install doesn't run what an earlier one left: ${name}`, async () => {
    await withTempDir(async (dir) => {
      plantInstall(dir, fields);
      const { bootstrap, calls } = pinnedBootstrap(dir, { statusCode: 404 });
      await assert.rejects(bootstrap.ensure(), /HTTP 404/);
      assert.equal((calls[0]!.opts as { url: string }).url, PIN.url);
    });
  });
}

test("an unpinned bootstrap, a desktop's, still takes whatever it has installed", async () => {
  await withTempDir(async (dir) => {
    const binaryPath = plantInstall(dir, { version: "1.2.3" });
    const bootstrap = new ChromiumBootstrap({ engine: "cloakbrowser", host: fakeHost({ userDataDir: () => dir }) });
    assert.deepEqual(await bootstrap.ensure(), { kind: "ready", version: "1.2.3", binaryPath });
  });
});

test("EngineRegistry hands `pinned` to the Chromium bootstrap", async () => {
  await withTempDir(async (dir) => {
    plantInstall(dir, { version: "1.2.3" });
    const { request } = scriptedRequest({ statusCode: 404 });
    const registry = new EngineRegistry(fakeHost({ userDataDir: () => dir, request }), { pinned: true });
    (registry.getChromiumBootstrap("cloakbrowser") as unknown as { retryDelayMs: number }).retryDelayMs = 0;
    await assert.rejects(registry.ensure("cloakbrowser"), /HTTP 404/);
  });
});
