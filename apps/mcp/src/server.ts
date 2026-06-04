import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
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

// Set MCP_HTTP_PORT to serve over Streamable HTTP (for remote clients like
// harmonix) instead of stdio. The process still acts as the single MCP_TOKEN
// user; every HTTP request must present that same token as a Bearer.
const MCP_HTTP_PORT = process.env.MCP_HTTP_PORT ? Number(process.env.MCP_HTTP_PORT) : undefined;
const MCP_HTTP_PATH = process.env.MCP_HTTP_PATH ?? "/mcp";

/** Constant-time check that the request carries `Authorization: Bearer <MCP_TOKEN>`. */
function bearerOk(req: IncomingMessage): boolean {
  const token = MCP_TOKEN;
  if (!token) return false;
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
  if (!m?.[1]) return false;
  const got = Buffer.from(m[1]);
  const want = Buffer.from(token);
  return got.length === want.length && timingSafeEqual(got, want);
}

const { db } = createDb(DATABASE_URL);
let ctx: AccessContext;

/** Some data-layer reads don't self-check RBAC (the REST routes gate them); the
 *  MCP enforces the same verb here. */
function need(perm: Permission): void {
  if (!ctx.permissions.includes(perm)) throw new Error(`Missing permission: ${perm}`);
}
const persp = (preview?: boolean): "preview" | "published" => (preview ? "preview" : "published");

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
        return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true as const };
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
  ({ documentId, locale }) => getContent(db, ctx, documentId, locale ?? "en"));
tool("create_content", "Create a new content item (page/block/global) as a draft.",
  { type: z.string(), parentId: z.string().nullable().optional(), locale: loc, name: z.string() },
  ({ type, parentId, locale, name }) => createContent(db, ctx, { type, parentId: parentId ?? null, locale: locale ?? "en", name }));
tool(
  "update_content",
  [
    "Save the working draft of a content item. `data` maps field name → value.",
    "IMPORTANT: each field's value shape depends on its content-type field TYPE —",
    "call get_content_type first. text/markdown → a plain string; richtext → a TipTap",
    "doc object {type:'doc',content:[…]}; contentArea → an ARRAY of block instances;",
    "reference → {documentId,type?}; select → one option-value string; image → an asset id.",
    "By default `data` REPLACES the whole map (send every field). Pass merge:true to",
    "patch only the fields you include and keep the rest.",
  ].join(" "),
  { documentId: docId, locale: loc, name: z.string().optional(), slug: z.string().nullable().optional(), displayInNav: z.boolean().optional(), data: z.record(z.unknown()), merge: z.boolean().optional().describe("Shallow-merge data over the current draft instead of replacing it") },
  ({ documentId, locale, name, slug, displayInNav, data, merge }) =>
    updateContent(db, ctx, documentId, locale ?? "en", { name, slug, displayInNav, data, merge }));
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
      if (!bearerOk(req)) {
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
