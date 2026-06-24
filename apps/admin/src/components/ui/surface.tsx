import type { HTMLAttributes } from "react";

/**
 * Surface — a single card/panel primitive, the way Sanity's <Card> separates
 * *surface* (background, border, shadow, tone) from *layout*. It replaces the
 * `rounded-lg border border-line bg-panel shadow-panel` string repeated across
 * dashboards, panels and popovers, and adds a semantic `tone` so coloured
 * surfaces (callouts, validation states) stay consistent in light + dark.
 *
 * - tone:      default | primary | positive | caution | critical
 * - elevation: 0 (flat) · 1 (panel shadow) · 2 (popover shadow)
 * - radius:    md (--radius) · lg (--radius-lg)
 * - padding:   none · sm · md · lg
 * - border:    draw a hairline in the tone's colour (default true)
 *
 * Borders on a tinted tone come from the solid colour at low alpha, matching
 * the tokens in index.css. All classes are literal so Tailwind keeps them.
 */
export type SurfaceTone = "default" | "primary" | "positive" | "caution" | "critical";

const toneFill: Record<SurfaceTone, string> = {
  default: "bg-panel text-fg",
  primary: "bg-accent-50 text-accent-700",
  positive: "bg-published-subtle text-published",
  caution: "bg-draft-subtle text-draft",
  critical: "bg-danger-subtle text-danger",
};

const toneBorder: Record<SurfaceTone, string> = {
  default: "border-line",
  primary: "border-accent/30",
  positive: "border-published/30",
  caution: "border-draft/30",
  critical: "border-danger/30",
};

const elevationClass = ["", "shadow-panel", "shadow-pop"] as const;
const radiusClass = { md: "rounded", lg: "rounded-lg" } as const;
const paddingClass = { none: "", sm: "p-3", md: "p-4", lg: "p-5" } as const;

export interface SurfaceProps extends HTMLAttributes<HTMLDivElement> {
  tone?: SurfaceTone;
  elevation?: 0 | 1 | 2;
  radius?: keyof typeof radiusClass;
  padding?: keyof typeof paddingClass;
  border?: boolean;
}

export function Surface({
  tone = "default",
  elevation = 0,
  radius = "lg",
  padding = "none",
  border = true,
  className = "",
  children,
  ...rest
}: SurfaceProps) {
  const cls = [
    toneFill[tone],
    border ? `border ${toneBorder[tone]}` : "",
    radiusClass[radius],
    paddingClass[padding],
    elevationClass[elevation],
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={cls} {...rest}>
      {children}
    </div>
  );
}
