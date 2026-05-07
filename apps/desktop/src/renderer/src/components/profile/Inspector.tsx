import { useEffect, useState, type JSX, type ReactNode } from "react";
import { Pencil, Square, X } from "lucide-react";
import type { FingerprintConfig, Profile, ProxyConfig } from "../../types";
import { Avatar, Flag, Pill, ccFromTimezone, profileInitials } from "../atoms";
import { Button } from "../atoms/Button";
import { relativeTime } from "../../lib/relativeTime";
import { FingerprintForm } from "./FingerprintForm";
import { ProxyTester } from "./ProxyTester";

interface Props {
  profileId: string;
  isRunning: boolean;
  onClose: () => void;
  onLaunch: () => void;
  onStop: () => void;
  onExport: () => void;
  onDelete: () => void;
  onChange: () => void;
  aiActivity?: { tool: string; whenIso: string } | undefined;
}

interface FormState {
  name: string;
  notes: string;
  tagsRaw: string;
  proxyEnabled: boolean;
  proxyType: "http" | "socks5";
  proxyHost: string;
  proxyPort: string;
  proxyUsername: string;
  proxyPassword: string;
  fingerprint: FingerprintConfig;
}

function toForm(p: Profile): FormState {
  return {
    name: p.name,
    notes: p.notes ?? "",
    tagsRaw: p.tags.join(", "),
    proxyEnabled: !!p.proxy,
    proxyType: p.proxy?.type ?? "http",
    proxyHost: p.proxy?.host ?? "",
    proxyPort: p.proxy?.port ? String(p.proxy.port) : "",
    proxyUsername: p.proxy?.username ?? "",
    proxyPassword: p.proxy?.password ?? "",
    fingerprint: p.fingerprint,
  };
}

