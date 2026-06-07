import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  type AccessContext,
  adminCreateUser,
  audit,
  adminDeleteUser,
  adminUpdateUser,
  cloneContent,
  createContent,
  createContentType,
  createDb,
  createDeliveryKey,
  createWebhook,
  deleteAsset,
  deleteWebhook,
  deliveryGetById,
  deliveryGetByPath,
  deliveryGetBySlug,
  deliveryGlobal,
  deliveryList,
  deliverySearch,
  deliveryStartPage,
  discardDraft,
  getAccessContext,
  getContent,
  resolveRequestedLocale,
  getContentType,
  getSiteConfig,
  getTree,
  importStockImage,
  listAssets,
  listAudit,
  listBlocks,
  listContentTypes,
  listDeliveryKeys,
  listLocales,
  listPages,
  listTrash,
  listUsers,
  listVersions,
  listWebhooks,
  moveContent,
  renameDeliveryKey,
  publishContent,
  restoreContent,
  MEDIA_PREFIX,
  searchStockImages,
  restoreVersion,
  revokeDeliveryKey,
  setStartPage,
  softDelete,
  unpublishContent,
  updateAssetAlt,
  updateContent,
  updateContentType,
  verifyLogin,
  verifyMcpToken,
} from "@paperboy/db";
import { AI_TASKS, ContentTypeDef, type FieldDef, type Permission, RoleName, aiAssist, fieldFormatHint } from "@paperboy/shared";
import { z } from "zod";

/**
 * Paperboy MCP server. Exposes the full CMS over the Model Context Protocol by
 * calling the SAME data-layer functions the REST API uses — so every tool goes
 * through object-level scope checks, Zod validation, the no-leak delivery
 * chokepoint and the audit log. Acts as a configured user (MCP_EMAIL/PASSWORD).
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("[paperboy-mcp] DATABASE_URL is required");
  process.exit(1);
}
const MCP_TOKEN = process.env.MCP_TOKEN; // a Paperboy-issued MCP token (preferred)
const MCP_EMAIL = process.env.MCP_EMAIL ?? "admin@paperboy.test";
const MCP_PASSWORD = process.env.MCP_PASSWORD ?? "Admin!Passw0rd";
const AI_CONFIG = { apiKey: process.env.ANTHROPIC_API_KEY, model: process.env.AI_MODEL ?? "claude-haiku-4-5-20251001" };
// Stock images: env fallback for the Unsplash key (a CMS-stored key wins), and
// the uploads dir imports are written to — MUST be the same volume the API's
// /api/v1/media serves, or imported files 404.
const UNSPLASH_ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY;
const UPLOADS_DIR = process.env.UPLOADS_DIR ?? "/app/uploads";

// Set MCP_HTTP_PORT to serve over Streamable HTTP (for remote clients like
// harmonix) instead of stdio. The process acts as a single user (its boot
// identity); a request may authenticate with the boot MCP_TOKEN itself OR any
// unrevoked admin-minted token belonging to the SAME user — so "mint a token
// in Settings → MCP, paste it into the client" works with no server restart.
const MCP_HTTP_PORT = process.env.MCP_HTTP_PORT ? Number(process.env.MCP_HTTP_PORT) : undefined;
const MCP_HTTP_PATH = process.env.MCP_HTTP_PATH ?? "/mcp";

function bearerOf(req: IncomingMessage): string | null {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
  return m?.[1] ?? null;
}

/**
 * Accept the boot token (constant-time compare) or any valid mcp_token row
 * resolving to the SAME user the process authenticated as. A token for a
 * DIFFERENT user is rejected — this process carries one identity; impersonating
 * another user through it would bypass that user's own RBAC trail.
 */
async function bearerOk(req: IncomingMessage, bootUserId: string): Promise<boolean> {
  const presented = bearerOf(req);
  if (!presented) return false;
  if (MCP_TOKEN) {
    const got = Buffer.from(presented);
    const want = Buffer.from(MCP_TOKEN);
    if (got.length === want.length && timingSafeEqual(got, want)) return true;
  }
  const userId = await verifyMcpToken(db, presented); // hashed lookup; null when unknown/revoked
  return userId !== null && userId === bootUserId;
}

