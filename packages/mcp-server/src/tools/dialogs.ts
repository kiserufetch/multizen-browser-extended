import { z } from "zod";
import { assertProfileRunning } from "../errorMapping.js";
import { ProfileIdSchema, type ExtensionTool } from "./shared.js";

const DialogActionSchema = z.enum(["accept", "dismiss"]);

const SetDialogPolicySchema = ProfileIdSchema.extend({
  mode: z.enum(["auto", "manual"]),
  alert: DialogActionSchema.optional(),
  confirm: DialogActionSchema.optional(),
  prompt: DialogActionSchema.optional(),
  beforeunload: DialogActionSchema.optional(),
  prompt_text: z.string().optional(),
});

const HandleDialogSchema = ProfileIdSchema.extend({
  action: DialogActionSchema,
  dialog_id: z.string().min(1).optional(),
  prompt_text: z.string().optional(),
});

const DIALOG_ACTION_PROPERTY = { type: "string", enum: ["accept", "dismiss"] } as const;

export const DIALOG_TOOLS: ExtensionTool[] = [
  {
    definition: {
      name: "set_dialog_policy",
      description:
        "Choose what happens to JavaScript dialogs on this profile. mode auto (the default) answers each one at once: alert and beforeunload accepted, confirm and prompt dismissed, unless you override a type here. mode manual leaves them open: see list_dialogs, answer with handle_dialog, and until then screenshot, extract and page actions fail with DIALOG_OPEN.",
      inputSchema: {
        type: "object",
        required: ["profile_id", "mode"],
        properties: {
          profile_id: { type: "string" },
          mode: { type: "string", enum: ["auto", "manual"] },
          alert: DIALOG_ACTION_PROPERTY,
          confirm: DIALOG_ACTION_PROPERTY,
          prompt: DIALOG_ACTION_PROPERTY,
          beforeunload: DIALOG_ACTION_PROPERTY,
          prompt_text: { type: "string", description: "Answer to a prompt accepted in auto mode" },
        },
      },
    },
    handler: async (args, ctx) => {
      const {
        profile_id: id,
        prompt_text: promptText,
        ...policy
      } = SetDialogPolicySchema.parse(args);
      assertProfileRunning(ctx.browserDriver, id);
      return ctx.browserDriver.setDialogPolicy(id, {
        ...policy,
        ...(promptText !== undefined ? { promptText } : {}),
      });
    },
  },
  {
    definition: {
      name: "list_dialogs",
      description:
        "List the JavaScript dialogs open on this profile: id, type, message, and the default text of a prompt. Only manual mode leaves dialogs open.",
      inputSchema: {
        type: "object",
        required: ["profile_id"],
        properties: { profile_id: { type: "string" } },
      },
    },
    handler: async (args, ctx) => {
      const { profile_id: id } = ProfileIdSchema.parse(args);
      assertProfileRunning(ctx.browserDriver, id);
      return { dialogs: await ctx.browserDriver.listDialogs(id) };
    },
  },
  {
    definition: {
      name: "handle_dialog",
      description:
        "Accept or dismiss an open JavaScript dialog: the oldest one unless dialog_id says otherwise. prompt_text answers a prompt being accepted.",
      inputSchema: {
        type: "object",
        required: ["profile_id", "action"],
        properties: {
          profile_id: { type: "string" },
          action: DIALOG_ACTION_PROPERTY,
          dialog_id: { type: "string", description: "Id from list_dialogs" },
          prompt_text: { type: "string" },
        },
      },
    },
    handler: async (args, ctx) => {
      const {
        profile_id: id,
        action,
        dialog_id: dialogId,
        prompt_text: promptText,
      } = HandleDialogSchema.parse(args);
      assertProfileRunning(ctx.browserDriver, id);
      return ctx.browserDriver.handleDialog(id, {
        action,
        ...(dialogId !== undefined ? { dialogId } : {}),
        ...(promptText !== undefined ? { promptText } : {}),
      });
    },
  },
];
