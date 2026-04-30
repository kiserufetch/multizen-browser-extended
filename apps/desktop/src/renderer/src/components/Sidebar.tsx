import type { JSX } from "react";
import { Activity, Layers, LifeBuoy, Settings } from "lucide-react";
import { cn } from "../lib/cn";

export type Section = "profiles" | "activity" | "settings";

interface Props {
  current: Section;
  onChange: (s: Section) => void;
  runningCount: number;
}

interface NavItem {
  key: Section;
  label: string;
  icon: typeof Layers;
}

const items: NavItem[] = [
  { key: "profiles", label: "Profiles", icon: Layers },
  { key: "activity", label: "Activity", icon: Activity },
  { key: "settings", label: "Settings", icon: Settings },
];

export function Sidebar({ current, onChange, runningCount }: Props): JSX.Element {
  return (
    <aside className="w-60 shrink-0 h-full surface-1 border-r border-[--color-border] flex flex-col">
      <div className="h-14 px-5 flex items-center gap-2.5 border-b border-[--color-border] drag-region">
        <img src="/icon.png" alt="" width="22" height="22" className="rounded no-drag" />
        <div className="leading-tight no-drag">
          <div className="text-sm font-semibold tracking-tight">MultiZen</div>
          <div className="text-[10px] text-[--color-fg-dim]">v0.2.0-pre</div>
        </div>
      </div>

      <nav className="flex-1 p-3 space-y-1">
        {items.map((item) => {
          const Icon = item.icon;
          const active = current === item.key;
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => onChange(item.key)}
              className={cn(
                "w-full h-9 px-3 rounded-md flex items-center gap-2.5 text-sm transition-colors",
                active
                  ? "bg-[--color-bg-hover] text-[--color-fg]"
                  : "text-[--color-fg-muted] hover:bg-[--color-bg-hover] hover:text-[--color-fg]",
              )}
            >
              <Icon size={15} className="shrink-0" />
              <span className="flex-1 text-left">{item.label}</span>
              {item.key === "profiles" && runningCount > 0 && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[--color-accent-pink]/15 text-[--color-accent-pink] font-mono">
                  {runningCount}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="p-3 border-t border-[--color-border] space-y-1">
        <a
          href="https://github.com/multizenteam/multizen-browser"
          target="_blank"
          rel="noopener"
          className="w-full h-9 px-3 rounded-md flex items-center gap-2.5 text-xs text-[--color-fg-muted] hover:bg-[--color-bg-hover] hover:text-[--color-fg] transition-colors"
        >
          <LifeBuoy size={14} />
          <span>Docs & support</span>
        </a>
      </div>
    </aside>
  );
}
