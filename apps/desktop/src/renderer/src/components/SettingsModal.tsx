import { useEffect, useState, type JSX, type ReactNode } from "react";
import type { AppSettings, SystemInfo } from "../types";

interface Props {
  onClose: () => void;
}

export function SettingsModal({ onClose }: Props): JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void window.multizen.settings.get().then((s) => {
      setSettings(s);
      setKeyDraft(s.anthropicApiKey ?? "");
    });
    void window.multizen.system.info().then(setInfo);
  }, []);

  async function save(): Promise<void> {
    if (!settings) return;
    setSaving(true);
    try {
      const next = await window.multizen.settings.update({
        anthropicApiKey: keyDraft.trim() || "",
        resolverModel: settings.resolverModel,
        mcpHttpEnabled: settings.mcpHttpEnabled,
        mcpHttpPort: settings.mcpHttpPort,
      });
      setSettings(next);
      onClose();
    } finally {
      setSaving(false);
    }
  }

  if (!settings) {
    return (
      <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 backdrop-blur-sm">
        <div className="text-[--color-fg-muted]">Loading…</div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/60 backdrop-blur-sm overflow-y-auto py-12">
      <div className="bg-[--color-bg-elevated] border border-[--color-border] rounded-xl w-full max-w-xl mx-4 p-6">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-semibold">Settings</h2>
          <button onClick={onClose} className="text-sm text-[--color-fg-muted] hover:text-[--color-fg]">
            Close
          </button>
        </div>

        <Section
          title="Anthropic API key (BYOK)"
          help="Used for natural-language click target resolution and structured extraction. Stored in your OS keychain, never sent to MultiZen servers."
        >
          <input
            type="password"
            placeholder="sk-ant-…"
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.target.value)}
            className="w-full px-3 h-10 rounded-md bg-[--color-bg] border border-[--color-border] text-sm focus:border-[--color-accent-purple] focus:outline-none font-mono"
          />
          <div className="mt-2 text-xs text-[--color-fg-dim]">
            Model: <code>{settings.resolverModel}</code>
          </div>
        </Section>

        <Section
          title="MCP HTTP server"
          help="When enabled, external MCP clients (Cursor, Claude Desktop) can connect to MultiZen at the URL below. When disabled, only stdio-spawned MCP works."
        >
          <label className="flex items-center gap-2 text-sm mb-3">
            <input
              type="checkbox"
              checked={settings.mcpHttpEnabled}
              onChange={(e) =>
                setSettings({ ...settings, mcpHttpEnabled: e.target.checked })
              }
            />
            <span>Enable MCP HTTP server on localhost:{settings.mcpHttpPort}</span>
          </label>
          {info?.mcpHttpUrl && (
            <code className="block text-xs px-3 py-2 rounded bg-[--color-bg] border border-[--color-border] text-[--color-fg-muted]">
              {info.mcpHttpUrl}
            </code>
          )}
        </Section>

        <div className="mt-6 pt-6 border-t border-[--color-border] flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 h-10 rounded-md border border-[--color-border] text-sm hover:border-[--color-fg-muted]"
          >
            Cancel
          </button>
          <button
            disabled={saving}
            onClick={save}
            className="px-4 h-10 rounded-md bg-gradient-to-r from-[--color-accent-orange] via-[--color-accent-pink] to-[--color-accent-purple] text-white text-sm font-medium disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  help,
  children,
}: {
  title: string;
  help?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="mb-6">
      <h3 className="text-sm font-semibold mb-1">{title}</h3>
      {help && <p className="text-xs text-[--color-fg-muted] mb-3 leading-relaxed">{help}</p>}
      {children}
    </div>
  );
}
