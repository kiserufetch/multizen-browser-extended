import { randomUUID } from "node:crypto";
import { mkdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import {
  MultizenError,
  PROFILE_UPLOADS_DIR,
  UPLOAD_INBOX_DIR,
  type DriverAction,
  type ElementTarget,
} from "@multizen/types";
import { assertProfileExists, assertProfileRunning } from "../errorMapping.js";
import {
  DEFAULT_MAX_INLINE_FILE_BYTES,
  ProfileIdSchema,
  type ExtensionTool,
  type ToolContext,
} from "./shared.js";

const MAX_FILES_PER_UPLOAD = 32;
const MAX_UPLOAD_NAME_CHARS = 120;

const TargetFields = {
  ref: z.string().min(1).optional(),
  selector: z.string().min(1).optional(),
};

interface TargetInput {
  ref?: string;
  selector?: string;
}

const ONE_TARGET = { message: "Pass exactly one of ref or selector" };
const AT_MOST_ONE_TARGET = { message: "Pass ref or selector, not both" };

function hasOneTarget(v: TargetInput): boolean {
  return (v.ref !== undefined) !== (v.selector !== undefined);
}

function hasAtMostOneTarget(v: TargetInput): boolean {
  return v.ref === undefined || v.selector === undefined;
}

function targetOf(v: TargetInput): ElementTarget | undefined {
  if (v.ref !== undefined) return { ref: v.ref };
  return v.selector !== undefined ? { selector: v.selector } : undefined;
}

const PressKeySchema = ProfileIdSchema.extend({
  key: z.string().min(1).max(64),
  ...TargetFields,
}).refine(hasAtMostOneTarget, AT_MOST_ONE_TARGET);

const HoverSchema = ProfileIdSchema.extend(TargetFields).refine(hasOneTarget, ONE_TARGET);

const SelectOptionSchema = ProfileIdSchema.extend({
  ...TargetFields,
  value: z.string().optional(),
  label: z.string().optional(),
  index: z.number().int().min(0).optional(),
})
  .refine(hasOneTarget, ONE_TARGET)
  .refine((v) => [v.value, v.label, v.index].filter((o) => o !== undefined).length === 1, {
    message: "Pass exactly one of value, label or index",
  });

const ScrollSchema = ProfileIdSchema.extend({
  ...TargetFields,
  delta_x: z.number().finite().optional(),
  delta_y: z.number().finite().optional(),
})
  .refine(hasAtMostOneTarget, AT_MOST_ONE_TARGET)
  .refine(
    (v) =>
      v.delta_x !== undefined ||
      v.delta_y !== undefined ||
      v.ref !== undefined ||
      v.selector !== undefined,
    { message: "Pass delta_x or delta_y, or an element to scroll into view" },
  );

const UploadFileSchema = ProfileIdSchema.extend({
  ...TargetFields,
  files: z
    .array(z.object({ file_name: z.string().min(1), data_base64: z.string().optional() }))
    .min(1)
    .max(MAX_FILES_PER_UPLOAD),
}).refine(hasOneTarget, ONE_TARGET);

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)$/i;

/**
 * Windows forms a containment check can't see through: UNC and device paths, an
 * alternate data stream on an allowed file, and names that open a device whatever
 * the directory. Trailing dots and spaces are stripped by Win32, so the name
 * checked would not be the name opened.
 */
export function windowsPathProblem(fileName: string): string | null {
  if (/^[\\/]{2}/.test(fileName)) return "UNC and device paths are not allowed";
  const afterDrive = fileName.replace(/^[a-z]:/i, "");
  if (afterDrive.includes(":")) return "alternate data streams are not allowed";
  for (const segment of afterDrive.split(/[\\/]/)) {
    if (segment === "" || segment === "." || segment === "..") continue;
    if (WINDOWS_RESERVED_NAME.test(segment.split(".")[0]!.trimEnd())) {
      return `"${segment}" is a reserved device name`;
    }
    if (/[. ]$/.test(segment)) return "a trailing dot or space is not allowed";
  }
  return null;
}

