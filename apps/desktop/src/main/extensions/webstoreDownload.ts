import { net } from "electron";
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { tempCrxPath } from "./crxPipeline.ts";

/**
 * Parse a Chrome Web Store URL (or a bare ID) into the 32-char extension ID.
 * Accepts:
 *   https://chromewebstore.google.com/detail/<slug>/<id>?...
 *   https://chrome.google.com/webstore/detail/<slug>/<id>
 *   <id>
 */
export function parseExtensionId(urlOrId: string): string {
  const s = urlOrId.trim();
  const m = /([a-p]{32})/.exec(s);
  if (!m || !m[1]) {
    throw new Error("Couldn't find a Chrome extension ID in that input.");
  }
  return m[1];
}

/**
 * Download an extension's `.crx` by ID from Google's update endpoint (the same
 * endpoint the browser uses), following the redirect to the CDN, and write it
 * to a temp file. Returns the temp file path (caller unpacks then deletes it).
 *
 * `prodversion` must be a real Chromium version matching the engine (e.g.
 * "145.0.7632.109") — stale/sentinel versions can 404.
 *
 * Note: this hits Google's own CRX endpoint on the user's behalf (user-initiated
 * install). It's a grey area in Google's ToS; the file-upload path is the
 * always-available alternative.
 */
export async function downloadCrxById(id: string, prodversion: string): Promise<string> {
  const url =
    `https://clients2.google.com/service/update2/crx?response=redirect` +
    `&acceptformat=crx2,crx3&prodversion=${encodeURIComponent(prodversion)}` +
    `&x=${encodeURIComponent(`id=${id}&installsource=ondemand&uc`)}`;

  const outPath = tempCrxPath();

  await new Promise<void>((resolve, reject) => {
    let out: ReturnType<typeof createWriteStream> | null = null;
    const fail = (err: Error): void => {
      if (out) {
        out.destroy();
        out = null;
      }
      reject(err);
    };

    const request = net.request({ method: "GET", url, redirect: "follow" });
    request.on("error", fail);
    request.on("response", (response) => {
      const status = response.statusCode;
      if (status < 200 || status >= 300) {
        response.on("data", () => {});
        fail(new Error(`HTTP ${status} downloading extension ${id} from the Web Store.`));
        return;
      }
      const stream = createWriteStream(outPath);
      out = stream;
      stream.on("error", fail);
      const flow = response as unknown as { pause?: () => void; resume?: () => void };
      response.on("data", (chunk: Buffer) => {
        if (!stream.write(chunk) && flow.pause && flow.resume) {
          flow.pause();
          stream.once("drain", () => flow.resume!());
        }
      });
      response.on("error", fail);
      response.on("end", () => {
        out = null;
        stream.end(() => resolve());
      });
    });
    request.end();
  }).catch(async (e) => {
    await rm(outPath, { force: true }).catch(() => {});
    throw e as Error;
  });

  return outPath;
}
