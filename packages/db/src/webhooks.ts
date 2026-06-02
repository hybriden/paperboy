import { createHmac, randomBytes } from "node:crypto";
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
  try {
    const u = new URL(input.url);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("bad protocol");
  } catch {
    throw Errors.badRequest("Webhook URL must be a valid http(s) URL");
  }
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
 * contains the event name. Best-effort: each delivery is awaited with its own
 * timeout + try/catch and logged; one failure never affects the others or the
 * caller. Returns per-hook results (used by tests; ignored by the publish path).
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
  const results: { id: number; status: number | null; ok: boolean }[] = [];
  for (const h of subscribed) {
    let status: number | null = null;
    let error: string | null = null;
    try {
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
    results.push({ id: h.id, status, ok: status != null && status >= 200 && status < 300 });
  }
  return results;
}
