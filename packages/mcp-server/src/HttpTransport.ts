import { createServer, type IncomingMessage, type ServerResponse, type Server as HttpServer } from "node:http";
import type { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

export interface HttpTransportOptions {
  port: number;
  host?: string;
  /** Optional bearer token; if set, requests must send Authorization: Bearer <token> */
  authToken?: string;
}

/**
 * HTTP+SSE transport so external MCP clients (Cursor, Claude Desktop)
 * can connect to the running desktop app, not just spawn a stdio child.
 *
 * Endpoints:
 *   GET  /sse        — open SSE stream
 *   POST /messages   — send a message to the open SSE stream
 *   GET  /healthz    — liveness check
 */
export class HttpTransport {
  private readonly server: HttpServer;
  private readonly opts: HttpTransportOptions;
  private sseTransport: SSEServerTransport | null = null;
  private mcp: McpServer | null = null;

  constructor(opts: HttpTransportOptions) {
    this.opts = opts;
    this.server = createServer((req, res) => this.handle(req, res));
  }

  async start(mcp: McpServer): Promise<void> {
    this.mcp = mcp;
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        this.server.off("listening", onListening);
        reject(err);
      };
      const onListening = (): void => {
        this.server.off("error", onError);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.opts.port, this.opts.host ?? "127.0.0.1");
    });
  }

  async stop(): Promise<void> {
    if (this.sseTransport) {
      await this.sseTransport.close();
      this.sseTransport = null;
    }
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.opts.authToken) {
      const auth = req.headers.authorization ?? "";
      if (auth !== `Bearer ${this.opts.authToken}`) {
        res.writeHead(401).end("unauthorized");
        return;
      }
    }

    const url = req.url ?? "/";

    if (url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({ ok: true, name: "multizen-mcp", connected: this.sseTransport !== null }),
      );
      return;
    }

    if (req.method === "GET" && url.startsWith("/sse")) {
      if (!this.mcp) {
        res.writeHead(503).end("mcp not started");
        return;
      }
      const transport = new SSEServerTransport("/messages", res);
      this.sseTransport = transport;
      await this.mcp.connect(transport);
      // SSE keeps the response open
      return;
    }

    if (req.method === "POST" && url.startsWith("/messages")) {
      if (!this.sseTransport) {
        res.writeHead(409).end("no SSE stream open");
        return;
      }
      try {
        await this.sseTransport.handlePostMessage(req, res);
      } catch (e) {
        res.writeHead(500).end((e as Error).message);
      }
      return;
    }

    res.writeHead(404).end("not found");
  }
}