const { db } = createDb(DATABASE_URL);
let ctx: AccessContext;

/** Some data-layer reads don't self-check RBAC (the REST routes gate them); the
 *  MCP enforces the same verb here. */
function need(perm: Permission): void {
  if (!ctx.permissions.includes(perm)) throw new Error(`Missing permission: ${perm}`);
}
const persp = (preview?: boolean): "preview" | "published" => (preview ? "preview" : "published");

/** Omitted locale → the document's safe locale (default-locale variant, else
 *  its sole locale, else a self-teaching error) — never a silent fork of a
 *  phantom 'en' branch on a nb-only document (rule 5; 2026-06-07 incident). */
const locFor = (documentId: string, locale?: string) => resolveRequestedLocale(db, documentId, locale);

/** Fire-and-forget audit entry — MCP writes leave the same trail as API routes. */
function mcpAudit(action: string, documentId?: string | null, locale?: string | null, detail?: object): void {
  void audit(db, { actorUserId: ctx.userId, action, documentId: documentId ?? null, locale: locale ?? null, ip: "mcp", detail }).catch(() => undefined);
}

// Tool definitions are collected as registrations so a fresh McpServer can be
// built per stdio process and per stateless HTTP request. A stateless HTTP
// request needs its own server+transport to carry the MCP init handshake.
type ToolRegistration = (server: McpServer) => void;
const registrations: ToolRegistration[] = [];

