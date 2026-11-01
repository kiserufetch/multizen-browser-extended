import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChromiumBootstrap } from "@multizen/browser-runtime";
import { createNodeHost } from "./nodeHost.ts";

const BODY = Buffer.from("0123456789");

interface Seen {
  url: string;
  range?: string;
}

/** Serves /file with Range support, and redirects toward it. */
async function startServer(): Promise<{ server: Server; base: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";
    seen.push({ url, range: req.headers.range });
    if (url === "/file") {
      const match = /^bytes=(\d+)-$/.exec(req.headers.range ?? "");
      if (match) {
        const start = Number(match[1]);
        res.writeHead(206, { "content-range": `bytes ${start}-${BODY.length - 1}/${BODY.length}` });
        res.end(BODY.subarray(start));
      } else {
        res.writeHead(200, { "content-length": BODY.length });
        res.end(BODY);
      }
    } else if (url === "/relative") {
      res.writeHead(302, { location: "/file" }).end();
    } else if (url === "/absolute") {
      res.writeHead(301, { location: `http://${req.headers.host}/relative` }).end();
    } else if (url.startsWith("/loop")) {
      res.writeHead(302, { location: `/loop${url.length}` }).end();
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

function fetchBody(
  host: ReturnType<typeof createNodeHost>,
  url: string,
  range?: string,
): Promise<{ status: number; headers: Record<string, unknown>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = host.request({ method: "GET", url, redirect: "follow" });
    if (range) req.setHeader("Range", range);
    req.on("error", reject);
    req.on("response", (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("error", reject);
      res.on("end", () =>
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }),
      );
    });
    req.end();
  });
}

test("the host names the data dir and offers no bundled resources", () => {
  const host = createNodeHost("the-dir");
  assert.equal(host.userDataDir(), "the-dir");
  assert.equal(host.resourceDir("companion"), null);
  assert.equal(host.resourceDir("linux-sandbox"), null);
});

test("request: a plain GET", async () => {
  const { server, base } = await startServer();
  try {
    const res = await fetchBody(createNodeHost("d"), `${base}/file`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, BODY);
  } finally {
    server.close();
  }
});

test("request: follows relative and absolute redirects, keeping Range on every hop", async () => {
  const { server, base, seen } = await startServer();
  try {
    const res = await fetchBody(createNodeHost("d"), `${base}/absolute`, "bytes=4-");
    assert.equal(res.status, 206);
    assert.deepEqual(res.body, BODY.subarray(4));
    assert.equal(res.headers["content-range"], "bytes 4-9/10");
    assert.deepEqual(seen, [
      { url: "/absolute", range: "bytes=4-" },
      { url: "/relative", range: "bytes=4-" },
      { url: "/file", range: "bytes=4-" },
    ]);
  } finally {
    server.close();
  }
});

test("request: gives up after five redirects", async () => {
  const { server, base, seen } = await startServer();
  try {
    await assert.rejects(fetchBody(createNodeHost("d"), `${base}/loop`), /Too many redirects/);
    assert.equal(seen.length, 6);
  } finally {
    server.close();
  }
});

test("request: a connection failure arrives as an error event", async () => {
  const { server, base } = await startServer();
  await new Promise((resolve) => server.close(resolve));
  await assert.rejects(fetchBody(createNodeHost("d"), `${base}/file`), /ECONNREFUSED/);
});

test("fetch answers from the network", async () => {
  const { server, base } = await startServer();
  try {
    const res = await createNodeHost("d").fetch(`${base}/file`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), BODY.toString());
  } finally {
    server.close();
  }
});

test("ChromiumBootstrap resumes a partial download through this host", async () => {
  const { server, base } = await startServer();
  const dir = mkdtempSync(join(tmpdir(), "mz-nodehost-"));
  try {
    const bootstrap = new ChromiumBootstrap({ host: createNodeHost(dir) });
    const outPath = join(dir, "engine.partial");
    writeFileSync(outPath, BODY.subarray(0, 4));
    const download = bootstrap as unknown as {
      downloadAttempt(
        manifest: { version: string; url: string },
        outPath: string,
        allowResume: boolean,
      ): Promise<string>;
    };
    await download.downloadAttempt({ version: "1", url: `${base}/relative` }, outPath, true);
    assert.deepEqual(readFileSync(outPath), BODY);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
