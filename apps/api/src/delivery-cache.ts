import { type Database, deliveryEpoch, onDeliveryChange } from "@paperboy/db";
import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Published delivery responses, kept in memory per site and URL. A page view
 * asks for the same globals and the same page over and over; Cloudflare can't
 * keep them because the key rides in a header, so without this every one is
 * rebuilt from the database.
 *
 * Correct by invalidation, not by TTL: every publish webhook and
 * delivery.changed announcement clears it in this process at once, and bumps
 * the delivery_epoch sequence that each request reads first, so a write made by
 * another process (the MCP server) is seen on the next request. The TTL is a
 * backstop for what announces nothing: a scheduled-publish window opening on
 * the clock, or SQL run by hand. It matches the max-age delivery already gives
 * downstream caches. Preview is never cached.
 */
const TTL_MS = 60_000;
// shortcut: counts entries, not bytes; measure memory if a site has thousands of URLs.
const MAX_ENTRIES = 1000;
const KEPT_HEADERS = ["cache-control", "etag", "vary", "x-total-count"];

interface Entry {
  at: number;
  /** The route answers If-None-Match itself, so the cache may too. */
  conditional: boolean;
  status: number;
  headers: Record<string, string>;
  payload: unknown;
}

export function createDeliveryCache(db: Database) {
  const entries = new Map<string, Entry>();
  const pending = new WeakMap<FastifyRequest, { key: string; token: string; conditional?: boolean }>();
  let token: string | null = null; // what the entries were built under
  let local = 0;
  const unsubscribe = onDeliveryChange(() => {
    local++;
    token = null;
    entries.clear();
  });

  return {
    unsubscribe,
    /** Answer a published read from the cache (true), or mark it to be stored. */
    async serve(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
      const seen = local;
      const now = `${await deliveryEpoch(db)}:${seen}`;
      if (now !== token) {
        entries.clear();
        token = now;
      }
      const key = `${req.deliverySiteId}\n${req.url}`;
      const hit = entries.get(key);
      if (hit && Date.now() - hit.at < TTL_MS) {
        reply.headers(hit.headers).code(hit.status);
        if (hit.conditional && req.headers["if-none-match"] === hit.headers.etag) void reply.code(304).send();
        else void reply.send(hit.payload);
        return true;
      }
      pending.set(req, { key, token: now });
      return false;
    },
    /** The route does conditional GET: a hit may answer 304 too. (A list's
     *  max-cv ETag would miss a removed item, so lists don't.) */
    conditional(req: FastifyRequest): void {
      const p = pending.get(req);
      if (p) p.conditional = true;
    },
    /** Keep a response `serve` marked, unless a change landed while it was
     *  built. Called before a 304 is sent too, so a conditional miss is kept. */
    store(req: FastifyRequest, reply: FastifyReply, payload: unknown): void {
      const p = pending.get(req);
      pending.delete(req);
      if (!p || p.token !== token || (reply.statusCode !== 200 && reply.statusCode !== 404)) return;
      if (entries.size >= MAX_ENTRIES) entries.delete(entries.keys().next().value!);
      const headers: Record<string, string> = {};
      for (const h of KEPT_HEADERS) {
        const v = reply.getHeader(h);
        if (typeof v === "string") headers[h] = v;
      }
      entries.set(p.key, { at: Date.now(), conditional: p.conditional === true, status: reply.statusCode, headers, payload });
    },
  };
}

export type DeliveryCache = ReturnType<typeof createDeliveryCache>;
