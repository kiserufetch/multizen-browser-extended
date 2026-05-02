import { useState, type JSX } from "react";
import { Plus } from "lucide-react";
import { Kbd } from "../atoms";

interface Props {
  onCancel: () => void;
  onCreated: (id: string, autoLaunch: boolean) => void;
}

/**
 * Inline create-profile sheet. Sits inside the canvas (not a modal), purple-bordered.
 */
export function NewProfileSheet({ onCancel, onCreated }: Props): JSX.Element {
  const [name, setName] = useState("");
  const [tagsRaw, setTagsRaw] = useState("");
  const [proxyRaw, setProxyRaw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function parseProxy(): { type: "http" | "socks5"; host: string; port: number; username?: string; password?: string } | undefined {
    const t = proxyRaw.trim();
    if (!t) return undefined;
    try {
      const u = new URL(t);
      const type = u.protocol.startsWith("socks") ? "socks5" : "http";
      const port = Number(u.port) || (type === "http" ? 8080 : 1080);
      return {
        type,
        host: u.hostname,
        port,
        username: u.username || undefined,
        password: u.password || undefined,
      };
    } catch {
      throw new Error("Proxy URL must be like socks5://user:pass@host:1080");
    }
  }

  async function submit(autoLaunch: boolean): Promise<void> {
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const proxy = parseProxy();
      const tags = tagsRaw.split(",").map((s) => s.trim()).filter(Boolean);
      const created = await window.multizen.profiles.create({
        name: name.trim(),
        tags,
        proxy,
      });
      onCreated(created.id, autoLaunch);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div
      className="mx-6 mb-4"
      style={{
        borderRadius: 16,
        background: "rgba(255,255,255,0.025)",
        boxShadow:
          "inset 0 0 0 1px rgba(168,85,247,0.25), 0 24px 48px -16px rgba(0,0,0,0.6), 0 0 40px rgba(168,85,247,0.12)",
        backdropFilter: "blur(20px)",
        padding: 18,
        animation: "mz-slide-up 200ms cubic-bezier(0.2,0.8,0.2,1)",
      }}
    >
      <div className="flex items-center gap-2.5 mb-3.5">
        <Plus size={14} className="text-purple-400" />
        <div className="text-[14px] font-bold text-slate-100">New profile</div>
        <span className="mono text-[10px] text-slate-500">esc to cancel</span>
        <div className="flex-1" />
        <button type="button" className="btn-ghost px-3 py-[7px] text-[12px] rounded-[9px]" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          disabled={busy || !name.trim()}
          onClick={() => void submit(false)}
          className="btn-secondary px-3 py-[7px] text-[12px] rounded-[9px]"
        >
          Create
        </button>
        <button
          type="button"
          disabled={busy || !name.trim()}
          onClick={() => void submit(true)}
          className="btn-brand px-3 py-[7px] text-[12px] rounded-[9px]"
        >
          {busy ? "…" : "Create & launch"}
          <Kbd>⌘ ⏎</Kbd>
        </button>
      </div>

      <div className="grid grid-cols-3 gap-2.5">
        <Field label="Name">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="acme — sales · west"
            className="sheet-input mono"
          />
        </Field>
        <Field label="Tags">
          <input
            value={tagsRaw}
            onChange={(e) => setTagsRaw(e.target.value)}
            placeholder="linkedin, client-acme"
            className="sheet-input mono"
          />
        </Field>
        <Field label="Proxy (optional)">
          <input
            value={proxyRaw}
            onChange={(e) => setProxyRaw(e.target.value)}
            placeholder="socks5://user:pass@host:1080"
            className="sheet-input mono"
          />
        </Field>
      </div>

      <div
        className="mt-3 flex items-center gap-2.5 text-[12px] text-slate-300"
        style={{
          padding: "10px 12px",
          borderRadius: 10,
          background: "rgba(255,255,255,0.02)",
          boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.05)",
        }}
      >
        <span className="text-slate-400">Fingerprint:</span>
        <span className="mono text-slate-400 truncate">
          auto-generated · Chrome 130 / macOS · en-US · America/New_York · 1440×900
        </span>
        <span className="flex-1" />
        <button type="button" className="text-[10px] text-slate-400 px-2 py-1 rounded bg-white/[0.04] hover:bg-white/[0.06]">
          regen
        </button>
      </div>

      <div className="mt-2 text-[11px] text-slate-500 leading-relaxed">
        Cookies, login state, and fingerprint live in this profile only. They never leak to other profiles.
      </div>

      {error && (
        <div
          className="mt-3 px-3 py-2 rounded-lg text-[12px] text-red-400"
          style={{ background: "rgba(239,68,68,0.06)", boxShadow: "inset 0 0 0 1px rgba(239,68,68,0.25)" }}
        >
          {error}
        </div>
      )}

      <style>{`
        .sheet-input {
          padding: 8px 11px;
          border-radius: 9px;
          background: rgba(255,255,255,0.04);
          box-shadow: inset 0 0 0 1px rgba(255,255,255,0.08);
          color: #cbd5e1;
          font-size: 12px;
          font-weight: 500;
          width: 100%;
          border: 0;
          outline: 0;
          transition: box-shadow 150ms;
        }
        .sheet-input::placeholder { color: rgba(71,85,105,1); }
        .sheet-input:focus {
          box-shadow: inset 0 0 0 1px rgba(168,85,247,0.4);
          background: rgba(255,255,255,0.05);
        }
      `}</style>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[11px] font-medium text-slate-500">{label}</div>
      {children}
    </div>
  );
}
