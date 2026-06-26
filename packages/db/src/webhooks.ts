import { createHmac } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { desc, eq } from "drizzle-orm";
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
  documentId: string;
  type: string;
  kind: string;
  locale: string;
  name: string;
  urlPath: string | null;
  at: string;
}

const WEBHOOK_TIMEOUT_MS = 5000;

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

export async function listWebhooks(db: Database, ctx: AccessContext) {
  requirePermission(ctx, "webhook.manage");
  const rows = await db.select().from(webhook).orderBy(desc(webhook.id));
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
    .values({ name: input.name, url: input.url, secret, events: input.events ?? [], createdBy: ctx.userId })
    .returning({ id: webhook.id });
  return { id: rows[0]!.id, secret };
}

export async function deleteWebhook(db: Database, ctx: AccessContext, id: number): Promise<void> {
  requirePermission(ctx, "webhook.manage");
  await db.delete(webhook).where(eq(webhook.id, id));
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
  payload: WebhookEvent,
): Promise<{ id: number; status: number | null; ok: boolean }[]> {
  const hooks = await db.select().from(webhook).where(eq(webhook.active, true));
  const subscribed = hooks.filter((h) => {
    const evts = (h.events as string[]) ?? [];
    return evts.length === 0 || evts.includes(payload.event);
  });
  const body = JSON.stringify(payload);
  return Promise.all(
    subscribed.map(async (h) => {
      let status: number | null = null;
      let error: string | null = null;
      try {
        // Re-check at dispatch time — this is the real egress boundary and closes
        // DNS-rebinding (a host that resolved public at create time, internal now).
        await assertPublicWebhookUrl(h.url);
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), WEBHOOK_TIMEOUT_MS);
        try {
          const res = await fetch(h.url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-paperboy-event": payload.event,
              "x-paperboy-signature": signPayload(h.secret, body),
            },
            body,
            signal: ac.signal,
          });
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
