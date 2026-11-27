import {
  createCloudProviderSolverPort,
  isCloudSolverProviderKind,
  loadModuleSolverPort,
} from "@multizen/browser-runtime";
import { HttpWebhookSolverAdapter, SolverWebhookSessions } from "@multizen/mcp-server";
import { defaultSettingsPath, SettingsStore } from "@multizen/settings-store";
import type { CaptchaSolverPort } from "@multizen/types";
import type { SolverCommand } from "../config.ts";
import { protocolStdout } from "../log.ts";
import { resolveServerSolverSettings } from "../runtime.ts";

export async function runSolver(cmd: SolverCommand): Promise<void> {
  const settingsStore = new SettingsStore(defaultSettingsPath(cmd.dataDir));
  const loaded = await settingsStore.load();
  const solver = resolveServerSolverSettings(loaded.solver, cmd.solver);

  let port: CaptchaSolverPort | null = null;
  let loadError: string | undefined;
  try {
    if (solver.enabled) {
      if (isCloudSolverProviderKind(solver.adapter) && solver.apiKey) {
        const apiBaseUrl =
          typeof solver.options?.apiBaseUrl === "string"
            ? solver.options.apiBaseUrl
            : undefined;
        port = createCloudProviderSolverPort(solver.adapter, {
          apiKey: solver.apiKey,
          ...(apiBaseUrl ? { apiBaseUrl } : {}),
        });
      } else if (solver.adapter === "module" && solver.modulePath) {
        port = await loadModuleSolverPort(solver.modulePath, {
          ...(solver.options ? { options: solver.options } : {}),
          ...(solver.apiKey ? { apiKey: solver.apiKey } : {}),
          ...(solver.webhookSecret ? { secret: solver.webhookSecret } : {}),
        });
      } else if (solver.adapter === "webhook" && solver.webhookUrl) {
        port = new HttpWebhookSolverAdapter({
          webhookUrl: solver.webhookUrl,
          ...(solver.webhookSecret ? { webhookSecret: solver.webhookSecret } : {}),
          ...(solver.apiKey ? { apiKey: solver.apiKey } : {}),
          callbackBaseUrl: () => "http://127.0.0.1:7777",
          sessions: new SolverWebhookSessions(),
        });
      }
    }
  } catch (e) {
    loadError = (e as Error).message;
  }

  const health = port?.healthcheck ? await port.healthcheck() : undefined;
  await port?.dispose?.().catch(() => {});

  const output = {
    enabled: solver.enabled,
    adapter: solver.adapter,
    configured: Boolean(port),
    adapterId: port?.id ?? null,
    adapterName: port?.name ?? null,
    capabilities: port?.capabilities ?? null,
    fallbackPolicy: solver.fallbackPolicy,
    proxyExposure: solver.proxyExposure,
    allowMainWorldJs: solver.allowMainWorldJs,
    timeoutMs: solver.timeoutMs,
    ...(solver.webhookUrl ? { webhookUrl: solver.webhookUrl } : {}),
    ...(solver.modulePath ? { modulePath: solver.modulePath } : {}),
    ...(health ? { health } : {}),
    ...(loadError ? { error: loadError } : {}),
  };

  protocolStdout.write(`${JSON.stringify(output, null, 2)}\n`);
}
