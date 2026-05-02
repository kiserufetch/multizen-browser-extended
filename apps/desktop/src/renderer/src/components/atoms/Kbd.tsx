import type { JSX, ReactNode } from "react";

export function Kbd({ children }: { children: ReactNode }): JSX.Element {
  return <span className="mz-kbd">{children}</span>;
}
