import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MultizenError, type CaptchaSolverPort } from "@multizen/types";

export interface SolverModuleContext {
  options?: Record<string, unknown>;
  apiKey?: string;
  secret?: string;
}

export type SolverModuleFactory = (
  ctx: SolverModuleContext,
) => CaptchaSolverPort | Promise<CaptchaSolverPort>;

export function isCaptchaSolverPort(value: unknown): value is CaptchaSolverPort {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CaptchaSolverPort>;
  return (
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    typeof candidate.name === "string" &&
    candidate.name.length > 0 &&
    Boolean(candidate.capabilities) &&
    Array.isArray(candidate.capabilities?.kinds) &&
    Array.isArray(candidate.capabilities?.modes) &&
    typeof candidate.solve === "function"
  );
}

/**
 * Dynamically loads a local ESM/JS module implementing `CaptchaSolverPort`.
 * The module may export `createSolverPort(ctx)` or a default factory / instance.
 */
export async function loadModuleSolverPort(
  modulePath: string,
  ctx: SolverModuleContext = {},
): Promise<CaptchaSolverPort> {
  const absPath = resolve(modulePath);
  const url = pathToFileURL(absPath).href;
  let imported: Record<string, unknown>;
  try {
    imported = (await import(url)) as Record<string, unknown>;
  } catch (e) {
    throw new MultizenError(
      "INVALID_INPUT",
      `Failed to import solver module at ${absPath}: ${(e as Error).message}`,
    );
  }

  const factory =
    typeof imported.createSolverPort === "function"
      ? (imported.createSolverPort as SolverModuleFactory)
      : typeof imported.default === "function"
        ? (imported.default as SolverModuleFactory)
        : null;

  const instance = factory ? await factory(ctx) : imported.default ?? imported;
  if (!isCaptchaSolverPort(instance)) {
    throw new MultizenError(
      "INVALID_INPUT",
      `Solver module at ${absPath} did not return a valid CaptchaSolverPort (requires id, name, capabilities, and solve()).`,
    );
  }
  return instance;
}
