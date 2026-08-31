import { createHmac } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
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

/** Non-routable / internal ranges a webhook must never target (SSRF): "this
 *  host", RFC1918, CGNAT, loopback, link-local (incl. the 169.254.169.254
 *  cloud-metadata IP), multicast and reserved/broadcast; IPv6 unspecified,
 *  loopback, unique-local, link-local and NAT64. IPv4-mapped IPv6 addresses
 *  (::ffff:a.b.c.d) are checked against the IPv4 rules by BlockList itself. */
const INTERNAL_RANGES = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  INTERNAL_RANGES.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["64:ff9b::", 96],
] as const) {
  INTERNAL_RANGES.addSubnet(net, prefix, "ipv6");
}

function isInternalAddress(ip: string): boolean {
  const family = isIP(ip);
  return family === 0 || INTERNAL_RANGES.check(ip, family === 6 ? "ipv6" : "ipv4");
}

/**
 * Deny-by-default egress guard for webhook URLs (H3). Requires http(s) and a
 * PUBLIC host, and returns the vetted addresses so the dispatcher connects to
 * exactly those: DNS is not consulted a second time at connect, which is what
 * closes DNS rebinding (a TTL-0 host answering public here and 169.254.169.254
 * to the connect). Returns undefined under PAPERBOY_WEBHOOK_ALLOW_PRIVATE=true —
 * the explicit escape hatch for deployments with legitimate internal targets —
 * and normal DNS then applies.
 */
async function assertPublicWebhookUrl(rawUrl: string): Promise<string[] | undefined> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw Errors.badRequest("Webhook URL must be a valid http(s) URL");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw Errors.badRequest("Webhook URL must be a valid http(s) URL");
  if (process.env.PAPERBOY_WEBHOOK_ALLOW_PRIVATE === "true") return undefined;
  // `new URL("http://[::1]/").hostname` keeps the brackets; isIP wants them off.
  const host = u.hostname.replace(/^\[|\]$/g, "");
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
  return addrs;
}

/** What a webhook POST needs from fetch's RequestInit — shared by the pinned
 *  transport below and the tests, which build these literals directly. */
export interface WebhookPostInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}
export interface WebhookResponse {
  status: number;
  headers: { get(name: string): string | null };
}

/**
 * One HTTP(S) request whose socket connects to `addresses` — the guard's vetted
 * answer — instead of resolving the hostname again. TLS still validates against
 * the URL's hostname (SNI + certificate), so pinning changes only WHERE the bytes
 * go, never WHO they are verified as. Without `addresses` (the ALLOW_PRIVATE
 * escape hatch, or a test injecting its own guard) normal DNS applies.
 */
function postPinned(url: string, init: WebhookPostInit, addresses?: string[]): Promise<WebhookResponse> {
  const u = new URL(url);
  const request = u.protocol === "https:" ? httpsRequest : httpRequest;
  const found = addresses?.map((address) => ({ address, family: isIP(address) })) ?? [];
  const headers = { ...init.headers, ...(init.body !== undefined ? { "content-length": String(Buffer.byteLength(init.body)) } : {}) };
  const options = {
    method: init.method ?? "POST",
    headers,
    signal: init.signal,
    lookup: found.length
      ? (_host: string, opts: { all?: boolean }, cb: (err: Error | null, address: string | typeof found, family?: number) => void) =>
          opts.all ? cb(null, found) : cb(null, found[0]!.address, found[0]!.family)
      : undefined,
  };
  return new Promise((resolve, reject) => {
    const req = request(u, options, (res) => {
      res.destroy(); // the body is irrelevant — free the socket without reading it
      resolve({
        status: res.statusCode ?? 0,
        headers: {
          get: (name) => {
            const v = res.headers[name.toLowerCase()];
            return (Array.isArray(v) ? v[0] : v) ?? null;
          },
        },
      });
    });
    req.on("error", reject);
    req.end(init.body);
  });
}

/**
 * POST, following redirects MANUALLY so every hop's host is re-checked, and
 * connecting each hop to the addresses `assertAllowed` vetted.
 *
 * Manual hops: a transport that follows 3xx on its own makes the pre-request host
 * check pointless — an allowlisted public host could answer `302 →
 * http://169.254.169.254/…` and the signed POST would go there. And because the
 * response status is persisted on the webhook row (readable via listWebhooks),
 * that turned into a blind host/port-scan oracle for the deployment's network.
 *
 * Pinned connect: the socket goes to the address the guard vetted, never to a
 * second resolution of the hostname — a TTL-0 host could otherwise answer public
 * to the check and internal to the connect (DNS rebinding). `assertAllowed` is
 * injected so both can be tested without controlling DNS; a guard that returns
 * nothing means "no pin" (normal DNS).
 */
export async function postFollowingRedirectsSafely(
  url: string,
  init: WebhookPostInit,
  assertAllowed: (url: string) => Promise<string[] | undefined | void>,
  maxHops = 3,
): Promise<WebhookResponse> {
  let current = url;
  for (let hop = 0; hop < maxHops; hop++) {
    const vetted = await assertAllowed(current); // re-checked for EVERY hop, including the first
    const res = await postPinned(current, init, Array.isArray(vetted) ? vetted : undefined);
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
  // Scoped: an id from another site reads as not-found, never a cross-site delete —
  // and a miss is a 404 rather than a false success that audits a phantom delete.
  const removed = await db
    .delete(webhook)
    .where(and(eq(webhook.id, id), eq(webhook.siteId, ctx.siteId)))
    .returning({ id: webhook.id });
  if (!removed[0]) throw Errors.notFound("Webhook");
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
          // assertPublicWebhookUrl runs per hop, and the addresses it vetted are
          // what each hop's socket connects to (no second DNS answer at connect):
          // that is the egress boundary against both redirect-based SSRF and DNS
          // rebinding — a host that resolved public to the check and internal now.
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
