import { useEffect, useState, type JSX, type ReactNode } from "react";
import type { Profile } from "../types";

interface Props {
  profileId: string;
  onClose: () => void;
  onSaved: () => void;
  onDeleted: () => void;
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
  fpUserAgent: string;
  fpLocale: string;
  fpTimezone: string;
  fpScreenW: string;
  fpScreenH: string;
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
    fpUserAgent: p.fingerprint.userAgent ?? "",
    fpLocale: p.fingerprint.locale,
    fpTimezone: p.fingerprint.timezone,
    fpScreenW: String(p.fingerprint.screen.width),
    fpScreenH: String(p.fingerprint.screen.height),
  };
}

export function ProfileDetail({ profileId, onClose, onSaved, onDeleted }: Props): JSX.Element {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void window.multizen.profiles.get(profileId).then((p) => {
      setProfile(p);
      if (p) setForm(toForm(p));
    });
  }, [profileId]);

  if (!profile || !form) {
    return (
      <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 backdrop-blur-sm">
        <div className="text-[--color-fg-muted]">Loading…</div>
      </div>
    );
  }

  const update = <K extends keyof FormState>(key: K, value: FormState[K]): void => {
    setForm((f) => (f ? { ...f, [key]: value } : f));
  };

  async function save(): Promise<void> {
    if (!form) return;
    setSaving(true);
    try {
      await window.multizen.profiles.update(profileId, {
        name: form.name,
        notes: form.notes || undefined,
        tags: form.tagsRaw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        proxy: form.proxyEnabled
          ? {
              type: form.proxyType,
              host: form.proxyHost,
              port: Number(form.proxyPort) || 0,
              username: form.proxyUsername || undefined,
              password: form.proxyPassword || undefined,
            }
          : null,
        fingerprint: {
          userAgent: form.fpUserAgent || undefined,
          locale: form.fpLocale,
          timezone: form.fpTimezone,
          screen: {
            width: Number(form.fpScreenW) || 1440,
            height: Number(form.fpScreenH) || 900,
          },
        },
      });
      onSaved();
      onClose();
    } finally {
      setSaving(false);
    }
  }

  async function remove(): Promise<void> {
    if (!window.confirm(`Delete profile "${profile?.name}"? Cookies and storage will be lost.`)) return;
    await window.multizen.profiles.delete(profileId);
    onDeleted();
    onClose();
  }

  async function exportArchive(): Promise<void> {
    const passphrase = window.prompt(
      "Choose a passphrase to encrypt the archive. You'll need it to import the profile elsewhere.",
    );
    if (!passphrase) return;
    if (passphrase.length < 8) {
      window.alert("Passphrase must be at least 8 characters.");
      return;
    }
    const result = await window.multizen.profiles.exportArchive(profileId, passphrase);
    if (result.ok) {
      window.alert(`Profile exported to:\n${result.path}`);
    } else if (result.reason !== "cancelled") {
      window.alert(`Export failed: ${result.reason}`);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/60 backdrop-blur-sm overflow-y-auto py-12">
      <div className="bg-[--color-bg-elevated] border border-[--color-border] rounded-xl w-full max-w-2xl mx-4 p-6">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-semibold">Profile detail</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-[--color-fg-muted] hover:text-[--color-fg] text-sm"
          >
            Close
          </button>
        </div>

        <Section title="General">
          <Field label="Name">
            <input
              className={inputClass}
              value={form.name}
              onChange={(e) => update("name", e.target.value)}
            />
          </Field>
          <Field label="Notes">
            <textarea
              className={inputClass}
              rows={2}
              value={form.notes}
              onChange={(e) => update("notes", e.target.value)}
            />
          </Field>
          <Field label="Tags (comma-separated)">
            <input
              className={inputClass}
              value={form.tagsRaw}
              onChange={(e) => update("tagsRaw", e.target.value)}
            />
          </Field>
        </Section>

        <Section title="Proxy">
          <label className="flex items-center gap-2 text-sm mb-3">
            <input
              type="checkbox"
              checked={form.proxyEnabled}
              onChange={(e) => update("proxyEnabled", e.target.checked)}
            />
            <span>Use proxy</span>
          </label>
          {form.proxyEnabled && (
            <>
              <div className="grid grid-cols-3 gap-3 mb-3">
                <select
                  className={inputClass}
                  value={form.proxyType}
                  onChange={(e) => update("proxyType", e.target.value as "http" | "socks5")}
                >
                  <option value="http">HTTP</option>
                  <option value="socks5">SOCKS5</option>
                </select>
                <input
                  className={`${inputClass} col-span-2`}
                  placeholder="host"
                  value={form.proxyHost}
                  onChange={(e) => update("proxyHost", e.target.value)}
                />
              </div>
              <input
                className={`${inputClass} mb-3`}
                placeholder="port"
                value={form.proxyPort}
                onChange={(e) => update("proxyPort", e.target.value)}
              />
              <div className="grid grid-cols-2 gap-3">
                <input
                  className={inputClass}
                  placeholder="username"
                  value={form.proxyUsername}
                  onChange={(e) => update("proxyUsername", e.target.value)}
                />
                <input
                  className={inputClass}
                  placeholder="password"
                  type="password"
                  value={form.proxyPassword}
                  onChange={(e) => update("proxyPassword", e.target.value)}
                />
              </div>
            </>
          )}
        </Section>

        <Section title="Fingerprint">
          <Field label="User-Agent">
            <input
              className={inputClass}
              value={form.fpUserAgent}
              onChange={(e) => update("fpUserAgent", e.target.value)}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3 mb-3">
            <Field label="Locale">
              <input
                className={inputClass}
                value={form.fpLocale}
                onChange={(e) => update("fpLocale", e.target.value)}
              />
            </Field>
            <Field label="Timezone">
              <input
                className={inputClass}
                value={form.fpTimezone}
                onChange={(e) => update("fpTimezone", e.target.value)}
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Screen width">
              <input
                className={inputClass}
                value={form.fpScreenW}
                onChange={(e) => update("fpScreenW", e.target.value)}
              />
            </Field>
            <Field label="Screen height">
              <input
                className={inputClass}
                value={form.fpScreenH}
                onChange={(e) => update("fpScreenH", e.target.value)}
              />
            </Field>
          </div>
        </Section>

        <div className="mt-8 pt-6 border-t border-[--color-border] flex items-center justify-between">
          <div className="flex gap-3 items-center">
            <button
              type="button"
              onClick={remove}
              className="text-sm text-red-400 hover:text-red-300"
            >
              Delete profile
            </button>
            <span className="text-[--color-fg-dim]">·</span>
            <button
              type="button"
              onClick={exportArchive}
              className="text-sm text-[--color-fg-muted] hover:text-[--color-fg]"
            >
              Export archive…
            </button>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 h-10 rounded-md border border-[--color-border] text-sm hover:border-[--color-fg-muted] transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={save}
              className="px-4 h-10 rounded-md bg-gradient-to-r from-[--color-accent-orange] via-[--color-accent-pink] to-[--color-accent-purple] text-white text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const inputClass =
  "w-full px-3 h-10 rounded-md bg-[--color-bg] border border-[--color-border] text-sm focus:border-[--color-accent-purple] focus:outline-none transition-colors";

function Section({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <div className="mb-6">
      <h3 className="text-xs uppercase tracking-wider text-[--color-fg-muted] mb-3">{title}</h3>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="mb-3">
      <label className="block text-xs text-[--color-fg-muted] mb-1">{label}</label>
      {children}
    </div>
  );
}
