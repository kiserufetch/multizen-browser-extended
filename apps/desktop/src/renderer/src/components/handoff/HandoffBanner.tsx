import { useEffect, useState, type JSX } from "react";
import { Hand } from "lucide-react";
import type { PendingHandoff, ProfileSummary } from "../../types";

const KIND_LABEL: Record<PendingHandoff["kind"], string> = {
  captcha: "CAPTCHA",
  "2fa": "2FA",
  login: "Login",
  confirm: "Confirm",
  other: "Step",
};

interface Props {
  profiles: ProfileSummary[];
  /** Null when the MCP HTTP server is off or failed to bind: then there is no panel. */
  mcpUrl: string | null;
}

/**
 * An agent asked for a person, on a profile of this app. One bar per handoff under the top
 * bar, with what it needs and the ways out. What an agent wrote is shown as plain text.
 * Agents aren't blocked meanwhile on the desktop: Resume and Abort just tell the one waiting.
 */
export function HandoffBanner({ profiles, mcpUrl }: Props): JSX.Element | null {
  const [pending, setPending] = useState<PendingHandoff[]>([]);

  useEffect(() => {
    if (!window.multizen) return;
    void window.multizen.handoff.pending().then(setPending);
    return window.multizen.handoff.onChanged(setPending);
  }, []);

  if (pending.length === 0) return null;

  return (
    <div className="flex flex-col">
      {pending.map((handoff) => {
        const profile = profiles.find((p) => p.id === handoff.profileId);
        const hasWindow = (profile?.runningDisplayMode ?? "headed") === "headed";
        return (
          <div
            key={handoff.handoffId}
            className="flex items-center gap-2 px-4 py-2 text-[12.5px] text-slate-200"
            style={{
              background: "rgba(251,191,36,0.08)",
              boxShadow: "inset 0 0 0 1px rgba(251,191,36,0.22)",
            }}
          >
            <Hand size={13} className="text-amber-300 shrink-0" />
            <span className="font-semibold shrink-0">{profile?.name ?? handoff.profileId}</span>
            <span className="mono text-[10.5px] px-1.5 rounded bg-white/5 text-slate-300 shrink-0">
              {KIND_LABEL[handoff.kind]}
            </span>
            <span className="truncate min-w-0 text-slate-300" title={handoff.reason}>
              {handoff.reason}
            </span>
            {!hasWindow && !mcpUrl && (
              <span className="text-amber-300 shrink-0">
                This profile has no window, and its panel needs the MCP server, which is off or
                didn't start.
              </span>
            )}
            <div className="flex-1" />
            {!hasWindow && mcpUrl && (
              <BannerButton onClick={() => void window.multizen.handoff.openPanel(handoff.handoffId)}>
                Open panel
              </BannerButton>
            )}
            <BannerButton
              primary
              onClick={() => void window.multizen.handoff.resume(handoff.profileId, handoff.handoffId)}
            >
              Resume
            </BannerButton>
            <BannerButton onClick={() => void window.multizen.handoff.abort(handoff.handoffId)}>
              Abort
            </BannerButton>
          </div>
        );
      })}
    </div>
  );
}

function BannerButton({
  primary,
  onClick,
  children,
}: {
  primary?: boolean;
  onClick: () => void;
  children: string;
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`shrink-0 px-2.5 py-1 rounded-md text-[12px] transition-colors ${
        primary ? "bg-amber-400/20 hover:bg-amber-400/30 text-amber-100" : "hover:bg-white/5 text-slate-300"
      }`}
    >
      {children}
    </button>
  );
}
