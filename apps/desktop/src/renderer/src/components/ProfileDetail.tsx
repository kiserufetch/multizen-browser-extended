import { useEffect, useState, type JSX, type ReactNode } from "react";
import { Download, Trash2 } from "lucide-react";
import { Modal, ModalFooter } from "./ui/Modal";
import { Input, Textarea, Label } from "./ui/Input";
import { Button } from "./ui/Button";
import type { Profile } from "../types";

interface Props {
  profileId: string;
  onClose: () => void;
  onSaved: () => void;
  onDeleted: () => void;
  onExport: (id: string) => void;
  onDelete: (id: string) => void;
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

export function ProfileDetail({
  profileId,
  onClose,
  onSaved,
  onExport,
  onDelete,
}: Props): JSX.Element {
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
      <Modal open={true} onClose={onClose} title="Loading…">
        <div className="text-sm text-[--color-fg-muted] py-6">Loading profile…</div>
      </Modal>
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

  return (
    <Modal open={true} onClose={onClose} title="Profile" description={profile.id} size="lg">
      <div className="space-y-6">
        <Section title="General">
          <div className="space-y-3">
            <div>
              <Label>Name</Label>
              <Input value={form.name} onChange={(e) => update("name", e.target.value)} />
            </div>
            <div>
              <Label>Tags</Label>
              <Input
                placeholder="comma-separated"
                value={form.tagsRaw}
                onChange={(e) => update("tagsRaw", e.target.value)}
              />
            </div>
            <div>
              <Label>Notes</Label>
              <Textarea
                rows={2}
                value={form.notes}
                onChange={(e) => update("notes", e.target.value)}
              />
            </div>
          </div>
        </Section>

        <Section title="Proxy" description="HTTP or SOCKS5 proxy used by this profile's browser.">
          <label className="flex items-center gap-2 text-sm mb-4 cursor-pointer">
            <input
              type="checkbox"
              checked={form.proxyEnabled}
              onChange={(e) => update("proxyEnabled", e.target.checked)}
              className="w-4 h-4 rounded accent-[--color-accent-purple]"
            />
            <span>Use proxy</span>
          </label>
          {form.proxyEnabled && (
            <div className="space-y-3">
              <div className="grid grid-cols-[120px_1fr_120px] gap-3">
                <div>
                  <Label>Type</Label>
                  <select
                    className="w-full px-3 h-10 rounded-md bg-[--color-bg-soft] border border-[--color-border] text-sm focus:border-[--color-accent-purple] focus:outline-none"
                    value={form.proxyType}
                    onChange={(e) => update("proxyType", e.target.value as "http" | "socks5")}
                  >
                    <option value="http">HTTP</option>
                    <option value="socks5">SOCKS5</option>
                  </select>
                </div>
                <div>
                  <Label>Host</Label>
                  <Input
                    placeholder="proxy.example.com"
                    value={form.proxyHost}
                    onChange={(e) => update("proxyHost", e.target.value)}
                  />
                </div>
                <div>
                  <Label>Port</Label>
                  <Input
                    placeholder="8080"
                    value={form.proxyPort}
                    onChange={(e) => update("proxyPort", e.target.value)}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Username</Label>
                  <Input
                    value={form.proxyUsername}
                    onChange={(e) => update("proxyUsername", e.target.value)}
                  />
                </div>
                <div>
                  <Label>Password</Label>
                  <Input
                    type="password"
                    value={form.proxyPassword}
                    onChange={(e) => update("proxyPassword", e.target.value)}
                  />
                </div>
              </div>
            </div>
          )}
        </Section>

        <Section
          title="Fingerprint"
          description="Browser identity. Auto-generated for new profiles; tweak only if you know what you're doing."
        >
          <div className="space-y-3">
            <div>
              <Label>User-Agent</Label>
              <Input
                className="font-mono text-xs"
                value={form.fpUserAgent}
                onChange={(e) => update("fpUserAgent", e.target.value)}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Locale</Label>
                <Input
                  value={form.fpLocale}
                  onChange={(e) => update("fpLocale", e.target.value)}
                />
              </div>
              <div>
                <Label>Timezone</Label>
                <Input
                  value={form.fpTimezone}
                  onChange={(e) => update("fpTimezone", e.target.value)}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Screen width</Label>
                <Input
                  value={form.fpScreenW}
                  onChange={(e) => update("fpScreenW", e.target.value)}
                />
              </div>
              <div>
                <Label>Screen height</Label>
                <Input
                  value={form.fpScreenH}
                  onChange={(e) => update("fpScreenH", e.target.value)}
                />
              </div>
            </div>
          </div>
        </Section>
      </div>

      <ModalFooter className="justify-between">
        <div className="flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            leftIcon={<Download size={13} />}
            onClick={() => onExport(profileId)}
          >
            Export archive
          </Button>
          <Button
            variant="ghost"
            size="sm"
            leftIcon={<Trash2 size={13} />}
            onClick={() => onDelete(profileId)}
            className="text-[--color-danger] hover:text-[--color-danger] hover:bg-[--color-danger]/10"
          >
            Delete
          </Button>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={saving} onClick={save}>
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </ModalFooter>
    </Modal>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <section>
      <header className="mb-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[--color-fg-muted]">
          {title}
        </h3>
        {description && (
          <p className="mt-1 text-xs text-[--color-fg-dim] leading-relaxed">{description}</p>
        )}
      </header>
      {children}
    </section>
  );
}