/** A plain file name for the inbox: no directories, nothing a filesystem reinterprets. */
export function safeUploadName(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? "";
  // The tail, to keep the extension of an overlong name.
  const cleaned = base
    .replace(/[\u0000-\u001f<>:"|?*]/g, "_")
    .slice(-MAX_UPLOAD_NAME_CHARS)
    .replace(/^[. ]+|[. ]+$/g, "");
  return cleaned || "upload";
}

function notAllowed(fileName: string, why: string): MultizenError {
  return new MultizenError("FILE_NOT_ALLOWED", `Can't upload "${fileName}": ${why}`, {
    hint: "Send the file as data_base64, or put it in the profile's uploads directory first.",
  });
}

/**
 * The real path of an existing file inside one of `roots`, else FILE_NOT_ALLOWED.
 * Compares real paths, so a symlink or junction inside a root can't lead out of it.
 * A missing file gets the same error as a forbidden one: this must not work as a
 * probe of what exists on the host.
 */
export async function resolveAllowedFile(
  fileName: string,
  roots: readonly string[],
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  if (platform === "win32") {
    const problem = windowsPathProblem(fileName);
    if (problem) throw notAllowed(fileName, problem);
  }
  for (const root of roots) {
    try {
      const realRoot = await realpath(root);
      const real = await realpath(isAbsolute(fileName) ? fileName : resolve(root, fileName));
      const inside = relative(realRoot, real);
      if (
        inside !== "" &&
        !inside.startsWith("..") &&
        !isAbsolute(inside) &&
        (await stat(real)).isFile()
      ) {
        return real;
      }
    } catch {
      // Not there under this root; the next one may have it.
    }
  }
  throw notAllowed(fileName, "it is not a file inside the uploads directory");
}

/** Decodes only after the size check, so an oversized request costs no memory. */
function decodeBase64(fileName: string, data: string): Buffer {
  const compact = data.replace(/\s+/g, "");
  const decoded = Buffer.from(compact, "base64");
  if (decoded.toString("base64").replace(/=+$/, "") !== compact.replace(/=+$/, "")) {
    throw new MultizenError("INVALID_INPUT", `data_base64 of "${fileName}" is not valid base64`);
  }
  return decoded;
}

interface PlannedUpload {
  fileName: string;
  size: number;
  /** Already on disk. */
  path?: string;
  /** Still to write to the inbox. */
  bytes?: Buffer;
}

/** Checks every file before anything is written: a refused batch leaves nothing behind. */
async function planUploads(
  files: ReadonlyArray<{ file_name: string; data_base64?: string }>,
  roots: readonly string[],
  maxBytes: number,
): Promise<PlannedUpload[]> {
  const declared = files.reduce(
    (sum, f) =>
      sum + (f.data_base64 === undefined ? 0 : Buffer.byteLength(f.data_base64, "base64")),
    0,
  );
  if (declared > maxBytes) {
    throw new MultizenError(
      "FILE_TOO_LARGE",
      `${declared} bytes of base64 upload is over the limit of ${maxBytes}.`,
      {
        hint: "Put the file in the profile's uploads directory and pass only file_name.",
        details: { size_bytes: declared, max_bytes: maxBytes },
      },
    );
  }
  const planned: PlannedUpload[] = [];
  for (const { file_name: fileName, data_base64: data } of files) {
    if (data !== undefined) {
      const bytes = decodeBase64(fileName, data);
      planned.push({ fileName, size: bytes.length, bytes });
    } else {
      const path = await resolveAllowedFile(fileName, roots);
      planned.push({ fileName, size: (await stat(path)).size, path });
    }
  }
  return planned;
}

async function uploadFile(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  const input = UploadFileSchema.parse(args);
  const id = input.profile_id;
  assertProfileExists(ctx.profileManager, id);
  assertProfileRunning(ctx.browserDriver, id);
  const uploadsDir = join(ctx.profileManager.get(id)!.dataDir, PROFILE_UPLOADS_DIR);
  const roots = ctx.uploadsRoot ? [uploadsDir, ctx.uploadsRoot] : [uploadsDir];
  const planned = await planUploads(
    input.files,
    roots,
    ctx.maxInlineFileBytes ?? DEFAULT_MAX_INLINE_FILE_BYTES,
  );

  const inbox = join(uploadsDir, UPLOAD_INBOX_DIR);
  const written: string[] = [];
  const paths: string[] = [];
  try {
    for (const file of planned) {
      if (file.bytes === undefined) {
        paths.push(file.path!);
        continue;
      }
      // A directory per file, so the page's File.name is the name it was sent under.
      const dir = join(inbox, randomUUID());
      await mkdir(dir, { recursive: true });
      written.push(dir);
      const path = join(dir, safeUploadName(file.fileName));
      await writeFile(path, file.bytes, { mode: 0o600, flag: "wx" });
      paths.push(path);
    }
    await ctx.browserDriver.performAction(id, {
      type: "upload_file",
      target: targetOf(input)!,
      paths,
    });
  } catch (e) {
    await Promise.all(written.map((dir) => rm(dir, { recursive: true, force: true })));
    throw e;
  }
  return {
    ok: true,
    files: planned.map((f) => ({ file_name: f.fileName, size_bytes: f.size })),
  };
}

function act(ctx: ToolContext, id: string, action: DriverAction): Promise<{ ok: true }> {
  assertProfileRunning(ctx.browserDriver, id);
  return ctx.browserDriver.performAction(id, action);
}

const PROFILE_ID_PROPERTY = { profile_id: { type: "string" } } as const;
const TARGET_PROPERTIES = {
  ref: { type: "string", description: "Element ref from extract, e.g. 'e7'" },
  selector: { type: "string", description: "CSS selector, when there is no ref" },
} as const;

export const INTERACTION_TOOLS: ExtensionTool[] = [
  {
    definition: {
      name: "press_key",
      description:
        "Press a key or chord in the page, e.g. 'Enter', 'Tab', 'Escape', 'Control+A'. 'ControlOrMeta' means Command on a macOS persona and Control otherwise. With ref or selector, clicks that element first. For text, use type or type_ref. Fails with INPUT_NOT_DELIVERED when the page did not receive the key.",
      inputSchema: {
        type: "object",
        required: ["profile_id", "key"],
        properties: {
          ...PROFILE_ID_PROPERTY,
          key: { type: "string", description: "Key name or chord" },
          ...TARGET_PROPERTIES,
        },
      },
    },
    handler: async (args, ctx) => {
      const input = PressKeySchema.parse(args);
      const target = targetOf(input);
      return act(ctx, input.profile_id, {
        type: "press_key",
        key: input.key,
        ...(target ? { target } : {}),
      });
    },
  },
  {
    definition: {
      name: "hover",
      description:
        "Move the mouse over an element, scrolling it into view first. Pass ref or selector.",
      inputSchema: {
        type: "object",
        required: ["profile_id"],
        properties: { ...PROFILE_ID_PROPERTY, ...TARGET_PROPERTIES },
      },
    },
    handler: async (args, ctx) => {
      const input = HoverSchema.parse(args);
      return act(ctx, input.profile_id, { type: "hover", target: targetOf(input)! });
    },
  },
  {
    definition: {
      name: "select_option",
      description:
        "Choose an option of a <select> element, by value, label or index (exactly one). Sets the selection directly rather than opening the popup, so the input and change events the page gets are not trusted ones.",
      inputSchema: {
        type: "object",
        required: ["profile_id"],
        properties: {
          ...PROFILE_ID_PROPERTY,
          ...TARGET_PROPERTIES,
          value: { type: "string" },
          label: { type: "string" },
          index: { type: "integer", minimum: 0 },
        },
      },
    },
    handler: async (args, ctx) => {
      const { profile_id: id, ref, selector, value, label, index } = SelectOptionSchema.parse(args);
      return act(ctx, id, {
        type: "select_option",
        target: targetOf({ ref, selector })!,
        ...(value !== undefined ? { value } : {}),
        ...(label !== undefined ? { label } : {}),
        ...(index !== undefined ? { index } : {}),
      });
    },
  },
  {
    definition: {
      name: "scroll",
      description:
        "Scroll with the mouse wheel by delta_x / delta_y CSS pixels, over the element if ref or selector is given. An element with no deltas is scrolled into view instead.",
      inputSchema: {
        type: "object",
        required: ["profile_id"],
        properties: {
          ...PROFILE_ID_PROPERTY,
          ...TARGET_PROPERTIES,
          delta_x: { type: "number" },
          delta_y: { type: "number", description: "Positive scrolls down" },
        },
      },
    },
    handler: async (args, ctx) => {
      const {
        profile_id: id,
        ref,
        selector,
        delta_x: deltaX,
        delta_y: deltaY,
      } = ScrollSchema.parse(args);
      const target = targetOf({ ref, selector });
      return act(ctx, id, {
        type: "scroll",
        ...(target ? { target } : {}),
        ...(deltaX !== undefined ? { deltaX } : {}),
        ...(deltaY !== undefined ? { deltaY } : {}),
      });
    },
  },
  {
    definition: {
      name: "upload_file",
      description:
        "Attach files to a file input, or to the file chooser an element opens when clicked. Pass ref or selector. Each entry of `files` is either data_base64 with a file_name (16 MB in total by default, kept until the profile closes), or file_name alone: an existing file inside the profile's uploads directory or the server's uploads root, relative to it. Any other host path gets FILE_NOT_ALLOWED; too much base64 gets FILE_TOO_LARGE.",
      inputSchema: {
        type: "object",
        required: ["profile_id", "files"],
        properties: {
          ...PROFILE_ID_PROPERTY,
          ...TARGET_PROPERTIES,
          files: {
            type: "array",
            minItems: 1,
            maxItems: MAX_FILES_PER_UPLOAD,
            items: {
              type: "object",
              required: ["file_name"],
              properties: {
                file_name: { type: "string" },
                data_base64: { type: "string", description: "The file's content" },
              },
            },
          },
        },
      },
    },
    handler: uploadFile,
  },
];