export function Inspector(props: Props): JSX.Element {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void window.multizen.profiles.get(props.profileId).then((p) => {
      setProfile(p);
      setEditing(false);
      if (p) setForm(toForm(p));
    });
  }, [props.profileId]);

  if (!profile) {
    return (
      <aside
        className="flex-shrink-0 overflow-auto flex flex-col"
        style={{
          width: 380,
          background: "rgba(255,255,255,0.02)",
          borderLeft: "1px solid rgba(255,255,255,0.05)",
          backdropFilter: "blur(20px)",
        }}
      >
        <div className="p-4 mz-shimmer h-20 m-4 rounded-lg" />
      </aside>
    );
  }

  const initials = profileInitials(profile.name);
  const cc = ccFromTimezone(profile.fingerprint.timezone);

  function update<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm((f) => (f ? { ...f, [key]: value } : f));
  }

  // Build a ProxyConfig from current form state for FingerprintForm
  // (so it can probe the proxy when user clicks "Detect from proxy").
  const proxyForForm: ProxyConfig | undefined =
    form && form.proxyEnabled && form.proxyHost
      ? {
          type: form.proxyType,
          host: form.proxyHost,
          port: Number(form.proxyPort) || (form.proxyType === "http" ? 8080 : 1080),
          username: form.proxyUsername || undefined,
          password: form.proxyPassword || undefined,
        }
      : undefined;

  async function save(): Promise<void> {
    if (!form) return;
    setSaving(true);
    try {
      const proxy: ProxyConfig | null = form.proxyEnabled
        ? {
            type: form.proxyType,
            host: form.proxyHost,
            port: Number(form.proxyPort) || 0,
            username: form.proxyUsername || undefined,
            password: form.proxyPassword || undefined,
          }
        : null;

      const updated = await window.multizen.profiles.update(props.profileId, {
        name: form.name,
        notes: form.notes || undefined,
        tags: form.tagsRaw.split(",").map((s) => s.trim()).filter(Boolean),
        proxy,
        fingerprint: form.fingerprint,
      });
      setProfile(updated);
      setForm(toForm(updated));
      setEditing(false);
      props.onChange();
    } finally {
      setSaving(false);
    }
  }

  function cancel(): void {
    if (profile) setForm(toForm(profile));
    setEditing(false);
  }

  return (
    <aside
      className="flex-shrink-0 overflow-auto flex flex-col"
      style={{
        width: 380,
        background: "rgba(255,255,255,0.02)",
        borderLeft: "1px solid rgba(255,255,255,0.05)",
        backdropFilter: "blur(20px)",
        animation: "mz-slide-up 200ms cubic-bezier(0.2,0.8,0.2,1)",
      }}
    >
      {/* Header */}
      <div className="flex flex-col gap-2.5 px-[18px] py-[18px] pb-4">
        <div className="flex items-center gap-2.5">
          <Avatar initials={initials} accent={!!props.aiActivity} />
          <div className="flex-1 min-w-0">
            <div className="font-bold text-[15px] leading-tight text-slate-100 truncate">
              {profile.name}
            </div>
            <div className="mono text-[11px] text-slate-500 mt-[3px] truncate">{profile.id}</div>
          </div>
          <button
            type="button"
            onClick={props.onClose}
            className="w-[26px] h-[26px] rounded-md flex items-center justify-center text-slate-500 hover:text-slate-200 hover:bg-white/5 transition-colors"
            aria-label="Close inspector"
          >
            <X size={14} />
          </button>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {props.aiActivity ? (
            <>
              <Pill kind="ai" dot glow>
                ai-driven · {relativeTime(props.aiActivity.whenIso)}
              </Pill>
              <span className="mono text-[10px] text-slate-500">{props.aiActivity.tool}</span>
            </>
          ) : props.isRunning ? (
            <Pill kind="running" dot>running</Pill>
          ) : (
            <Pill kind="idle">
              idle · last opened {relativeTime(profile.lastOpenedAt)}
            </Pill>
          )}
        </div>

        <div className="flex gap-1.5 mt-1">
          {props.isRunning ? (
            <Button
              variant="secondary"
              onClick={props.onStop}
              leftIcon={<Square size={12} fill="currentColor" strokeWidth={0} />}
            >
              Stop
            </Button>
          ) : (
            <Button variant="primary" onClick={props.onLaunch}>
              Launch
            </Button>
          )}
          {!editing && (
            <Button
              variant="ghost"
              onClick={() => setEditing(true)}
              leftIcon={<Pencil size={12} strokeWidth={1.5} />}
            >
              Edit
            </Button>
          )}
        </div>
      </div>

      {/* General */}
      <Section title="General">
        {editing && form ? (
          <div className="space-y-3">
            <FieldEdit label="Name">
              <Input value={form.name} onChange={(v) => update("name", v)} />
            </FieldEdit>
            <FieldEdit label="Tags">
              <Input
                value={form.tagsRaw}
                onChange={(v) => update("tagsRaw", v)}
                placeholder="comma-separated"
              />
            </FieldEdit>
            <FieldEdit label="Notes">
              <Textarea value={form.notes} onChange={(v) => update("notes", v)} rows={3} />
            </FieldEdit>
          </div>
        ) : (
          <div className="space-y-2.5">
            <FieldRead label="Tags">
              {profile.tags.length === 0 ? (
                <span className="text-[11px] text-slate-600">No tags</span>
              ) : (
                <div className="flex gap-1.5 flex-wrap">
                  {profile.tags.map((t) => (
                    <span
                      key={t}
                      className="mz-pill mono text-slate-400"
                      style={{
                        background: "rgba(255,255,255,0.04)",
                        boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.06)",
                      }}
                    >
                      {t}
                    </span>
                  ))}
                </div>
              )}
            </FieldRead>
            {profile.notes && (
              <FieldRead label="Notes">
                <div className="text-[12px] text-slate-300 leading-relaxed whitespace-pre-wrap">
                  {profile.notes}
                </div>
              </FieldRead>
            )}
          </div>
        )}
      </Section>

      {/* Proxy */}
      <Section
        title="Proxy"
        right={
          !editing &&
          (profile.proxy ? (
            <span className="mono text-[10px] text-emerald-400">● connected</span>
          ) : (
            <span className="mono text-[10px] text-slate-600">none</span>
          ))
        }
      >
        {editing && form ? (
          <div className="space-y-3">
            <label className="flex items-center gap-2 text-[12px] text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={form.proxyEnabled}
                onChange={(e) => update("proxyEnabled", e.target.checked)}
                className="w-3.5 h-3.5 rounded accent-purple-500"
              />
              Use proxy
            </label>
            {form.proxyEnabled && (
              <>
                <div className="grid grid-cols-[110px_1fr_90px] gap-2.5">
                  <FieldEdit label="Type">
                    <select
                      value={form.proxyType}
                      onChange={(e) =>
                        update("proxyType", e.target.value as "http" | "socks5")
                      }
                      className="w-full px-2.5 h-9 rounded-lg bg-white/[0.03] text-[12px] text-slate-200 outline-none"
                      style={{ boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)" }}
                    >
                      <option value="http">HTTP</option>
                      <option value="socks5">SOCKS5</option>
                    </select>
                  </FieldEdit>
                  <FieldEdit label="Host">
                    <Input
                      value={form.proxyHost}
                      onChange={(v) => update("proxyHost", v)}
                      placeholder="proxy.example.com"
                      mono
                    />
                  </FieldEdit>
                  <FieldEdit label="Port">
                    <Input
                      value={form.proxyPort}
                      onChange={(v) => update("proxyPort", v)}
                      placeholder="8080"
                      mono
                    />
                  </FieldEdit>
                </div>
                <div className="grid grid-cols-2 gap-2.5">
                  <FieldEdit label="Username">
                    <Input
                      value={form.proxyUsername}
                      onChange={(v) => update("proxyUsername", v)}
                      mono
                    />
                  </FieldEdit>
                  <FieldEdit label="Password">
                    <Input
                      type="password"
                      value={form.proxyPassword}
                      onChange={(v) => update("proxyPassword", v)}
                      mono
                    />
                  </FieldEdit>
                </div>
                <ProxyTester proxy={proxyForForm} />
              </>
            )}
          </div>
        ) : profile.proxy ? (
          <>
            <div className="flex items-center gap-2 mb-2.5">
              <Flag cc={cc} large />
              <span className="text-[12px] text-slate-300 font-medium">{profile.proxy.host}</span>
            </div>
            <FieldRead label="Type" mono>
              {profile.proxy.type.toUpperCase()}
            </FieldRead>
            <FieldRead label="Host" mono>
              {profile.proxy.host}:{profile.proxy.port}
            </FieldRead>
            {profile.proxy.username && (
              <FieldRead label="Auth" mono hint="Stored locally">
                {profile.proxy.username} · ••••••••
              </FieldRead>
            )}
            <ProxyTester proxy={profile.proxy} />
          </>
        ) : (
          <div className="text-[11px] text-slate-600">
            Direct connection — no proxy configured.
          </div>
        )}
      </Section>

      {/* Fingerprint — coherent device/locale/screen via FingerprintForm */}
      <Section title="Fingerprint">
        {editing && form ? (
          <FingerprintForm
            fingerprint={form.fingerprint}
            onChange={(fp) => update("fingerprint", fp)}
            proxy={proxyForForm}
          />
        ) : (
          <div className="grid grid-cols-2 gap-2.5">
            <FieldRead label="Device" mono>
              {profile.fingerprint.device}
            </FieldRead>
            <FieldRead label="Locale" mono>
              <span className="inline-flex items-center gap-1.5">
                <Flag cc={cc} /> {profile.fingerprint.locale}
              </span>
            </FieldRead>
            <FieldRead label="Timezone" mono>
              {profile.fingerprint.timezone}
            </FieldRead>
            <FieldRead label="Screen" mono>
              {profile.fingerprint.screen.width}×{profile.fingerprint.screen.height}
            </FieldRead>
            <FieldRead label="WebGL" mono>
              {profile.fingerprint.webgl.renderer}
            </FieldRead>
            <FieldRead label="HW concurrency" mono>
              {String(profile.fingerprint.hardwareConcurrency)}
            </FieldRead>
          </div>
        )}
      </Section>

      {/* Footer */}
      <div
        className="flex items-center justify-between gap-2 px-[18px] py-3.5 mt-auto"
        style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}
      >
        {editing ? (
          <>
            <span className="text-[10px] text-slate-600">Editing…</span>
            <div className="flex gap-1.5">
              <Button variant="ghost" size="sm" onClick={cancel} disabled={saving}>
                Cancel
              </Button>
              <Button variant="primary" size="sm" onClick={save} disabled={saving}>
                {saving ? "Saving…" : "Save changes"}
              </Button>
            </div>
          </>
        ) : (
          <div className="flex gap-1.5">
            <Button variant="secondary" size="sm" onClick={props.onExport}>
              Export
            </Button>
            <Button variant="danger" size="sm" onClick={props.onDelete}>
              Delete
            </Button>
          </div>
        )}
      </div>
    </aside>
  );
}

