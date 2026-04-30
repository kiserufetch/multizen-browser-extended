import { useEffect, useState, type JSX } from "react";
import { Activity, Check, Loader2, X } from "lucide-react";
import { PageHeader } from "../components/PageHeader";
import { EmptyState } from "../components/EmptyState";
import { cn } from "../lib/cn";
import type { ActivityEvent } from "../types";

export function ActivitySection(): JSX.Element {
  const [events, setEvents] = useState<ActivityEvent[]>([]);

  useEffect(() => {
    if (!window.multizen) return;
    void window.multizen.activity.recent().then(setEvents);
    const off = window.multizen.activity.onEvent((e) => {
      setEvents((prev) => {
        const idx = prev.findIndex((x) => x.id === e.id);
        if (idx >= 0) {
          const copy = prev.slice();
          copy[idx] = e;
          return copy;
        }
        return [...prev, e].slice(-200);
      });
    });
    return off;
  }, []);

  const reversed = [...events].reverse();

  return (
    <div className="max-w-4xl mx-auto">
      <PageHeader
        title="Activity"
        description="Real-time feed of MCP tool calls. Every action your AI agent takes shows up here, with sanitized arguments and outcomes."
      />

      {reversed.length === 0 ? (
        <EmptyState
          icon={Activity}
          title="No activity yet"
          description="Once you launch a profile or your AI agent starts using MCP, you'll see every navigate, click, and extract here."
        />
      ) : (
        <div className="surface-1 rounded-xl overflow-hidden">
          {reversed.map((e, i) => (
            <ActivityRow key={e.id} event={e} isLast={i === reversed.length - 1} />
          ))}
        </div>
      )}
    </div>
  );
}

function ActivityRow({ event, isLast }: { event: ActivityEvent; isLast: boolean }): JSX.Element {
  return (
    <div
      className={cn(
        "px-5 py-3 flex items-start gap-3",
        !isLast && "border-b border-[--color-border]",
      )}
    >
      <StatusIcon status={event.status} />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <code className="text-xs font-semibold text-[--color-fg]">{event.tool}</code>
          {event.profileId && (
            <code className="text-[10px] text-[--color-fg-dim] font-mono">
              profile {event.profileId.slice(0, 8)}
            </code>
          )}
          <span className="ml-auto text-[10px] text-[--color-fg-dim]">
            {new Date(event.timestamp).toLocaleTimeString()}
            {event.durationMs !== undefined && ` · ${event.durationMs}ms`}
          </span>
        </div>
        {event.summary && (
          <div className="mt-0.5 text-xs text-[--color-fg-muted] truncate">{event.summary}</div>
        )}
        {Object.keys(event.args).length > 0 && (
          <div className="mt-1 text-[10px] font-mono text-[--color-fg-dim] truncate">
            {Object.entries(event.args)
              .filter(([k]) => k !== "profile_id")
              .map(([k, v]) => `${k}=${typeof v === "string" ? JSON.stringify(v).slice(0, 60) : String(v)}`)
              .join(" ")}
          </div>
        )}
      </div>
    </div>
  );
}

function StatusIcon({ status }: { status: ActivityEvent["status"] }): JSX.Element {
  const cls = "shrink-0 mt-0.5";
  if (status === "ok")
    return <Check size={14} className={cn(cls, "text-[--color-success]")} />;
  if (status === "error")
    return <X size={14} className={cn(cls, "text-[--color-danger]")} />;
  return <Loader2 size={14} className={cn(cls, "text-[--color-warning] animate-spin")} />;
}
