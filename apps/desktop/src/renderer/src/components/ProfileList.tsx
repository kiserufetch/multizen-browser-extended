import type { JSX } from "react";
import type { ProfileSummary } from "../types";

interface Props {
  profiles: ProfileSummary[];
  onOpen: (id: string) => void;
  onLaunch: (id: string) => void;
  onClose: (id: string) => void;
  onCreate: () => void;
}

export function ProfileList({ profiles, onOpen, onLaunch, onClose, onCreate }: Props): JSX.Element {
  if (profiles.length === 0) {
    return (
      <div className="text-center py-20 border border-dashed border-[--color-border] rounded-xl">
        <p className="text-[--color-fg-muted] mb-2">No profiles yet.</p>
        <button
          type="button"
          onClick={onCreate}
          className="text-sm text-[--color-accent-pink] hover:underline"
        >
          Create your first profile
        </button>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {profiles.map((p) => (
        <div
          key={p.id}
          className="rounded-lg border border-[--color-border] bg-[--color-bg-elevated] p-4 hover:border-[--color-fg-muted] transition-colors"
        >
          <div className="flex items-start justify-between mb-2">
            <button
              type="button"
              onClick={() => onOpen(p.id)}
              className="font-semibold text-left hover:text-[--color-accent-pink] transition-colors"
            >
              {p.name}
            </button>
            {p.isRunning && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-[--color-accent-pink]/15 text-[--color-accent-pink]">
                running
              </span>
            )}
          </div>
          {p.tags.length > 0 && (
            <div className="flex gap-1 flex-wrap mb-3">
              {p.tags.map((t) => (
                <span key={t} className="text-xs px-2 py-0.5 rounded bg-[--color-bg]">
                  {t}
                </span>
              ))}
            </div>
          )}
          <div className="text-xs text-[--color-fg-dim] mb-4 font-mono truncate">
            {p.id}
          </div>
          <div className="flex gap-2">
            {!p.isRunning ? (
              <button
                type="button"
                onClick={() => onLaunch(p.id)}
                className="flex-1 h-9 rounded-md bg-[--color-accent-purple]/10 text-[--color-accent-purple] text-sm hover:bg-[--color-accent-purple]/20 transition-colors"
              >
                Launch
              </button>
            ) : (
              <button
                type="button"
                onClick={() => onClose(p.id)}
                className="flex-1 h-9 rounded-md border border-[--color-border] text-sm hover:border-[--color-fg-muted] transition-colors"
              >
                Close
              </button>
            )}
            <button
              type="button"
              onClick={() => onOpen(p.id)}
              className="h-9 px-3 rounded-md border border-[--color-border] text-sm text-[--color-fg-muted] hover:text-[--color-fg] transition-colors"
            >
              Details
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
