import {
  AppError,
  type Perspective,
  deliveryGetById,
  deliveryGetByPath,
  deliveryGetBySlug,
  deliveryGlobal,
  deliveryList,
  deliverySearch,
  deliveryStartPage,
  verifyDeliveryKey,
} from "@paperboy/db";
import { DeliveryContent } from "@paperboy/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

/** Extract the bearer/x-api-key credential and resolve its perspective + site. */
async function resolveCredential(
  app: FastifyInstance,
  req: FastifyRequest,
): Promise<{ perspective: Perspective; siteId: string }> {
  const auth = req.headers.authorization;
  let key = "";
  if (auth?.startsWith("Bearer ")) key = auth.slice(7).trim();
  else if (typeof req.headers["x-api-key"] === "string") key = req.headers["x-api-key"];
  // SECURITY: never accept credentials from the query string.
  const resolved = await verifyDeliveryKey(app.db, key);
  if (!resolved) {
    throw new AppError(401, "unauthorized", "Invalid or missing API key");
  }
  // public key -> only published; preview key -> draft-aware working view. The
  // key also pins the site (D1) — delivery is confined to it.
  return { perspective: resolved.type === "public" ? "published" : "preview", siteId: resolved.siteId };
}

function setCacheHeaders(reply: FastifyReply, perspective: Perspective, cv: number): void {
  if (perspective === "preview") {
    reply.header("Cache-Control", "private, no-store");
  } else {
    reply.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    reply.header("ETag", `W/"cv-${cv}"`);
  }
}

const PopulateQuery = z.object({
  locale: z.string().optional(),
  // Accept any non-negative depth; the resolver clamps to MAX_POPULATE_DEPTH (4)
  // rather than rejecting larger values, so clients aren't penalised for asking.
  populate: z.coerce.number().min(0).max(100).optional(),
});

/** Shared conditional-GET helper: 304 when the published ETag matches. */
function notModified(req: FastifyRequest, perspective: Perspective, cv: number): boolean {
  return perspective === "published" && req.headers["if-none-match"] === `W/"cv-${cv}"`;
}

