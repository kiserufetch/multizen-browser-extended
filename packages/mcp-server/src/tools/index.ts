import { DIALOG_TOOLS } from "./dialogs.js";
import { DOWNLOAD_TOOLS } from "./downloads.js";
import { HUMAN_HANDLERS, HUMAN_TOOLS } from "./human.js";
import { INTERACTION_TOOLS } from "./interaction.js";
import { LEASE_TOOLS } from "./leases.js";
import type { ExtensionTool } from "./shared.js";

export type { ToolContext } from "./shared.js";

const EXTENSION_TOOLS: ExtensionTool[] = [
  ...INTERACTION_TOOLS,
  ...DOWNLOAD_TOOLS,
  ...DIALOG_TOOLS,
  ...LEASE_TOOLS,
  ...HUMAN_TOOLS,
];

export const EXTENSION_DEFS = EXTENSION_TOOLS.map((t) => t.definition);

/** A Map, not an object: the key is caller input. */
export const EXTENSION_HANDLERS: ReadonlyMap<string, ExtensionTool["handler"]> = new Map([
  ...EXTENSION_TOOLS.map((t) => [t.definition.name, t.handler] as const),
  ...HUMAN_HANDLERS,
]);
