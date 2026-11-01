import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import type { ServerResponse } from "node:http";
import type { ProfileManager } from "@multizen/profile-manager";
import type { BrowserDriver } from "@multizen/types";
import type { HttpRoute } from "./HttpTransport.js";
import { mayUse, mayUseProfile } from "./toolGate.js";
import { policyFor } from "./toolPolicy.js";

/**
 * What came from the web stays inert: a download is never rendered from this origin, or
 * typed by what its server claimed.
 */
const DOWNLOAD_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "application/octet-stream",
  "x-content-type-options": "nosniff",
  "content-security-policy": "sandbox; default-src 'none'",
  "cache-control": "no-store",
};

function refuse(res: ServerResponse, status: number, error: string): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error }));
}

/** The name is sanitized by the tracker. This is only about what a header can carry. */
function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/**
 * `GET /files/downloads/:profileId/:id`, for files too large for get_download to send
 * inline. Goes on the authenticated routes, so it takes a Bearer token and a panel cookie
 * means nothing here. The id is one the tracker generated, never a path.
 */
export function createDownloadRoute(opts: {
  driver: BrowserDriver;
  profiles: Pick<ProfileManager, "get">;
}): HttpRoute {
  return async (req, res, url, ctx) => {
    const match = /^\/files\/downloads\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (!match) return false;
    const { principal } = ctx;
    if (!principal) {
      refuse(res, 401, "unauthorized");
      return true;
    }
    if (req.method !== "GET") {
      res.setHeader("allow", "GET");
      refuse(res, 405, "method_not_allowed");
      return true;
    }
    let profileId: string;
    let downloadId: string;
    try {
      profileId = decodeURIComponent(match[1]!);
      downloadId = decodeURIComponent(match[2]!);
    } catch {
      refuse(res, 400, "bad_path");
      return true;
    }
    const policy = policyFor("get_download");
    if (!policy || !mayUse(principal, "get_download", policy)) {
      refuse(res, 403, "forbidden");
      return true;
    }
    if (!mayUseProfile(principal, profileId) || !opts.profiles.get(profileId)) {
      refuse(res, 404, "not_found");
      return true;
    }
    const download = await opts.driver.getDownload(profileId, downloadId);
    if (!download || download.state !== "completed" || download.path === null) {
      refuse(res, 404, "not_found");
      return true;
    }
    const { size } = await stat(download.path);
    res.writeHead(200, {
      ...DOWNLOAD_HEADERS,
      "content-length": String(size),
      "content-disposition": contentDisposition(download.fileName),
    });
    await pipeline(createReadStream(download.path), res).catch(() => {
      // The client went away, or the file did: the connection ends either way.
      res.destroy();
    });
    return true;
  };
}
