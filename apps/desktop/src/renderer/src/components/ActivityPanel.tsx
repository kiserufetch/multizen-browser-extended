import { useEffect, useState, type JSX } from "react";
import type { ActivityEvent } from "../types";

export function ActivityPanel(): JSX.Element {
  const [events, setEvents] = useState<ActivityEvent[]>([]);

  useEffect(() => {
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
    <div className="border border-[--color-border] rounded-lg bg-[--color-bg-elevated] overflow-hidden">
      <div className="px-4 h-10 flex items-center border-b border-[--color-border]">
        <h3 className="text-sm font-semibold">Activity</h3>
        <span className="ml-auto text-xs text-[--color-fg-dim]">{events.length}</span>
      </div>
      <div className="max-h-[420px] overflow-y-auto">
        {reversed.length === 0 && (
          <div className="p-4 text-sm text-[--color-fg-muted]">
            No activity yet. AI tool calls and manual launches will appear here.
          </div>
        )}
        {reversed.map((e) => (
          <div
            key={e.id}
            className="px-4 py-2.5 border-b border-[--color-border] last:border-b-0 text-xs font-mono"
          >
            <div className="flex items-center gap-2">
              <span className="text-[--color-fg-dim]">
                {new Date(e.timestamp).toLocaleTimeString()}
              </span>
              <span
                className={
                  e.status === "ok"
                    ? "text-emerald-400"
                    : e.status === "error"
                      ? "text-red-400"
                      : "text-amber-400"
                }
              >
                {e.status}
              </span>
              <span className="font-semibold text-[--color-fg]">{e.tool}</span>
              {e.profileId && (
                <span className="text-[--color-fg-dim] truncate">
                  {e.profileId.slice(0, 8)}
                </span>
              )}
              {e.durationMs !== undefined && (
                <span className="ml-auto text-[--color-fg-dim]">
                  {e.durationMs}ms
                </span>
              )}
            </div>
            {e.summary && (
              <div className="mt-1 text-[--color-fg-muted] truncate">{e.summary}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
