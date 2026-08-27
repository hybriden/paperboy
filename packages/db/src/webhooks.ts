import { createHmac } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { and, desc, eq, lte } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Database } from "./client.js";
import { Errors } from "./errors.js";
import { type AccessContext, requirePermission } from "./scope.js";
import { webhook, webhookDelivery } from "./schema.js";

/**
 * Outbound webhooks (publish-triggered integration events).
 * Each subscription stores an HMAC-SHA256 secret; deliveries are signed so the
 * receiver can verify authenticity. Dispatch is best-effort and fire-and-forget
 * from the publish path — a failing receiver never blocks or fails a publish.
 */

export interface WebhookEvent {
  event: "content.published" | "content.unpublished";
  /** Which site the content belongs to — dispatch only reaches that site's hooks. */
  siteId: string;
  documentId: string;
  type: string;
  kind: string;
  locale: string;
  name: string;
  urlPath: string | null;
  at: string;
}

/**
 * A visitor submitted a form. This is how a submission leaves Paperboy —
 * Paperboy has no mail transport of its own, so notification is an integration
 * concern (n8n, Zapier, a Worker) reached through the same signed, SSRF-guarded,
 * delivery-logged pipe as publish events.
 *
 * The whole event is opt-in twice over, because it carries visitor personal
 * data off the instance: the editor ticks "Send to integrations" on the form,
 * AND the webhook must name `form.submitted` in its own event list — a
 * catch-all subscription deliberately does NOT receive it (see PII_EVENTS).
 */
export interface FormSubmittedEvent {
  event: "form.submitted";
  formId: string;
  formName: string;
  submissionId: string;
  siteId: string;
  locale: string;
  at: string;
  notifyEmail?: string;
  values?: Record<string, unknown>;
  fields?: { name: string; label: string; kind: string }[];
}

export type AnyWebhookEvent = WebhookEvent | FormSubmittedEvent;

const WEBHOOK_TIMEOUT_MS = 5000;

/** Events whose payload contains visitor personal data. These are never
 *  included in the "subscribe to everything" default — see dispatchWebhooks. */
const PII_EVENTS = new Set<string>(["form.submitted"]);

export function signPayload(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/** True for non-routable / internal addresses that a webhook must never target
 *  (SSRF): loopback, RFC1918, link-local incl. the 169.254.169.254 cloud-metadata
 *  IP, CGNAT, unique-local, and the unspecified address — IPv4 and IPv6. */
function isInternalAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 127 || a === 0 || a === 10) return true; // loopback, "this host", 10/8
    if (a === 172 && b! >= 16 && b! <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true; // 192.168/16
    if (a === 169 && b === 254) return true; // link-local incl. IMDS 169.254.169.254
    if (a === 100 && b! >= 64 && b! <= 127) return true; // CGNAT 100.64/10
    return false;
  }
  const v = ip.toLowerCase();
  if (v === "::1" || v === "::") return true; // loopback / unspecified
  if (v.startsWith("::ffff:")) return isInternalAddress(v.slice(7)); // IPv4-mapped
  if (v.startsWith("fe80")) return true; // link-local
  if (v.startsWith("fc") || v.startsWith("fd")) return true; // unique-local fc00::/7
  return false;
}

/** Deny-by-default egress guard for webhook URLs (H3). Requires http(s) and a
 *  PUBLIC host (DNS-resolved, so a hostname can't hide an internal IP, and the
 *  dispatch-time re-check closes DNS-rebinding). PAPERBOY_WEBHOOK_ALLOW_PRIVATE=true
 *  is an explicit escape hatch for deployments with legitimate internal targets. */
async function assertPublicWebhookUrl(rawUrl: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw Errors.badRequest("Webhook URL must be a valid http(s) URL");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw Errors.badRequest("Webhook URL must be a valid http(s) URL");
  if (process.env.PAPERBOY_WEBHOOK_ALLOW_PRIVATE === "true") return;
  const host = u.hostname;
  let addrs: string[];
  if (isIP(host)) {
    addrs = [host];
  } else {
    try {
      addrs = (await lookup(host, { all: true })).map((r) => r.address);
    } catch {
      throw Errors.badRequest("Webhook URL host could not be resolved");
    }
  }
  if (!addrs.length || addrs.some(isInternalAddress)) {
    throw Errors.badRequest("Webhook URL must point to a public host (loopback/link-local/private addresses are not allowed)");
  }
}

/**
 * POST, following redirects MANUALLY so every hop's host is re-checked.
 *
 * undici follows 3xx by default, which made the pre-fetch host check pointless: an
 * allowlisted public host could answer `302 → http://169.254.169.254/…` and the
 * signed POST would go there. And because the response status is persisted on the
 * webhook row (and readable via listWebhooks), that turned into a blind
 * host/port-scan oracle for the deployment's internal network.
 *
 * Same discipline as stock.ts's downloadBytes (S3-M8), which fixed this for image
 * downloads but was never applied here. `assertAllowed` is injected so it can be
 * tested without controlling DNS.
 */
