import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  type AccessContext,
  adminCreateUser,
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
  deliveryStartPage,
  discardDraft,
  getAccessContext,
  getContent,
  getContentType,
  getSiteConfig,
  getTree,
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
import { AI_TASKS, ContentTypeDef, type Permission, RoleName, aiAssist } from "@paperboy/shared";
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

const { db } = createDb(DATABASE_URL);
let ctx: AccessContext;

/** Some data-layer reads don't self-check RBAC (the REST routes gate them); the
 *  MCP enforces the same verb here. */
function need(perm: Permission): void {
  if (!ctx.permissions.includes(perm)) throw new Error(`Missing permission: ${perm}`);
}
const persp = (preview?: boolean): "preview" | "published" => (preview ? "preview" : "published");

const server = new McpServer({ name: "paperboy", version: "0.1.0" });

/** Register a tool whose handler returns any JSON-serialisable value. */
function tool<S extends z.ZodRawShape>(
  name: string,
  description: string,
  shape: S,
  run: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
): void {
  const cb = async (args: z.infer<z.ZodObject<S>>) => {
    try {
      const result = await run(args);
      return { content: [{ type: "text" as const, text: JSON.stringify(result ?? { ok: true }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true as const };
    }
  };
  // The SDK's tool callback type is heavily generic; the wrapper above keeps each
  // tool's `run` strongly typed against its Zod shape, so cast only at this boundary.
  server.tool(name, description, shape, cb as never);
}

const loc = z.string().optional().describe("Locale code (default 'en')");
const docId = z.string().describe("Content documentId");

/* ------------------------------- content ------------------------------- */
tool("tree", "List the page tree under a parent (omit parentId for top level).", { parentId: z.string().optional() },
  ({ parentId }) => getTree(db, ctx, parentId ?? null));
tool("get_content", "Get a content item's working version (draft else published) for a locale.", { documentId: docId, locale: loc },
  ({ documentId, locale }) => getContent(db, ctx, documentId, locale ?? "en"));
tool("create_content", "Create a new content item (page/block/global) as a draft.",
  { type: z.string(), parentId: z.string().nullable().optional(), locale: loc, name: z.string() },
  ({ type, parentId, locale, name }) => createContent(db, ctx, { type, parentId: parentId ?? null, locale: locale ?? "en", name }));
tool("update_content", "Save the working draft of a content item (data is the field map).",
  { documentId: docId, locale: loc, name: z.string().optional(), slug: z.string().nullable().optional(), displayInNav: z.boolean().optional(), data: z.record(z.unknown()) },
  ({ documentId, locale, name, slug, displayInNav, data }) =>
    updateContent(db, ctx, documentId, locale ?? "en", { name, slug, displayInNav, data }));
tool("publish", "Publish the working draft of a content item for a locale.", { documentId: docId, locale: loc },
  ({ documentId, locale }) => publishContent(db, ctx, documentId, locale ?? "en"));
tool("unpublish", "Unpublish (take down) a content item for a locale.", { documentId: docId, locale: loc },
  ({ documentId, locale }) => unpublishContent(db, ctx, documentId, locale ?? "en"));
tool("discard_draft", "Discard unpublished draft changes for a locale.", { documentId: docId, locale: loc },
  async ({ documentId, locale }) => { await discardDraft(db, ctx, documentId, locale ?? "en"); return { ok: true }; });
tool("move_content", "Reorder (beforeId/afterId) or re-parent (parentId) a page.",
  { documentId: docId, parentId: z.string().nullable().optional(), beforeId: z.string().nullable().optional(), afterId: z.string().nullable().optional() },
  async ({ documentId, parentId, beforeId, afterId }) => { await moveContent(db, ctx, documentId, { parentId, beforeId, afterId }); return { ok: true }; });
tool("duplicate_content", "Duplicate a content item as a new draft sibling.", { documentId: docId, locale: loc },
  ({ documentId, locale }) => cloneContent(db, ctx, documentId, locale ?? "en"));
tool("trash_content", "Soft-delete a content item (and its subtree) to the trash.", { documentId: docId },
  ({ documentId }) => softDelete(db, ctx, documentId));
tool("restore_content", "Restore a content item from the trash.", { documentId: docId },
  ({ documentId }) => restoreContent(db, ctx, documentId));
tool("list_trash", "List soft-deleted content in scope.", {}, () => listTrash(db, ctx));
tool("list_versions", "List the version history of a content item for a locale.", { documentId: docId, locale: loc },
  ({ documentId, locale }) => listVersions(db, ctx, documentId, locale ?? "en"));
tool("restore_version", "Restore a historical version into a new draft.", { documentId: docId, locale: loc, versionId: z.number() },
  ({ documentId, locale, versionId }) => restoreVersion(db, ctx, documentId, locale ?? "en", versionId));
tool("list_blocks", "List shared blocks (the assets pane).", {}, () => listBlocks(db, ctx));
tool("list_pages", "Flat list of all pages in scope (for move/parent pickers).", {}, () => listPages(db, ctx));

/* ----------------------------- content model --------------------------- */
tool("list_content_types", "List all content types.", {}, async () => { need("content.read"); return listContentTypes(db); });
tool("get_content_type", "Get a content type definition by name.", { name: z.string() },
  async ({ name }) => { need("content.read"); return getContentType(db, name); });
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

/* ------------------------------ delivery (read) ------------------------ */
const delv = { locale: loc, populate: z.number().min(0).max(4).optional(), preview: z.boolean().optional().describe("Use the preview perspective (drafts)") };
tool("delivery_get_by_id", "Read delivered content by documentId (no-leak chokepoint).", { documentId: docId, ...delv },
  ({ documentId, locale, populate, preview }) => deliveryGetById(db, persp(preview), documentId, locale ?? "en", populate));
tool("delivery_get_by_slug", "Read delivered content by slug.", { slug: z.string(), ...delv },
  ({ slug, locale, populate, preview }) => deliveryGetBySlug(db, persp(preview), slug, locale ?? "en", populate));
tool("delivery_get_by_path", "Read delivered content by hierarchical URL path (e.g. /home/about).", { path: z.string(), ...delv },
  ({ path, locale, populate, preview }) => deliveryGetByPath(db, persp(preview), path.split("/").filter(Boolean), locale ?? "en", populate));
tool("delivery_list", "List delivered content of a type.", { type: z.string(), ...delv },
  ({ type, locale, populate, preview }) => deliveryList(db, persp(preview), type, locale ?? "en", populate));
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
tool("list_audit", "Read the append-only audit log (admin).", { limit: z.number().optional(), before: z.number().optional() },
  ({ limit, before }) => listAudit(db, ctx, { limit, before }));
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
  ctx = await getAccessContext(db, userId);
  console.error(`[paperboy-mcp] authenticated (${userId}) via ${MCP_TOKEN ? "token" : "password"} — ${ctx.permissions.length} permissions`);
  await server.connect(new StdioServerTransport());
  console.error("[paperboy-mcp] ready on stdio");
}
main().catch((err) => {
  console.error("[paperboy-mcp] fatal:", err);
  process.exit(1);
});
