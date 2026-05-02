import { useEffect, useState, type JSX, type ReactNode } from "react";
import { Globe, Plus, Square, X } from "lucide-react";
import type { Profile, ProfileSummary } from "../../types";
import { Avatar, Flag, Pill, ccFromTimezone, profileInitials } from "../atoms";
import { relativeTime } from "../../lib/relativeTime";

interface Props {
  profileId: string;
  isRunning: boolean;
  onClose: () => void;
  onLaunch: () => void;
  onStop: () => void;
  onExport: () => void;
  onDelete: () => void;
  onChange: () => void;
  /** Slug of an active AI tool, if any */
  aiActivity?: { tool: string; whenIso: string } | undefined;
}

/**
 * Right-pane Inspector — slides in when a profile is selected.
 * 380px wide, scrolls independently, glass surface.
 */
export function Inspector(props: Props): JSX.Element {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [editingTags, setEditingTags] = useState(false);
  const [tagsDraft, setTagsDraft] = useState("");

  useEffect(() => {
    void window.multizen.profiles.get(props.profileId).then(setProfile);
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
  const proxyConnected = !!profile.proxy;

  async function commitTags(): Promise<void> {
    const tags = tagsDraft.split(",").map((s) => s.trim()).filter(Boolean);
    const updated = await window.multizen.profiles.update(props.profileId, { tags });
    setProfile(updated);
    setEditingTags(false);
    props.onChange();
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
            <div className="font-bold text-[15px] leading-tight text-slate-100">{profile.name}</div>
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

        <div className="flex items-center gap-2">
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
            <Pill kind="idle">idle · last opened {relativeTime(profile.lastOpenedAt)}</Pill>
          )}
        </div>

        <div className="flex gap-1.5 mt-1">
          {props.isRunning ? (
            <button type="button" className="btn-secondary px-3 py-[7px] rounded-[9px] text-[12px]" onClick={props.onStop}>
              <Square size={12} strokeWidth={1.5} />
              Stop
            </button>
          ) : (
            <button type="button" className="btn-brand px-3 py-[7px] rounded-[9px] text-[12px]" onClick={props.onLaunch}>
              Launch
            </button>
          )}
          <button
            type="button"
            className="btn-secondary px-0 rounded-[9px]"
            style={{ width: 32, height: 28 }}
            title="Open Chromium"
            onClick={props.onLaunch}
          >
            <Globe size={13} strokeWidth={1.5} />
          </button>
        </div>
      </div>

      <Section
        title="Tags"
        action={
          <button
            type="button"
            className="text-[10px] text-slate-400 px-1.5 py-[3px] rounded bg-white/[0.04] hover:bg-white/[0.06]"
            onClick={() => {
              setTagsDraft(profile.tags.join(", "));
              setEditingTags(true);
            }}
          >
            <Plus size={11} className="inline" /> edit
          </button>
        }
      >
        {editingTags ? (
          <input
            autoFocus
            type="text"
            value={tagsDraft}
            onChange={(e) => setTagsDraft(e.target.value)}
            onBlur={commitTags}
            onKeyDown={(e) => {
              if (e.key === "Enter") void commitTags();
              if (e.key === "Escape") setEditingTags(false);
            }}
            className="w-full mono text-[12px] text-slate-300 px-2.5 py-2 rounded-lg bg-white/[0.04] focus:outline-none"
            style={{ boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)" }}
          />
        ) : profile.tags.length === 0 ? (
          <div className="text-[11px] text-slate-600">No tags</div>
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
      </Section>

      <Section
        title="Proxy"
        action={
          proxyConnected ? (
            <span className="mono text-[10px] text-emerald-400">● connected</span>
          ) : (
            <span className="mono text-[10px] text-slate-600">none</span>
          )
        }
      >
        {profile.proxy ? (
          <>
            <div className="flex items-center gap-2 mb-2.5">
              <Flag cc={cc} large />
              <span className="text-[12px] text-slate-300 font-medium">{profile.proxy.host}</span>
            </div>
            <Field label="Type" mono value={profile.proxy.type.toUpperCase()} />
            <Field label="Host" mono value={`${profile.proxy.host}:${profile.proxy.port}`} />
            {profile.proxy.username && (
              <Field
                label="Auth"
                mono
                value={`${profile.proxy.username} · ••••••••`}
                hint="Stored locally"
              />
            )}
          </>
        ) : (
          <div className="text-[11px] text-slate-600">Direct connection — no proxy configured.</div>
        )}
      </Section>

      <Section title="Fingerprint">
        <div className="grid grid-cols-2 gap-2.5">
          <Field label="UA" mono value={shortUA(profile.fingerprint.userAgent)} />
          <Field
            label="Locale"
            mono
            value={
              <span className="inline-flex items-center gap-1.5">
                <Flag cc={cc} /> {profile.fingerprint.locale}
              </span>
            }
          />
          <Field label="Timezone" mono value={profile.fingerprint.timezone} />
          <Field label="Screen" mono value={`${profile.fingerprint.screen.width}×${profile.fingerprint.screen.height}`} />
          <Field
            label="WebGL"
            mono
            value={profile.fingerprint.webgl?.renderer ?? "default"}
          />
          <Field label="HW concurrency" mono value={String(profile.fingerprint.hardwareConcurrency ?? "—")} />
        </div>
      </Section>

      {profile.notes && (
        <Section title="Notes">
          <div
            className="px-3 py-2.5 rounded-lg text-[12px] text-slate-300 leading-relaxed whitespace-pre-wrap"
            style={{
              background: "rgba(255,255,255,0.03)",
              boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.06)",
              fontFamily: "var(--font-sans)",
            }}
          >
            {profile.notes}
          </div>
        </Section>
      )}

      <Section title="Danger">
        <div className="flex gap-2 flex-wrap">
          <button
            type="button"
            onClick={props.onExport}
            className="btn-secondary text-[12px] px-3 py-[7px] rounded-[9px]"
          >
            Export archive
          </button>
          <button
            type="button"
            onClick={props.onDelete}
            className="text-[12px] px-3 py-[7px] rounded-[9px] cursor-pointer text-red-400"
            style={{
              background: "rgba(239,68,68,0.05)",
              boxShadow: "inset 0 0 0 1px rgba(239,68,68,0.2)",
              border: 0,
            }}
          >
            Delete profile
          </button>
        </div>
      </Section>
    </aside>
  );
}

function Section({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}): JSX.Element {
  return (
    <div className="px-[18px] py-4" style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
      <div className="flex items-center gap-2 mb-2.5">
        <div className="text-[11px] font-semibold tracking-wider uppercase text-slate-500">{title}</div>
        <div className="flex-1" />
        {action}
      </div>
      {children}
    </div>
  );
}

function Field({
  label,
  mono,
  value,
  hint,
}: {
  label: string;
  mono?: boolean;
  value: ReactNode;
  hint?: string;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1 mb-2.5">
      <div className="text-[11px] font-medium text-slate-500">{label}</div>
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
        {value}
      </div>
      {hint && <div className="mono text-[10px] text-slate-500">{hint}</div>}
    </div>
  );
}

function shortUA(ua?: string): string {
  if (!ua) return "default";
  const m = ua.match(/Chrome\/(\d+).*\((.*?)\)/);
  if (!m) return ua.slice(0, 32);
  const platform = m[2]?.split(";")[0]?.trim() ?? "";
  return `Chrome ${m[1]} / ${platform}`;
}

/** Small helper used by App.tsx to look up the current running summary. */
export function isProfileRunning(p: ProfileSummary): boolean {
  return p.isRunning;
}
