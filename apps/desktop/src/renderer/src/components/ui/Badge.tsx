import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

type Tone = "neutral" | "success" | "warning" | "danger" | "accent";

interface Props {
  children: ReactNode;
  tone?: Tone;
  dot?: boolean;
  className?: string;
}

const tones: Record<Tone, string> = {
  neutral: "bg-[--color-bg-soft] text-[--color-fg-muted] border-[--color-border]",
  success: "bg-[--color-success]/10 text-[--color-success] border-[--color-success]/20",
  warning: "bg-[--color-warning]/10 text-[--color-warning] border-[--color-warning]/20",
  danger: "bg-[--color-danger]/10 text-[--color-danger] border-[--color-danger]/20",
  accent: "bg-[--color-accent-pink]/10 text-[--color-accent-pink] border-[--color-accent-pink]/20",
};

export function Badge({ children, tone = "neutral", dot, className }: Props): React.JSX.Element {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium border",
        tones[tone],
        className,
      )}
    >
      {dot && (
        <span
          className={cn(
            "w-1.5 h-1.5 rounded-full",
            tone === "success" && "bg-[--color-success] animate-pulse",
            tone === "warning" && "bg-[--color-warning]",
            tone === "danger" && "bg-[--color-danger]",
            tone === "accent" && "bg-[--color-accent-pink] animate-pulse",
            tone === "neutral" && "bg-[--color-fg-dim]",
          )}
        />
      )}
      {children}
    </span>
  );
}
