import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "../../lib/cn";

interface Props {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  children: ReactNode;
  size?: "sm" | "md" | "lg";
  hideClose?: boolean;
}

const sizes = {
  sm: "max-w-md",
  md: "max-w-lg",
  lg: "max-w-2xl",
};

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  size = "md",
  hideClose,
}: Props): React.JSX.Element | null {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 backdrop-blur-md overflow-y-auto py-12 animate-[fadeIn_120ms_ease-out]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={cn(
          "relative w-full mx-4 rounded-xl surface-1 shadow-[var(--shadow-modal)]",
          "animate-[scaleIn_140ms_ease-out]",
          sizes[size],
        )}
      >
        {(title || !hideClose) && (
          <div className="flex items-start justify-between px-6 pt-5 pb-4 border-b border-[--color-border]">
            <div>
              {title && <h2 className="text-base font-semibold tracking-tight">{title}</h2>}
              {description && (
                <p className="mt-1 text-xs text-[--color-fg-muted] leading-relaxed">{description}</p>
              )}
            </div>
            {!hideClose && (
              <button
                onClick={onClose}
                className="p-1 rounded-md text-[--color-fg-muted] hover:text-[--color-fg] hover:bg-[--color-bg-hover] transition-colors"
                aria-label="Close"
              >
                <X size={16} />
              </button>
            )}
          </div>
        )}
        <div className="p-6">{children}</div>
      </div>

      <style>{`
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes scaleIn { from { opacity: 0; transform: scale(0.96) translateY(-8px); } to { opacity: 1; transform: scale(1) translateY(0); } }
      `}</style>
    </div>
  );
}

export function ModalFooter({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div className={cn("mt-6 pt-5 border-t border-[--color-border] flex items-center justify-end gap-2", className)}>
      {children}
    </div>
  );
}
