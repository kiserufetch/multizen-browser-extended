import { useEffect, useRef, useState, type JSX, type ReactNode } from "react";
import { ChevronDown, Settings2 } from "lucide-react";
import { Kbd } from "../atoms";
import { FingerprintForm } from "./FingerprintForm";
import { ProxyTester } from "./ProxyTester";
import type { FingerprintConfig, ProxyConfig } from "../../types";

interface Props {
  onCancel: () => void;
  onCreated: (id: string, autoLaunch: boolean) => void;
  /**
   * Reports whether the user has modified anything that would be lost on
   * close. The parent uses this to decide whether to prompt before
   * dismissing.
   */
  onDirtyChange?: (dirty: boolean) => void;
}

interface DraftProxy {
  enabled: boolean;
  type: "http" | "socks5";
  host: string;
  port: string;
  username: string;
  password: string;
}

const EMPTY_PROXY: DraftProxy = {
  enabled: false,
  type: "http",
  host: "",
  port: "",
  username: "",
  password: "",
};

/**
 * Inline create-profile sheet. Uses the same `<FingerprintForm />` as the
 * Inspector edit mode so create and edit are pixel-identical.
 */
export function NewProfileSheet({ onCancel, onCreated, onDirtyChange }: Props): JSX.Element {
  const [name, setName] = useState("");
  const [tagsRaw, setTagsRaw] = useState("");
  const [proxy, setProxy] = useState<DraftProxy>(EMPTY_PROXY);
  const [fingerprint, setFingerprint] = useState<FingerprintConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Auto-generate a fingerprint preset on mount so the create call always
  // has one and the regen button has something to replace.
  useEffect(() => {
    if (!window.multizen) return;
    void window.multizen.fingerprint.generate().then(setFingerprint);
  }, []);

  // Track "dirty" — anything the user typed that's not the default. The
  // freshly-generated fingerprint isn't user input so we ignore it.
  const dirtyRef = useRef(false);
  useEffect(() => {
    const dirty =
      name.trim() !== "" ||
      tagsRaw.trim() !== "" ||
      proxy.enabled ||
      proxy.host !== "" ||
      proxy.username !== "" ||
      proxy.password !== "";
    if (dirty !== dirtyRef.current) {
      dirtyRef.current = dirty;
      onDirtyChange?.(dirty);
    }
  }, [name, tagsRaw, proxy, onDirtyChange]);

  function buildProxy(): ProxyConfig | undefined {
    if (!proxy.enabled) return undefined;
    if (!proxy.host) {
      throw new Error("Proxy host is required");
    }
    return {
      type: proxy.type,
      host: proxy.host,
      port: Number(proxy.port) || (proxy.type === "http" ? 8080 : 1080),
      username: proxy.username || undefined,
      password: proxy.password || undefined,
    };
  }

  // Derive a ProxyConfig snapshot for the FingerprintForm so it can probe geo.
  const proxyForForm: ProxyConfig | undefined = proxy.enabled && proxy.host
    ? {
        type: proxy.type,
        host: proxy.host,
        port: Number(proxy.port) || (proxy.type === "http" ? 8080 : 1080),
        username: proxy.username || undefined,
        password: proxy.password || undefined,
      }
    : undefined;

  async function submit(autoLaunch: boolean): Promise<void> {
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const tags = tagsRaw.split(",").map((s) => s.trim()).filter(Boolean);
      const built = buildProxy();
      const created = await window.multizen.profiles.create({
        name: name.trim(),
        tags,
        proxy: built,
        fingerprint: fingerprint ?? undefined,
      });
      onCreated(created.id, autoLaunch);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="px-5 py-4">
      {/* General */}
      <Group label="General">
        <div className="grid grid-cols-2 gap-2.5">
          <Field label="Name">
            <Input
              autoFocus
              value={name}
              onChange={setName}
              placeholder="e.g. acme — sales · west"
            />
          </Field>
          <Field label="Tags">
            <Input
              value={tagsRaw}
              onChange={setTagsRaw}
              placeholder="comma-separated (optional)"
            />
          </Field>
        </div>
      </Group>

      <button
        type="button"
        onClick={() => setShowAdvanced((v) => !v)}
        aria-expanded={showAdvanced}
        className="group mt-4 w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-[12px] text-slate-300 hover:text-slate-100 transition-colors"
        style={{
          background: showAdvanced
            ? "rgba(168,85,247,0.07)"
            : "rgba(255,255,255,0.025)",
          boxShadow: showAdvanced
            ? "inset 0 0 0 1px rgba(168,85,247,0.25)"
            : "inset 0 0 0 1px rgba(255,255,255,0.06)",
        }}
      >
        <Settings2
          size={13}
          strokeWidth={1.75}
          className={
            showAdvanced
              ? "text-purple-300"
              : "text-slate-500 group-hover:text-slate-300 transition-colors"
          }
        />
        <span className="flex-1 text-left font-medium">
          {showAdvanced ? "Proxy & fingerprint" : "Configure proxy & fingerprint"}
        </span>
        {!showAdvanced && (
          <span className="text-[10px] text-slate-600 font-normal">optional</span>
        )}
        <ChevronDown
          size={13}
          strokeWidth={2}
          className="text-slate-500 group-hover:text-slate-300 transition-all"
          style={{
            transform: showAdvanced ? "rotate(180deg)" : "rotate(0deg)",
            transitionDuration: "180ms",
          }}
        />
      </button>

      {showAdvanced && (
        <>
          {/* Proxy */}
          <Group label="Proxy">
            <label className="flex items-center gap-2 text-[12px] text-slate-300 cursor-pointer mb-2.5">
              <input
                type="checkbox"
                checked={proxy.enabled}
                onChange={(e) =>
                  setProxy((p) => ({ ...p, enabled: e.target.checked }))
                }
                className="w-3.5 h-3.5 rounded accent-purple-500"
              />
              Use proxy
            </label>
            {proxy.enabled && (
              <div className="space-y-2.5">
                <div className="grid grid-cols-[110px_1fr_90px] gap-2.5">
                  <Field label="Type">
                    <select
                      value={proxy.type}
                      onChange={(e) =>
                        setProxy((p) => ({ ...p, type: e.target.value as "http" | "socks5" }))
                      }
                      className="w-full px-2.5 h-9 rounded-lg bg-white/[0.03] text-[12px] text-slate-200 outline-none"
                      style={{ boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)" }}
                    >
                      <option value="http">HTTP</option>
                      <option value="socks5">SOCKS5</option>
                    </select>
                  </Field>
                  <Field label="Host">
                    <Input
                      value={proxy.host}
                      onChange={(v) => setProxy((p) => ({ ...p, host: v }))}
                      placeholder="proxy.example.com"
                      mono
                    />
                  </Field>
                  <Field label="Port">
                    <Input
                      value={proxy.port}
                      onChange={(v) => setProxy((p) => ({ ...p, port: v }))}
                      placeholder="8080"
                      mono
                    />
                  </Field>
                </div>
                <div className="grid grid-cols-2 gap-2.5">
                  <Field label="Username">
                    <Input
                      value={proxy.username}
                      onChange={(v) => setProxy((p) => ({ ...p, username: v }))}
                      mono
                    />
                  </Field>
                  <Field label="Password">
                    <Input
                      type="password"
                      value={proxy.password}
                      onChange={(v) => setProxy((p) => ({ ...p, password: v }))}
                      mono
                    />
                  </Field>
                </div>
                <ProxyTester proxy={proxyForForm} />
              </div>
            )}
          </Group>

          {/* Fingerprint — same component as Inspector edit */}
          <Group label="Fingerprint">
            {fingerprint ? (
              <FingerprintForm
                fingerprint={fingerprint}
                onChange={setFingerprint}
                proxy={proxyForForm}
              />
            ) : (
              <div className="text-[11px] text-slate-600">Loading preset…</div>
            )}
          </Group>
        </>
      )}

      <div className="mt-3 text-[11px] text-slate-500 leading-relaxed">
        Cookies, login state, and fingerprint live in this profile only. They
        never leak to other profiles.
      </div>

      {error && (
        <div
          className="mt-3 px-3 py-2 rounded-lg text-[12px] text-red-400"
          style={{
            background: "rgba(239,68,68,0.06)",
            boxShadow: "inset 0 0 0 1px rgba(239,68,68,0.25)",
          }}
        >
          {error}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center justify-end gap-2 mt-5">
        <button
          type="button"
          className="btn-ghost px-3 py-[7px] text-[12px] rounded-[9px]"
          onClick={onCancel}
          disabled={busy}
        >
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
          <Kbd variant="on-brand">⌘ ⏎</Kbd>
        </button>
      </div>
    </div>
  );
}

function Group({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="mt-4">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-2.5">
        {label}
      </div>
      {children}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[11px] font-medium text-slate-500">{label}</div>
      {children}
    </div>
  );
}

function Input({
  value,
  onChange,
  placeholder,
  mono,
  type,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  type?: "text" | "password";
  autoFocus?: boolean;
}): JSX.Element {
  return (
    <input
      autoFocus={autoFocus}
      type={type ?? "text"}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full px-2.5 h-9 rounded-lg bg-white/[0.03] text-[12px] text-slate-200 placeholder:text-slate-600 outline-none focus:bg-white/[0.05] transition-colors"
      style={{
        boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)",
        fontFamily: mono ? "var(--font-mono)" : "var(--font-sans)",
        fontWeight: mono ? 500 : 400,
      }}
    />
  );
}
