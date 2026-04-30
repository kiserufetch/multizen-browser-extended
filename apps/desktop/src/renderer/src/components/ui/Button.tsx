import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "../../lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg" | "icon";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
}

const variants: Record<Variant, string> = {
  primary:
    "gradient-bg text-white font-medium hover:opacity-95 active:opacity-100 shadow-[0_4px_20px_-6px_rgba(139,92,246,0.5)]",
  secondary:
    "bg-[--color-bg-elevated] border border-[--color-border] text-[--color-fg] hover:border-[--color-border-strong] hover:bg-[--color-bg-hover]",
  ghost:
    "text-[--color-fg-muted] hover:text-[--color-fg] hover:bg-[--color-bg-hover]",
  danger:
    "bg-[--color-danger]/10 border border-[--color-danger]/30 text-[--color-danger] hover:bg-[--color-danger]/15",
};

const sizes: Record<Size, string> = {
  sm: "h-8 px-3 text-xs gap-1.5 rounded-md",
  md: "h-9 px-4 text-sm gap-2 rounded-md",
  lg: "h-11 px-5 text-sm gap-2 rounded-lg",
  icon: "h-9 w-9 rounded-md",
};

export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  { variant = "secondary", size = "md", leftIcon, rightIcon, className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={cn(
        "inline-flex items-center justify-center font-medium transition-all",
        "disabled:opacity-50 disabled:pointer-events-none",
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {leftIcon}
      {children}
      {rightIcon}
    </button>
  );
});