export async function postFollowingRedirectsSafely(
  url: string,
  init: RequestInit,
  assertAllowed: (url: string) => Promise<void>,
  maxHops = 3,
): Promise<Response> {
  let current = url;
  for (let hop = 0; hop < maxHops; hop++) {
    await assertAllowed(current); // re-checked for EVERY hop, including the first
    const res = await fetch(current, { ...init, redirect: "manual" });
    if (res.status < 300 || res.status >= 400) return res;
    const location = res.headers.get("location");
    if (!location) throw Errors.badRequest("Webhook delivery failed: redirect without a location header");
    current = new URL(location, current).toString(); // validated at the top of the next hop
  }
  throw Errors.badRequest(`Webhook delivery failed: too many redirects (>${maxHops})`);
}

export async function listWebhooks(db: Database, ctx: AccessContext) {
  requirePermission(ctx, "webhook.manage");
  // Site-scoped like content, assets and delivery keys: another site's
  // subscriptions are invisible here, not merely filtered from a default view.
  const rows = await db.select().from(webhook).where(eq(webhook.siteId, ctx.siteId)).orderBy(desc(webhook.id));
  // Never expose the signing secret after creation.
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    url: r.url,
    events: (r.events as string[]) ?? [],
    active: r.active,
    lastStatus: r.lastStatus,
    lastAt: r.lastAt ? r.lastAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function createWebhook(
  db: Database,
  ctx: AccessContext,
  input: { name: string; url: string; events?: string[] },
): Promise<{ id: number; secret: string }> {
  requirePermission(ctx, "webhook.manage");
  await assertPublicWebhookUrl(input.url);
  const secret = `whsec_${nanoid(32)}`;
  const rows = await db
    .insert(webhook)
    .values({ siteId: ctx.siteId, name: input.name, url: input.url, secret, events: input.events ?? [], createdBy: ctx.userId })
    .returning({ id: webhook.id });
  return { id: rows[0]!.id, secret };
}

export async function deleteWebhook(db: Database, ctx: AccessContext, id: number): Promise<void> {
  requirePermission(ctx, "webhook.manage");
  // Scoped: an id from another site is a no-op, not a cross-site delete.
  await db.delete(webhook).where(and(eq(webhook.id, id), eq(webhook.siteId, ctx.siteId)));
}

/**
 * Fan out an event to every active subscriber whose `events` is empty (all) or
 * contains the event name. Best-effort and CONCURRENT: each delivery has its
 * own timeout + try/catch and is logged; one dead or slow endpoint never
 * delays the others or affects the caller. Returns per-hook results (used by
 * tests; ignored by the publish path).
 */
export async function dispatchWebhooks(
  db: Database,
  payload: AnyWebhookEvent,
): Promise<{ id: number; status: number | null; ok: boolean }[]> {
  // Partitioned by site. Before this, one brand's hook received every brand's
  // events — and once form.submitted joined them, that meant another site's
  // visitors' personal data, which the delivery and management chokepoints
  // would both have refused to hand over.
  const hooks = await db
    .select()
    .from(webhook)
    .where(and(eq(webhook.active, true), eq(webhook.siteId, payload.siteId)));
  const subscribed = hooks.filter((h) => {
    const evts = (h.events as string[]) ?? [];
    if (evts.includes(payload.event)) return true;
    // An empty list means "every event" — but ONLY for content events. A
    // form.submitted payload carries visitor personal data (names, addresses,
    // free-text messages) to a third party, so it must be asked for by name: a
    // hook wired up for deploy notifications, possibly to another team's
    // vendor, must not silently start receiving enquiries. Every hook created
    // before this event existed has an empty list.
    return evts.length === 0 && !PII_EVENTS.has(payload.event);
  });
  const body = JSON.stringify(payload);
  return Promise.all(
    subscribed.map(async (h) => {
      let status: number | null = null;
      let error: string | null = null;
      try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), WEBHOOK_TIMEOUT_MS);
        try {
          // assertPublicWebhookUrl runs per hop (not just once before the fetch):
          // it is the real egress boundary, and it closes both DNS rebinding — a
          // host that resolved public at create time and internal now — and
          // redirect-based SSRF.
          const res = await postFollowingRedirectsSafely(
            h.url,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-paperboy-event": payload.event,
                "x-paperboy-signature": signPayload(h.secret, body),
              },
              body,
              signal: ac.signal,
            },
            assertPublicWebhookUrl,
          );
          status = res.status;
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      await db.insert(webhookDelivery).values({ webhookId: h.id, event: payload.event, status, error });
      await db.update(webhook).set({ lastStatus: status, lastAt: new Date() }).where(eq(webhook.id, h.id));
      return { id: h.id, status, ok: status != null && status >= 200 && status < 300 };
    }),
  );
}

/**
 * Prune webhook_delivery rows older than `days` (default 90 via env). This table
 * grows O(publishes x active hooks) and holds only recent-delivery debugging
 * value, so a rolling window is safe. days<=0 keeps everything.
 */
export async function runWebhookDeliveryRetention(db: Database, days: number, now: Date = new Date()): Promise<{ deleted: number }> {
  if (!days || days <= 0) return { deleted: 0 };
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  const res = await db.delete(webhookDelivery).where(lte(webhookDelivery.ts, cutoff)).returning({ id: webhookDelivery.id });
  return { deleted: res.length };
}
