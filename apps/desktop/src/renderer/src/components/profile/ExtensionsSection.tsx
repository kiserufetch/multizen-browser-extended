import { useEffect, useState, type JSX } from "react";
import { Blocks, Loader2, Plus, Trash2 } from "lucide-react";
import type { ExtensionConfig } from "../../types";

/**
 * Per-profile extensions manager, shared by the create + edit sheets. Mirrors
 * the Proxy section. Fully functional once the profile exists (has an id);
 * during create (profileId === null) it shows a hint to save first.
 */
export function ExtensionsSection({
  profileId,
}: {
  profileId: string | null;
}): JSX.Element {
  const [items, setItems] = useState<ExtensionConfig[]>([]);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!profileId || !window.multizen) return;
    void window.multizen.extensions.list(profileId).then(setItems);
    // A companion "Add to MultiZen" install (while editing a running profile)
    // pushes here — refresh the list.
    return window.multizen.extensions.onInstalled((e) => {
      if (e.profileId === profileId) {
        void window.multizen.extensions.list(profileId).then(setItems);
        if (!e.ok) setError(e.error);
      }
    });
  }, [profileId]);

  async function run(fn: () => Promise<ExtensionConfig[]>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      setItems(await fn());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!profileId) {
    return (
      <div className="text-[12px] text-slate-500 leading-relaxed">
        Save the profile first — then you can add extensions (.crx / .zip / folder, or by
        Chrome Web Store link) and they'll load in this profile only.
      </div>
    );
  }

  const pid = profileId;
  return (
    <div className="space-y-2.5">
      {items.length > 0 && (
        <div className="space-y-1.5">
          {items.map((ext) => (
            <div
              key={ext.id}
              className="flex items-center gap-2.5 px-3 py-2 rounded-lg"
              style={{
                background: "rgba(255,255,255,0.03)",
                boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.06)",
              }}
            >
              <Blocks size={14} className="text-purple-300 shrink-0" />
              <span className="flex-1 text-[12px] text-slate-200 truncate">{ext.name}</span>
              <label className="flex items-center gap-1.5 text-[11px] text-slate-400 cursor-pointer">
                <input
                  type="checkbox"
                  checked={ext.enabled}
                  onChange={(e) =>
                    void run(() => window.multizen.extensions.toggle(pid, ext.id, e.target.checked))
                  }
                  className="w-3.5 h-3.5 rounded accent-purple-500"
                />
                on
              </label>
              <button
                type="button"
                aria-label="Remove"
                onClick={() => void run(() => window.multizen.extensions.remove(pid, ext.id))}
                className="text-slate-500 hover:text-red-400 transition-colors"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        <Input
          value={url}
          onChange={setUrl}
          placeholder="Chrome Web Store URL or extension ID"
        />
        <button
          type="button"
          disabled={busy || !url.trim()}
          onClick={() =>
            void run(async () => {
              const next = await window.multizen.extensions.addFromWebStore(pid, url.trim());
              setUrl("");
              return next;
            })
          }
          className="btn-secondary px-3 py-[7px] text-[12px] rounded-[9px] whitespace-nowrap inline-flex items-center gap-1.5"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
          Add
        </button>
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(() => window.multizen.extensions.addFromFile(pid))}
          className="btn-ghost px-3 py-[7px] text-[12px] rounded-[9px]"
        >
          Add .crx / .zip…
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(() => window.multizen.extensions.addFromFolder(pid))}
          className="btn-ghost px-3 py-[7px] text-[12px] rounded-[9px]"
        >
          Add folder…
        </button>
      </div>

      <div className="text-[11px] text-slate-600 leading-relaxed">
        Or open the Chrome Web Store inside this profile and click <b>Add to MultiZen</b>.
        Changes apply on the next launch.
      </div>

      {error && (
        <div
          className="px-3 py-2 rounded-lg text-[12px] text-red-400"
          style={{
            background: "rgba(239,68,68,0.06)",
            boxShadow: "inset 0 0 0 1px rgba(239,68,68,0.25)",
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}

function Input({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}): JSX.Element {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="flex-1 px-2.5 h-9 rounded-lg bg-white/[0.03] text-[12px] text-slate-200 placeholder:text-slate-600 outline-none focus:bg-white/[0.05] transition-colors"
      style={{ boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)" }}
    />
  );
}
