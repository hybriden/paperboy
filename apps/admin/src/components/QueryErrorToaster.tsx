import { useEffect, useRef } from "react";
import { useToast } from "./ui/toast.js";

/** DOM event the query cache in main.tsx dispatches for every failed query
 *  (detail = message). Declared here, not in main.tsx, so the entry module
 *  isn't imported back by a component it renders. */
export const QUERY_ERROR_EVENT = "pb:queryerror";

/** One toast per failed query — a dropped request must never be silent. Identical
 *  messages inside a short window collapse into one: a failed navigation fans out
 *  to a dozen queries, and a dozen identical toasts is its own bug. */
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
