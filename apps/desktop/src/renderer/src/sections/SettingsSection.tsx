import { useEffect, useState, type JSX } from "react";
import { Check, Copy, ExternalLink, Server } from "lucide-react";
import { Button } from "../components/ui/Button";
import { PageHeader } from "../components/PageHeader";
import type { AppSettings, SystemInfo } from "../types";

export function SettingsSection(): JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!window.multizen) return;
    void window.multizen.settings.get().then(setSettings);
    void window.multizen.system.info().then(setInfo);
  }, []);

  if (!settings) {
    return <div className="text-sm text-slate-400">Loading…</div>;
  }

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

  return (
    <div className="max-w-2xl mx-auto">
      <PageHeader
        title="Settings"
        description="Configuration is local to your machine. MultiZen does not call any external API on your behalf."
      />

      <Card icon={<Server size={16} />} title="MCP HTTP transport">
        <p className="text-xs text-slate-400 leading-relaxed mb-4">
          When enabled, Cursor / Claude Desktop / any MCP client can connect to the running
          desktop app at the URL below. Disable to require explicit stdio spawning.
        </p>
        <label className="flex items-center gap-3 mb-4 cursor-pointer">
          <input
            type="checkbox"
            checked={settings.mcpHttpEnabled}
            onChange={(e) => void patch({ mcpHttpEnabled: e.target.checked })}
            className="w-4 h-4 rounded accent-purple-500"
          />
          <span className="text-sm">Enable MCP HTTP server on localhost:{settings.mcpHttpPort}</span>
        </label>
        {info?.mcpHttpUrl && (
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs px-3 py-2 rounded bg-white/[0.02] ring-1 ring-white/5 text-slate-400 font-mono truncate">
              {info.mcpHttpUrl}
            </code>
            <Button
              variant="secondary"
              size="icon"
              onClick={copyMcpUrl}
              aria-label="Copy URL"
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </Button>
          </div>
        )}
      </Card>

      <Card icon={<ExternalLink size={16} />} title="About">
        <dl className="text-xs grid grid-cols-2 gap-y-2">
          <dt className="text-slate-400">App version</dt>
          <dd className="font-mono">{info?.appVersion ?? "—"}</dd>
          <dt className="text-slate-400">Platform</dt>
          <dd className="font-mono">{info?.platform ?? "—"}</dd>
        </dl>
      </Card>
    </div>
  );
}

function Card({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section className="rounded-xl bg-white/[0.02] ring-1 ring-white/5 p-5 mb-4">
      <header className="flex items-center gap-2 mb-4">
        <span className="text-purple-400">{icon}</span>
        <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
      </header>
      {children}
    </section>
  );
}
