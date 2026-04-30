import { useEffect, useState, type JSX } from "react";
import { Check, Copy, ExternalLink, KeyRound, Server } from "lucide-react";
import { Button } from "../components/ui/Button";
import { Input, Label } from "../components/ui/Input";
import { PageHeader } from "../components/PageHeader";
import type { AppSettings, SystemInfo } from "../types";

export function SettingsSection(): JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!window.multizen) return;
    void window.multizen.settings.get().then((s) => {
      setSettings(s);
      setKeyDraft(s.anthropicApiKey ?? "");
    });
    void window.multizen.system.info().then(setInfo);
  }, []);

  if (!settings) {
    return <div className="text-sm text-[--color-fg-muted]">Loading…</div>;
  }

  async function patch(p: Partial<AppSettings>): Promise<void> {
    if (!settings) return;
    const next = await window.multizen.settings.update(p);
    setSettings(next);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1500);
  }

  async function saveKey(): Promise<void> {
    await patch({ anthropicApiKey: keyDraft.trim() });
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
        description="Configuration is local to your machine. Secrets live in your OS keychain — we never send them anywhere."
      />

      <Card icon={<KeyRound size={16} />} title="Anthropic API key (BYOK)">
        <p className="text-xs text-[--color-fg-muted] leading-relaxed mb-4">
          Used for natural-language click target resolution and structured extraction. Stored
          in your OS keychain. The desktop app never proxies this key — every Anthropic call
          comes from your local process to Anthropic directly.
        </p>
        <Label>API key</Label>
        <Input
          type="password"
          placeholder="sk-ant-…"
          value={keyDraft}
          onChange={(e) => setKeyDraft(e.target.value)}
          className="font-mono"
        />
        <div className="mt-3 flex items-center justify-between">
          <div className="text-[11px] text-[--color-fg-dim]">
            Model: <code className="text-[--color-fg-muted]">{settings.resolverModel}</code>
          </div>
          <Button
            variant="primary"
            size="sm"
            onClick={saveKey}
            leftIcon={saved ? <Check size={12} /> : undefined}
          >
            {saved ? "Saved" : "Save key"}
          </Button>
        </div>
      </Card>

      <Card icon={<Server size={16} />} title="MCP HTTP transport">
        <p className="text-xs text-[--color-fg-muted] leading-relaxed mb-4">
          When enabled, Cursor / Claude Desktop / any MCP client can connect to the running
          desktop app at the URL below. Disable to require explicit stdio spawning.
        </p>
        <label className="flex items-center gap-3 mb-4 cursor-pointer">
          <input
            type="checkbox"
            checked={settings.mcpHttpEnabled}
            onChange={(e) => void patch({ mcpHttpEnabled: e.target.checked })}
            className="w-4 h-4 rounded accent-[--color-accent-purple]"
          />
          <span className="text-sm">Enable MCP HTTP server on localhost:{settings.mcpHttpPort}</span>
        </label>
        {info?.mcpHttpUrl && (
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs px-3 py-2 rounded bg-[--color-bg-soft] border border-[--color-border] text-[--color-fg-muted] font-mono truncate">
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
          <dt className="text-[--color-fg-muted]">App version</dt>
          <dd className="font-mono">{info?.appVersion ?? "—"}</dd>
          <dt className="text-[--color-fg-muted]">Platform</dt>
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
    <section className="surface-1 rounded-xl p-5 mb-4">
      <header className="flex items-center gap-2 mb-4">
        <span className="text-[--color-accent-pink]">{icon}</span>
        <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
      </header>
      {children}
    </section>
  );
}
