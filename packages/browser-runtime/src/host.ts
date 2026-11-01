export interface HostHttpResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  on(ev: "data", cb: (c: Buffer) => void): this;
  on(ev: "end", cb: () => void): this;
  on(ev: "error", cb: (e: Error) => void): this;
  pause?(): void;
  resume?(): void;
}

export interface HostHttpRequest {
  setHeader(name: string, value: string): void;
  on(ev: "error", cb: (e: Error) => void): this;
  on(ev: "response", cb: (r: HostHttpResponse) => void): this;
  end(): void;
}

/**
 * What the browser runtime needs from the process that embeds it. The desktop
 * implements it on Electron (`apps/desktop/src/main/electronHost.ts`). The shape
 * mirrors the subset of Electron's `net` the moved code already used.
 */
export interface RuntimeHost {
  /** Root that bootstraps cache under: <dir>/chromium/<engine>, <dir>/camoufox. */
  userDataDir(): string;
  /** Packaged or dev path of a bundled resource; null if absent. */
  resourceDir(name: "companion" | "linux-sandbox"): string | null;
  fetch(url: string, init?: RequestInit): Promise<Response>;
  request(opts: { method: "GET"; url: string; redirect: "follow" }): HostHttpRequest;
}
