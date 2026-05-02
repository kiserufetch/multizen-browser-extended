import { useMemo, type JSX } from "react";
import { Activity as ActivityIcon } from "lucide-react";
import type { ActivityEvent, ProfileSummary } from "../../types";
import { Pill, Flag, ccFromTimezone } from "../atoms";
import { formatTime } from "../../lib/relativeTime";

interface Props {
  events: ActivityEvent[];
  profiles: ProfileSummary[];
}

/** Full-page activity view (Activity tab in left rail) */
export function ActivityPage({ events, profiles }: Props): JSX.Element {
  const profilesById = useMemo(() => new Map(profiles.map((p) => [p.id, p])), [profiles]);
  const recent = useMemo(() => events.slice().reverse(), [events]);

  return (
    <div className="flex-1 overflow-auto" style={{ padding: "24px 32px" }}>
      <div className="max-w-[960px] mx-auto">
        <div className="flex items-baseline gap-3 mb-1.5">
          <div className="text-lg font-bold tracking-tight text-slate-100">Activity</div>
          <div className="mono text-[11px] text-slate-600">·  {events.length} calls</div>
        </div>
        <div className="text-[13px] text-slate-500 mb-5 leading-relaxed">
          Real-time feed of MCP tool calls. Every action your AI agent takes shows up here, with
          sanitized arguments and outcomes.
        </div>

        {recent.length === 0 ? (
          <div
            className="text-center"
            style={{
              padding: 48,
              borderRadius: 18,
              background: "rgba(255,255,255,0.02)",
              boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.05)",
            }}
          >
            <div
              className="mx-auto flex items-center justify-center"
              style={{
                width: 44,
                height: 44,
                borderRadius: 12,
                background: "rgba(168,85,247,0.10)",
                color: "#c084fc",
                boxShadow: "inset 0 0 0 1px rgba(168,85,247,0.2)",
              }}
            >
              <ActivityIcon size={20} strokeWidth={1.5} />
            </div>
            <div className="text-[13px] font-semibold text-slate-100 mt-3">No activity yet</div>
            <div className="text-[12px] text-slate-500 mt-1.5 leading-relaxed">
              Once you launch a profile or your AI agent starts using MCP, every call streams here.
            </div>
          </div>
        ) : (
          <div className="mz-card overflow-hidden">
            {recent.map((e, i) => (
              <PageRow
                key={e.id}
                event={e}
                profile={e.profileId ? profilesById.get(e.profileId) : undefined}
                isLast={i === recent.length - 1}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PageRow({
  event,
  profile,
  isLast,
}: {
  event: ActivityEvent;
  profile?: ProfileSummary;
  isLast: boolean;
}): JSX.Element {
  const cc = profile ? ccFromTimezone(undefined) : undefined;
  return (
    <div
      className="flex items-start gap-3"
      style={{
        padding: "12px 18px",
        borderBottom: isLast ? "none" : "1px solid rgba(255,255,255,0.04)",
        background: event.status === "pending" ? "rgba(168,85,247,0.04)" : undefined,
      }}
    >
      <StatusPill status={event.status} />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <code className="mono text-[12px] font-semibold text-slate-100">
            <span className="text-purple-400">multizen.</span>
            {event.tool}
          </code>
          <span className="ml-auto mono text-[10px] text-slate-500">
            {formatTime(event.timestamp)}
            {event.durationMs !== undefined && ` · ${event.durationMs}ms`}
          </span>
        </div>
        {event.summary && <div className="text-[12px] text-slate-400 mt-0.5 truncate">{event.summary}</div>}
        {profile && (
          <div className="mono text-[10px] text-slate-500 mt-1 flex items-center gap-1.5">
            <Flag cc={cc} />
            {profile.name} · {profile.id.slice(0, 12)}
          </div>
        )}
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: ActivityEvent["status"] }): JSX.Element {
  if (status === "ok") return <Pill kind="running">ok</Pill>;
  if (status === "pending") return <Pill kind="ai" dot>live</Pill>;
  return <Pill kind="error">error</Pill>;
}
