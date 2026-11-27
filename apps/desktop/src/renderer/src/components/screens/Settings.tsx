import { useEffect, useState, type JSX, type ReactNode } from "react";
import {
  Boxes,
  Check,
  Chrome,
  Copy,
  DownloadCloud,
  Eye,
  EyeOff,
  Monitor,
  Plug,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Zap,
} from "lucide-react";
import { displayModeLabel, Pill } from "../atoms";
import { displayModeChoices } from "../profile/BrowserSection";
import { relativeTime } from "../../lib/relativeTime";
import type {
  AppSettings,
  ChromiumStatus,
  EngineUpdateStatus,
  SandboxStatus,
  SolverSettings,
  SystemInfo,
  UpdateStatus,
} from "../../types";

interface Props {
  onImport: () => void;
}

export function Settings({ onImport }: Props): JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [copied, setCopied] = useState(false);
  const [tokenCopied, setTokenCopied] = useState(false);
  const [tokenShown, setTokenShown] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [lastChecked, setLastChecked] = useState<number>(0);
  const [chromiumStatus, setChromiumStatus] = useState<ChromiumStatus | null>(null);
  const [engineUpdateStatus, setEngineUpdateStatus] = useState<EngineUpdateStatus | null>(null);
  const [sandbox, setSandbox] = useState<SandboxStatus | null>(null);
  const [sandboxBusy, setSandboxBusy] = useState(false);
  const [sandboxCmdCopied, setSandboxCmdCopied] = useState(false);
  const [solverTestBusy, setSolverTestBusy] = useState(false);
  const [solverTestResult, setSolverTestResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);

  useEffect(() => {
    if (!window.multizen) return;
    void window.multizen.settings.get().then(setSettings);
    void window.multizen.system.info().then(setInfo);
    void window.multizen.update.status().then(setUpdateStatus);
    void window.multizen.update.lastChecked().then(setLastChecked);
    void window.multizen.chromium.status().then(setChromiumStatus);
    void window.multizen.engineUpdate.status().then(setEngineUpdateStatus);
    void window.multizen.sandbox.status().then(setSandbox);
    const offChromium = window.multizen.chromium.onStatus(setChromiumStatus);
    const offEngineUpdate = window.multizen.engineUpdate.onStatus(setEngineUpdateStatus);
    // Refresh "last checked" on every status change too, so a background
    // auto-check updates the label live while Settings is open.
    const offUpdate = window.multizen.update.onStatus((s) => {
      setUpdateStatus(s);
      void window.multizen.update.lastChecked().then(setLastChecked);
    });
    return () => {
      offChromium();
      offEngineUpdate();
      offUpdate();
    };
  }, []);

  async function patch(p: Partial<AppSettings>): Promise<void> {
    if (!settings) return;
    const next = await window.multizen.settings.update(p);
    setSettings(next);
  }

  async function patchSolver(p: Partial<SolverSettings>): Promise<void> {
    if (!settings) return;
    const current: SolverSettings = settings.solver ?? {
      enabled: false,
      adapter: "none",
      fallbackPolicy: "solver-then-human",
      proxyExposure: "bridge",
      allowMainWorldJs: false,
      timeoutMs: 120_000,
    };
    await patch({ solver: { ...current, ...p } });
  }

  async function testSolverPort(): Promise<void> {
    setSolverTestBusy(true);
    setSolverTestResult(null);
    try {
      const res = await window.multizen.solver.test(settings?.solver);
      setSolverTestResult({ ok: res.ok, message: res.message });
    } finally {
      setSolverTestBusy(false);
    }
  }

  async function checkForUpdates(): Promise<void> {
    await window.multizen.update.check();
    setLastChecked(await window.multizen.update.lastChecked());
  }

  async function checkEngineForUpdates(): Promise<void> {
    // install() = check + stage the newer version (applies on next launch).
    setEngineUpdateStatus(await window.multizen.engineUpdate.install());
  }

  async function runSandboxSetup(): Promise<void> {
    setSandboxBusy(true);
    try {
      setSandbox(await window.multizen.sandbox.setup());
    } finally {
      setSandboxBusy(false);
    }
  }

  function copyMcpUrl(): void {
    if (!info?.mcpHttpUrl) return;
    navigator.clipboard.writeText(info.mcpHttpUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  function copyMcpToken(): void {
    if (!info?.mcpAuthToken) return;
    navigator.clipboard.writeText(info.mcpAuthToken);
    setTokenCopied(true);
    window.setTimeout(() => setTokenCopied(false), 1500);
  }

  if (!settings) {
    return (
      <div className="flex-1 overflow-auto p-8">
        <div className="max-w-[720px] mx-auto text-[13px] text-slate-500">Loading…</div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto" style={{ padding: "24px 32px" }}>
      <div className="max-w-[720px] mx-auto">
        <div className="text-lg font-bold tracking-tight text-slate-100 mb-1.5">Settings</div>
        <div className="text-[13px] text-slate-500 mb-5">
          MCP server, archives, build info. Configuration is local — MultiZen does not call any
          external API on your behalf.
        </div>

        <Row
          icon={<Zap size={16} strokeWidth={1.5} />}
          title="MCP server"
          desc="Local HTTP transport that Cursor / Claude Desktop / Cline / any MCP client connects to. Requires the auth token below. The MCP tab has ready-to-paste client configs."
        >
          <div className="flex gap-2 items-center flex-wrap">
            <Pill kind={info?.mcpHttpUrl ? "running" : "idle"} dot={!!info?.mcpHttpUrl}>
              {info?.mcpHttpUrl ? `running on :${settings.mcpHttpPort}` : "off"}
            </Pill>

            {info?.mcpHttpUrl && (
              <div
                className="flex-1 min-w-[260px] flex items-center gap-2"
                style={{
                  padding: "8px 12px",
                  borderRadius: 10,
                  background: "rgba(255,255,255,0.03)",
                  boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.06)",
                }}
              >
                <span className="flex-1 mono text-[12px] text-slate-300 truncate">
                  {info.mcpHttpUrl}
                </span>
                <button
                  type="button"
                  onClick={copyMcpUrl}
                  className="text-purple-400 hover:text-purple-300 transition-colors"
                  aria-label="Copy URL"
                >
                  {copied ? <Check size={13} /> : <Copy size={13} />}
                </button>
              </div>
            )}
          </div>

          {info?.mcpAuthToken && (
            <div className="mt-2">
              <div className="text-[11px] text-slate-500 mb-1">
                Auth token — required. Send as{" "}
                <span className="mono text-slate-400">Authorization: Bearer &lt;token&gt;</span>. Keep
                it secret.
              </div>
              <div
                className="flex items-center gap-2"
                style={{
                  padding: "8px 12px",
                  borderRadius: 10,
                  background: "rgba(255,255,255,0.03)",
                  boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.06)",
                }}
              >
                <span className="flex-1 mono text-[12px] text-slate-300 truncate">
                  {tokenShown ? info.mcpAuthToken : "•".repeat(24)}
                </span>
                <button
                  type="button"
                  onClick={() => setTokenShown((v) => !v)}
                  className="text-slate-400 hover:text-slate-200 transition-colors"
                  aria-label={tokenShown ? "Hide token" : "Reveal token"}
                >
                  {tokenShown ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
                <button
                  type="button"
                  onClick={copyMcpToken}
                  className="text-purple-400 hover:text-purple-300 transition-colors"
                  aria-label="Copy token"
                >
                  {tokenCopied ? <Check size={13} /> : <Copy size={13} />}
                </button>
              </div>
            </div>
          )}

          <label className="flex items-center gap-2.5 mt-3 text-[12px] text-slate-400 cursor-pointer">
            <input
              type="checkbox"
              checked={settings.mcpHttpEnabled}
              onChange={(e) => void patch({ mcpHttpEnabled: e.target.checked })}
              className="w-3.5 h-3.5 rounded accent-purple-500"
            />
            Auto-start MCP HTTP transport on app launch
          </label>
        </Row>

        <Row
          icon={<Plug size={16} strokeWidth={1.5} />}
          title="Challenge solver port"
          desc="Connect an external HTTP webhook or local ESM solver adapter. When enabled, CAPTCHA requests route through the solver port first and fall back to human handoff if needed."
        >
          {(() => {
            const solver: SolverSettings = settings.solver ?? {
              enabled: false,
              adapter: "none",
              fallbackPolicy: "solver-then-human",
              proxyExposure: "bridge",
              allowMainWorldJs: false,
              timeoutMs: 120_000,
            };
            return (
              <div className="space-y-3">
                <div className="flex items-center gap-3 flex-wrap">
                  <label className="flex items-center gap-2.5 text-[12px] text-slate-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={solver.enabled}
                      onChange={(e) =>
                        void patchSolver({
                          enabled: e.target.checked,
                          adapter:
                            e.target.checked && solver.adapter === "none"
                              ? "capsolver"
                              : solver.adapter,
                        })
                      }
                      className="w-3.5 h-3.5 rounded accent-purple-500"
                    />
                    Enable challenge solver port
                  </label>
                  <Pill kind={solver.enabled ? "running" : "idle"} dot={solver.enabled}>
                    {solver.enabled ? solver.adapter : "off"}
                  </Pill>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                  <div>
                    <div className="text-[11px] text-slate-500 mb-1">Adapter type</div>
                    <select
                      value={solver.adapter}
                      onChange={(e) =>
                        void patchSolver({
                          adapter: e.target.value as SolverSettings["adapter"],
                        })
                      }
                      className="w-full px-2.5 h-9 rounded-lg bg-white/[0.03] text-[12px] text-slate-200 outline-none"
                      style={{ boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)" }}
                    >
                      <option value="none">None</option>
                      <option value="capsolver">CapSolver (API v2)</option>
                      <option value="2captcha">2Captcha (API v2)</option>
                      <option value="rucaptcha">RuCaptcha (API v2)</option>
                      <option value="webhook">HTTP Webhook</option>
                      <option value="module">Local ESM Module</option>
                    </select>
                  </div>

                  <div>
                    <div className="text-[11px] text-slate-500 mb-1">Fallback policy</div>
                    <select
                      value={solver.fallbackPolicy}
                      onChange={(e) =>
                        void patchSolver({
                          fallbackPolicy: e.target.value as SolverSettings["fallbackPolicy"],
                        })
                      }
                      className="w-full px-2.5 h-9 rounded-lg bg-white/[0.03] text-[12px] text-slate-200 outline-none"
                      style={{ boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)" }}
                    >
                      <option value="solver-then-human">Solver → Human fallback</option>
                      <option value="solver-only">Solver only</option>
                      <option value="human-only">Human handoff only</option>
                    </select>
                  </div>

                  <div>
                    <div className="text-[11px] text-slate-500 mb-1">Proxy exposure</div>
                    <select
                      value={solver.proxyExposure}
                      onChange={(e) =>
                        void patchSolver({
                          proxyExposure: e.target.value as SolverSettings["proxyExposure"],
                        })
                      }
                      className="w-full px-2.5 h-9 rounded-lg bg-white/[0.03] text-[12px] text-slate-200 outline-none"
                      style={{ boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)" }}
                    >
                      <option value="bridge">Local SOCKS5 bridge (safe)</option>
                      <option value="raw">Raw upstream credentials</option>
                      <option value="none">Do not pass proxy</option>
                    </select>
                  </div>
                </div>

                {(solver.adapter === "capsolver" ||
                  solver.adapter === "2captcha" ||
                  solver.adapter === "rucaptcha") && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    <div>
                      <div className="text-[11px] text-slate-500 mb-1">
                        {solver.adapter === "capsolver"
                          ? "CapSolver API Key"
                          : solver.adapter === "2captcha"
                            ? "2Captcha API Key"
                            : "RuCaptcha API Key"}
                      </div>
                      <input
                        type="password"
                        value={solver.apiKey ?? ""}
                        onChange={(e) => void patchSolver({ apiKey: e.target.value })}
                        placeholder="clientKey from your dashboard"
                        className="w-full px-2.5 h-9 rounded-lg bg-white/[0.03] text-[12px] text-slate-200 mono outline-none placeholder:text-slate-600"
                        style={{ boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)" }}
                      />
                    </div>
                    <div>
                      <div className="text-[11px] text-slate-500 mb-1">
                        Custom API Base URL (optional)
                      </div>
                      <input
                        type="text"
                        value={
                          typeof solver.options?.apiBaseUrl === "string"
                            ? solver.options.apiBaseUrl
                            : ""
                        }
                        onChange={(e) =>
                          void patchSolver({
                            options: {
                              ...(solver.options ?? {}),
                              apiBaseUrl: e.target.value,
                            },
                          })
                        }
                        placeholder={
                          solver.adapter === "capsolver"
                            ? "https://api.capsolver.com"
                            : solver.adapter === "2captcha"
                              ? "https://api.2captcha.com"
                              : "https://api.rucaptcha.com"
                        }
                        className="w-full px-2.5 h-9 rounded-lg bg-white/[0.03] text-[12px] text-slate-200 mono outline-none placeholder:text-slate-600"
                        style={{ boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)" }}
                      />
                    </div>
                  </div>
                )}

                {solver.adapter === "webhook" && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    <div>
                      <div className="text-[11px] text-slate-500 mb-1">Webhook URL</div>
                      <input
                        type="text"
                        value={solver.webhookUrl ?? ""}
                        onChange={(e) => void patchSolver({ webhookUrl: e.target.value })}
                        placeholder="http://127.0.0.1:9090/solve"
                        className="w-full px-2.5 h-9 rounded-lg bg-white/[0.03] text-[12px] text-slate-200 mono outline-none placeholder:text-slate-600"
                        style={{ boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)" }}
                      />
                    </div>
                    <div>
                      <div className="text-[11px] text-slate-500 mb-1">HMAC Secret (optional)</div>
                      <input
                        type="password"
                        value={solver.webhookSecret ?? ""}
                        onChange={(e) => void patchSolver({ webhookSecret: e.target.value })}
                        placeholder="X-MultiZen-Signature secret"
                        className="w-full px-2.5 h-9 rounded-lg bg-white/[0.03] text-[12px] text-slate-200 mono outline-none placeholder:text-slate-600"
                        style={{ boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)" }}
                      />
                    </div>
                  </div>
                )}

                {solver.adapter === "module" && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    <div>
                      <div className="text-[11px] text-slate-500 mb-1">ESM Module Path</div>
                      <input
                        type="text"
                        value={solver.modulePath ?? ""}
                        onChange={(e) => void patchSolver({ modulePath: e.target.value })}
                        placeholder="/path/to/solver-adapter.mjs"
                        className="w-full px-2.5 h-9 rounded-lg bg-white/[0.03] text-[12px] text-slate-200 mono outline-none placeholder:text-slate-600"
                        style={{ boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)" }}
                      />
                    </div>
                    <div>
                      <div className="text-[11px] text-slate-500 mb-1">Adapter API Key (optional)</div>
                      <input
                        type="password"
                        value={solver.apiKey ?? ""}
                        onChange={(e) => void patchSolver({ apiKey: e.target.value })}
                        placeholder="Passed to createSolverPort({ apiKey })"
                        className="w-full px-2.5 h-9 rounded-lg bg-white/[0.03] text-[12px] text-slate-200 mono outline-none placeholder:text-slate-600"
                        style={{ boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)" }}
                      />
                    </div>
                  </div>
                )}

                <label className="flex items-center gap-2.5 text-[12px] text-slate-400 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={solver.allowMainWorldJs}
                    onChange={(e) => void patchSolver({ allowMainWorldJs: e.target.checked })}
                    className="w-3.5 h-3.5 rounded accent-purple-500"
                  />
                  Allow main-world JS callback execution after token injection
                </label>

                <div className="flex items-center gap-2.5 flex-wrap">
                  <button
                    type="button"
                    className="btn-secondary px-3 py-[7px] text-[12px] rounded-[9px]"
                    onClick={() => void testSolverPort()}
                    disabled={solverTestBusy || solver.adapter === "none"}
                  >
                    {solverTestBusy ? "Testing…" : "Test solver port"}
                  </button>
                  {solverTestResult && (
                    <span
                      className={`text-[12px] ${
                        solverTestResult.ok ? "text-emerald-400" : "text-amber-400"
                      }`}
                    >
                      {solverTestResult.message}
                    </span>
                  )}
                </div>
              </div>
            );
          })()}
        </Row>

        <Row
          icon={<Monitor size={16} strokeWidth={1.5} />}
          title="Default display mode"
          desc="How a profile opens unless it has its own choice. Running profiles keep the mode they started in."
        >
          <div className="grid gap-2 sm:grid-cols-2">
            {displayModeChoices(info?.platform ?? "", settings.defaultDisplayMode).map((option) => {
              const selected = (settings.defaultDisplayMode ?? "headed") === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => void patch({ defaultDisplayMode: option.value })}
                  className="text-left p-3 rounded-lg transition-colors"
                  style={{
                    boxShadow: selected
                      ? "inset 0 0 0 1px rgba(168,85,247,0.45)"
                      : "inset 0 0 0 1px rgba(255,255,255,0.07)",
                    background: selected ? "rgba(168,85,247,0.08)" : "rgba(255,255,255,0.025)",
                  }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[13px] font-medium text-slate-100">
                      {displayModeLabel(option.value)}
                    </span>
                    {selected && <Pill kind="running">active</Pill>}
                  </div>
                  <div className="text-[11px] text-slate-500 mt-1 leading-relaxed">
                    {option.description}
                  </div>
                </button>
              );
            })}
          </div>
        </Row>

        <Row
          icon={<Chrome size={16} strokeWidth={1.5} />}
          title="Default engine for new profiles"
          desc="New profiles use this engine unless you pick another. Existing profiles keep their own."
        >
          <div className="grid gap-2 sm:grid-cols-2">
            {engineOptions.map((option) => {
              const selected = settings.browserEngine === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => void patch({ browserEngine: option.value })}
                  className="text-left p-3 rounded-lg transition-colors"
                  style={{
                    boxShadow: selected
                      ? "inset 0 0 0 1px rgba(168,85,247,0.45)"
                      : "inset 0 0 0 1px rgba(255,255,255,0.07)",
                    background: selected ? "rgba(168,85,247,0.08)" : "rgba(255,255,255,0.025)",
                  }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[13px] font-medium text-slate-100">{option.label}</span>
                    {selected && <Pill kind="running">active</Pill>}
                  </div>
                  <div className="text-[11px] text-slate-500 mt-1 leading-relaxed">
                    {option.description}
                  </div>
                </button>
              );
            })}
          </div>

          <div className="mt-3 flex items-center gap-2.5 flex-wrap">
            <span className="text-[12px] text-slate-400">
              {chromiumStatus?.kind === "ready"
                ? `Installed: v${chromiumStatus.version}`
                : "Engine not downloaded yet"}
            </span>
            <button
              type="button"
              className="btn-secondary px-3 py-[7px] text-[12px] rounded-[9px] inline-flex items-center gap-1.5"
              onClick={() => void checkEngineForUpdates()}
              disabled={
                engineUpdateStatus?.kind === "checking" ||
                engineUpdateStatus?.kind === "downloading"
              }
            >
              <RefreshCw
                size={12}
                className={
                  engineUpdateStatus?.kind === "checking" ||
                  engineUpdateStatus?.kind === "downloading"
                    ? "animate-spin"
                    : ""
                }
              />
              Check for updates
            </button>
            <span className="text-[12px] text-slate-400">
              {engineUpdateLabel(engineUpdateStatus)}
            </span>
          </div>
          <label className="flex items-center gap-2.5 mt-3 text-[12px] text-slate-400 cursor-pointer">
            <input
              type="checkbox"
              checked={settings.engineAutoUpdate}
              onChange={(e) => void patch({ engineAutoUpdate: e.target.checked })}
              className="w-3.5 h-3.5 rounded accent-purple-500"
            />
            Automatically keep the browser engine up to date
          </label>
        </Row>

        {sandbox && sandbox.state !== "n/a" && sandbox.state !== "not-restricted" && (
          <Row
            icon={<ShieldAlert size={16} strokeWidth={1.5} />}
            title="Linux browser sandbox"
            desc="This kernel restricts the browser's sandbox. MultiZen can re-enable it for just this browser with a one-time system authorization — the sandbox stays on with no warning banner."
          >
            <div className="flex items-center gap-2.5 flex-wrap">
              {sandbox.state === "active" ? (
                <Pill kind="running" dot>
                  sandbox on
                </Pill>
              ) : (
                <>
                  <Pill kind="idle">
                    {sandbox.state === "declined"
                      ? "launching without sandbox"
                      : sandbox.state === "unsupported"
                        ? "sandbox unavailable"
                        : "setup needed"}
                  </Pill>
                  {sandbox.state !== "unsupported" && (
                    <button
                      type="button"
                      className="btn-secondary px-3 py-[7px] text-[12px] rounded-[9px]"
                      onClick={() => void runSandboxSetup()}
                      disabled={sandboxBusy}
                    >
                      {sandboxBusy ? "Setting up…" : "Set up secure sandbox"}
                    </button>
                  )}
                </>
              )}
            </div>
            {sandbox.reasonText && (
              <div className="text-[11px] text-slate-500 mt-2 leading-relaxed">
                {sandbox.reasonText}
              </div>
            )}
            {sandbox.manualCommand && (
              <div className="mt-2">
                <div className="text-[11px] text-slate-600 mb-1">Or enable it manually:</div>
                <div
                  className="flex items-center gap-2"
                  style={{
                    padding: "8px 12px",
                    borderRadius: 10,
                    background: "rgba(255,255,255,0.03)",
                    boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.06)",
                  }}
                >
                  <span className="flex-1 mono text-[12px] text-slate-300 truncate">
                    {sandbox.manualCommand}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText(sandbox.manualCommand ?? "");
                      setSandboxCmdCopied(true);
                      window.setTimeout(() => setSandboxCmdCopied(false), 1500);
                    }}
                    className="text-purple-400 hover:text-purple-300 transition-colors"
                    aria-label="Copy command"
                  >
                    {sandboxCmdCopied ? <Check size={13} /> : <Copy size={13} />}
                  </button>
                </div>
              </div>
            )}
          </Row>
        )}

        <Row
          icon={<Boxes size={16} strokeWidth={1.5} />}
          title="Archives"
          desc=".mzar files are encrypted bundles of profiles — cookies, login state, fingerprints, notes — protected with a passphrase you set at export time."
        >
          <div className="flex gap-2">
            <button
              type="button"
              className="btn-secondary px-3 py-[7px] text-[12px] rounded-[9px]"
              onClick={onImport}
            >
              Import .mzar archive
            </button>
            <a
              href="https://github.com/multizenteam/multizen-browser#archives"
              target="_blank"
              rel="noopener"
              className="btn-ghost px-3 py-[7px] text-[12px] rounded-[9px]"
            >
              Read archive format docs
            </a>
          </div>
        </Row>

        <Row
          icon={<DownloadCloud size={16} strokeWidth={1.5} />}
          title="Updates"
          desc={
            info?.platform === "darwin"
              ? "Auto-install isn't available on macOS yet — we'll notify you in-app to download the new version."
              : "MultiZen checks for updates in the background and installs them on restart."
          }
        >
          <div className="flex items-center gap-2.5 flex-wrap">
            <button
              type="button"
              className="btn-secondary px-3 py-[7px] text-[12px] rounded-[9px] inline-flex items-center gap-1.5"
              onClick={() => void checkForUpdates()}
              disabled={updateStatus?.kind === "checking"}
            >
              <RefreshCw
                size={12}
                className={updateStatus?.kind === "checking" ? "animate-spin" : ""}
              />
              Check for updates
            </button>
            <span className="text-[12px] text-slate-400">{updateLabel(updateStatus)}</span>
          </div>
          <div className="text-[11px] text-slate-600 mt-2">
            Last checked: {lastChecked ? relativeTime(new Date(lastChecked).toISOString()) : "never"}
          </div>
          <label className="flex items-center gap-2.5 mt-3 text-[12px] text-slate-400 cursor-pointer">
            <input
              type="checkbox"
              checked={settings.autoUpdate}
              onChange={(e) => void patch({ autoUpdate: e.target.checked })}
              className="w-3.5 h-3.5 rounded accent-purple-500"
            />
            Automatically check for updates
          </label>
        </Row>

        <Row
          icon={<ShieldCheck size={16} strokeWidth={1.5} />}
          title="Anonymous usage"
          desc="Off by default. Help gauge how many people run MultiZen."
        >
          <label className="flex items-center gap-2.5 text-[12px] text-slate-400 cursor-pointer">
            <input
              type="checkbox"
              checked={settings.usageReporting}
              onChange={(e) => void patch({ usageReporting: e.target.checked })}
              className="w-3.5 h-3.5 rounded accent-purple-500"
            />
            Send an anonymous daily heartbeat
          </label>
          <div className="text-[11px] text-slate-600 mt-2 leading-relaxed">
            When on, sends once a day: app version, OS family, and a random
            single-use token — <b>no</b> account, <b>no</b> persistent ID, and your IP is
            never stored (a coarse country is derived server-side then discarded). No
            profiles, proxies, or browsing are ever included. Set{" "}
            <code className="text-slate-500">MULTIZEN_NO_TELEMETRY=1</code> to force it off.
          </div>
        </Row>

        <Row icon={<Sparkles size={16} strokeWidth={1.5} />} title="About" desc="">
          <div className="mono text-[12px] text-slate-400 leading-relaxed">
            MultiZen Extended v{info?.appVersion ?? "0.0.0"} · {info?.platform ?? "—"} · Electron{" "}
            {electronVersion()}
          </div>
        </Row>
      </div>
    </div>
  );
}

const engineOptions: Array<{
  value: AppSettings["browserEngine"];
  label: string;
  description: string;
}> = [
  {
    value: "cloakbrowser",
    label: "CloakBrowser",
    description: "Source-patched Chromium from CloakHQ releases. Primary runtime.",
  },
  {
    value: "camoufox",
    label: "Camoufox",
    description: "Firefox-based anti-detect. A non-Chrome TLS/JS fingerprint.",
  },
];

function electronVersion(): string {
  // Vite injects nothing useful here; just use a stable string for now.
  return "33";
}

function updateLabel(status: UpdateStatus | null): string {
  switch (status?.kind) {
    case "checking":
      return "Checking…";
    case "up-to-date":
      return "You're on the latest version";
    case "available":
      return `v${status.version} available`;
    case "downloading":
      return `Downloading v${status.version}… ${status.percent}%`;
    case "ready":
      return `v${status.version} ready — restart to update`;
    case "error":
      return `Check failed: ${status.message}`;
    default:
      return "";
  }
}

function engineUpdateLabel(status: EngineUpdateStatus | null): string {
  switch (status?.kind) {
    case "checking":
      return "Checking…";
    case "up-to-date":
      return "Engine is up to date";
    case "available":
      return `v${status.version} available`;
    case "downloading": {
      const pct =
        status.bytesTotal > 0
          ? Math.round((status.bytesReceived / status.bytesTotal) * 100)
          : 0;
      return `Downloading v${status.version}… ${pct}%`;
    }
    case "staged":
      return `v${status.version} will apply next time you launch a profile`;
    case "error":
      return `Check failed: ${status.message}`;
    default:
      return "";
  }
}

function Row({
  icon,
  title,
  desc,
  children,
}: {
  icon: ReactNode;
  title: string;
  desc: ReactNode;
  children?: ReactNode;
}): JSX.Element {
  return (
    <div
      className="flex items-start gap-3.5"
      style={{
        padding: "16px 0",
        borderBottom: "1px solid rgba(255,255,255,0.04)",
      }}
    >
      <div
        className="flex items-center justify-center flex-shrink-0"
        style={{
          width: 36,
          height: 36,
          borderRadius: 10,
          background: "rgba(168,85,247,0.10)",
          boxShadow: "inset 0 0 0 1px rgba(168,85,247,0.18)",
          color: "#c084fc",
        }}
      >
        {icon}
      </div>
      <div className="flex-1">
        <div className="text-[13px] font-semibold text-slate-100">{title}</div>
        {desc && (
          <div className="text-[12px] text-slate-500 mt-1 leading-relaxed max-w-[480px]">
            {desc}
          </div>
        )}
        {children && <div className="mt-2.5">{children}</div>}
      </div>
    </div>
  );
}
