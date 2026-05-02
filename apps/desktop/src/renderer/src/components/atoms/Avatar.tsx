import type { JSX } from "react";

interface Props {
  initials: string;
  accent?: boolean;
  size?: number;
}

export function Avatar({ initials, accent = false, size = 32 }: Props): JSX.Element {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: 8,
        background: accent
          ? "linear-gradient(135deg, rgba(168,85,247,0.25), rgba(236,72,153,0.18))"
          : "linear-gradient(135deg, #1e293b, #334155)",
        boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.06)",
        color: accent ? "#f5d0fe" : "#cbd5e1",
        flexShrink: 0,
      }}
      className="flex items-center justify-center font-semibold"
    >
      <span style={{ fontSize: Math.max(11, size / 2.5), lineHeight: 1 }}>{initials}</span>
    </div>
  );
}

export function profileInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const parts = trimmed.split(/[\s\-_·.]+/).filter(Boolean);
  if (parts.length >= 2) {
    return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase();
  }
  return trimmed.slice(0, 2).toUpperCase();
}
