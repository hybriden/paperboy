import type { HTMLAttributes } from "react";

/**
 * Badge — the small status pill repeated across the app (published/draft state,
 * key types, webhook results, role tags). Tone-driven so it themes correctly in
 * light + dark; `soft` (tinted) by default, `solid` for a filled emphasis.
 */
export type BadgeTone = "default" | "primary" | "positive" | "caution" | "critical";

const soft: Record<BadgeTone, string> = {
  default: "bg-line text-muted",
  primary: "bg-accent-50 text-accent-700",
  positive: "bg-published-subtle text-published",
  caution: "bg-draft-subtle text-draft",
  critical: "bg-danger-subtle text-danger",
};

const solid: Record<BadgeTone, string> = {
  default: "bg-muted text-canvas",
  primary: "bg-accent text-accent-fg",
  positive: "bg-published text-published-fg",
  caution: "bg-draft text-draft-fg",
  critical: "bg-danger text-danger-fg",
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  variant?: "soft" | "solid";
}

export function Badge({ tone = "default", variant = "soft", className = "", children, ...rest }: BadgeProps) {
  const cls = `inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${variant === "solid" ? solid[tone] : soft[tone]} ${className}`;
  return (
    <span className={cls} {...rest}>
      {children}
    </span>
  );
}