/** Register a tool whose handler returns any JSON-serialisable value. */
function tool<S extends z.ZodRawShape>(
  name: string,
  description: string,
  shape: S,
  run: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
): void {
  registrations.push((server) => {
    const cb = async (args: z.infer<z.ZodObject<S>>) => {
      try {
        const result = await run(args);
        return { content: [{ type: "text" as const, text: JSON.stringify(result ?? { ok: true }, null, 2) }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // The error travels back in-band, but agents (and their loop guards)
        // routinely swallow it — ALSO leave a trail in docker logs, with the
        // args, so a failed agent run is diagnosable after the fact.
        console.error(`[paperboy-mcp] tool ${name} failed: ${msg}\n  args: ${JSON.stringify(args)?.slice(0, 4000)}`);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true as const };
      }
    };
    // The SDK's tool callback type is heavily generic; the wrapper above keeps each
    // tool's `run` strongly typed against its Zod shape, so cast only at this boundary.
    server.tool(name, description, shape, cb as never);
  });
}

/** Build a fresh server instance with every registered tool. */
function buildServer(): McpServer {
  const server = new McpServer({ name: "paperboy", version: "0.1.0" });
  for (const register of registrations) register(server);
  return server;
}

const loc = z.string().optional().describe("Locale code (default 'en')");
const docId = z.string().describe("Content documentId");

/* ------------------------------- content ------------------------------- */
tool("tree", "List the page tree under a parent (omit parentId for top level).", { parentId: z.string().optional() },
  ({ parentId }) => getTree(db, ctx, parentId ?? null));
tool("get_content", "Get a content item's working version (draft else published) for a locale.", { documentId: docId, locale: loc },
  async ({ documentId, locale }) => getContent(db, ctx, documentId, await locFor(documentId, locale)));
tool(
  "create_content",
  [
    "Create a new content item (page/block/global) as a draft.",
    "IMPORTANT: pages almost always belong UNDER an existing parent — a page's position",
    "decides its URL and which template the frontend renders it with (a blog post created",
    "at root gets a generic layout and looks empty when published). Call `tree` first and",
    "pass the right parentId (e.g. blog posts/articles go under their blog/list page).",
    "Omit parentId ONLY for genuinely top-level pages like the site's main sections.",
  ].join(" "),
  {
    type: z.string(),
    parentId: z.string().nullable().optional().describe("documentId of the parent page. Required in practice for pages — find it with `tree`. Omit only for top-level pages."),
    locale: z.string().optional().describe("The LANGUAGE BRANCH for this content — MATCH the language you are writing (Norwegian content → 'nb', English → 'en'). Call list_locales to see the site's branches. Defaults to the site default locale, which is usually English."),
    name: z.string(),
  },
  async ({ type, parentId, locale, name }) => {
    const created = await createContent(db, ctx, { type, parentId: parentId ?? null, locale: locale ?? "en", name });
    mcpAudit("content.create", created.documentId, created.locale);
    // A page created at root is usually an agent forgetting parentId (real incident:
    // a blog post at root rendered "empty" on the live site). Surface a hint the
    // agent reads in-band — the create still succeeds (top-level pages are legal).
    if (created.kind === "page" && !parentId) {
      return {
        ...created,
        hint: "This page was created at the TOP LEVEL of the site. If it belongs under another page (e.g. a blog post under the blog page), call `tree` to find the parent and fix it with move_content {documentId, parentId} BEFORE publishing — its URL and rendering template depend on its position.",
      };
    }
    return created;
  });
tool(
  "update_content",
  [
    "Save the working draft of a content item. `data` maps field name → value.",
    "IMPORTANT: each field's value shape depends on its content-type field TYPE —",
    "call get_content_type first. text/markdown → a plain string; richtext → a TipTap",
    "doc object {type:'doc',content:[…]}; contentArea → an ARRAY of block instances;",
    "reference → {documentId,type?}; select → one option-value string; image → an asset id.",
    "By default `data` is MERGED over the current draft — fields you omit are kept.",
    "Pass merge:false to REPLACE the whole map (then you must send every required field,",
    "or the next publish will fail validation).",
  ].join(" "),
  { documentId: docId, locale: loc, name: z.string().optional(), slug: z.string().nullable().optional(), displayInNav: z.boolean().optional(), data: z.record(z.unknown()), merge: z.boolean().optional().describe("Default true: shallow-merge data over the current draft. false = replace the whole field map") },
  // merge defaults to TRUE here (agent-facing surface): a full replace that
  // silently drops required fields like `intro` passes the relaxed draft
  // validation but bricks every subsequent publish — the worst failure mode
  // an agent can hit. Replace semantics stay available via merge:false.
  async ({ documentId, locale, name, slug, displayInNav, data, merge }) => {
    const l = await locFor(documentId, locale);
    const updated = await updateContent(db, ctx, documentId, l, { name, slug, displayInNav, data, merge: merge ?? true });
    mcpAudit("content.update", documentId, l);
    return updated;
  });
tool(
  "set_field",
  [
    "Set ONE field of a content item's draft to a plain string value (merged — other",
    "fields are kept). THE MOST ROBUST WAY TO WRITE LONG TEXT/MARKDOWN CONTENT:",
    "a flat string parameter survives tool-call serialization that can mangle long",
    "strings nested inside `data` records. For text/markdown/select/datetime/image",
    "fields, and the special field name `name` (the item's display name).",
  ].join(" "),
  { documentId: docId, locale: loc, field: z.string().describe("Field name from the content type (or 'name')"), value: z.string().describe("The plain string value") },
  async ({ documentId, locale, field, value }) => {
    const l = await locFor(documentId, locale);
    const updated =
      field === "name"
        ? await updateContent(db, ctx, documentId, l, { name: value, data: {}, merge: true })
        : await updateContent(db, ctx, documentId, l, { data: { [field]: value }, merge: true });
    mcpAudit("content.update", documentId, l, { field });
    return updated;
  });
tool(
  "publish",
  [
    "Publish the working draft of a content item for a locale. The locale is a",
    "LANGUAGE BRANCH — publishing Norwegian text into 'en' puts it on the English",
    "site; a strong language/branch mismatch is refused unless allowLanguageMismatch is true.",
  ].join(" "),
  { documentId: docId, locale: loc, allowLanguageMismatch: z.boolean().optional().describe("Set true ONLY when publishing content whose language deliberately differs from the locale branch") },
  async ({ documentId, locale, allowLanguageMismatch }) => {
    const l = await locFor(documentId, locale);
    const published = await publishContent(db, ctx, documentId, l, { allowLanguageMismatch });
    mcpAudit("content.publish", documentId, l);
    return published;
  });
tool("unpublish", "Unpublish (take down) a content item for a locale.", { documentId: docId, locale: loc },
  async ({ documentId, locale }) => {
    const l = await locFor(documentId, locale);
    const result = await unpublishContent(db, ctx, documentId, l);
    mcpAudit("content.unpublish", documentId, l);
    return result;
  });
tool("discard_draft", "Discard unpublished draft changes for a locale.", { documentId: docId, locale: loc },
  async ({ documentId, locale }) => { const l = await locFor(documentId, locale); await discardDraft(db, ctx, documentId, l); mcpAudit("content.discard_draft", documentId, l); return { ok: true }; });
tool("move_content", "Reorder (beforeId/afterId) or re-parent (parentId) a page.",
  { documentId: docId, parentId: z.string().nullable().optional(), beforeId: z.string().nullable().optional(), afterId: z.string().nullable().optional() },
  async ({ documentId, parentId, beforeId, afterId }) => { await moveContent(db, ctx, documentId, { parentId, beforeId, afterId }); mcpAudit("content.move", documentId); return { ok: true }; });
tool("duplicate_content", "Duplicate a content item as a new draft sibling.", { documentId: docId, locale: loc },
  async ({ documentId, locale }) => {
    const copy = await cloneContent(db, ctx, documentId, await locFor(documentId, locale));
    mcpAudit("content.duplicate", copy.documentId, copy.locale, { source: documentId });
    return copy;
  });
tool("trash_content", "Soft-delete a content item (and its subtree) to the trash.", { documentId: docId },
  async ({ documentId }) => { const r = await softDelete(db, ctx, documentId); mcpAudit("content.trash", documentId); return r; });
tool("restore_content", "Restore a content item from the trash.", { documentId: docId },
  async ({ documentId }) => { const r = await restoreContent(db, ctx, documentId); mcpAudit("content.restore", documentId); return r; });
tool("list_trash", "List soft-deleted content in scope.", {}, () => listTrash(db, ctx));
tool("list_versions", "List the version history of a content item for a locale.", { documentId: docId, locale: loc },
  async ({ documentId, locale }) => listVersions(db, ctx, documentId, await locFor(documentId, locale)));
tool("restore_version", "Restore a historical version into a new draft.", { documentId: docId, locale: loc, versionId: z.number() },
  async ({ documentId, locale, versionId }) => {
    const l = await locFor(documentId, locale);
    const restored = await restoreVersion(db, ctx, documentId, l, versionId);
    mcpAudit("content.version_restore", documentId, l, { versionId });
    return restored;
  });
tool("list_blocks", "List shared blocks (the assets pane).", {}, () => listBlocks(db, ctx));
tool("list_pages", "Flat list of all pages in scope (for move/parent pickers).", {}, () => listPages(db, ctx));

/* ----------------------------- content model --------------------------- */
// Annotate each field with the JSON shape update_content expects for it, so an
// agent learns the encoding from the type itself (not by trial and error).
function withFieldFormats<T extends { fields: FieldDef[] }>(def: T): T & { fields: Array<FieldDef & { valueFormat: string; valueExample: unknown }> } {
  return {
    ...def,
    fields: def.fields.map((f) => {
      const { format, example } = fieldFormatHint(f);
      return { ...f, valueFormat: format, valueExample: example };
    }),
  };
}
tool("list_content_types", "List all content types (fields annotated with the value format update_content expects).", {},
  async () => { need("content.read"); return (await listContentTypes(db)).map(withFieldFormats); });
tool("get_content_type", "Get a content type definition by name. Each field includes valueFormat + valueExample — the exact JSON shape update_content expects.", { name: z.string() },
  async ({ name }) => { need("content.read"); const def = await getContentType(db, name); return def ? withFieldFormats(def) : def; });
tool("create_content_type", "Create a content type from a full ContentTypeDef object.", { definition: z.record(z.unknown()) },
  ({ definition }) => createContentType(db, ctx, ContentTypeDef.parse(definition)));
tool("update_content_type", "Update a content type (name and kind are immutable).", { name: z.string(), definition: z.record(z.unknown()) },
  async ({ name, definition }) => (await updateContentType(db, ctx, name, ContentTypeDef.parse(definition))).next);

/* -------------------------------- media -------------------------------- */
tool("list_assets", "List uploaded media assets.", {}, () => listAssets(db, ctx));
tool("update_asset_alt", "Set an asset's alt text.", { documentId: docId, alt: z.string() },
  ({ documentId, alt }) => updateAssetAlt(db, ctx, documentId, alt));
tool("delete_asset", "Delete a media asset.", { documentId: docId },
  async ({ documentId }) => { await deleteAsset(db, ctx, documentId); return { ok: true }; });
tool(
  "search_stock_images",
  "Search the configured stock photo provider (Settings → Stock images; Unsplash). Returns photo candidates with id, description and attribution. To USE a photo: call import_stock_image with its id, then set_field the returned asset documentId on an image field.",
  { query: z.string().min(1).max(200).describe("What the photo should show, e.g. 'mountain lake sunrise'") },
  ({ query }) => searchStockImages(db, ctx, query, UNSPLASH_ACCESS_KEY),
);
tool(
  "import_stock_image",
  "Import a stock photo (by the id from search_stock_images) into the media library. Downloads the image, stores it as a regular asset with alt text + attribution, and returns the asset — set its documentId on an image field with set_field.",
  {
    providerId: z.string().min(1).max(200).describe("Photo id from search_stock_images"),
    alt: z.string().max(300).optional().describe("Alt text override (defaults to the provider's description)"),
  },
  async ({ providerId, alt }) => {
    const rec = await importStockImage(db, ctx, { providerId, alt }, {
      envKey: UNSPLASH_ACCESS_KEY,
      save: async (fileName, buf) => {
        await mkdir(UPLOADS_DIR, { recursive: true });
        await writeFile(join(UPLOADS_DIR, fileName), buf); // safe: server-generated name
        return { relativePath: `${MEDIA_PREFIX}/${fileName}` };
      },
    });
    mcpAudit("asset.import", rec.documentId, null, { provider: rec.sourceMeta?.provider, providerId, mime: rec.mime, size: rec.size });
    return rec;
  },
);

/* ------------------------------ delivery (read) ------------------------ */
const delv = { locale: loc, populate: z.number().min(0).max(4).optional(), preview: z.boolean().optional().describe("Use the preview perspective (drafts)") };
tool("delivery_get_by_id", "Read delivered content by documentId (no-leak chokepoint).", { documentId: docId, ...delv },
  ({ documentId, locale, populate, preview }) => deliveryGetById(db, persp(preview), documentId, locale ?? "en", populate));
tool("delivery_get_by_slug", "Read delivered content by slug.", { slug: z.string(), ...delv },
  ({ slug, locale, populate, preview }) => deliveryGetBySlug(db, persp(preview), slug, locale ?? "en", populate));
tool("delivery_get_by_path", "Read delivered content by hierarchical URL path (e.g. /home/about).", { path: z.string(), ...delv },
  ({ path, locale, populate, preview }) => deliveryGetByPath(db, persp(preview), path.split("/").filter(Boolean), locale ?? "en", populate));
tool(
  "delivery_list",
  "List delivered content of a type. Supports pagination (limit/offset), sorting (sort: 'name' | 'createdAt' | 'data.<field>', prefix '-' for descending) and equality filters on data fields. Returns { items, total }.",
  {
    type: z.string(),
    ...delv,
    limit: z.number().int().min(1).max(500).optional(),
    offset: z.number().int().min(0).optional(),
    sort: z.string().optional().describe("name | createdAt | data.<field>; prefix - for descending"),
    filter: z.record(z.string()).optional().describe("Equality filters on data fields, e.g. {\"author\": \"Jane\"}"),
  },
  ({ type, locale, populate, preview, limit, offset, sort, filter }) =>
    deliveryList(db, persp(preview), type, locale ?? "en", populate, undefined, { limit, offset, sort, filter }));
tool(
  "delivery_search",
  "Full-text search over delivered content (name + field text). Returns { items, total } resolved through the same no-leak chokepoint.",
  { query: z.string().min(1).max(200), type: z.string().optional(), locale: loc, limit: z.number().int().min(1).max(100).optional(), preview: z.boolean().optional() },
  ({ query, type, locale, limit, preview }) => deliverySearch(db, persp(preview), query, locale ?? "en", type, limit));
tool("delivery_global", "Read a delivered global singleton by type.", { type: z.string(), locale: loc, preview: z.boolean().optional() },
  ({ type, locale, preview }) => deliveryGlobal(db, persp(preview), type, locale ?? "en"));
tool("delivery_start", "Read the configured start page (served at /).", { locale: loc, populate: z.number().min(0).max(4).optional(), preview: z.boolean().optional() },
  ({ locale, populate, preview }) => deliveryStartPage(db, persp(preview), locale ?? "en", populate));

/* --------------------------------- site -------------------------------- */
tool("get_site_config", "Get site config (current start page).", {}, () => getSiteConfig(db, ctx));
tool("set_start_page", "Set (or clear with null) the page served at /.", { documentId: z.string().nullable() },
  async ({ documentId }) => { await setStartPage(db, ctx, documentId); return { ok: true }; });

/* ---------------------------- platform admin --------------------------- */
tool("list_users", "List users with roles and section scopes (admin).", {}, () => listUsers(db, ctx));
tool("create_user", "Create a user (admin).", { email: z.string().email(), name: z.string(), password: z.string().min(10), roles: z.array(RoleName).min(1), sections: z.array(z.string()).optional() },
  async (a) => ({ id: await adminCreateUser(db, ctx, a) }));
tool("update_user", "Update a user's name/roles/sections (admin).", { id: z.string(), name: z.string().optional(), roles: z.array(RoleName).optional(), sections: z.array(z.string()).optional() },
  async ({ id, ...rest }) => { await adminUpdateUser(db, ctx, id, rest); return { ok: true }; });
tool("delete_user", "Delete a user (admin).", { id: z.string() },
  async ({ id }) => { await adminDeleteUser(db, ctx, id); return { ok: true }; });
tool("list_delivery_keys", "List delivery API keys (admin).", {}, () => listDeliveryKeys(db, ctx));
tool("create_delivery_key", "Create a delivery API key (admin). Returns the secret once.", { name: z.string(), type: z.enum(["public", "preview"]) },
  ({ name, type }) => { need("deliverykey.manage"); return createDeliveryKey(db, name, type); });
tool("rename_delivery_key", "Rename a delivery API key (admin).", { id: z.number(), name: z.string().min(1) },
  async ({ id, name }) => { await renameDeliveryKey(db, ctx, id, name); return { ok: true }; });
tool("revoke_delivery_key", "Revoke a delivery API key by id (admin).", { id: z.number() },
  async ({ id }) => { await revokeDeliveryKey(db, ctx, id); return { ok: true }; });
tool("list_webhooks", "List webhook subscriptions (admin).", {}, () => listWebhooks(db, ctx));
tool("create_webhook", "Create a webhook (admin). Returns the signing secret once.", { name: z.string(), url: z.string(), events: z.array(z.string()).optional() },
  (a) => createWebhook(db, ctx, a));
tool("delete_webhook", "Delete a webhook by id (admin).", { id: z.number() },
  async ({ id }) => { await deleteWebhook(db, ctx, id); return { ok: true }; });
tool("list_audit", "Read the append-only audit log (admin). Filter by action prefix (e.g. 'content.'), actor user id, documentId, or ISO time range.",
  { limit: z.number().optional(), before: z.number().optional(), action: z.string().optional(), actorUserId: z.string().optional(), documentId: z.string().optional(), from: z.string().optional(), to: z.string().optional() },
  (a) => listAudit(db, ctx, a));
tool("list_locales", "List enabled locales.", {}, async () => { need("content.read"); return listLocales(db); });

/* ---------------------------------- AI --------------------------------- */
tool("ai_assist", "AI editorial help: meta_title, meta_description, summarize, improve, alt_text, translate.",
  { task: z.enum(AI_TASKS), input: z.string().min(1), targetLocale: z.string().optional() },
  async (a) => { need("content.update"); return aiAssist(a, AI_CONFIG); });

/* --------------------------------- boot -------------------------------- */
async function main(): Promise<void> {
  // Prefer a Paperboy-issued MCP token (Settings → MCP); fall back to email+password.
  let userId: string;
  if (MCP_TOKEN) {
    const id = await verifyMcpToken(db, MCP_TOKEN);
    if (!id) {
      console.error("[paperboy-mcp] MCP_TOKEN is invalid or revoked");
      process.exit(1);
    }
    userId = id;
  } else {
    userId = await verifyLogin(db, MCP_EMAIL, MCP_PASSWORD);
  }
  // via:"mcp" — every write through this server is agent provenance: versions
  // record created_via='mcp' and drafts carry the needs-review flag.
  ctx = { ...(await getAccessContext(db, userId)), via: "mcp" };
  console.error(`[paperboy-mcp] authenticated (${userId}) via ${MCP_TOKEN ? "token" : "password"} — ${ctx.permissions.length} permissions`);

  if (MCP_HTTP_PORT) {
    // HTTP mode is a remote, multi-request surface — it must be gated. The
    // process acts as the MCP_TOKEN user, so we require that exact token.
    if (!MCP_TOKEN) {
      console.error("[paperboy-mcp] MCP_HTTP_PORT requires MCP_TOKEN (used as the Bearer credential)");
      process.exit(1);
    }
    // One transport+server per MCP session. The client gets a session id on
    // `initialize` and replays it via the `mcp-session-id` header; that's what
    // carries the protocol's init state across separate requests.
    const sessions = new Map<string, StreamableHTTPServerTransport>();
    const http = createHttpServer(async (req, res) => {
      const path = (req.url ?? "/").split("?")[0];
      if (path === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (path !== MCP_HTTP_PATH) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      if (!(await bearerOk(req, userId))) {
        res.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      try {
        const sid = req.headers["mcp-session-id"];
        const existing = typeof sid === "string" ? sessions.get(sid) : undefined;
        if (existing) {
          await existing.handleRequest(req, res);
          return;
        }
        // No known session → start a new one (the request must be `initialize`;
        // the transport replies with the right JSON-RPC error otherwise). All
        // sessions act as the single configured user.
        const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (id) => {
            sessions.set(id, transport);
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };
        const reqServer = buildServer();
        await reqServer.connect(transport);
        await transport.handleRequest(req, res);
      } catch (err) {
        console.error("[paperboy-mcp] request error:", err);
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "internal error" }));
        }
      }
    });
    http.listen(MCP_HTTP_PORT, () => console.error(`[paperboy-mcp] ready on http :${MCP_HTTP_PORT}${MCP_HTTP_PATH}`));
  } else {
    const server = buildServer();
    await server.connect(new StdioServerTransport());
    console.error("[paperboy-mcp] ready on stdio");
  }
}
main().catch((err) => {
  console.error("[paperboy-mcp] fatal:", err);
  process.exit(1);
});
