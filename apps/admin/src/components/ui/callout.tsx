import type { ReactNode } from "react";
import { Surface, type SurfaceTone } from "./surface.js";

/**
 * Callout — an inline notice (info / warning / error) built on Surface, so its
 * tinted background, border and text colour all come from one tone and theme
 * consistently. Replaces the ad-hoc `border border-danger/30 bg-danger/5 …`
 * boxes and AI-off hints scattered through the views.
 */
export function Callout({
  tone = "primary",
  icon,
  title,
  action,
  className = "",
  children,
}: {
  tone?: SurfaceTone;
  icon?: ReactNode;
  title?: ReactNode;
  action?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <Surface tone={tone} padding="sm" radius="md" className={`flex items-start gap-2.5 text-sm ${className}`}>
      {icon && <span className="mt-0.5 shrink-0">{icon}</span>}
      <div className="min-w-0 flex-1">
        {title && <div className="font-semibold">{title}</div>}
        {children}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </Surface>
  );
}
