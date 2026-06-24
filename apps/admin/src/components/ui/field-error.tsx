import type { ReactNode } from "react";

/**
 * FieldError — the inline, per-field validation message shown beneath an input.
 * Pairs with `aria-invalid` on the control and the `.field-input[aria-invalid]`
 * border rule in index.css. Renders nothing when there's no error.
 */
export function FieldError({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return (
    <p className="mt-1 text-xs text-danger" role="alert">
      {children}
    </p>
  );
}
