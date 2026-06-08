import {
  AppError,
  adminCreateUser,
  adminDeleteUser,
  adminUpdateUser,
  audit,
  cloneContent,
  createContent,
  createContentType,
  createDeliveryKey,
  createMcpToken,
  listMcpTokens,
  revokeMcpToken,
  createWebhook,
  deleteAsset,
  deleteWebhook,
  dispatchWebhooks,
  getAgentReviewRequired,
  getSiteConfig,
  getStoredAiKey,
  getStoredAiModel,
  getStoredStockConfig,
  markReviewed,
  setAgentReviewRequired,
  importStockImage,
  searchStockImages,
  setAiConfig,
  setStockConfig,
  setPreviewBaseUrl,
  setStartPage,
  listAudit,
  listDeliveryKeys,
  listTrash,
  emptyTrash,
  listAllLocales,
  createLocale,
  updateLocale,
  deleteLocale,
  listUsers,
  listWebhooks,
  renameDeliveryKey,
  restoreContent,
  restoreVersion,
  revokeDeliveryKey,
  softDelete,
  MEDIA_PREFIX,
  deliveryFlagDelta,
  discardDraft,
  insertAsset,
  listAssets,
  listBlocks,
  listPages,
  updateAssetAlt,
  getContent,
  getContentType,
  getTree,
  getVersion,
  contentTypeUsage,
  deleteContentType,
  listContentTypes,
  listLocales,
  listVersions,
  moveContent,
  publishContent,
  schedulePublish,
  searchContent,
  unpublishContent,
  updateContent,
  updateContentType,
  listSites,
  createSite,
  renameSite,
} from "@paperboy/db";
import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  Asset,
  BlockSummary,
  ContentDetail,
  ContentTypeDef,
  CreateContentRequest,
  Locale,
  RoleName,
  STOCK_PROVIDERS,
  StockSearchResult,
  TreeNode,
  UpdateContentRequest,
  sniffUpload,
} from "@paperboy/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { nanoid } from "nanoid";
import { z } from "zod";
import { requireAuth, requireCsrf, requirePermission } from "../security.js";

const LocaleQuery = z.object({ locale: z.string().optional() });
const DocParams = z.object({ documentId: z.string() });