export async function registerDeliveryRoutes(appBase: FastifyInstance): Promise<void> {
  const app = appBase.withTypeProvider<ZodTypeProvider>();

  // Attach perspective + site early so a missing/invalid key fails before any DB read.
  app.addHook("onRequest", async (req) => {
    const { perspective, siteId } = await resolveCredential(app, req);
    req.perspective = perspective;
    req.deliverySiteId = siteId;
  });

  app.get(
    "/content",
    {
      config: { rateLimit: { max: 600, timeWindow: "1 minute" } },
      schema: {
        tags: ["delivery"],
        querystring: PopulateQuery.extend({
          /** Content type filter. Optional when parentId is given (children of any type). */
          type: z.string().optional(),
          /** Only items that are direct children of this document (e.g. a ListPage's own subtree). */
          parentId: z.string().optional(),
          /** Page size (pagination is opt-in; omitted = all items). */
          limit: z.coerce.number().int().min(1).max(500).optional(),
          offset: z.coerce.number().int().min(0).optional(),
          /** Sort key: name | createdAt | data.<field>; prefix "-" for descending. */
          sort: z
            .string()
            .regex(/^-?(name|createdAt|data\.[A-Za-z0-9_]+)$/, "sort must be name, createdAt or data.<field>, optionally prefixed with -")
            .optional(),
          // Equality filters arrive as extra `data.<field>=value` params (catchall below).
        }).catchall(z.string()),
        response: {
          200: z.object({ items: z.array(DeliveryContent), cv: z.number(), total: z.number() }),
          400: z.object({ error: z.string() }),
        },
      },
    },
    async (req, reply) => {
      if (!req.query.type && !req.query.parentId) {
        return reply.code(400).send({ error: "Provide a type and/or a parentId." });
      }
      const perspective = req.perspective!;
      const locale = req.query.locale ?? "en";
      // `data.<field>=value` query params become equality filters.
      const filter: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.query)) {
        if (k.startsWith("data.") && typeof v === "string") filter[k.slice(5)] = v;
      }
      const { items, total } = await deliveryList(app.db, perspective, req.deliverySiteId!, req.query.type, locale, req.query.populate, req.query.parentId, {
        limit: req.query.limit,
        offset: req.query.offset,
        sort: req.query.sort,
        filter,
      });
      const maxCv = items.reduce((m, i) => Math.max(m, i.cv), 0);
      setCacheHeaders(reply, perspective, maxCv);
      reply.header("X-Total-Count", String(total));
      return { items, cv: maxCv, total };
    },
  );

  app.get(
    "/search",
    {
      config: { rateLimit: { max: 300, timeWindow: "1 minute" } },
      schema: {
        tags: ["delivery"],
        querystring: z.object({
          q: z.string().min(1).max(200),
          type: z.string().optional(),
          locale: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(100).optional(),
        }),
        response: { 200: z.object({ items: z.array(DeliveryContent), total: z.number() }) },
      },
    },
    async (req, reply) => {
      const perspective = req.perspective!;
      const { items, total } = await deliverySearch(app.db, perspective, req.deliverySiteId!, req.query.q, req.query.locale ?? "en", req.query.type, req.query.limit);
      // Search results change with content — short public cache only.
      reply.header("Cache-Control", perspective === "preview" ? "private, no-store" : "public, max-age=30");
      return { items, total };
    },
  );

  app.get(
    "/start",
    {
      config: { rateLimit: { max: 600, timeWindow: "1 minute" } },
      schema: {
        tags: ["delivery"],
        querystring: PopulateQuery,
        response: { 200: DeliveryContent, 404: z.object({ error: z.string(), message: z.string() }) },
      },
    },
    async (req, reply) => {
      const perspective = req.perspective!;
      const locale = req.query.locale ?? "en";
      const result = await deliveryStartPage(app.db, perspective, req.deliverySiteId!, locale, req.query.populate);
      if (!result) return reply.code(404).send({ error: "not_found", message: "No start page configured" });
      if (notModified(req, perspective, result.cv)) {
        setCacheHeaders(reply, perspective, result.cv);
        return reply.code(304 as 200).send(undefined as never);
      }
      setCacheHeaders(reply, perspective, result.cv);
      return result;
    },
  );

  app.get(
    "/content/by-slug",
    {
      config: { rateLimit: { max: 600, timeWindow: "1 minute" } },
      schema: {
        tags: ["delivery"],
        querystring: PopulateQuery.extend({ slug: z.string() }),
        response: { 200: DeliveryContent, 404: z.object({ error: z.string(), message: z.string() }) },
      },
    },
    async (req, reply) => {
      const perspective = req.perspective!;
      const locale = req.query.locale ?? "en";
      const result = await deliveryGetBySlug(app.db, perspective, req.deliverySiteId!, req.query.slug, locale, req.query.populate);
      if (!result) return reply.code(404).send({ error: "not_found", message: "No published content for that slug" });
      if (notModified(req, perspective, result.cv)) {
        setCacheHeaders(reply, perspective, result.cv);
        return reply.code(304 as 200).send(undefined as never);
      }
      setCacheHeaders(reply, perspective, result.cv);
      return result;
    },
  );

  app.get(
    "/content/by-path",
    {
      config: { rateLimit: { max: 600, timeWindow: "1 minute" } },
      schema: {
        tags: ["delivery"],
        querystring: PopulateQuery.extend({ path: z.string() }),
        response: { 200: DeliveryContent, 404: z.object({ error: z.string(), message: z.string() }) },
      },
    },
    async (req, reply) => {
      const perspective = req.perspective!;
      const locale = req.query.locale ?? "en";
      const segments = req.query.path.split("/").filter(Boolean);
      const result = await deliveryGetByPath(app.db, perspective, req.deliverySiteId!, segments, locale, req.query.populate);
      if (!result) return reply.code(404).send({ error: "not_found", message: "No content at that path" });
      if (notModified(req, perspective, result.cv)) {
        setCacheHeaders(reply, perspective, result.cv);
        return reply.code(304 as 200).send(undefined as never);
      }
      setCacheHeaders(reply, perspective, result.cv);
      return result;
    },
  );

  app.get(
    "/content/:documentId",
    {
      config: { rateLimit: { max: 600, timeWindow: "1 minute" } },
      schema: {
        tags: ["delivery"],
        params: z.object({ documentId: z.string() }),
        querystring: PopulateQuery,
        response: { 200: DeliveryContent, 404: z.object({ error: z.string(), message: z.string() }) },
      },
    },
    async (req, reply) => {
      const perspective = req.perspective!;
      const locale = req.query.locale ?? "en";
      const result = await deliveryGetById(app.db, perspective, req.deliverySiteId!, req.params.documentId, locale, req.query.populate);
      if (!result) return reply.code(404).send({ error: "not_found", message: "Not found or not published" });
      // Conditional GET on published content (ETag keyed by cache-version).
      if (notModified(req, perspective, result.cv)) {
        setCacheHeaders(reply, perspective, result.cv);
        return reply.code(304 as 200).send(undefined as never);
      }
      setCacheHeaders(reply, perspective, result.cv);
      return result;
    },
  );

  app.get(
    "/globals/:type",
    {
      config: { rateLimit: { max: 600, timeWindow: "1 minute" } },
      schema: {
        tags: ["delivery"],
        params: z.object({ type: z.string() }),
        querystring: z.object({ locale: z.string().optional() }),
        response: { 200: DeliveryContent, 404: z.object({ error: z.string(), message: z.string() }) },
      },
    },
    async (req, reply) => {
      const perspective = req.perspective!;
      const locale = req.query.locale ?? "en";
      const global = await deliveryGlobal(app.db, perspective, req.deliverySiteId!, req.params.type, locale);
      if (!global) return reply.code(404).send({ error: "not_found", message: "No such global" });
      setCacheHeaders(reply, perspective, global.cv);
      return global;
    },
  );
}
