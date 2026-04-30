import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";
import { cn } from "../../lib/cn";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  leftIcon?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, leftIcon, ...rest },
  ref,
) {
  if (leftIcon) {
    return (
      <div className="relative">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[--color-fg-dim] pointer-events-none">
          {leftIcon}
        </span>
        <input
          ref={ref}
          className={cn(
            "w-full pl-9 pr-3 h-10 rounded-md bg-[--color-bg-soft] border border-[--color-border]",
            "text-sm text-[--color-fg] placeholder:text-[--color-fg-dim]",
            "focus:border-[--color-accent-purple] focus:outline-none focus:bg-[--color-bg]",
            "transition-colors",
            className,
          )}
          {...rest}
        />
      </div>
    );
  }
  return (
    <input
      ref={ref}
      className={cn(
        "w-full px-3 h-10 rounded-md bg-[--color-bg-soft] border border-[--color-border]",
        "text-sm text-[--color-fg] placeholder:text-[--color-fg-dim]",
        "focus:border-[--color-accent-purple] focus:outline-none focus:bg-[--color-bg]",
        "transition-colors",
        className,
      )}
      {...rest}
    />
  );
});

interface TextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      className={cn(
        "w-full px-3 py-2 rounded-md bg-[--color-bg-soft] border border-[--color-border]",
        "text-sm text-[--color-fg] placeholder:text-[--color-fg-dim] resize-none",
        "focus:border-[--color-accent-purple] focus:outline-none focus:bg-[--color-bg]",
        "transition-colors",
        className,
      )}
      {...rest}
    />
  );
});

export function Label({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <label className={cn("block text-xs font-medium text-[--color-fg-muted] mb-1.5", className)}>
      {children}
    </label>
  );
}
