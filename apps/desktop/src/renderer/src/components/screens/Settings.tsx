import { useEffect, useState, type JSX, type ReactNode } from "react";
import { Boxes, Check, Chrome, Copy, Sparkles, Zap } from "lucide-react";
import { Pill } from "../atoms";
import type { AppSettings, SystemInfo } from "../../types";

interface Props {
  onImport: () => void;
}

export function Settings({ onImport }: Props): JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!window.multizen) return;
    void window.multizen.settings.get().then(setSettings);
    void window.multizen.system.info().then(setInfo);
  }, []);

  async function patch(p: Partial<AppSettings>): Promise<void> {
    if (!settings) return;
    const next = await window.multizen.settings.update(p);
    setSettings(next);
  }

  function copyMcpUrl(): void {
    if (!info?.mcpHttpUrl) return;
    navigator.clipboard.writeText(info.mcpHttpUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
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
          desc="Local HTTP transport that Cursor / Claude Desktop / Cline / any MCP client connects to. Add this URL to your client config."
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
          icon={<Chrome size={16} strokeWidth={1.5} />}
          title="Browser engine"
          desc="Applied on next app launch."
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
        </Row>

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

        <Row icon={<Sparkles size={16} strokeWidth={1.5} />} title="About" desc="">
          <div className="mono text-[12px] text-slate-400 leading-relaxed">
            MultiZen v{info?.appVersion ?? "0.0.0"} · {info?.platform ?? "—"} · Electron{" "}
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
    value: "cft",
    label: "Chrome for Testing",
    description: "Compatibility fallback using Google's official automation build.",
  },
];

function electronVersion(): string {
  // Vite injects nothing useful here; just use a stable string for now.
  return "33";
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
