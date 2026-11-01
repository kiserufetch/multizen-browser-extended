import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PAGES_DIR = fileURLToPath(new URL("../pages/", import.meta.url));

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".ico": "image/x-icon",
};

/**
 * Asks for what a server has to ask for: without this the high-entropy Client Hints
 * only reach it through script. Same as the headless spike's.
 */
const ACCEPT_CH =
  "sec-ch-ua-full-version-list,sec-ch-ua-platform-version,sec-ch-ua-arch,sec-ch-ua-bitness,sec-ch-ua-model,sec-ch-ua-wow64,device-memory,dpr,viewport-width";

export interface CapturedRequest {
  path: string;
  httpVersion: string;
  /** In the order the browser sent them, with this site's port taken out of the values. */
  headers: Array<[string, string]>;
}

/** A tree of files under a URL prefix. `rewrite` changes what's served, never what's on disk. */
export interface Mount {
  prefix: string;
  dir: string;
  rewrite?: (file: string, text: string) => string;
}

export interface LocalSite {
  port: number;
  origin: string;
  url(path: string): string;
  /** Every request so far for this exact path, query left out. */
  requestsFor(path: string): CapturedRequest[];
  /** Adds a tree of files to the site. */
  mount(mount: Mount): void;
  close(): Promise<void>;
}

function capture(req: IncomingMessage, port: number): CapturedRequest {
  const headers: Array<[string, string]> = [];
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
    headers.push([req.rawHeaders[i]!, req.rawHeaders[i + 1]!.split(String(port)).join("<port>")]);
  }
  return { path: (req.url ?? "").split("?")[0]!, httpVersion: req.httpVersion, headers };
}

function fileUnder(dir: string, relative: string): string | null {
  const path = normalize(join(dir, relative));
  if (path !== dir && !path.startsWith(dir.endsWith(sep) ? dir : dir + sep)) return null;
  if (!existsSync(path) || statSync(path).isDirectory()) return null;
  return path;
}

/**
 * The self-hosted pages, on loopback, as `http://localhost:<port>`: a secure context
 * with no TLS in the way, so a page's own APIs behave as on a real site. Nothing here
 * refers to anything off this machine.
 */
export async function startLocalSite(): Promise<LocalSite> {
  const requests: CapturedRequest[] = [];
  const mounts: Mount[] = [{ prefix: "/p/", dir: PAGES_DIR }];
  const serve = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const port = (req.socket.address() as AddressInfo).port;
    requests.push(capture(req, port));
    res.setHeader("cache-control", "no-store");
    res.setHeader("accept-ch", ACCEPT_CH);
    if (url.pathname === "/p/probe-sub") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    if (url.pathname === "/__baseline/unavailable") {
      res.writeHead(503, { "content-type": "text/plain" }).end("not available in a self-hosted run");
      return;
    }
    for (const mount of mounts) {
      if (!url.pathname.startsWith(mount.prefix)) continue;
      let relative = decodeURIComponent(url.pathname.slice(mount.prefix.length));
      if (relative === "" || relative.endsWith("/")) relative += "index.html";
      const path = fileUnder(mount.dir, relative);
      if (!path) continue;
      const type = CONTENT_TYPES[extname(path)] ?? "application/octet-stream";
      if (!mount.rewrite || !type.startsWith("text/")) {
        res.writeHead(200, { "content-type": type }).end(readFileSync(path));
      } else {
        res.writeHead(200, { "content-type": type }).end(mount.rewrite(relative, readFileSync(path, "utf8")));
      }
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  };
  const server = createServer((req, res) => {
    try {
      serve(req, res);
    } catch (e) {
      res.writeHead(500, { "content-type": "text/plain" }).end((e as Error).message);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const origin = `http://localhost:${port}`;
  return {
    port,
    origin,
    url: (path) => `${origin}${path}`,
    requestsFor: (path) => requests.filter((r) => r.path === path),
    mount: (mount) => {
      // Longest prefix first, as "/" would otherwise answer for every other mount.
      mounts.push(mount);
      mounts.sort((a, b) => b.prefix.length - a.prefix.length);
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
