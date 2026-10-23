import {
  audit,
  createRedirect,
  deleteNotFound,
  deleteRedirects,
  exportRedirectsCsv,
  importRedirects,
  listNotFound,
  listRedirects,
  testRedirect,
  updateRedirect,
} from "@paperboy/db";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAuth, requireCsrf, requirePermission } from "../security.js";

/**
 * Settings → Redirects (management side), for the ACTIVE site. Reads need
 * content.read; every write needs content.publish — the same gate as the rest
 * of the site's public setup (preview URL, public files), because a redirect
 * changes what visitors get. The rules themselves live in packages/db/src/redirects.ts.
 */

const Status = z.union([z.literal(301), z.literal(302), z.literal(307), z.literal(308), z.literal(410)]);

const Problem = z.object({ code: z.enum(["target-missing", "target-unpublished", "shadowed", "chain", "loop"]), message: z.string() });
const Target = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("page"), documentId: z.string(), locale: z.string(), name: z.string().nullable(), url: z.string().nullable() }),
  z.object({ kind: z.literal("path"), path: z.string() }),
  z.object({ kind: z.literal("url"), url: z.string() }),
  z.object({ kind: z.literal("gone") }),
]);
const RedirectOut = z.object({
  id: z.number(),
  source: z.string(),
  sourcePath: z.string(),
  match: z.enum(["exact", "prefix"]),
  target: Target,
  status: Status,
  keepQuery: z.boolean(),
  origin: z.enum(["manual", "auto", "import"]),
  note: z.string().nullable(),
  hits: z.number(),
  lastHitAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  problems: z.array(Problem),
});
const WriteOut = z.object({ redirect: RedirectOut, collapsed: z.boolean(), repointed: z.number() });

const RedirectBody = z.object({
  source: z.string().min(1).max(1000),
  target: z.string().max(2000).nullable().optional(),
  targetDocumentId: z.string().max(64).nullable().optional(),
  targetLocale: z.string().max(35).nullable().optional(),
  status: Status.optional(),
  keepQuery: z.boolean().optional(),
  note: z.string().max(500).nullable().optional(),
});

