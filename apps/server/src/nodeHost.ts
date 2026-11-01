import { EventEmitter } from "node:events";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { HostHttpRequest, HostHttpResponse, RuntimeHost } from "@multizen/browser-runtime";

const MAX_REDIRECTS = 5;
/** A stalled download surfaces as an error, for the bootstrap's retry to resume. */
const IDLE_TIMEOUT_MS = 60_000;

/** The subset of Electron's `net.request` the runtime uses: follows redirects,
 *  keeps every header (`Range` above all) across them, and emits the final
 *  response or a single error. */
class NodeHttpRequest extends EventEmitter implements HostHttpRequest {
  private readonly headers: Record<string, string> = {
    "user-agent": "multizen-server",
  };
  private readonly url: string;

  constructor(url: string) {
    super();
    this.url = url;
  }

  setHeader(name: string, value: string): void {
    this.headers[name] = value;
  }

  end(): void {
    this.send(new URL(this.url), 0);
  }

  private send(url: URL, redirects: number): void {
    const open = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = open(url, { method: "GET", headers: this.headers }, (res: IncomingMessage) => {
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if (status >= 300 && status < 400 && location) {
        res.resume();
        if (redirects >= MAX_REDIRECTS) {
          this.emit("error", new Error(`Too many redirects fetching ${this.url}`));
          return;
        }
        this.send(new URL(location, url), redirects + 1);
        return;
      }
      this.emit("response", res as HostHttpResponse);
    });
    req.setTimeout(IDLE_TIMEOUT_MS, () => {
      req.destroy(new Error(`Timed out fetching ${url.href}`));
    });
    req.on("error", (e) => this.emit("error", e));
    req.end();
  }
}

/**
 * The browser runtime's host outside Electron. `resourceDir` answers null for
 * everything: the server ships neither the companion extension (nothing would
 * handle its button) nor the Linux sandbox installer.
 */
export function createNodeHost(dataDir: string): RuntimeHost {
  return {
    userDataDir: () => dataDir,
    resourceDir: () => null,
    fetch: (url, init) => fetch(url, init),
    request: (opts) => new NodeHttpRequest(opts.url),
  };
}