export async function registerManageRoutes(appBase: FastifyInstance): Promise<void> {
  const app = appBase.withTypeProvider<ZodTypeProvider>();

  // Everything under /manage requires authentication.
  app.addHook("preHandler", requireAuth);

  /**
   * Fire publish/unpublish webhooks WITHOUT blocking the HTTP response. The
   * promise is intentionally not awaited (best-effort fan-out); errors are
   * swallowed by dispatchWebhooks per-hook and logged in webhook_delivery.
   */
  function emitContentEvent(
    event: "content.published" | "content.unpublished",
    detail: { documentId: string; type: string; kind: string; locale: string; name: string; urlPath: string | null },
  ): void {
    void dispatchWebhooks(app.db, { event, ...detail, at: new Date().toISOString() }).catch(() => undefined);
  }

  /* --------------------------- content types ---------------------------- */
  app.get(
    "/content-types",
    { schema: { tags: ["manage"], response: { 200: z.array(ContentTypeDef) } } },
    async () => listContentTypes(app.db),
  );
  app.get(
    "/content-types/:name",
    { schema: { tags: ["manage"], params: z.object({ name: z.string() }), response: { 200: ContentTypeDef } } },
    async (req) => getContentType(app.db, req.params.name),
  );
  app.get(
    "/content-types-usage",
    {
      schema: {
        tags: ["manage"],
        response: { 200: z.record(z.object({ items: z.number(), inlineIn: z.number() })) },
      },
    },
    async () => contentTypeUsage(app.db),
  );
  app.post(
    "/content-types",
    { preHandler: [requireCsrf, requirePermission("contenttype.manage")], schema: { tags: ["manage"], body: ContentTypeDef, response: { 200: ContentTypeDef } } },
    async (req) => {
      const created = await createContentType(app.db, req.accessCtx!, req.body);
      await audit(app.db, { actorUserId: req.user!.id, action: "contenttype.create", ip: req.ip, detail: { name: created.name, kind: created.kind, fields: created.fields.length } });
      return created;
    },
  );
  app.put(
    "/content-types/:name",
    { preHandler: [requireCsrf, requirePermission("contenttype.manage")], schema: { tags: ["manage"], params: z.object({ name: z.string() }), body: ContentTypeDef, response: { 200: ContentTypeDef } } },
    async (req) => {
      const { next, prev } = await updateContentType(app.db, req.accessCtx!, req.params.name, req.body);
      await audit(app.db, { actorUserId: req.user!.id, action: "contenttype.update", ip: req.ip, detail: { name: next.name, deliveryDelta: deliveryFlagDelta(prev, next) } });
      return next;
    },
  );
  app.delete(
    "/content-types/:name",
    { preHandler: [requireCsrf, requirePermission("contenttype.manage")], schema: { tags: ["manage"], params: z.object({ name: z.string() }), response: { 200: z.object({ ok: z.boolean() }) } } },
    async (req) => {
      await deleteContentType(app.db, req.accessCtx!, req.params.name);
      await audit(app.db, { actorUserId: req.user!.id, action: "contenttype.delete", ip: req.ip, detail: { name: req.params.name } });
      return { ok: true };
    },
  );

  /* ------------------------------ locales ------------------------------- */
  app.get(
    "/locales",
    { schema: { tags: ["manage"], response: { 200: z.array(Locale) } } },
    async () => {
      const rows = await listLocales(app.db);
      return rows.map((r) => ({
        code: r.code,
        displayName: r.displayName,
        isDefault: r.isDefault,
        enabled: r.enabled,
        fallbackLocaleCode: r.fallbackLocaleCode,
      }));
    },
  );
  app.get(
    "/locales/all",
    { preHandler: [requirePermission("contenttype.manage")], schema: { tags: ["manage"], response: { 200: z.array(Locale) } } },
    async (req) => {
      const rows = await listAllLocales(app.db, req.accessCtx!);
      return rows.map((r) => ({
        code: r.code,
        displayName: r.displayName,
        isDefault: r.isDefault,
        enabled: r.enabled,
        fallbackLocaleCode: r.fallbackLocaleCode,
      }));
    },
  );
  app.post(
    "/locales",
    { preHandler: [requireCsrf, requirePermission("contenttype.manage")], schema: { tags: ["manage"], body: z.object({ code: z.string().min(2).max(35), displayName: z.string().min(1).max(120), fallbackLocaleCode: z.string().nullable().optional() }), response: { 200: z.object({ ok: z.boolean() }) } } },
    async (req) => {
      await createLocale(app.db, req.accessCtx!, req.body);
      await audit(app.db, { actorUserId: req.user!.id, action: "locale.create", ip: req.ip, detail: { code: req.body.code } });
      return { ok: true };
    },
  );
  app.patch(
    "/locales/:code",
    { preHandler: [requireCsrf, requirePermission("contenttype.manage")], schema: { tags: ["manage"], params: z.object({ code: z.string() }), body: z.object({ displayName: z.string().min(1).max(120).optional(), fallbackLocaleCode: z.string().nullable().optional(), enabled: z.boolean().optional() }), response: { 200: z.object({ ok: z.boolean() }) } } },
    async (req) => {
      await updateLocale(app.db, req.accessCtx!, req.params.code, req.body);
      await audit(app.db, { actorUserId: req.user!.id, action: "locale.update", ip: req.ip, detail: { code: req.params.code, ...req.body } });
      return { ok: true };
    },
  );
  app.delete(
    "/locales/:code",
    { preHandler: [requireCsrf, requirePermission("contenttype.manage")], schema: { tags: ["manage"], params: z.object({ code: z.string() }), response: { 200: z.object({ ok: z.boolean() }) } } },
    async (req) => {
      await deleteLocale(app.db, req.accessCtx!, req.params.code);
      await audit(app.db, { actorUserId: req.user!.id, action: "locale.delete", ip: req.ip, detail: { code: req.params.code } });
      return { ok: true };
    },
  );

  /* ------------------------------- tree --------------------------------- */
  app.get(
    "/content/tree",
    {
      schema: {
        tags: ["manage"],
        querystring: z.object({ parentId: z.string().optional() }),
        response: { 200: z.array(TreeNode) },
      },
    },
    async (req) => getTree(app.db, req.accessCtx!, req.query.parentId ?? null),
  );

  /* --------------------------- asset pane: blocks ----------------------- */
  app.get(
    "/blocks",
    { schema: { tags: ["manage"], response: { 200: z.array(BlockSummary) } } },
    async (req) => listBlocks(app.db, req.accessCtx!),
  );

  /* ---------------------------- create/read ----------------------------- */
  app.post(
    "/content",
    { preHandler: [requireCsrf, requirePermission("content.create")], schema: { tags: ["manage"], body: CreateContentRequest, response: { 200: ContentDetail } } },
    async (req) => {
      const created = await createContent(app.db, req.accessCtx!, req.body);
      await audit(app.db, { actorUserId: req.user!.id, action: "content.create", documentId: created.documentId, locale: created.locale, ip: req.ip });
      return created;
    },
  );

  app.get(
    "/content/:documentId",
    { schema: { tags: ["manage"], params: DocParams, querystring: LocaleQuery, response: { 200: ContentDetail } } },
    async (req) => {
      const locale = req.query.locale ?? "en";
      return getContent(app.db, req.accessCtx!, req.params.documentId, locale);
    },
  );

  /* ------------------------------- update ------------------------------- */
  app.put(
    "/content/:documentId",
    { preHandler: [requireCsrf, requirePermission("content.update")], schema: { tags: ["manage"], params: DocParams, querystring: LocaleQuery, body: UpdateContentRequest, response: { 200: ContentDetail } } },
    async (req) => {
      const locale = req.query.locale ?? "en";
      const updated = await updateContent(app.db, req.accessCtx!, req.params.documentId, locale, req.body);
      await audit(app.db, { actorUserId: req.user!.id, action: "content.update", documentId: req.params.documentId, locale, ip: req.ip });
      return updated;
    },
  );

  /* ---------------------------- transitions ----------------------------- */
  app.post(
    "/content/:documentId/publish",
    { preHandler: [requireCsrf, requirePermission("content.publish")], schema: { tags: ["manage"], params: DocParams, querystring: LocaleQuery, response: { 200: ContentDetail } } },
    async (req) => {
      const locale = req.query.locale ?? "en";
      const r = await publishContent(app.db, req.accessCtx!, req.params.documentId, locale);
      await audit(app.db, { actorUserId: req.user!.id, action: "content.publish", documentId: req.params.documentId, locale, ip: req.ip });
      emitContentEvent("content.published", { documentId: r.documentId, type: r.type, kind: r.kind, locale, name: r.name, urlPath: r.urlPath });
      return r;
    },
  );
  // Scheduled publish: future go-live (publishAt) and/or expiry (expireAt). A
  // null publishAt only (re)sets/clears expiry and cancels a pending schedule.
  app.post(
    "/content/:documentId/schedule",
    {
      preHandler: [requireCsrf, requirePermission("content.publish")],
      schema: {
        tags: ["manage"],
        params: DocParams,
        querystring: LocaleQuery,
        body: z.object({ publishAt: z.string().datetime().nullable(), expireAt: z.string().datetime().nullable() }),
        response: { 200: ContentDetail },
      },
    },
    async (req) => {
      const locale = req.query.locale ?? "en";
      const r = await schedulePublish(app.db, req.accessCtx!, req.params.documentId, locale, {
        publishAt: req.body.publishAt ? new Date(req.body.publishAt) : null,
        expireAt: req.body.expireAt ? new Date(req.body.expireAt) : null,
      });
      await audit(app.db, {
        actorUserId: req.user!.id,
        action: "content.schedule",
        documentId: req.params.documentId,
        locale,
        ip: req.ip,
        detail: { publishAt: req.body.publishAt, expireAt: req.body.expireAt },
      });
      // If it published immediately, schedulePublish fired the webhook itself.
      return r;
    },
  );
  app.post(
    "/content/:documentId/unpublish",
    { preHandler: [requireCsrf, requirePermission("content.publish")], schema: { tags: ["manage"], params: DocParams, querystring: LocaleQuery, response: { 200: ContentDetail } } },
    async (req) => {
      const locale = req.query.locale ?? "en";
      const r = await unpublishContent(app.db, req.accessCtx!, req.params.documentId, locale);
      await audit(app.db, { actorUserId: req.user!.id, action: "content.unpublish", documentId: req.params.documentId, locale, ip: req.ip });
      emitContentEvent("content.unpublished", { documentId: r.documentId, type: r.type, kind: r.kind, locale, name: r.name, urlPath: r.urlPath });
      return r;
    },
  );
  // Human approval of an agent-written draft (clears the needs-review flag).
  app.post(
    "/content/:documentId/review",
    { preHandler: [requireCsrf, requirePermission("content.update")], schema: { tags: ["manage"], params: DocParams, querystring: LocaleQuery, response: { 200: ContentDetail } } },
    async (req) => {
      const locale = req.query.locale ?? "en";
      const r = await markReviewed(app.db, req.accessCtx!, req.params.documentId, locale);
      await audit(app.db, { actorUserId: req.user!.id, action: "content.review", documentId: req.params.documentId, locale, ip: req.ip });
      return r;
    },
  );
  app.post(
    "/content/:documentId/discard-draft",
    { preHandler: [requireCsrf, requirePermission("content.update")], schema: { tags: ["manage"], params: DocParams, querystring: LocaleQuery, response: { 200: z.object({ ok: z.boolean() }) } } },
    async (req) => {
      const locale = req.query.locale ?? "en";
      await discardDraft(app.db, req.accessCtx!, req.params.documentId, locale);
      await audit(app.db, { actorUserId: req.user!.id, action: "content.discard_draft", documentId: req.params.documentId, locale, ip: req.ip });
      return { ok: true };
    },
  );

  /* -------------------------------- move -------------------------------- */
  app.post(
    "/content/:documentId/move",
    { preHandler: [requireCsrf, requirePermission("content.update")], schema: { tags: ["manage"], params: DocParams, body: z.object({ parentId: z.string().nullable().optional(), beforeId: z.string().nullable().optional(), afterId: z.string().nullable().optional() }), response: { 200: z.object({ ok: z.boolean() }) } } },
    async (req) => {
      await moveContent(app.db, req.accessCtx!, req.params.documentId, req.body);
      await audit(app.db, { actorUserId: req.user!.id, action: "content.move", documentId: req.params.documentId, ip: req.ip, detail: { parentId: req.body.parentId } });
      return { ok: true };
    },
  );

  /* --------------------------- pages (move picker) ---------------------- */
  app.get(
    "/pages",
    { schema: { tags: ["manage"], response: { 200: z.array(z.object({ documentId: z.string(), name: z.string(), parentId: z.string().nullable(), type: z.string() })) } } },
    async (req) => listPages(app.db, req.accessCtx!),
  );

  /* ------------------------------- media -------------------------------- */
  app.get(
    "/assets",
    { schema: { tags: ["manage"], response: { 200: z.array(Asset) } } },
    async (req) => listAssets(app.db, req.accessCtx!),
  );

  app.post(
    "/assets",
    {
      preHandler: [requireCsrf, requirePermission("content.create")],
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: { tags: ["manage"], response: { 200: Asset } },
    },
    async (req) => {
      const data = await req.file();
      if (!data) throw new AppError(400, "bad_request", "No file uploaded");
      let buf: Buffer;
      try {
        buf = await data.toBuffer();
      } catch {
        throw new AppError(413, "too_large", "Max file size is 5 MB");
      }
      if (data.file.truncated) throw new AppError(413, "too_large", "Max file size is 5 MB");
      const sniff = sniffUpload(buf);
      if (!sniff) throw new AppError(415, "unsupported_media", "Only PNG, JPEG, GIF, WEBP images or PDF documents are allowed");
      const documentId = nanoid(24);
      const fileName = `${documentId}.${sniff.ext}`;
      await writeFile(join(app.uploadsDir, fileName), buf); // safe: server-generated name
      const rec = await insertAsset(app.db, req.accessCtx!, {
        documentId,
        filename: data.filename,
        mime: sniff.mime,
        size: buf.length,
        relativePath: `${MEDIA_PREFIX}/${fileName}`,
      });
      await audit(app.db, { actorUserId: req.user!.id, action: "asset.upload", documentId, ip: req.ip, detail: { mime: rec.mime, size: rec.size } });
      return rec;
    },
  );

  app.put(
    "/assets/:documentId",
    { preHandler: [requireCsrf, requirePermission("content.update")], schema: { tags: ["manage"], params: DocParams, body: z.object({ alt: z.string().max(300) }), response: { 200: Asset } } },
    async (req) => updateAssetAlt(app.db, req.accessCtx!, req.params.documentId, req.body.alt),
  );

  app.delete(
    "/assets/:documentId",
    { preHandler: [requireCsrf, requirePermission("content.delete")], schema: { tags: ["manage"], params: DocParams, response: { 200: z.object({ ok: z.boolean() }) } } },
    async (req) => {
      const { relativePath } = await deleteAsset(app.db, req.accessCtx!, req.params.documentId);
      // Best-effort file unlink (the DB row is the source of truth; a leftover file is harmless).
      const fileName = relativePath.replace(`${MEDIA_PREFIX}/`, "");
      if (fileName && !fileName.includes("/") && !fileName.includes("..")) {
        await unlink(join(app.uploadsDir, fileName)).catch(() => undefined);
      }
      await audit(app.db, { actorUserId: req.user!.id, action: "asset.delete", documentId: req.params.documentId, ip: req.ip });
      return { ok: true };
    },
  );

  /* ------------------------------- search ------------------------------- */
  app.get(
    "/content/search",
    {
      preHandler: [requirePermission("content.read")],
      schema: {
        tags: ["manage"],
        querystring: z.object({ q: z.string(), limit: z.coerce.number().optional() }),
        response: {
          200: z.array(
            z.object({
              documentId: z.string(),
              type: z.string(),
              kind: z.enum(["page", "block", "global"]),
              name: z.string(),
              locale: z.string(),
              urlPath: z.string().nullable(),
            }),
          ),
        },
      },
    },
    async (req) => searchContent(app.db, req.accessCtx!, req.query.q, { limit: req.query.limit }),
  );

  /* ------------------------------ versions ------------------------------ */
  app.get(
    "/content/:documentId/versions",
    { schema: { tags: ["manage"], params: DocParams, querystring: LocaleQuery, response: { 200: z.array(z.object({ id: z.number(), versionNumber: z.number(), status: z.string(), isCurrentPublished: z.boolean(), name: z.string(), createdAt: z.string(), createdBy: z.string().nullable(), publishAt: z.string().nullable(), expireAt: z.string().nullable() })) } } },
    async (req) => {
      const locale = req.query.locale ?? "en";
      const rows = await listVersions(app.db, req.accessCtx!, req.params.documentId, locale);
      return rows.map((r) => ({
        ...r,
        createdAt: r.createdAt.toISOString(),
        publishAt: r.publishAt ? r.publishAt.toISOString() : null,
        expireAt: r.expireAt ? r.expireAt.toISOString() : null,
      }));
    },
  );

  // Full payload of one version — powers the compare/diff view.
  app.get(
    "/content/:documentId/versions/:versionId",
    {
      schema: {
        tags: ["manage"],
        params: z.object({ documentId: z.string(), versionId: z.coerce.number() }),
        querystring: LocaleQuery,
        response: {
          200: z.object({
            id: z.number(),
            versionNumber: z.number(),
            status: z.enum(["draft", "published"]),
            isCurrentPublished: z.boolean(),
            name: z.string(),
            slug: z.string().nullable(),
            displayInNav: z.boolean(),
            data: z.record(z.unknown()),
            createdAt: z.string(),
            createdBy: z.string().nullable(),
          }),
        },
      },
    },
    async (req) => {
      const locale = req.query.locale ?? "en";
      return getVersion(app.db, req.accessCtx!, req.params.documentId, locale, req.params.versionId);
    },
  );

  /* --------------------------- delivery keys ---------------------------- */
  app.post(
    "/delivery-keys",
    { preHandler: [requireCsrf, requirePermission("deliverykey.manage")], schema: { tags: ["manage"], body: z.object({ name: z.string(), type: z.enum(["public", "preview"]) }), response: { 200: z.object({ key: z.string() }) } } },
    async (req) => {
      const r = await createDeliveryKey(app.db, req.accessCtx!.siteId, req.body.name, req.body.type);
      await audit(app.db, { actorUserId: req.user!.id, action: "deliverykey.create", ip: req.ip, detail: { type: req.body.type } });
      return r;
    },
  );

  const DeliveryKeyRow = z.object({
    id: z.number(),
    name: z.string(),
    keyPrefix: z.string(),
    type: z.enum(["public", "preview"]),
    createdAt: z.string(),
    revokedAt: z.string().nullable(),
  });
  app.get(
    "/delivery-keys",
    { preHandler: [requirePermission("deliverykey.manage")], schema: { tags: ["manage"], response: { 200: z.array(DeliveryKeyRow) } } },
    async (req) => listDeliveryKeys(app.db, req.accessCtx!),
  );
  app.put(
    "/delivery-keys/:id",
    { preHandler: [requireCsrf, requirePermission("deliverykey.manage")], schema: { tags: ["manage"], params: z.object({ id: z.coerce.number() }), body: z.object({ name: z.string().min(1).max(120) }), response: { 200: z.object({ ok: z.boolean() }) } } },
    async (req) => {
      await renameDeliveryKey(app.db, req.accessCtx!, req.params.id, req.body.name);
      await audit(app.db, { actorUserId: req.user!.id, action: "deliverykey.rename", ip: req.ip, detail: { id: req.params.id, name: req.body.name } });
      return { ok: true };
    },
  );
  app.post(
    "/delivery-keys/:id/revoke",
    { preHandler: [requireCsrf, requirePermission("deliverykey.manage")], schema: { tags: ["manage"], params: z.object({ id: z.coerce.number() }), response: { 200: z.object({ ok: z.boolean() }) } } },
    async (req) => {
      await revokeDeliveryKey(app.db, req.accessCtx!, req.params.id);
      await audit(app.db, { actorUserId: req.user!.id, action: "deliverykey.revoke", ip: req.ip, detail: { id: req.params.id } });
      return { ok: true };
    },
  );

  /* ------------------------------ MCP tokens ----------------------------- */
  const McpTokenRow = z.object({
    id: z.number(), name: z.string(), userId: z.string(), email: z.string(),
    createdAt: z.string(), lastUsedAt: z.string().nullable(), revokedAt: z.string().nullable(),
  });
  app.get(
    "/mcp-tokens",
    { preHandler: [requirePermission("user.manage")], schema: { tags: ["manage"], response: { 200: z.array(McpTokenRow) } } },
    async (req) => listMcpTokens(app.db, req.accessCtx!),
  );
  app.post(
    "/mcp-tokens",
    { preHandler: [requireCsrf, requirePermission("user.manage")], schema: { tags: ["manage"], body: z.object({ name: z.string().min(1).max(80), userId: z.string() }), response: { 200: z.object({ token: z.string() }) } } },
    async (req) => {
      const r = await createMcpToken(app.db, req.accessCtx!, req.body);
      await audit(app.db, { actorUserId: req.user!.id, action: "mcptoken.create", ip: req.ip, detail: { name: req.body.name, userId: req.body.userId } });
      return r;
    },
  );
  app.post(
    "/mcp-tokens/:id/revoke",
    { preHandler: [requireCsrf, requirePermission("user.manage")], schema: { tags: ["manage"], params: z.object({ id: z.coerce.number() }), response: { 200: z.object({ ok: z.boolean() }) } } },
    async (req) => {
      await revokeMcpToken(app.db, req.accessCtx!, req.params.id);
      await audit(app.db, { actorUserId: req.user!.id, action: "mcptoken.revoke", ip: req.ip, detail: { id: req.params.id } });
      return { ok: true };
    },
  );

  /* -------------------------------- trash ------------------------------- */
  app.get(
    "/content/trash",
    { preHandler: [requirePermission("content.read")], schema: { tags: ["manage"], response: { 200: z.array(z.object({ documentId: z.string(), type: z.string(), kind: z.string(), name: z.string(), deletedAt: z.string() })) } } },
    async (req) => listTrash(app.db, req.accessCtx!),
  );
  app.post(
    "/content/trash/empty",
    { preHandler: [requireCsrf, requirePermission("content.delete")], schema: { tags: ["manage"], response: { 200: z.object({ ok: z.boolean(), purged: z.number() }) } } },
    async (req) => {
      const r = await emptyTrash(app.db, req.accessCtx!);
      await audit(app.db, { actorUserId: req.user!.id, action: "content.trash.empty", ip: req.ip, detail: r });
      return { ok: true, ...r };
    },
  );
  app.delete(
    "/content/:documentId",
    { preHandler: [requireCsrf, requirePermission("content.delete")], schema: { tags: ["manage"], params: DocParams, response: { 200: z.object({ ok: z.boolean(), trashed: z.number() }) } } },
    async (req) => {
      const r = await softDelete(app.db, req.accessCtx!, req.params.documentId);
      await audit(app.db, { actorUserId: req.user!.id, action: "content.trash", documentId: req.params.documentId, ip: req.ip, detail: r });
      return { ok: true, ...r };
    },
  );
  app.post(
    "/content/:documentId/restore",
    { preHandler: [requireCsrf, requirePermission("content.delete")], schema: { tags: ["manage"], params: DocParams, response: { 200: z.object({ ok: z.boolean(), restored: z.number() }) } } },
    async (req) => {
      const r = await restoreContent(app.db, req.accessCtx!, req.params.documentId);
      await audit(app.db, { actorUserId: req.user!.id, action: "content.restore", documentId: req.params.documentId, ip: req.ip, detail: r });
      return { ok: true, ...r };
    },
  );

  /* ------------------------------ duplicate ----------------------------- */
  app.post(
    "/content/:documentId/duplicate",
    { preHandler: [requireCsrf, requirePermission("content.create")], schema: { tags: ["manage"], params: DocParams, querystring: LocaleQuery, response: { 200: ContentDetail } } },
    async (req) => {
      const locale = req.query.locale ?? "en";
      const created = await cloneContent(app.db, req.accessCtx!, req.params.documentId, locale);
      await audit(app.db, { actorUserId: req.user!.id, action: "content.duplicate", documentId: created.documentId, ip: req.ip, detail: { from: req.params.documentId } });
      return created;
    },
  );

  /* -------------------------- version restore --------------------------- */
  app.post(
    "/content/:documentId/versions/:versionId/restore",
    { preHandler: [requireCsrf, requirePermission("content.update")], schema: { tags: ["manage"], params: z.object({ documentId: z.string(), versionId: z.coerce.number() }), querystring: LocaleQuery, response: { 200: ContentDetail } } },
    async (req) => {
      const locale = req.query.locale ?? "en";
      const r = await restoreVersion(app.db, req.accessCtx!, req.params.documentId, locale, req.params.versionId);
      await audit(app.db, { actorUserId: req.user!.id, action: "content.version_restore", documentId: req.params.documentId, locale, ip: req.ip, detail: { versionId: req.params.versionId } });
      return r;
    },
  );

  /* ------------------------------ site config --------------------------- */
  app.get(
    "/site",
    { preHandler: [requirePermission("content.read")], schema: { tags: ["manage"], response: { 200: z.object({ startPageId: z.string().nullable(), previewBaseUrl: z.string() }) } } },
    async (req) => getSiteConfig(app.db, req.accessCtx!),
  );
  app.post(
    "/site/start-page",
    { preHandler: [requireCsrf, requirePermission("content.publish")], schema: { tags: ["manage"], body: z.object({ documentId: z.string().nullable() }), response: { 200: z.object({ ok: z.boolean() }) } } },
    async (req) => {
      await setStartPage(app.db, req.accessCtx!, req.body.documentId);
      await audit(app.db, { actorUserId: req.user!.id, action: "site.start_page", documentId: req.body.documentId, ip: req.ip });
      return { ok: true };
    },
  );
  app.post(
    "/site/preview-url",
    { preHandler: [requireCsrf, requirePermission("content.publish")], schema: { tags: ["manage"], body: z.object({ url: z.string().max(2000) }), response: { 200: z.object({ ok: z.boolean() }) } } },
    async (req) => {
      await setPreviewBaseUrl(app.db, req.accessCtx!, req.body.url);
      await audit(app.db, { actorUserId: req.user!.id, action: "site.preview_url", ip: req.ip });
      return { ok: true };
    },
  );

  /* ------------------------------- AI key ------------------------------- */
  // Write-only AI provider config. The key is never returned — only whether one
  // is set, where it comes from (CMS DB vs env fallback), its last 4 chars, and
  // the model. Admin-gated (user.manage).
  const AiConfigStatus = z.object({
    configured: z.boolean(),
    source: z.enum(["db", "env", "none"]),
    last4: z.string().nullable(),
    model: z.string().nullable(),
  });
  async function aiStatus(): Promise<z.infer<typeof AiConfigStatus>> {
    const dbKey = await getStoredAiKey(app.db);
    const key = dbKey ?? app.aiConfig.apiKey;
    const dbModel = await getStoredAiModel(app.db);
    return {
      configured: Boolean(key),
      source: dbKey ? "db" : app.aiConfig.apiKey ? "env" : "none",
      last4: key ? key.slice(-4) : null,
      model: dbModel ?? app.aiConfig.model ?? null,
    };
  }
  app.get(
    "/site/ai",
    { preHandler: [requirePermission("user.manage")], schema: { tags: ["manage"], response: { 200: AiConfigStatus } } },
    async () => aiStatus(),
  );
  app.post(
    "/site/ai",
    {
      preHandler: [requireCsrf, requirePermission("user.manage")],
      schema: {
        tags: ["manage"],
        body: z.object({ apiKey: z.string().max(400).nullable().optional(), model: z.string().max(120).nullable().optional() }),
        response: { 200: AiConfigStatus },
      },
    },
    async (req) => {
      await setAiConfig(app.db, req.accessCtx!, { apiKey: req.body.apiKey, model: req.body.model });
      await audit(app.db, {
        actorUserId: req.user!.id,
        action: "site.ai_config",
        ip: req.ip,
        // Never log the key itself — only what changed.
        detail: {
          keySet: typeof req.body.apiKey === "string" && req.body.apiKey.trim().length > 0,
          keyCleared: req.body.apiKey === null || req.body.apiKey === "",
          model: req.body.model ?? undefined,
        },
      });
      return aiStatus();
    },
  );

  /* ----------------------------- agent review --------------------------- */
  // Opt-in gate: agent (MCP) drafts must be human-approved before an AGENT may
  // publish them. Default off so existing agent pipelines keep working.
  app.get(
    "/site/agent-review",
    { preHandler: [requirePermission("user.manage")], schema: { tags: ["manage"], response: { 200: z.object({ required: z.boolean() }) } } },
    async () => ({ required: await getAgentReviewRequired(app.db) }),
  );
  app.post(
    "/site/agent-review",
    { preHandler: [requireCsrf, requirePermission("user.manage")], schema: { tags: ["manage"], body: z.object({ required: z.boolean() }), response: { 200: z.object({ required: z.boolean() }) } } },
    async (req) => {
      await setAgentReviewRequired(app.db, req.accessCtx!, req.body.required);
      await audit(app.db, { actorUserId: req.user!.id, action: "site.agent_review", ip: req.ip, detail: { required: req.body.required } });
      return { required: req.body.required };
    },
  );

  /* ----------------------------- stock images --------------------------- */
  // Stock image provider (Unsplash first). Same write-only key handling as the
  // AI config: the key is never returned, only configured/source/last4.
  const StockConfigStatus = z.object({
    configured: z.boolean(),
    provider: z.enum(STOCK_PROVIDERS),
    source: z.enum(["db", "env", "none"]),
    last4: z.string().nullable(),
  });
  async function stockStatus(): Promise<z.infer<typeof StockConfigStatus>> {
    const stored = await getStoredStockConfig(app.db);
    const key = stored?.apiKey ?? app.stockConfig.unsplashKey;
    return {
      configured: Boolean(key),
      provider: stored?.provider ?? "unsplash",
      source: stored?.apiKey ? "db" : app.stockConfig.unsplashKey ? "env" : "none",
      last4: key ? key.slice(-4) : null,
    };
  }
  app.get(
    "/stock/config",
    { preHandler: [requirePermission("user.manage")], schema: { tags: ["manage"], response: { 200: StockConfigStatus } } },
    async () => stockStatus(),
  );
  app.post(
    "/stock/config",
    {
      preHandler: [requireCsrf, requirePermission("user.manage")],
      schema: {
        tags: ["manage"],
        body: z.object({ provider: z.enum(STOCK_PROVIDERS).optional(), apiKey: z.string().max(400).nullable().optional() }),
        response: { 200: StockConfigStatus },
      },
    },
    async (req) => {
      await setStockConfig(app.db, req.accessCtx!, { provider: req.body.provider, apiKey: req.body.apiKey });
      await audit(app.db, {
        actorUserId: req.user!.id,
        action: "site.stock_config",
        ip: req.ip,
        // Never log the key itself — only what changed.
        detail: {
          keySet: typeof req.body.apiKey === "string" && req.body.apiKey.trim().length > 0,
          keyCleared: req.body.apiKey === null || req.body.apiKey === "",
          provider: req.body.provider,
        },
      });
      return stockStatus();
    },
  );
  app.get(
    "/stock/search",
    {
      preHandler: [requirePermission("content.read")],
      // Protects the provider's request budget (Unsplash demo keys: 50/hour).
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: { tags: ["manage"], querystring: z.object({ q: z.string().min(1).max(200) }), response: { 200: z.array(StockSearchResult) } },
    },
    async (req) => searchStockImages(app.db, req.accessCtx!, req.query.q, app.stockConfig.unsplashKey),
  );
  app.post(
    "/stock/import",
    {
      preHandler: [requireCsrf, requirePermission("content.create")],
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } }, // matches /assets upload
      schema: {
        tags: ["manage"],
        body: z.object({ providerId: z.string().min(1).max(200), alt: z.string().max(300).optional() }),
        response: { 200: Asset },
      },
    },
    async (req) => {
      const rec = await importStockImage(app.db, req.accessCtx!, req.body, {
        envKey: app.stockConfig.unsplashKey,
        save: async (fileName, buf) => {
          await writeFile(join(app.uploadsDir, fileName), buf); // safe: server-generated name
          return { relativePath: `${MEDIA_PREFIX}/${fileName}` };
        },
      });
      await audit(app.db, {
        actorUserId: req.user!.id,
        action: "asset.import",
        documentId: rec.documentId,
        ip: req.ip,
        detail: { provider: rec.sourceMeta?.provider, providerId: req.body.providerId, mime: rec.mime, size: rec.size },
      });
      return rec;
    },
  );

  /* ------------------------------ webhooks ------------------------------ */
  const WebhookRow = z.object({
    id: z.number(),
    name: z.string(),
    url: z.string(),
    events: z.array(z.string()),
    active: z.boolean(),
    lastStatus: z.number().nullable(),
    lastAt: z.string().nullable(),
    createdAt: z.string(),
  });
  app.get(
    "/webhooks",
    { preHandler: [requirePermission("webhook.manage")], schema: { tags: ["manage"], response: { 200: z.array(WebhookRow) } } },
    async (req) => listWebhooks(app.db, req.accessCtx!),
  );
  app.post(
    "/webhooks",
    { preHandler: [requireCsrf, requirePermission("webhook.manage")], schema: { tags: ["manage"], body: z.object({ name: z.string().min(1).max(120), url: z.string().max(2000), events: z.array(z.string()).optional() }), response: { 200: z.object({ id: z.number(), secret: z.string() }) } } },
    async (req) => {
      const r = await createWebhook(app.db, req.accessCtx!, req.body);
      await audit(app.db, { actorUserId: req.user!.id, action: "webhook.create", ip: req.ip, detail: { name: req.body.name, url: req.body.url } });
      return r;
    },
  );
  app.delete(
    "/webhooks/:id",
    { preHandler: [requireCsrf, requirePermission("webhook.manage")], schema: { tags: ["manage"], params: z.object({ id: z.coerce.number() }), response: { 200: z.object({ ok: z.boolean() }) } } },
    async (req) => {
      await deleteWebhook(app.db, req.accessCtx!, req.params.id);
      await audit(app.db, { actorUserId: req.user!.id, action: "webhook.delete", ip: req.ip, detail: { id: req.params.id } });
      return { ok: true };
    },
  );

  /* ------------------------------- audit -------------------------------- */
  app.get(
    "/audit",
    { preHandler: [requirePermission("audit.read")], schema: { tags: ["manage"], querystring: z.object({ limit: z.coerce.number().optional(), before: z.coerce.number().optional(), action: z.string().max(80).optional(), actor: z.string().max(60).optional(), documentId: z.string().max(60).optional(), from: z.string().max(40).optional(), to: z.string().max(40).optional() }), response: { 200: z.array(z.object({ id: z.number(), ts: z.string(), actorUserId: z.string().nullable(), actorName: z.string().nullable(), action: z.string(), documentId: z.string().nullable(), locale: z.string().nullable(), ip: z.string().nullable(), detail: z.unknown() })) } } },
    async (req) => listAudit(app.db, req.accessCtx!, { limit: req.query.limit, before: req.query.before, action: req.query.action, actorUserId: req.query.actor, documentId: req.query.documentId, from: req.query.from, to: req.query.to }),
  );

  /* ------------------------------- users -------------------------------- */
  const ManagedUserRow = z.object({
    id: z.string(),
    email: z.string(),
    name: z.string(),
    roles: z.array(RoleName),
    sections: z.array(z.string()),
    locked: z.boolean(),
    createdAt: z.string(),
  });
  app.get(
    "/users",
    { preHandler: [requirePermission("user.manage")], schema: { tags: ["manage"], response: { 200: z.array(ManagedUserRow) } } },
    async (req) => listUsers(app.db, req.accessCtx!),
  );
  app.post(
    "/users",
    { preHandler: [requireCsrf, requirePermission("user.manage")], schema: { tags: ["manage"], body: z.object({ email: z.string().email(), name: z.string().min(1).max(120), password: z.string().min(10).max(200), roles: z.array(RoleName).min(1), sections: z.array(z.string()).optional() }), response: { 200: z.object({ id: z.string() }) } } },
    async (req) => {
      const id = await adminCreateUser(app.db, req.accessCtx!, req.body);
      await audit(app.db, { actorUserId: req.user!.id, action: "user.create", ip: req.ip, detail: { email: req.body.email, roles: req.body.roles } });
      return { id };
    },
  );
  app.put(
    "/users/:id",
    { preHandler: [requireCsrf, requirePermission("user.manage")], schema: { tags: ["manage"], params: z.object({ id: z.string() }), body: z.object({ name: z.string().min(1).max(120).optional(), email: z.string().email().max(200).optional(), roles: z.array(RoleName).optional(), sections: z.array(z.string()).optional() }), response: { 200: z.object({ ok: z.boolean() }) } } },
    async (req) => {
      await adminUpdateUser(app.db, req.accessCtx!, req.params.id, req.body);
      await audit(app.db, { actorUserId: req.user!.id, action: "user.update", ip: req.ip, detail: { id: req.params.id, roles: req.body.roles, email: req.body.email } });
      return { ok: true };
    },
  );
  app.delete(
    "/users/:id",
    { preHandler: [requireCsrf, requirePermission("user.manage")], schema: { tags: ["manage"], params: z.object({ id: z.string() }), response: { 200: z.object({ ok: z.boolean() }) } } },
    async (req) => {
      await adminDeleteUser(app.db, req.accessCtx!, req.params.id);
      await audit(app.db, { actorUserId: req.user!.id, action: "user.delete", ip: req.ip, detail: { id: req.params.id } });
      return { ok: true };
    },
  );

  /* --------------------------------- sites ---------------------------------- */
  const SiteOut = z.object({
    id: z.string(),
    slug: z.string(),
    name: z.string(),
    defaultLocale: z.string(),
    active: z.boolean(),
    createdAt: z.string(),
    previewBaseUrl: z.string().nullable(),
    startPageId: z.string().nullable(),
  });

  // List all sites + which one is active for this request (the site switcher).
  app.get(
    "/sites",
    { preHandler: [requirePermission("content.read")], schema: { tags: ["manage"], response: { 200: z.object({ sites: z.array(SiteOut), activeSiteId: z.string() }) } } },
    async (req) => {
      const sites = await listSites(app.db, req.accessCtx!);
      return {
        sites: sites.map((s) => ({ ...s, createdAt: s.createdAt.toISOString() })),
        activeSiteId: req.accessCtx!.siteId,
      };
    },
  );

  // Create a site (cross-site admin: user.manage).
  app.post(
    "/sites",
    {
      preHandler: [requireCsrf, requirePermission("user.manage")],
      schema: {
        tags: ["manage"],
        body: z.object({ slug: z.string().min(1).max(60), name: z.string().min(1).max(120), defaultLocale: z.string().min(2).max(35) }),
        response: { 200: SiteOut },
      },
    },
    async (req) => {
      const site = await createSite(app.db, req.accessCtx!, req.body);
      await audit(app.db, { actorUserId: req.user!.id, action: "site.create", ip: req.ip, detail: { id: site.id, slug: site.slug } });
      return { ...site, createdAt: site.createdAt.toISOString() };
    },
  );

  // Rename a site (name and/or slug). Targets the :id, not the active site.
  app.patch(
    "/sites/:id",
    {
      preHandler: [requireCsrf, requirePermission("user.manage")],
      schema: {
        tags: ["manage"],
        params: z.object({ id: z.string() }),
        body: z.object({ name: z.string().min(1).max(120).optional(), slug: z.string().min(1).max(60).optional() }),
        response: { 200: SiteOut },
      },
    },
    async (req) => {
      const site = await renameSite(app.db, req.accessCtx!, req.params.id, req.body);
      await audit(app.db, { actorUserId: req.user!.id, action: "site.rename", ip: req.ip, detail: { id: site.id, name: site.name, slug: site.slug } });
      return { ...site, createdAt: site.createdAt.toISOString() };
    },
  );
}