function Section({
  title,
  children,
  right,
}: {
  title: string;
  children: ReactNode;
  right?: ReactNode;
}): JSX.Element {
  return (
    <div className="px-[18px] py-4" style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
      <div className="flex items-center gap-2 mb-2.5">
        <div className="text-[11px] font-semibold tracking-wider uppercase text-slate-500">
          {title}
        </div>
        <div className="flex-1" />
        {right}
      </div>
      {children}
    </div>
  );
}

function FieldRead({
  label,
  mono,
  hint,
  children,
}: {
  label: string;
  mono?: boolean;
  hint?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1 mb-2.5">
      <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wider">{label}</div>
      <div
        className="px-2.5 py-[7px] rounded-lg text-slate-300"
        style={{
          background: "rgba(255,255,255,0.03)",
          boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.06)",
          fontFamily: mono ? "var(--font-mono)" : "var(--font-sans)",
          fontSize: mono ? 12 : 13,
          fontWeight: mono ? 500 : 400,
          lineHeight: 1.3,
        }}
      >
        {children}
      </div>
      {hint && <div className="mono text-[10px] text-slate-600">{hint}</div>}
    </div>
  );
}

function FieldEdit({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wider">{label}</div>
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
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  type?: "text" | "password";
}): JSX.Element {
  return (
    <input
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

function Textarea({
  value,
  onChange,
  placeholder,
  rows = 3,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
}): JSX.Element {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      className="w-full px-2.5 py-2 rounded-lg bg-white/[0.03] text-[12px] text-slate-200 placeholder:text-slate-600 outline-none focus:bg-white/[0.05] transition-colors resize-none"
      style={{
        boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)",
        fontFamily: "var(--font-sans)",
      }}
    />
  );
}
