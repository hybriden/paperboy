import {
  AppError,
  type Perspective,
  deliveryGetById,
  deliveryGetByPath,
  deliveryGetBySlug,
  deliveryGlobal,
  deliveryList,
  deliveryPages,
  deliverySearch,
  deliveryStartPage,
  getSiteById,
  resolveDefaultLocale,
  verifyDeliveryKey,
} from "@paperboy/db";
import { DeliveryContent, buildLlmsTxt, buildRobotsTxt, buildSecurityTxt, buildSitemapXml, parseSeoFilesConfig } from "@paperboy/shared";
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
    // The delivery key (Authorization / x-api-key) selects BOTH the perspective and
    // the SITE, so a shared/CDN cache must partition on it — otherwise one site's
    // payload is served to another site's key at the same URL (per-site slugs collide).
    reply.header("Vary", "Authorization, X-Api-Key");
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

/**
 * Finish a single-item delivery read: emit cache headers, then return either a
 * 304 (published ETag match) or the payload. The conditional-GET dance lives
 * here only, so cache correctness can't drift between the by-slug/by-path/by-id
 * /start handlers that all share it.
 */
function deliverItem<T extends { cv: number }>(
  req: FastifyRequest,
  reply: FastifyReply,
  perspective: Perspective,
  result: T,
): T | FastifyReply {
  setCacheHeaders(reply, perspective, result.cv);
  if (notModified(req, perspective, result.cv)) {
    return reply.code(304 as 200).send(undefined as never);
  }
  return result;
}

