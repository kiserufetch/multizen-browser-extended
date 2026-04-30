import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

interface Props {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: ReactNode;
}

export function EmptyState({ icon: Icon, title, description, action }: Props): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center py-20 px-6 text-center surface-2 rounded-xl">
      <div className="w-12 h-12 rounded-full surface-1 flex items-center justify-center mb-4 text-[--color-fg-muted]">
        <Icon size={20} />
      </div>
      <h3 className="text-base font-semibold mb-1.5">{title}</h3>
      <p className="text-sm text-[--color-fg-muted] max-w-xs mb-5 leading-relaxed">{description}</p>
      {action}
    </div>
  );
}
