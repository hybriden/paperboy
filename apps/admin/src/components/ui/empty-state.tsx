import type { ReactNode } from "react";

/**
 * EmptyState — a centred "nothing here yet" placeholder for panes and sections.
 * For dense list rows inside a card, prefer a compact inline message; this is
 * for pane-level empties.
 */
export function EmptyState({
  title,
  className = "",
  children,
}: {
  title?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div className={`flex flex-col items-center justify-center gap-2 px-6 py-10 text-center ${className}`}>
      {title && <p className="text-sm font-semibold text-fg">{title}</p>}
      {children && <p className="max-w-sm text-sm text-muted">{children}</p>}
    </div>
  );
}
