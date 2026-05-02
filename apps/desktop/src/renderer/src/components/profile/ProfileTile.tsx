import type { JSX } from "react";
import { Zap } from "lucide-react";
import type { ProfileSummary } from "../../types";
import { Avatar, Flag, Pill, profileInitials } from "../atoms";
import { relativeTime } from "../../lib/relativeTime";
import type { ActivityEvent } from "../../types";

export type TileState = "idle" | "running" | "ai" | "error";

export interface TileData extends ProfileSummary {
  /** Inferred from running state + recent AI activity */
  state: TileState;
  /** Active page URL when running and we know it (future use) */
  url?: string;
  /** Country code for the proxy / locale */
  country?: string;
  /** Most recent MCP tool call for this profile, if AI-driven */
  lastTool?: string;
  lastDuration?: string;
  /** Error description, when state is 'error' */
  errorMessage?: string;
  /** Cookie / state size summary, future-use */
  meta?: string;
}

const RING_BY_STATE: Record<TileState, string> = {
  idle: "rgba(255,255,255,0.05)",
  running: "rgba(16,185,129,0.30)",
  ai: "rgba(168,85,247,0.30)",
  error: "rgba(239,68,68,0.30)",
};

const GLOW_BY_STATE: Record<TileState, string> = {
  idle: "none",
  running: "0 0 32px rgba(16,185,129,0.18)",
  ai: "0 0 32px rgba(168,85,247,0.18)",
  error: "0 0 32px rgba(239,68,68,0.15)",
};

interface Props {
  profile: TileData;
  onClick: () => void;
}

export function ProfileTile({ profile, onClick }: Props): JSX.Element {
  const initials = profileInitials(profile.name);

  return (
    <button
      type="button"
      onClick={onClick}
      className="text-left flex flex-col gap-2.5 p-3.5 cursor-pointer relative overflow-hidden transition-all hover:-translate-y-px"
      style={{
        borderRadius: 18,
        background: "rgba(255,255,255,0.025)",
        boxShadow: `inset 0 0 0 1px ${RING_BY_STATE[profile.state]}, 0 24px 48px -16px rgba(0,0,0,0.5), ${GLOW_BY_STATE[profile.state]}`,
        backdropFilter: "blur(20px)",
        transitionTimingFunction: "cubic-bezier(0.2,0.8,0.2,1)",
        transitionDuration: "180ms",
      }}
    >
      {/* Header */}
      <div className="flex justify-between items-start gap-2.5">
        <div className="flex gap-2.5 items-center min-w-0">
          <Avatar initials={initials} accent={profile.state === "ai"} />
          <div className="min-w-0">
            <div className="font-semibold text-[13px] leading-tight text-slate-100 truncate">
              {profile.name}
            </div>
            <div className="mono text-[10px] text-slate-600 mt-[3px] truncate">
              {profile.id.slice(0, 12)}
            </div>
          </div>
        </div>
        <PillForState state={profile.state} />
      </div>

      {/* Tags */}
      {profile.tags.length > 0 && (
        <div className="flex gap-1.5 flex-wrap">
          {profile.tags.slice(0, 4).map((t) => (
            <span
              key={t}
              className="mz-pill mono text-slate-400"
              style={{
                background: "rgba(255,255,255,0.04)",
                boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.05)",
              }}
            >
              {t}
            </span>
          ))}
          {profile.tags.length > 4 && (
            <span className="mz-pill mono text-slate-600">+{profile.tags.length - 4}</span>
          )}
        </div>
      )}

      {/* Footer line — context per state */}
      <ContextLine profile={profile} />

      {/* Bottom meta */}
      <div
        className="flex justify-between items-center mt-auto pt-1 mono text-[10px] text-slate-600"
        style={{ fontWeight: 500 }}
      >
        <span>{profile.lastOpenedAt ? relativeTime(profile.lastOpenedAt) : "never opened"}</span>
        <span className="inline-flex items-center gap-1.5">
          <Flag cc={profile.country} />
          {profile.meta ?? "direct"}
        </span>
      </div>
    </button>
  );
}

function PillForState({ state }: { state: TileState }): JSX.Element {
  if (state === "ai") return <Pill kind="ai" dot glow>ai-driven</Pill>;
  if (state === "running") return <Pill kind="running" dot glow>running</Pill>;
  if (state === "error") return <Pill kind="error">error</Pill>;
  return <Pill kind="idle">idle</Pill>;
}

function ContextLine({ profile }: { profile: TileData }): JSX.Element | null {
  if (profile.state === "ai") {
    return (
      <div
        className="flex items-center gap-2 px-2.5 py-2 rounded-lg"
        style={{
          background: "rgba(168,85,247,0.06)",
          boxShadow: "inset 0 0 0 1px rgba(168,85,247,0.12)",
        }}
      >
        <Zap size={12} className="text-purple-400" />
        <span className="mono text-[11px] text-purple-200 truncate flex-1">
          <span className="text-purple-400">multizen.</span>
          {profile.lastTool ?? "…"}
        </span>
        {profile.lastDuration && (
          <span className="mono text-[10px] text-purple-300">{profile.lastDuration}</span>
        )}
      </div>
    );
  }
  if (profile.state === "running" && profile.url) {
    return <div className="mono text-[11px] text-slate-400 truncate">{profile.url}</div>;
  }
  if (profile.state === "error" && profile.errorMessage) {
    return <div className="mono text-[11px] leading-tight text-red-400">{profile.errorMessage}</div>;
  }
  return null;
}

/**
 * Derive tile state + AI activity context from the profile's recent
 * activity events.
 */
export function deriveTileState(
  profile: ProfileSummary,
  recentEvents: ActivityEvent[],
): Pick<TileData, "state" | "lastTool" | "lastDuration" | "errorMessage"> {
  if (!profile.isRunning) return { state: "idle" };

  const recent = recentEvents
    .filter((e) => e.profileId === profile.id)
    .slice()
    .reverse();

  const lastError = recent.find((e) => e.status === "error");
  const lastDriveCall = recent.find(
    (e) => e.tool !== "list_profiles" && e.tool !== "launch_profile" && e.tool !== "close_profile",
  );

  if (lastError && Date.now() - new Date(lastError.timestamp).getTime() < 30_000) {
    return { state: "error", errorMessage: lastError.summary };
  }

  if (lastDriveCall && Date.now() - new Date(lastDriveCall.timestamp).getTime() < 8_000) {
    return {
      state: "ai",
      lastTool: lastDriveCall.tool,
      lastDuration: lastDriveCall.durationMs ? `${lastDriveCall.durationMs}ms` : undefined,
    };
  }

  return { state: "running" };
}
