import { useState, type JSX } from "react";
import { ChevronRight, MoreHorizontal, Play, Square } from "lucide-react";
import type { ProfileSummary } from "../types";
import { Badge } from "./ui/Badge";
import { cn } from "../lib/cn";

interface Props {
  profile: ProfileSummary;
  onLaunch: () => void;
  onClose: () => void;
  onOpen: () => void;
  onExport: () => void;
  onDelete: () => void;
}

export function ProfileCard({ profile, onLaunch, onClose, onOpen, onExport, onDelete }: Props): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);

  const lastOpened = profile.lastOpenedAt
    ? formatRelative(new Date(profile.lastOpenedAt))
    : "never opened";

  return (
    <div
      className={cn(
        "group relative rounded-lg surface-1 hover:bg-[--color-bg-hover] transition-all",
        "shadow-[var(--shadow-card)]",
        profile.isRunning && "border-[--color-accent-pink]/30",
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        className="w-full text-left p-4 pb-3"
      >
        <div className="flex items-start justify-between mb-3 gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-0.5">
              <h3 className="font-semibold text-[--color-fg] text-sm truncate">{profile.name}</h3>
              <ChevronRight
                size={14}
                className="text-[--color-fg-dim] opacity-0 group-hover:opacity-100 transition-opacity"
              />
            </div>
            <div className="text-[11px] text-[--color-fg-dim]">
              {lastOpened}
            </div>
          </div>
          {profile.isRunning && (
            <Badge tone="accent" dot>running</Badge>
          )}
        </div>
        {profile.tags.length > 0 && (
          <div className="flex gap-1 flex-wrap">
            {profile.tags.slice(0, 4).map((t) => (
              <span
                key={t}
                className="text-[10px] px-1.5 py-0.5 rounded bg-[--color-bg-soft] text-[--color-fg-muted] border border-[--color-border]"
              >
                {t}
              </span>
            ))}
            {profile.tags.length > 4 && (
              <span className="text-[10px] px-1.5 py-0.5 text-[--color-fg-dim]">
                +{profile.tags.length - 4}
              </span>
            )}
          </div>
        )}
      </button>

      <div className="px-4 pb-3 flex gap-2">
        {!profile.isRunning ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onLaunch();
            }}
            className="flex-1 h-8 rounded-md bg-[--color-accent-purple]/10 text-[--color-accent-purple] text-xs font-medium hover:bg-[--color-accent-purple]/20 transition-colors flex items-center justify-center gap-1.5"
          >
            <Play size={12} fill="currentColor" />
            Launch
          </button>
        ) : (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            className="flex-1 h-8 rounded-md border border-[--color-border-strong] text-xs font-medium hover:bg-[--color-bg-soft] transition-colors flex items-center justify-center gap-1.5"
          >
            <Square size={11} fill="currentColor" />
            Close
          </button>
        )}
        <div className="relative">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen(!menuOpen);
            }}
            className="h-8 w-8 rounded-md border border-[--color-border] text-[--color-fg-muted] hover:text-[--color-fg] hover:bg-[--color-bg-soft] transition-colors flex items-center justify-center"
          >
            <MoreHorizontal size={14} />
          </button>
          {menuOpen && (
            <>
              <div
                className="fixed inset-0 z-10"
                onClick={() => setMenuOpen(false)}
              />
              <div className="absolute right-0 top-9 z-20 w-44 surface-1 rounded-md shadow-[var(--shadow-modal)] py-1">
                <MenuItem onClick={() => { setMenuOpen(false); onOpen(); }}>
                  Edit profile
                </MenuItem>
                <MenuItem onClick={() => { setMenuOpen(false); onExport(); }}>
                  Export archive…
                </MenuItem>
                <div className="my-1 border-t border-[--color-border]" />
                <MenuItem
                  onClick={() => { setMenuOpen(false); onDelete(); }}
                  tone="danger"
                >
                  Delete profile
                </MenuItem>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function MenuItem({
  children,
  onClick,
  tone,
}: {
  children: React.ReactNode;
  onClick: () => void;
  tone?: "danger";
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "w-full text-left px-3 py-1.5 text-xs hover:bg-[--color-bg-hover] transition-colors",
        tone === "danger" ? "text-[--color-danger]" : "text-[--color-fg]",
      )}
    >
      {children}
    </button>
  );
}

function formatRelative(d: Date): string {
  const diff = Date.now() - d.getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString();
}
