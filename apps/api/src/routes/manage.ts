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
  resolveAiRuntimeConfig,
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
  removeAssetFiles,
  deliveryFlagDelta,
  deleteVariant,
  discardDraft,
  insertAsset,
  listAssets,
  listBlocks,
  listFolders,
  createFolder,
  renameFolder,
  deleteFolder,
  setAssetFolder,
  setBlockFolder,
  listPages,
  updateAssetAlt,
  getContent,
  getContentType,
  getTypeTemplate,
  exportTypeTemplates,
  importTypeTemplates,
  findReferencingDocuments,
  getTree,
  getVersion,
  contentTypeUsage,
  deleteContentType,
  deleteTypeTemplate,
  createTypeTemplate,
  updateTypeTemplate,
  listTypeTemplates,
  instantiateTypeTemplate,
  listContentTypes,
  listLocales,
  listVersions,
  moveContent,
  publishContent,
  setChildSort,
  schedulePublish,
  searchContent,
  unpublishContent,
  updateContent,
  updateContentType,
  listSites,
  createSite,
  deleteSite,
  getDashboard,
  renameSite,
  resolveDefaultLocale,
} from "@paperboy/db";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AI_PROVIDERS,
  Asset,
  BlockSummary,
  aiAssist,
  listAiModels,
  ContentDetail,
  ChildSort,
  ContentTypeDef,
  CreateContentRequest,
  CreateFolderRequest,
  Folder,
  FolderKind,
  Locale,
  RoleName,
  STOCK_PROVIDERS,
  SetFolderRequest,
  StockSearchResult,
  TYPE_TEMPLATE_EXPORT_FORMAT,
  TYPE_TEMPLATE_EXPORT_VERSION,
  TreeNode,
  TypeTemplateExport,
  UpdateContentRequest,
  UpdateFolderRequest,
  sniffUpload,
} from "@paperboy/shared";
import { mintPreviewToken } from "@paperboy/shared/preview-token";
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
      // Authenticated-only, deliberately: the admin's type panel shows these counts
      // to Editors, so gating on contenttype.manage (Admin-only) would break a
      // legitimate caller.
      // KNOWN GAP (not fixed): contentTypeUsage full-scans every content_version's
      // JSONB with no WHERE and no site filter — measured ~113 MiB / 600 ms on a
      // 500-document corpus. Any authenticated user can loop it, and the aggregate
      // counts span every site. Needs a GIN-backed aggregate or a cache, not a
      // permission change.
      schema: {
        tags: ["manage"],
        response: { 200: z.record(z.string(), z.object({ items: z.number(), inlineIn: z.number() })) },
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

  /* ---------------------- content-type template collection -------------- */
  // Reusable ContentTypeDef recipes (per-instance). A template's name is the
  // type name it materialises by default; see instantiateTypeTemplate.
  const TypeTemplateParams = z.object({ name: z.string() });
  const InstantiateTemplateBody = z.object({
    updateExisting: z.boolean().optional(),
    asName: z.string().max(60).optional(),
    withBlocks: z.boolean().optional(),
  });
  const InstantiateTemplateResponse = z.object({
    type: ContentTypeDef,
    name: z.string(),
    action: z.enum(["created", "updated"]),
    blocks: z
      .object({ created: z.array(z.string()), existing: z.array(z.string()), missing: z.array(z.string()) })
      .optional(),
  });
  // Accepts a full export document as-is (format/version/exportedAt are
  // optional and checked, so a pasted export imports without editing).
  const ImportTemplatesBody = z.object({
    format: z.string().optional(),
    version: z.number().optional(),
    exportedAt: z.string().optional(),
    templates: z.array(ContentTypeDef).min(1).max(200),
    overwrite: z.boolean().optional(),
  });
  const ImportTemplatesResponse = z.object({
    created: z.array(z.string()),
    updated: z.array(z.string()),
    skipped: z.array(z.object({ name: z.string(), reason: z.string() })),
  });
  app.get(
    "/type-templates",
    { schema: { tags: ["manage"], response: { 200: z.array(ContentTypeDef) } } },
    async () => listTypeTemplates(app.db),
  );
  // Static route — wins over /type-templates/:name (and "export" can never be
  // a template name: names are PascalCase).
  app.get(
    "/type-templates/export",
    {
      schema: {
        tags: ["manage"],
        querystring: z.object({ names: z.string().optional() }),
        response: { 200: TypeTemplateExport },
      },
    },
    async (req) => {
      const names = req.query.names
        ?.split(",")
        .map((n) => n.trim())
        .filter(Boolean);
      const templates = await exportTypeTemplates(app.db, names);
      return {
        format: TYPE_TEMPLATE_EXPORT_FORMAT,
        version: TYPE_TEMPLATE_EXPORT_VERSION,
        exportedAt: new Date().toISOString(),
        templates,
      };
    },
  );
  app.post(
    "/type-templates/import",
    {
      preHandler: [requireCsrf, requirePermission("contenttype.manage")],
      schema: { tags: ["manage"], body: ImportTemplatesBody, response: { 200: ImportTemplatesResponse } },
    },
    async (req) => {
      const { version, templates, overwrite } = req.body;
      if (version !== undefined && version !== TYPE_TEMPLATE_EXPORT_VERSION) {
        throw new AppError(
          400,
          "unsupported_export_version",
          `Unsupported type-template export version ${version} — this instance imports version ${TYPE_TEMPLATE_EXPORT_VERSION}. Re-export from a matching Paperboy version.`,
        );
      }
      const result = await importTypeTemplates(app.db, req.accessCtx!, templates, overwrite ?? false);
      await audit(app.db, {
        actorUserId: req.user!.id,
        action: "type_template.import",
        ip: req.ip,
        detail: {
          created: result.created,
          updated: result.updated,
          skipped: result.skipped.map((s) => s.name),
          overwrite: overwrite ?? false,
        },
      });
      return result;
    },
  );
  app.get(
    "/type-templates/:name",
    { schema: { tags: ["manage"], params: TypeTemplateParams, response: { 200: ContentTypeDef } } },
    async (req) => getTypeTemplate(app.db, req.params.name),
  );
  app.post(
    "/type-templates",
    { preHandler: [requireCsrf, requirePermission("contenttype.manage")], schema: { tags: ["manage"], body: ContentTypeDef, response: { 200: ContentTypeDef } } },
    async (req) => {
      const created = await createTypeTemplate(app.db, req.accessCtx!, req.body);
      await audit(app.db, { actorUserId: req.user!.id, action: "type_template.create", ip: req.ip, detail: { name: created.name, kind: created.kind, fields: created.fields.length } });
      return created;
    },
  );
  app.put(
    "/type-templates/:name",
    { preHandler: [requireCsrf, requirePermission("contenttype.manage")], schema: { tags: ["manage"], params: TypeTemplateParams, body: ContentTypeDef, response: { 200: ContentTypeDef } } },
    async (req) => {
      const { next, prev } = await updateTypeTemplate(app.db, req.accessCtx!, req.params.name, req.body);
      await audit(app.db, { actorUserId: req.user!.id, action: "type_template.update", ip: req.ip, detail: { name: next.name, deliveryDelta: deliveryFlagDelta(prev, next) } });
      return next;
    },
  );
  app.delete(
    "/type-templates/:name",
    { preHandler: [requireCsrf, requirePermission("contenttype.manage")], schema: { tags: ["manage"], params: TypeTemplateParams, response: { 200: z.object({ ok: z.boolean() }) } } },
    async (req) => {
      await deleteTypeTemplate(app.db, req.accessCtx!, req.params.name);
      await audit(app.db, { actorUserId: req.user!.id, action: "type_template.delete", ip: req.ip, detail: { name: req.params.name } });
      return { ok: true };
    },
  );
  app.post(
    "/type-templates/:name/instantiate",
    {
      preHandler: [requireCsrf, requirePermission("contenttype.manage")],
      schema: { tags: ["manage"], params: TypeTemplateParams, body: InstantiateTemplateBody, response: { 200: InstantiateTemplateResponse } },
    },
    async (req) => {
      const result = await instantiateTypeTemplate(app.db, req.accessCtx!, req.params.name, req.body);
      await audit(app.db, { actorUserId: req.user!.id, action: "type_template.instantiate", ip: req.ip, detail: { template: req.params.name, type: result.name, action: result.action } });
      return result;
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

  // "Used on": documents that reference this one (reference field or shared
  // block in a contentArea) — so editors see the blast radius before changing it.
  app.get(
    "/content/:documentId/references",
    {
      schema: {
        tags: ["manage"],
        params: DocParams,
        response: { 200: z.array(z.object({ documentId: z.string(), name: z.string(), type: z.string(), kind: z.string(), fields: z.array(z.string()) })) },
      },
    },
    async (req) => findReferencingDocuments(app.db, req.accessCtx!, req.params.documentId),
  );

  // Move a shared block into a block folder (null = root/unfiled).
  app.put(
    "/blocks/:documentId/folder",
    { preHandler: [requireCsrf, requirePermission("content.update")], schema: { tags: ["manage"], params: DocParams, body: SetFolderRequest, response: { 200: z.object({ ok: z.boolean() }) } } },
    async (req) => {
      await setBlockFolder(app.db, req.accessCtx!, req.params.documentId, req.body.folderId);
      return { ok: true };
    },
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
      const locale = req.query.locale ?? (await resolveDefaultLocale(app.db, req.accessCtx!.siteId));
      return getContent(app.db, req.accessCtx!, req.params.documentId, locale);
    },
  );

  /* ------------------------------- update ------------------------------- */
  app.put(
    "/content/:documentId",
    { preHandler: [requireCsrf, requirePermission("content.update")], schema: { tags: ["manage"], params: DocParams, querystring: LocaleQuery, body: UpdateContentRequest, response: { 200: ContentDetail } } },
    async (req) => {
      const locale = req.query.locale ?? (await resolveDefaultLocale(app.db, req.accessCtx!.siteId));
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
      const locale = req.query.locale ?? (await resolveDefaultLocale(app.db, req.accessCtx!.siteId));
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
      const locale = req.query.locale ?? (await resolveDefaultLocale(app.db, req.accessCtx!.siteId));
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
      const locale = req.query.locale ?? (await resolveDefaultLocale(app.db, req.accessCtx!.siteId));
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
      const locale = req.query.locale ?? (await resolveDefaultLocale(app.db, req.accessCtx!.siteId));
      const r = await markReviewed(app.db, req.accessCtx!, req.params.documentId, locale);
      await audit(app.db, { actorUserId: req.user!.id, action: "content.review", documentId: req.params.documentId, locale, ip: req.ip });
      return r;
    },
  );
  app.post(
    "/content/:documentId/discard-draft",
    { preHandler: [requireCsrf, requirePermission("content.update")], schema: { tags: ["manage"], params: DocParams, querystring: LocaleQuery, response: { 200: z.object({ ok: z.boolean() }) } } },
    async (req) => {
      const locale = req.query.locale ?? (await resolveDefaultLocale(app.db, req.accessCtx!.siteId));
      await discardDraft(app.db, req.accessCtx!, req.params.documentId, locale);
      await audit(app.db, { actorUserId: req.user!.id, action: "content.discard_draft", documentId: req.params.documentId, locale, ip: req.ip });
      return { ok: true };
    },
  );
  // Delete ONE language variant of a document (every version in that locale).
  // Distinct from discard-draft (keeps published) and trash (whole document);
  // refuses the document's only remaining locale. Used to re-translate a variant.
  app.delete(
    "/content/:documentId/variant",
    { preHandler: [requireCsrf, requirePermission("content.delete")], schema: { tags: ["manage"], params: DocParams, querystring: LocaleQuery, response: { 200: z.object({ ok: z.boolean(), deleted: z.number() }) } } },
    async (req) => {
      const locale = req.query.locale ?? (await resolveDefaultLocale(app.db, req.accessCtx!.siteId));
      const r = await deleteVariant(app.db, req.accessCtx!, req.params.documentId, locale);
      await audit(app.db, { actorUserId: req.user!.id, action: "content.delete_variant", documentId: req.params.documentId, locale, ip: req.ip });
      return r;
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

  // Container child ordering: how a page's children are listed in the tree and
  // (by default) in delivery. "manual" restores the drag-and-drop tree order.
  app.post(
    "/content/:documentId/child-sort",
    { preHandler: [requireCsrf, requirePermission("content.update")], schema: { tags: ["manage"], params: DocParams, body: z.object({ childSort: ChildSort }), response: { 200: z.object({ ok: z.boolean() }) } } },
    async (req) => {
      await setChildSort(app.db, req.accessCtx!, req.params.documentId, req.body.childSort);
      await audit(app.db, { actorUserId: req.user!.id, action: "content.child_sort", documentId: req.params.documentId, ip: req.ip, detail: { childSort: req.body.childSort } });
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
        // Display metadata only (the served file uses the nanoid name above). Strip
        // control chars + path separators and cap the length, so unbounded/untrusted
        // text never reaches storage or any consumer (L8).
        filename: (data.filename ?? "").replace(/[\p{Cc}/\\]/gu, "").slice(0, 255) || "file",
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
      // uploadsDir passed → deleteAsset unlinks the bytes itself, so the API and
      // MCP surfaces erase identically.
      await deleteAsset(app.db, req.accessCtx!, req.params.documentId, app.uploadsDir);
      await audit(app.db, { actorUserId: req.user!.id, action: "asset.delete", documentId: req.params.documentId, ip: req.ip });
      return { ok: true };
    },
  );

  // Move an asset into a media folder (null = root/unfiled).
  app.put(
    "/assets/:documentId/folder",
    { preHandler: [requireCsrf, requirePermission("content.update")], schema: { tags: ["manage"], params: DocParams, body: SetFolderRequest, response: { 200: z.object({ ok: z.boolean() }) } } },
    async (req) => {
      await setAssetFolder(app.db, req.accessCtx!, req.params.documentId, req.body.folderId);
      return { ok: true };
    },
  );

  /* ----------------------------- asset-pane folders --------------------- */
  // Nested, per-site folders organizing the Media ('media') and Shared-blocks
  // ('block') libraries — two separate trees discriminated by `kind`.
  app.get(
    "/folders",
    { schema: { tags: ["manage"], querystring: z.object({ kind: FolderKind }), response: { 200: z.array(Folder) } } },
    async (req) => listFolders(app.db, req.accessCtx!, req.query.kind),
  );

  app.post(
    "/folders",
    { preHandler: [requireCsrf, requirePermission("content.create")], schema: { tags: ["manage"], body: CreateFolderRequest, response: { 200: Folder } } },
    async (req) => {
      const f = await createFolder(app.db, req.accessCtx!, req.body);
      await audit(app.db, { actorUserId: req.user!.id, action: "folder.create", documentId: f.documentId, ip: req.ip, detail: { kind: f.kind } });
      return f;
    },
  );

  app.put(
    "/folders/:documentId",
    { preHandler: [requireCsrf, requirePermission("content.update")], schema: { tags: ["manage"], params: DocParams, body: UpdateFolderRequest, response: { 200: Folder } } },
    async (req) => {
      const f = await renameFolder(app.db, req.accessCtx!, req.params.documentId, req.body);
      await audit(app.db, { actorUserId: req.user!.id, action: "folder.update", documentId: req.params.documentId, ip: req.ip });
      return f;
    },
  );

  app.delete(
    "/folders/:documentId",
    { preHandler: [requireCsrf, requirePermission("content.delete")], schema: { tags: ["manage"], params: DocParams, response: { 200: z.object({ ok: z.boolean() }) } } },
    async (req) => {
      await deleteFolder(app.db, req.accessCtx!, req.params.documentId);
      await audit(app.db, { actorUserId: req.user!.id, action: "folder.delete", documentId: req.params.documentId, ip: req.ip });
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
        querystring: z.object({ q: z.string().min(1).max(200), limit: z.coerce.number().int().min(1).max(50).optional() }),
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
      const locale = req.query.locale ?? (await resolveDefaultLocale(app.db, req.accessCtx!.siteId));
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
            data: z.record(z.string(), z.unknown()),
            createdAt: z.string(),
            createdBy: z.string().nullable(),
          }),
        },
      },
    },
    async (req) => {
      const locale = req.query.locale ?? (await resolveDefaultLocale(app.db, req.accessCtx!.siteId));
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

  /* ---------------------------- preview token ---------------------------- */
  /**
   * Mint a short-lived token for the in-editor preview iframe.
   *
   * Session-authenticated (this router requires auth), so only a signed-in editor
   * can obtain one — which is the difference that matters: the admin used to carry
   * the long-lived PREVIEW_SECRET itself, inlined into its unauthenticated JS
   * bundle, so anyone who fetched that bundle could read every draft forever.
   *
   * `content.read` because seeing drafts is a read of unpublished content — AND
   * `siteWide`, because the token is not scoped to a document or section. The
   * preview perspective it unlocks is KEY-scoped (the frontend uses the preview
   * delivery key), so it cannot express "only this Author's sections": a
   * section-scoped Author who got one could read every unpublished draft in the
   * site, which is exactly the escalation `needDelivery` blocks on the MCP side
   * (apps/mcp/src/server.ts). Same rule, same reason, both surfaces.
   *
   * Minting is audited: this is a bearer credential for all site drafts, and
   * because it is stateless there is no revocation and no other server-side
   * artifact — the audit row is the only trail an incident review would have.
   */
  app.get(
    "/preview-token",
    {
      preHandler: requirePermission("content.read"),
      schema: {
        tags: ["manage"],
        response: { 200: z.object({ token: z.string(), expiresAt: z.number() }) },
      },
    },
    async (req) => {
      if (!req.accessCtx!.siteWide) {
        throw new AppError(
          403,
          "forbidden",
          "Live preview needs a token that grants draft access across the whole site, and your account is limited to specific sections — so it isn't available for your role. You can still edit and publish normally; ask an administrator if you need preview.",
        );
      }
      const secret = app.previewSecret;
      if (!secret) {
        // Self-teaching: name the variable and both places it has to be set.
        throw new AppError(
          503,
          "unavailable",
          "In-editor preview is not configured: set PREVIEW_SECRET (min 16 chars) on BOTH the api and the frontend — the api signs preview tokens with it and the frontend verifies them. scripts/setup.sh generates one.",
        );
      }
      const minted = mintPreviewToken(secret);
      await audit(app.db, { actorUserId: req.user!.id, action: "preview.token_minted", ip: req.ip });
      return minted;
    },
  );

  /* ------------------------------ duplicate ----------------------------- */
  app.post(
    "/content/:documentId/duplicate",
    { preHandler: [requireCsrf, requirePermission("content.create")], schema: { tags: ["manage"], params: DocParams, querystring: LocaleQuery, response: { 200: ContentDetail } } },
    async (req) => {
      const locale = req.query.locale ?? (await resolveDefaultLocale(app.db, req.accessCtx!.siteId));
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
      const locale = req.query.locale ?? (await resolveDefaultLocale(app.db, req.accessCtx!.siteId));
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

  /* ---------------------------- AI provider ------------------------------ */
  // Write-only AI provider config. The key is never returned — only whether one
  // is set, where it comes from (CMS DB vs env fallback), its last 4 chars,
  // plus the resolved provider/model/baseUrl. Admin-gated (user.manage).
  const AiConfigStatus = z.object({
    configured: z.boolean(),
    source: z.enum(["db", "env", "none"]),
    provider: z.enum(AI_PROVIDERS),
    last4: z.string().nullable(),
    model: z.string().nullable(),
    baseUrl: z.string().nullable(),
  });
  async function aiStatus(): Promise<z.infer<typeof AiConfigStatus>> {
    const cfg = await resolveAiRuntimeConfig(app.db, app.aiEnv);
    return {
      configured: Boolean(cfg.apiKey),
      source: cfg.source,
      provider: cfg.provider ?? "anthropic",
      last4: cfg.apiKey ? cfg.apiKey.slice(-4) : null,
      model: cfg.model || null,
      baseUrl: cfg.baseUrl ?? null,
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
        body: z.object({
          provider: z.enum(AI_PROVIDERS).optional(),
          apiKey: z.string().max(400).nullable().optional(),
          model: z.string().max(120).nullable().optional(),
          baseUrl: z.string().max(400).nullable().optional(),
        }),
        response: { 200: AiConfigStatus },
      },
    },
    async (req) => {
      await setAiConfig(app.db, req.accessCtx!, {
        provider: req.body.provider,
        apiKey: req.body.apiKey,
        model: req.body.model,
        baseUrl: req.body.baseUrl,
      });
      await audit(app.db, {
        actorUserId: req.user!.id,
        action: "site.ai_config",
        ip: req.ip,
        // Never log the key itself — only what changed.
        detail: {
          provider: req.body.provider ?? undefined,
          keySet: typeof req.body.apiKey === "string" && req.body.apiKey.trim().length > 0,
          keyCleared: req.body.apiKey === null || req.body.apiKey === "",
          model: req.body.model ?? undefined,
          baseUrl: req.body.baseUrl ?? undefined,
        },
      });
      return aiStatus();
    },
  );
  // A REAL end-to-end check: one tiny model call through the resolved config.
  // "Key present" (GET /site/ai) can't catch a wrong baseUrl or a bad model
  // name — the classic OpenAI-compatible misconfigs — so the panel's Test
  // button uses this and shows the provider's own error message on failure.
  app.post(
    "/site/ai/test",
    {
      preHandler: [requireCsrf, requirePermission("user.manage")],
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
      schema: {
        tags: ["manage"],
        response: { 200: z.object({ ok: z.boolean(), provider: z.enum(AI_PROVIDERS), model: z.string(), message: z.string().nullable() }) },
      },
    },
    async () => {
      const cfg = await resolveAiRuntimeConfig(app.db, app.aiEnv);
      if (!cfg.apiKey) {
        return { ok: false, provider: cfg.provider ?? "anthropic", model: cfg.model, message: "No API key configured — add one here or via the environment." };
      }
      try {
        // A model-REQUIRING task: "summarize" would silently degrade to the
        // offline fallback on provider failure and report a false ok.
        await aiAssist({ task: "rewrite", input: "ping", instruction: "Reply with the single word: pong" }, cfg);
        return { ok: true, provider: cfg.provider ?? "anthropic", model: cfg.model, message: null };
      } catch (err) {
        return { ok: false, provider: cfg.provider ?? "anthropic", model: cfg.model, message: (err as Error).message };
      }
    },
  );
  // Probe the endpoint's model catalog (both dialects expose a listing) so the
  // panel's Model field can offer a searchable picker instead of blind typing —
  // essential on aggregator endpoints like OpenRouter with hundreds of models.
  // Same saved-config semantics as /test; a proxy without /models is reported
  // honestly, never treated as a config error.
  app.get(
    "/site/ai/models",
    {
      preHandler: [requirePermission("user.manage")],
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["manage"],
        response: { 200: z.object({ ok: z.boolean(), provider: z.enum(AI_PROVIDERS), models: z.array(z.string()), message: z.string().nullable() }) },
      },
    },
    async () => {
      const cfg = await resolveAiRuntimeConfig(app.db, app.aiEnv);
      const provider = cfg.provider ?? "anthropic";
      if (!cfg.apiKey) {
        return { ok: false, provider, models: [], message: "No API key configured — save one first, then fetch the model list." };
      }
      try {
        const models = await listAiModels(cfg);
        return { ok: true, provider, models, message: null };
      } catch (err) {
        return {
          ok: false,
          provider,
          models: [],
          message: `Couldn't list models from the endpoint (${(err as Error).message}) — it may not implement /models; type the model name manually.`,
        };
      }
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

  /* ------------------------------- dashboard -------------------------------- */
  // "What needs my attention" in one round-trip: WIP drafts, the scheduled
  // publish queue, translation coverage and housekeeping counts. Same partition
  // and scoping as the tree; webhook health only for webhook.manage holders.
  const DashboardOut = z.object({
    wip: z.array(
      z.object({
        documentId: z.string(),
        name: z.string(),
        type: z.string(),
        kind: z.string(),
        locale: z.string(),
        change: z.enum(["new", "updated"]),
        at: z.string(),
      }),
    ),
    wipTotal: z.number(),
    scheduled: z.array(
      z.object({ documentId: z.string(), name: z.string(), locale: z.string(), action: z.enum(["publish", "unpublish"]), at: z.string() }),
    ),
    translation: z.array(
      z.object({
        locale: z.string(),
        displayName: z.string(),
        missing: z.number(),
        pages: z.array(z.object({ documentId: z.string(), name: z.string() })),
      }),
    ),
    housekeeping: z.object({
      trash: z.number(),
      unusedBlocks: z.number(),
      emptyTypes: z.number(),
      missingAlt: z.number(),
      failingWebhooks: z.number().nullable(),
    }),
    imagesMissingAlt: z.array(z.object({ documentId: z.string(), url: z.string(), filename: z.string() })),
    unusedBlocksList: z.array(z.object({ documentId: z.string(), name: z.string(), type: z.string() })),
    emptyTypesList: z.array(z.object({ name: z.string(), displayName: z.string(), kind: z.string() })),
  });
  app.get(
    "/dashboard",
    { preHandler: [requirePermission("content.read")], schema: { tags: ["manage"], response: { 200: DashboardOut } } },
    async (req) => getDashboard(app.db, req.accessCtx!),
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

  // Delete a site and everything bound to it (content, media, keys, scopes).
  // Irreversible — the caller must echo the site's slug as ?confirm=<slug>.
  app.delete(
    "/sites/:id",
    {
      preHandler: [requireCsrf, requirePermission("user.manage")],
      schema: {
        tags: ["manage"],
        params: z.object({ id: z.string() }),
        querystring: z.object({ confirm: z.string().optional() }),
        response: { 200: z.object({ ok: z.boolean(), contentItems: z.number(), assets: z.number(), deliveryKeys: z.number() }) },
      },
    },
    async (req) => {
      const r = await deleteSite(app.db, req.accessCtx!, req.params.id, req.query.confirm);
      // Rows are gone; now the bytes. Without this every image of a deleted site
      // stayed downloadable at its previously-published URL forever.
      for (const path of r.assetPaths) await removeAssetFiles(app.uploadsDir, path);
      await audit(app.db, {
        actorUserId: req.user!.id,
        action: "site.delete",
        ip: req.ip,
        detail: { id: r.site.id, slug: r.site.slug, name: r.site.name, contentItems: r.contentItems, assets: r.assets, deliveryKeys: r.deliveryKeys },
      });
      return { ok: true, contentItems: r.contentItems, assets: r.assets, deliveryKeys: r.deliveryKeys };
    },
  );
}
