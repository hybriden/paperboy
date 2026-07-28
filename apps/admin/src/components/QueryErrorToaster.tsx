import { useEffect, useRef } from "react";
import { QUERY_ERROR_EVENT } from "../main.js";
import { useToast } from "./ui/toast.js";

/**
 * Makes failed queries VISIBLE.
 *
 * Every query error now reaches the cache-level onError in main.tsx, which
 * announces it as a DOM event; this component (inside ToastProvider, so it can use
 * the toast API) turns it into one toast. Without it a dropped request was silent
 * and terminal — panels went blank, or reported false state, with nothing to tell
 * the editor their screen no longer reflects the server.
 *
 * Deliberately COALESCED: one failed navigation can fan out to a dozen queries, and
 * a dozen identical toasts is its own bug. Identical messages inside a short window
 * collapse into one.
 */
const COALESCE_MS = 3000;

export function QueryErrorToaster() {
  const toast = useToast();
  const lastRef = useRef<{ message: string; at: number }>({ message: "", at: 0 });

  useEffect(() => {
    const onError = (e: Event) => {
      const message = String((e as CustomEvent).detail ?? "Request failed");
      const now = Date.now();
      const last = lastRef.current;
      if (last.message === message && now - last.at < COALESCE_MS) return;
      lastRef.current = { message, at: now };
      toast.error("Couldn’t load that", message);
    };
    window.addEventListener(QUERY_ERROR_EVENT, onError);
    return () => window.removeEventListener(QUERY_ERROR_EVENT, onError);
  }, [toast]);

  return null;
}
