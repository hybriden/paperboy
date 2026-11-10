"use server";

import type { ExperimentExposure } from "@paperboycms/client";
import { headers } from "next/headers";
import { submitForm } from "../lib/delivery";

/**
 * The visitor's address, from the header the operator's edge sets and
 * overwrites (PAPERBOY_CLIENT_IP_HEADER: `cf-connecting-ip` behind Cloudflare,
 * `x-real-ip` behind nginx). None configured = none sent: Next keeps a
 * visitor's own X-Forwarded-For, so reading it would let a bot pick a fresh
 * address for every request and walk past the CMS's per-IP limit.
 */
async function visitorIp(): Promise<string | undefined> {
  const name = process.env.PAPERBOY_CLIENT_IP_HEADER?.trim();
  if (!name) return undefined;
  return (await headers()).get(name)?.split(",")[0]?.trim() || undefined;
}

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
 *
 * Nor the idempotency key: the FORM mints it, once per attempt, so a retry of
 * the same attempt is deduplicated by the CMS while a new submission after a
 * success still counts. Minted here it would be fresh on every call — a retry
 * would never match.
 */
export async function submitFormAction(input: {
  formId: string;
  values: Record<string, unknown>;
  elapsedMs: number;
  honeypot: string;
  turnstileToken?: string;
  locale?: string;
  idempotencyKey: string;
  /** The A/B versions the page showed: a conversion for "form"-goal experiments. */
  experiments?: ExperimentExposure[];
}): Promise<
  { ok: true; confirmation: { type: string; text?: unknown } } | { ok: false; fields: Record<string, string> }
> {
  try {
    const res = await submitForm({ ...input, visitorIp: await visitorIp() });
    return res.ok ? { ok: true, confirmation: res.confirmation } : res;
  } catch {
    // Never leak transport detail to a visitor; tell them what to do instead.
    return { ok: false, fields: { _form: "Sorry — the form could not be sent just now. Please try again." } };
  }
}
