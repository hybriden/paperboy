"use server";

import { randomUUID } from "node:crypto";
import { submitForm } from "../lib/delivery";

/**
 * The server action the reference form posts to.
 *
 * It exists so the delivery key stays on the server and so the browser talks to
 * this site's own origin — no CORS, no key in the page source. A customer can
 * replace it with a route handler or their own backend; the CMS only cares that
 * something server-side presents a valid key.
 *
 * Note what is deliberately NOT here: validation. The CMS recompiles the rules
 * from the published form definition and returns one message per field, so
 * duplicating them here would just create a second set to drift out of sync.
 */
export async function submitFormAction(input: {
  formId: string;
  values: Record<string, unknown>;
  elapsedMs: number;
  honeypot: string;
  turnstileToken?: string;
  locale?: string;
}): Promise<
  { ok: true; confirmation: { type: string; text?: unknown } } | { ok: false; fields: Record<string, string> }
> {
  try {
    const res = await submitForm({
      ...input,
      // A fresh key per attempt, so a network retry of THIS action is
      // deduplicated by the CMS while a genuine second submission still counts.
      idempotencyKey: randomUUID(),
    });
    return res.ok ? { ok: true, confirmation: res.confirmation } : res;
  } catch {
    // Never leak transport detail to a visitor; tell them what to do instead.
    return { ok: false, fields: { _form: "Sorry — the form could not be sent just now. Please try again." } };
  }
}
