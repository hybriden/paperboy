import type { HTMLAttributes } from "react";

/**
 * Badge — the small status pill repeated across the app (published/draft state,
 * key types, webhook results, role tags). Tone-driven so it themes correctly in
 * light + dark.
 */
export type BadgeTone = "default" | "primary" | "positive" | "caution" | "critical";

const toneClass: Record<BadgeTone, string> = {
  default: "bg-line text-muted",
  primary: "bg-accent-50 text-accent-700",
  positive: "bg-published-subtle text-published",
  caution: "bg-draft-subtle text-draft",
  critical: "bg-danger-subtle text-danger",
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

export function Badge({ tone = "default", className = "", children, ...rest }: BadgeProps) {
  const cls = `inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${toneClass[tone]} ${className}`;
  return (
    <span className={cls} {...rest}>
      {children}
    </span>
  );
}
