import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { MultizenError } from "@multizen/types";
import { assertProfileRunning } from "../errorMapping.js";
import { DEFAULT_MAX_INLINE_FILE_BYTES, ProfileIdSchema, type ExtensionTool } from "./shared.js";

const GetDownloadSchema = ProfileIdSchema.extend({ download_id: z.string().min(1) });

export const DOWNLOAD_TOOLS: ExtensionTool[] = [
  {
    definition: {
      name: "list_downloads",
      description:
        "List the files this profile's browser has downloaded: id, file name, source URL, state (in_progress, completed, canceled) and bytes.",
      inputSchema: {
        type: "object",
        required: ["profile_id"],
        properties: { profile_id: { type: "string" } },
      },
    },
    handler: async (args, ctx) => {
      const { profile_id: id } = ProfileIdSchema.parse(args);
      assertProfileRunning(ctx.browserDriver, id);
      return { downloads: await ctx.browserDriver.listDownloads(id) };
    },
  },
  {
    definition: {
      name: "get_download",
      description:
        "Get a download by the id list_downloads gave it. A completed file comes back as data_base64, up to 16 MB by default; a larger one gets FILE_TOO_LARGE. An unfinished download returns its state with no data.",
      inputSchema: {
        type: "object",
        required: ["profile_id", "download_id"],
        properties: { profile_id: { type: "string" }, download_id: { type: "string" } },
      },
    },
    handler: async (args, ctx) => {
      const { profile_id: id, download_id: downloadId } = GetDownloadSchema.parse(args);
      assertProfileRunning(ctx.browserDriver, id);
      const download = await ctx.browserDriver.getDownload(id, downloadId);
      if (!download) {
        throw new MultizenError("INVALID_INPUT", `No download ${downloadId} on profile ${id}`);
      }
      const { path, ...record } = download;
      if (path === null || record.state !== "completed") return record;
      const maxBytes = ctx.maxInlineFileBytes ?? DEFAULT_MAX_INLINE_FILE_BYTES;
      const { size } = await stat(path);
      if (size > maxBytes) {
        throw new MultizenError(
          "FILE_TOO_LARGE",
          `Download ${downloadId} is ${size} bytes, over the inline limit of ${maxBytes}.`,
          { details: { size_bytes: size, max_bytes: maxBytes } },
        );
      }
      return { ...record, data_base64: (await readFile(path)).toString("base64") };
    },
  },
];