export async function registerRedirectRoutes(appBase: FastifyInstance): Promise<void> {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  app.addHook("preHandler", requireAuth);

  app.get(
    "/redirects",
    {
      preHandler: [requirePermission("content.read")],
      schema: { tags: ["manage"], summary: "List redirect rules (active site)", querystring: z.object({ targetDocumentId: z.string().max(64).optional() }), response: { 200: z.array(RedirectOut) } },
    },
    async (req) => listRedirects(app.db, req.accessCtx!, { targetDocumentId: req.query.targetDocumentId }),
  );

  app.post(
    "/redirects",
    { preHandler: [requireCsrf, requirePermission("content.publish")], schema: { tags: ["manage"], summary: "Create a redirect rule", body: RedirectBody, response: { 200: WriteOut } } },
    async (req) => {
      const out = await createRedirect(app.db, req.accessCtx!, req.body);
      await audit(app.db, { siteId: req.accessCtx?.siteId, actorUserId: req.user!.id, action: "redirect.create", ip: req.ip, detail: { id: out.redirect.id, source: out.redirect.source, status: out.redirect.status } });
      return out;
    },
  );

  app.patch(
    "/redirects/:id",
    {
      preHandler: [requireCsrf, requirePermission("content.publish")],
      schema: { tags: ["manage"], summary: "Update a redirect rule", params: z.object({ id: z.coerce.number().int() }), body: RedirectBody.partial(), response: { 200: WriteOut } },
    },
    async (req) => {
      const out = await updateRedirect(app.db, req.accessCtx!, req.params.id, req.body);
      await audit(app.db, { siteId: req.accessCtx?.siteId, actorUserId: req.user!.id, action: "redirect.update", ip: req.ip, detail: { id: req.params.id, ...req.body } });
      return out;
    },
  );

  app.post(
    "/redirects/delete",
    {
      preHandler: [requireCsrf, requirePermission("content.publish")],
      schema: { tags: ["manage"], summary: "Delete redirect rules", body: z.object({ ids: z.array(z.number().int()).min(1).max(5000) }), response: { 200: z.object({ deleted: z.number() }) } },
    },
    async (req) => {
      const deleted = await deleteRedirects(app.db, req.accessCtx!, req.body.ids);
      await audit(app.db, { siteId: req.accessCtx?.siteId, actorUserId: req.user!.id, action: "redirect.delete", ip: req.ip, detail: { ids: req.body.ids, deleted } });
      return { deleted };
    },
  );

  app.get(
    "/redirects/test",
    {
      preHandler: [requirePermission("content.read")],
      schema: {
        tags: ["manage"],
        summary: "Follow a URL through pages and rules, hop by hop",
        querystring: z.object({ url: z.string().min(1).max(2000) }),
        response: {
          200: z.object({
            hops: z.number(),
            steps: z.array(
              z.object({
                path: z.string(),
                result: z.enum(["page", "redirect", "gone", "external", "not-found", "loop"]),
                ruleId: z.number().optional(),
                status: Status.optional(),
                location: z.string().nullable().optional(),
                page: z.object({ documentId: z.string(), locale: z.string() }).optional(),
              }),
            ),
          }),
        },
      },
    },
    async (req) => testRedirect(app.db, req.accessCtx!, req.query.url),
  );

  app.get(
    "/redirects.csv",
    { preHandler: [requirePermission("content.read")], schema: { tags: ["manage"], summary: "Export redirect rules as CSV", response: { 200: z.string() } } },
    async (req, reply) => {
      const csv = await exportRedirectsCsv(app.db, req.accessCtx!);
      reply.header("content-type", "text/csv; charset=utf-8");
      reply.header("content-disposition", 'attachment; filename="redirects.csv"');
      return csv;
    },
  );

  app.post(
    "/redirects/import",
    {
      preHandler: [requireCsrf, requirePermission("content.publish")],
      schema: {
        tags: ["manage"],
        summary: "Import redirect rules from CSV (dryRun previews every row)",
        body: z.object({ csv: z.string().max(2_000_000), dryRun: z.boolean().default(true) }),
        response: {
          200: z.object({
            created: z.number(),
            updated: z.number(),
            errors: z.number(),
            rows: z.array(z.object({ line: z.number(), source: z.string(), target: z.string(), action: z.enum(["create", "update", "unchanged", "error"]), message: z.string().optional() })),
          }),
        },
      },
    },
    async (req) => {
      const out = await importRedirects(app.db, req.accessCtx!, req.body.csv, { dryRun: req.body.dryRun });
      if (!req.body.dryRun) {
        await audit(app.db, { siteId: req.accessCtx?.siteId, actorUserId: req.user!.id, action: "redirect.import", ip: req.ip, detail: { created: out.created, updated: out.updated, errors: out.errors } });
      }
      return out;
    },
  );

  app.get(
    "/redirects/not-found",
    {
      preHandler: [requirePermission("content.read")],
      schema: {
        tags: ["manage"],
        summary: "Paths that answered 404 on the frontend (aggregated)",
        response: { 200: z.array(z.object({ path: z.string(), hits: z.number(), firstSeen: z.string(), lastSeen: z.string(), coveredBy: z.number().nullable() })) },
      },
    },
    async (req) => listNotFound(app.db, req.accessCtx!),
  );

  app.post(
    "/redirects/not-found/delete",
    {
      preHandler: [requireCsrf, requirePermission("content.publish")],
      schema: { tags: ["manage"], summary: "Dismiss 404 paths", body: z.object({ paths: z.array(z.string().max(2000)).min(1).max(2000) }), response: { 200: z.object({ deleted: z.number() }) } },
    },
    async (req) => ({ deleted: await deleteNotFound(app.db, req.accessCtx!, req.body.paths) }),
  );
}
