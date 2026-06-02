import { useSyncExternalStore } from "react";

/**
 * Subscribe to a CSS media query and re-render when it changes.
 * SSR-safe (returns false on the server), though this is a client-only SPA.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/**
 * True on phone-width screens. Below Tailwind's `sm` breakpoint (640px), where
 * the desktop multi-pane editor can't fit — the layout switches to a single
 * scrollable column (see Shell / EditView / Editor).
 */
export function useIsMobile(): boolean {
  return useMediaQuery("(max-width: 639px)");
}