export async function registerDeliveryRoutes(appBase: FastifyInstance): Promise<void> {
  const app = appBase.withTypeProvider<ZodTypeProvider>();

  // Attach perspective + site before any handler runs.
  //
  // preHandler, NOT onRequest: @fastify/rate-limit installs its check as a
  // per-route hook, and Fastify runs instance-level onRequest hooks first — so
  // resolving here on onRequest short-circuited the limiter for every REJECTED
  // request. Measured: 700 requests with invalid keys → 700x 401, zero 429s, i.e.
  // unmetered delivery-key guessing plus unmetered load on the credential lookup
  // (itself a DB query). preHandler still precedes every handler, so nothing is
  // read before the key is validated.
  app.addHook("preHandler", async (req) => {
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
      const locale = req.query.locale ?? (await resolveDefaultLocale(app.db, req.deliverySiteId!));
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
      const { items, total } = await deliverySearch(app.db, perspective, req.deliverySiteId!, req.query.q, (req.query.locale ?? (await resolveDefaultLocale(app.db, req.deliverySiteId!))), req.query.type, req.query.limit);
      // Search results change with content — short public cache only.
      reply.header("Cache-Control", perspective === "preview" ? "private, no-store" : "public, max-age=30");
      // MUST partition on the credential like every other delivery response. This
      // route set Cache-Control by hand and so skipped the `Vary` that
      // setCacheHeaders adds, leaving `public, max-age=30` with no Vary at all —
      // so a shared cache would serve one site's search results (or a preview
      // key's drafts) to another site's key at the same URL. Same reason, same
      // header; only the max-age differs.
      if (perspective !== "preview") reply.header("Vary", "Authorization, X-Api-Key");
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
      const locale = req.query.locale ?? (await resolveDefaultLocale(app.db, req.deliverySiteId!));
      const result = await deliveryStartPage(app.db, perspective, req.deliverySiteId!, locale, req.query.populate);
      if (!result) return reply.code(404).send({ error: "not_found", message: "No start page configured" });
      return deliverItem(req, reply, perspective, result);
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
      const locale = req.query.locale ?? (await resolveDefaultLocale(app.db, req.deliverySiteId!));
      const result = await deliveryGetBySlug(app.db, perspective, req.deliverySiteId!, req.query.slug, locale, req.query.populate);
      if (!result) return reply.code(404).send({ error: "not_found", message: "No published content for that slug" });
      return deliverItem(req, reply, perspective, result);
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
      const locale = req.query.locale ?? (await resolveDefaultLocale(app.db, req.deliverySiteId!));
      const segments = req.query.path.split("/").filter(Boolean);
      const result = await deliveryGetByPath(app.db, perspective, req.deliverySiteId!, segments, locale, req.query.populate);
      if (!result) return reply.code(404).send({ error: "not_found", message: "No content at that path" });
      return deliverItem(req, reply, perspective, result);
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
      const locale = req.query.locale ?? (await resolveDefaultLocale(app.db, req.deliverySiteId!));
      const result = await deliveryGetById(app.db, perspective, req.deliverySiteId!, req.params.documentId, locale, req.query.populate);
      if (!result) return reply.code(404).send({ error: "not_found", message: "Not found or not published" });
      return deliverItem(req, reply, perspective, result);
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
      const locale = req.query.locale ?? (await resolveDefaultLocale(app.db, req.deliverySiteId!));
      const global = await deliveryGlobal(app.db, perspective, req.deliverySiteId!, req.params.type, locale);
      if (!global) return reply.code(404).send({ error: "not_found", message: "No such global" });
      setCacheHeaders(reply, perspective, global.cv);
      return global;
    },
  );

  /* ------------------------------ public files ---------------------------- */
  // The page inventory + the generated robots.txt / sitemap.xml / llms.txt /
  // security.txt built on it. Served from delivery (key = site + perspective,
  // like every read) so a frontend just PROXIES its own /robots.txt etc.
  // through — content-driven, never stale on publish; apps/web is the
  // reference. Config lives per site in Settings → Site.

  const PublicPageOut = z.object({
    documentId: z.string(),
    type: z.string(),
    name: z.string(),
    locale: z.string(),
    urlPath: z.string(),
    lastmod: z.string(),
    noIndex: z.boolean(),
    description: z.string().optional(),
  });
  app.get(
    "/pages",
    {
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
      schema: { tags: ["delivery"], response: { 200: z.object({ pages: z.array(PublicPageOut), cv: z.number() }) } },
    },
    async (req, reply) => {
      const result = await deliveryPages(app.db, req.perspective!, req.deliverySiteId!);
      setCacheHeaders(reply, req.perspective!, result.cv);
      return result;
    },
  );

  /** Site row + parsed files config for the key's site. */
  async function siteFiles(req: FastifyRequest) {
    const s = await getSiteById(app.db, req.deliverySiteId!);
    return { site: s, cfg: parseSeoFilesConfig(s?.seoFiles), base: s?.canonicalBaseUrl ?? null };
  }
  function textFileHeaders(reply: FastifyReply, perspective: Perspective, contentType: string): void {
    reply.type(contentType);
    reply.header("Cache-Control", perspective === "preview" ? "private, no-store" : "public, max-age=300, stale-while-revalidate=600");
    reply.header("Vary", "Authorization, X-Api-Key");
  }
  const needsBase = (file: string) =>
    new AppError(
      409,
      "not_configured",
      `${file} needs absolute URLs — set the site's Canonical base URL (the public origin, e.g. https://www.example.com) in Settings → Site first.`,
    );

  app.get(
    "/robots.txt",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } }, schema: { tags: ["delivery"] } },
    async (req, reply) => {
      const { cfg, base } = await siteFiles(req);
      textFileHeaders(reply, req.perspective!, "text/plain; charset=utf-8");
      return buildRobotsTxt({ canonicalBaseUrl: base, robotsExtra: cfg.robotsExtra });
    },
  );
  app.get(
    "/sitemap.xml",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } }, schema: { tags: ["delivery"] } },
    async (req, reply) => {
      const { base } = await siteFiles(req);
      if (!base) throw needsBase("sitemap.xml");
      const { pages } = await deliveryPages(app.db, req.perspective!, req.deliverySiteId!);
      textFileHeaders(reply, req.perspective!, "application/xml; charset=utf-8");
      return buildSitemapXml(pages, base);
    },
  );
  app.get(
    "/llms.txt",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } }, schema: { tags: ["delivery"] } },
    async (req, reply) => {
      const { site, cfg, base } = await siteFiles(req);
      textFileHeaders(reply, req.perspective!, "text/plain; charset=utf-8");
      // A full editor override needs no base URL (it embeds its own links).
      if (cfg.llmsOverride?.trim()) return buildLlmsTxt({ siteName: "", canonicalBaseUrl: "", defaultLocale: "", pages: [], override: cfg.llmsOverride });
      if (!base) throw needsBase("llms.txt");
      const { pages } = await deliveryPages(app.db, req.perspective!, req.deliverySiteId!);
      return buildLlmsTxt({
        siteName: site?.name ?? "",
        canonicalBaseUrl: base,
        defaultLocale: site?.defaultLocale ?? "en",
        pages,
        summary: cfg.llmsSummary,
      });
    },
  );
  app.get(
    "/security.txt",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } }, schema: { tags: ["delivery"] } },
    async (req, reply) => {
      const { cfg, base } = await siteFiles(req);
      const body = buildSecurityTxt({ ...cfg, canonicalBaseUrl: base });
      if (body === null) {
        throw new AppError(
          404,
          "not_configured",
          "security.txt is not configured — RFC 9116 requires a Contact. Set one (email or https: URL) in Settings → Site → Public files.",
        );
      }
      textFileHeaders(reply, req.perspective!, "text/plain; charset=utf-8");
      return body;
    },
  );
}
