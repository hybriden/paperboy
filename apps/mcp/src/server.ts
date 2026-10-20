import { AsyncLocalStorage } from "node:async_hooks";
import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { makeMcpHttpHandler, sweepIdleSessions } from "./http-handler.js";
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
   createTypeTemplate,
  createDeliveryKey,
  createWebhook,
   deleteAsset,
   deleteTypeTemplate,
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
  copyVariant,
  getContent,
  resolveRequestedLocale,
   getContentType,
   getTypeTemplate,
  getSiteById,
  getSiteBySlug,
  getSiteConfig,
  listSites,
  getTree,
  importStockImage,
  createUploadLink,
  importAssetFromUrl,
  saveToUploadsDir,
  storeUploadedAsset,
  deleteSubmission,
  eraseSubmissionsByEmail,
  exportSubmissions,
  getSubmission,
  listAssets,
  listForms,
  listSubmissions,
  listAudit,
  listBlocks,
  listGlobals,
   listContentTypes,
   listTypeTemplates,
   instantiateTypeTemplate,
   exportTypeTemplates,
   importTypeTemplates,
   resolveAiRuntimeConfig,
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
  schedulePublish,
  restoreContent,
  searchStockImages,
  restoreVersion,
  revokeDeliveryKey,
   setStartPage,
  createRedirect,
  deleteRedirects,
  listNotFound,
  listRedirects,
  testRedirect,
  updateRedirect,
   softDelete,
   updateTypeTemplate,
  unpublishContent,
  updateAssetAlt,
  updateContent,
  updateContentType,
  verifyLogin,
  mcpTokenState,
  resolveDefaultLocale,
  verifyMcpToken,
  verifyOAuthAccessToken,
  schemaTables,
} from "@paperboy/db";
import { AI_TASKS, ContentTypeDef, type FieldDef, type Permission, RoleName, TYPE_TEMPLATE_EXPORT_FORMAT, TYPE_TEMPLATE_EXPORT_VERSION, aiAssist, fieldFormatHint, redactForLog } from "@paperboy/shared";
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
// "" counts as unset: compose passes `MCP_TOKEN: ${MCP_TOKEN:-}` through empty.
const MCP_TOKEN = process.env.MCP_TOKEN || undefined; // a Paperboy-issued MCP token (preferred)
const MCP_LOGIN =
  process.env.MCP_EMAIL && process.env.MCP_PASSWORD ? { email: process.env.MCP_EMAIL, password: process.env.MCP_PASSWORD } : undefined;
// Multisite: this process acts in ONE site, given as a site id or slug. Unset
// means the Default site — which is why an agent pointed at an instance with a
// second site read nothing but the Default's content. A per-REQUEST site is
// deliberately not offered: `ctx` is a single module-level identity that HTTP
// mode reassigns per request, and that is only safe while every request resolves
// to the same one. One server, one site.
const PAPERBOY_SITE = process.env.PAPERBOY_SITE || undefined;

// AI config resolves PER CALL through the same chokepoint as the API: a config
// stored in the CMS (Settings → AI) wins over these env fallbacks, and each
// env key is bound to its own provider (ANTHROPIC_API_KEY → anthropic,
// OPENAI_API_KEY [+ OPENAI_BASE_URL] → openai; AI_PROVIDER picks when both are
// set). Previously env-only, so a key configured in the admin didn't reach MCP.
const AI_ENV = {
  AI_PROVIDER: process.env.AI_PROVIDER,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  AI_MODEL: process.env.AI_MODEL,
};
// Stock images: env fallback for the Unsplash key (a CMS-stored key wins), and
// the uploads dir imports are written to — MUST be the same volume the API's
// /api/v1/media serves, or imported files 404.
const UNSPLASH_ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY;
const UPLOADS_DIR = process.env.UPLOADS_DIR ?? "/app/uploads";

// Set MCP_HTTP_PORT to serve over Streamable HTTP (for remote clients like
// harmonix) instead of stdio. Each request acts as the user its credential
// belongs to — an OAuth access token, any unrevoked minted token, or the boot
// MCP_TOKEN — so one server serves many people, and "mint a token in Settings →
// MCP, paste it into the client" works with no server restart.
const MCP_HTTP_PORT = process.env.MCP_HTTP_PORT ? Number(process.env.MCP_HTTP_PORT) : undefined;
if (MCP_HTTP_PORT !== undefined && !(Number.isInteger(MCP_HTTP_PORT) && MCP_HTTP_PORT > 0 && MCP_HTTP_PORT < 65536)) {
  console.error(`[paperboy-mcp] MCP_HTTP_PORT must be a TCP port (1–65535), got "${process.env.MCP_HTTP_PORT}"`);
  process.exit(1);
}

/**
 * OAuth (HTTP mode): the public URL of this MCP endpoint — the resource OAuth
 * tokens are issued for, and what a 401 points clients at. Unset =
 * {PUBLIC_URL}/mcp, the same default the API uses; both unset = OAuth off.
 * With OAuth on, the process needs no identity of its own: each request acts as
 * the user whose token it presents.
 */
function publicUrl(name: string, value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  } catch {
    console.error(`[paperboy-mcp] ${name} must be a full URL such as https://cms.example.com (got "${value}")`);
    process.exit(1);
  }
}
const PUBLIC_URL = publicUrl("PUBLIC_URL", process.env.PUBLIC_URL);
const MCP_PUBLIC_URL = publicUrl("MCP_PUBLIC_URL", process.env.MCP_PUBLIC_URL) ?? (PUBLIC_URL ? `${PUBLIC_URL}/mcp` : undefined);
const OAUTH = Boolean(MCP_HTTP_PORT && MCP_PUBLIC_URL);

// No fallback identity: the seeded demo login is a published constant in this
// public repo, so defaulting to it booted an unconfigured server as admin.
if (!MCP_TOKEN && !MCP_LOGIN && !OAUTH) {
  console.error(
    "[paperboy-mcp] No credentials: set MCP_TOKEN (mint one in Settings → MCP), or MCP_EMAIL and MCP_PASSWORD — or, in HTTP mode, PUBLIC_URL so clients sign in with OAuth",
  );
  process.exit(1);
}
const MCP_HTTP_PATH = process.env.MCP_HTTP_PATH ?? "/mcp";

function bearerOf(req: IncomingMessage): string | null {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
  return m?.[1] ?? null;
}

/**
 * Authenticate one HTTP request → the user it acts as and the site cap of the
 * credential IT presented. Every request carries its own identity: an OAuth
 * access token, or an mcp_token row, acts as the user it was issued to — with
 * that user's roles and section scopes, re-resolved per request — so one server
 * serves many people without any of them borrowing another's reach.
 */
type BearerCheck = { ok: false } | { ok: true; userId: string; siteId: string | null };
const DENIED: BearerCheck = { ok: false };

async function bearerOk(req: IncomingMessage, bootUserId: string | null): Promise<BearerCheck> {
  const presented = bearerOf(req);
  if (!presented) return DENIED;

  if (OAUTH && presented.startsWith("mcpa_")) {
    const grant = await verifyOAuthAccessToken(db, presented, MCP_PUBLIC_URL!);
    return grant ? { ok: true, userId: grant.userId, siteId: grant.siteId } : DENIED;
  }

  // The DATABASE IS CONSULTED FIRST, so revocation always wins: a compare against
  // the in-memory boot token before the lookup would keep a token revoked in
  // Settings → MCP working until the container restarts.
  const found = await mcpTokenState(db, presented);
  if (found.state === "revoked") return DENIED;
  if (found.state === "active") {
    await verifyMcpToken(db, presented); // stamp last-used
    return { ok: true, userId: found.userId, siteId: found.siteId };
  }

  // Unknown to the database: an env-only MCP_TOKEN with no row. Legitimate (it is
  // how a bare `MCP_TOKEN=… docker compose up mcp` works), and rotated by
  // restarting with a new value rather than by revoking a row.
  if (MCP_TOKEN && bootUserId) {
    const got = Buffer.from(presented);
    const want = Buffer.from(MCP_TOKEN);
    // An env-only token has no row, so it carries the boot token's cap.
    if (got.length === want.length && timingSafeEqual(got, want)) return { ok: true, userId: bootUserId, siteId: bootTokenSiteId };
  }
  return DENIED;
}

const { db } = createDb(DATABASE_URL);
/**
 * The AccessContext for the tool call in flight.
 *
 * Module-level so the ~40 tool handlers can read it without threading a
 * parameter, and AsyncLocalStorage-backed so two OVERLAPPING calls that name
 * different sites can never see each other's — a plain mutable `ctx` would let
 * a concurrent call write into the wrong site, which is the exact class of bug
 * multisite partitioning exists to prevent.
 */
interface Scope {
  /** The AccessContext tools run under. */
  ctx: AccessContext;
  /** The site the PRESENTING token is confined to; null = every site. */
  tokenSiteId: string | null;
}
const scope = new AsyncLocalStorage<Scope>();
/** The process's own scope: stdio's only one, and the seed for each HTTP request. */
let bootScope: Scope;
const cur = (): Scope => scope.getStore() ?? bootScope;
/**
 * The site the presenting TOKEN is confined to, or null for a cross-site token.
 * A credential-level cap: it bounds `PAPERBOY_SITE` and every per-call `site`,
 * so a narrow token cannot reach wider by asking. It lives in the per-request
 * scope, not a module variable, so one HTTP server can serve a site-scoped and
 * a cross-site token at once without either inheriting the other's reach.
 */
const tokenSite = (): string | null => cur().tokenSiteId;
/** The BOOT token's cap — what PAPERBOY_SITE is checked against at startup. */
let bootTokenSiteId: string | null = null;
const ctx = (): AccessContext => cur().ctx;

/**
 * Resolve a tool call's `site` (slug or id) to the AccessContext to run it in.
 *
 * Deliberately NOT cached: HTTP mode re-resolves the identity per request so a
 * demotion applies live, and a cached per-site context would outlive it.
 */
async function ctxForSite(site: string): Promise<AccessContext> {
  const found = (await getSiteById(db, site)) ?? (await getSiteBySlug(db, site));
  const cap = tokenSite();
  if (found && cap && found.id !== cap) {
    const mine = await getSiteById(db, cap);
    throw new Error(
      `This MCP token is scoped to the ${mine ? `'${mine.slug}'` : cap} site and cannot act in '${site}'. Mint a token for that site in Settings → MCP, or one for every site.`,
    );
  }
  if (!found) {
    // Self-teaching (agent-API rule #2): name the sites that exist, so the agent
    // fixes this in one step instead of guessing slugs.
    const known = (await reachableSites()).map((x) => `${x.slug} (${x.id})`).join(", ");
    throw new Error(`Unknown site "${site}". This token can act in: ${known || "none"}. Call list_sites to see them.`);
  }
  return { ...(await getAccessContext(db, ctx().userId, found.id)), via: "mcp" };
}

/** The sites this token may act in — every site, or just the one it is scoped to. */
async function reachableSites() {
  const all = await listSites(db, ctx());
  const cap = tokenSite();
  return cap ? all.filter((x) => x.id === cap) : all;
}

/**
 * Users and their (global) roles, content types, type templates and the audit
 * trail belong to EVERY site, so a token capped to one site must not touch
 * them — an Admin token scoped to site A could otherwise create an Admin and
 * sign in with access to every site, turning the cap into a suggestion.
 */
function requireCrossSiteToken(what: string): void {
  if (tokenSite()) {
    throw new Error(
      `${what} is shared by every site, so a token scoped to one site cannot do this. ` +
        `Mint a token for every site in Settings → MCP (tick "Every site") and use that one.`,
    );
  }
}

/** Some data-layer reads don't self-check RBAC (the REST routes gate them); the
 *  MCP enforces the same verb here. */
function need(perm: Permission): void {
  if (!ctx().permissions.includes(perm)) throw new Error(`Missing permission: ${perm}`);
}
const persp = (preview?: boolean): "preview" | "published" => (preview ? "preview" : "published");

/**
 * Authorize a delivery_* read.
 *
 * On the HTTP API these reads are authorized by `verifyDeliveryKey` — a public key
 * gets published content, a preview key gets drafts. MCP has no delivery key, and
 * used to substitute NOTHING: every delivery tool called the chokepoint directly,
 * so any token (even a Viewer's, or a section-scoped Author's) could read every
 * unpublished draft in the site with `preview: true`.
 *
 * The delivery chokepoint is key-scoped, not section-scoped, so it cannot express
 * "only this Author's sections". Hence: content.read for any perspective, and the
 * PREVIEW perspective additionally requires site-wide read.
 */
function needDelivery(preview?: boolean): void {
  need("content.read");
  if (preview && !ctx().readSiteWide) {
    throw new Error(
      "The preview perspective (unpublished drafts) requires site-wide read access, and your account is limited to specific sections. Use list_content / get_content instead — they enforce your section scope. Omit `preview` (or set it to false) to read published content through delivery_*.",
    );
  }
}

/** Omitted locale → the document's safe locale (default-locale variant, else
 *  its sole locale, else a self-teaching error) — never a silent fork of a
 *  phantom 'en' branch on a nb-only document (rule 5; 2026-06-07 incident). */
const locFor = (documentId: string, locale?: string) => resolveRequestedLocale(db, documentId, locale, ctx());

/** Audit entry for an MCP write — the same trail as the API routes. Every tool
 *  AWAITS it so a failed insert lands in that tool's stderr trail (rule #6); it
 *  is logged rather than thrown because the write itself already succeeded. */
function mcpAudit(action: string, documentId?: string | null, locale?: string | null, detail?: object): Promise<void> {
  return audit(db, { actorUserId: ctx().userId, action, documentId: documentId ?? null, locale: locale ?? null, ip: "mcp", detail }).catch((err: unknown) =>
    console.error(`[paperboy-mcp] audit failed for ${action}:`, err),
  );
}

// Tool definitions are collected as registrations so a fresh McpServer can be
// built per stdio process and per stateless HTTP request. A stateless HTTP
// request needs its own server+transport to carry the MCP init handshake.
type ToolRegistration = (server: McpServer) => void;
const registrations: ToolRegistration[] = [];

/** Register a tool whose handler returns any JSON-serialisable value. */
const SITE_ARG = z
  .string()
  .optional()
  .describe(
    "Site slug or id to act in (multisite). Omit to use this server's default site. Call list_sites to see what exists — an empty tree or search usually means the wrong site, not missing content.",
  );

/** Writes that remove or take down data (MCP `destructiveHint`). Trash is
 *  absent on purpose: restore_content undoes it. */
const DESTRUCTIVE_TOOLS = new Set([
  "unpublish", "discard_draft", "delete_asset", "delete_form_submission", "erase_form_submissions",
  "delete_type_template", "delete_redirects", "delete_user", "revoke_delivery_key", "delete_webhook",
]);
/** Writes where repeating the same call leaves the same state (MCP `idempotentHint`). */
const IDEMPOTENT_TOOLS = new Set([
  "update_content", "set_field", "copy_variant", "move_content", "update_content_type", "update_type_template",
  "update_asset_alt", "set_start_page", "update_redirect", "update_user", "rename_delivery_key",
]);
/** Tools that reach a service outside this CMS (stock provider, AI model, arbitrary URL). */
const OPEN_WORLD_TOOLS = new Set(["search_stock_images", "import_stock_image", "upload_asset", "ai_assist"]);
const isReadOnlyTool = (name: string) => name === "tree" || name === "ai_assist" || /^(list|get|delivery|search|test|export)_/.test(name);

function toolAnnotations(name: string): ToolAnnotations {
  const openWorldHint = OPEN_WORLD_TOOLS.has(name);
  if (isReadOnlyTool(name)) return { readOnlyHint: true, openWorldHint };
  return { readOnlyHint: false, destructiveHint: DESTRUCTIVE_TOOLS.has(name), idempotentHint: IDEMPOTENT_TOOLS.has(name), openWorldHint };
}

function tool<S extends z.ZodRawShape>(
  name: string,
  description: string,
  shape: S,
  run: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
): void {
  registrations.push((server) => {
    const cb = async (raw: z.infer<z.ZodObject<S>> & { site?: string }) => {
      try {
        // `site` is ours, not the handler's: strip it before the args reach a
        // data-layer schema that would reject the unknown key.
        const { site, ...args } = (raw ?? {}) as { site?: string };
        const result = await scope.run(
          site ? { ...cur(), ctx: await ctxForSite(site) } : cur(),
          () => run(args as z.infer<z.ZodObject<S>>),
        );
        return { content: [{ type: "text" as const, text: JSON.stringify(result ?? { ok: true }, null, 2) }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // The error travels back in-band, but agents (and their loop guards)
        // routinely swallow it — ALSO leave a trail in docker logs, with the
        // args (the raw ones, so the `site` the call named is in the trail).
        console.error(`[paperboy-mcp] tool ${name} failed: ${msg}\n  args: ${JSON.stringify(redactForLog(raw))?.slice(0, 4000)}`);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true as const };
      }
    };
    // The SDK's tool callback type is heavily generic; the wrapper above keeps each
    // tool's `run` strongly typed against its Zod shape, so cast only at this boundary.
    // Multisite: EVERY tool takes an optional `site`, so one server reaches every
    // site in the instance. Omitted, it acts in PAPERBOY_SITE (else the Default).
    server.registerTool(name, { description, inputSchema: { ...shape, site: SITE_ARG }, annotations: toolAnnotations(name) }, cb as never);
  });
}

/** Build a fresh server instance with every registered tool. */
function buildServer(): McpServer {
  const server = new McpServer({ name: "paperboy", version: "0.1.0" });
  for (const register of registrations) register(server);
  return server;
}

const loc = z.string().optional().describe("Locale code. Omit for the document's own locale (its site-default variant, else its only variant).");
const docId = z.string().describe("The item's documentId (stable across locales and versions), e.g. from tree, list_pages or get_content.");
/** Strict ISO instant — a bare local time has no timezone and would publish at a server-dependent moment (rule 1: reject, don't guess). */
const isoInstant = (field: string) =>
  z.string().datetime({
    offset: true,
    message: `${field} must be a full ISO 8601 datetime with timezone, e.g. "2026-09-01T09:00:00Z" — a bare "2026-09-01T09:00" has no timezone and is ambiguous`,
  });

/* ------------------------------- content ------------------------------- */
tool(
  "tree",
  "List ONE level of the page tree: the direct children of parentId, or the top-level pages when it is omitted, in the order the container sorts them. Each node has documentId, type, name, per-locale status and hasChildren — call tree again with a node's documentId to go deeper. Use it to find the parentId for create_content/move_content. For every page at once use list_pages; shared blocks and globals are not in the tree (list_blocks, list_globals).",
  { parentId: z.string().optional().describe("documentId of the page whose children to list. Omit for the top level.") },
  ({ parentId }) => getTree(db, ctx(), parentId ?? null));
tool(
  "get_content",
  "Read one content item for editing: its working version (the draft if one exists, else the published version) in one locale, with name, slug, status, revision and the full `data` field map. Read this before update_content so you merge into current values, and pass its `revision` when replacing with merge:false. To see what visitors get instead (published only, private fields removed), use delivery_get_by_id.",
  { documentId: docId, locale: loc },
  async ({ documentId, locale }) => getContent(db, ctx(), documentId, await locFor(documentId, locale)));
tool(
  "create_content",
  [
    "Create a new content item (page/block/global) as a draft.",
    "Pass the field content in `data` (field name → value, same shapes as update_content)",
    "to fill the page in ONE call — strongly preferred for a one-shot create. If you omit",
    "`data` it creates an EMPTY shell (name + auto slug only) that you MUST then fill with",
    "update_content/set_field, or the page stays blank. Either way: get_content_type first",
    "to learn the field names/shapes for this type.",
    "IMPORTANT: pages almost always belong UNDER an existing parent — a page's position",
    "decides its URL and which template the frontend renders it with (a blog post created",
    "at root gets a generic layout and looks empty when published). Call `tree` first and",
    "pass the right parentId (e.g. blog posts/articles go under their blog/list page).",
    "Omit parentId ONLY for genuinely top-level pages like the site's main sections.",
    "Under a LIST PAGE, the type must match what that page lists (its listedType):",
    "OMIT type to inherit it, or a mismatch is refused (the content would publish",
    "but never appear on the list).",
  ].join(" "),
  {
    type: z.string().optional().describe("Content type name. Under a list-page parent, OMIT to inherit the type that page lists; a mismatch is refused unless allowTypeMismatch."),
    parentId: z.string().nullable().optional().describe("documentId of the parent page. Required in practice for pages — find it with `tree`. Omit only for top-level pages."),
    locale: z.string().optional().describe("The LANGUAGE BRANCH for this content — MATCH the language you are writing (Norwegian content → 'nb', English → 'en'). Call list_locales to see the site's branches. Defaults to the site default locale, which is usually English."),
    name: z.string().describe("Display name of the item (also the source of a page's auto slug), e.g. 'Summer sale 2026'."),
    data: z.record(z.string(), z.unknown()).optional().describe("Initial field values (field name → value), same shapes as update_content. Provide this to create a FILLED draft in one call. Call get_content_type first for the field names/shapes."),
    slug: z.string().optional().describe("URL slug for a page. Omit to auto-derive from the name."),
    allowTypeMismatch: z.boolean().optional().describe("Set true ONLY for a deliberate sub-page whose type differs from the parent list page's listedType"),
    allowLanguageMismatch: z.boolean().optional().describe("Set true ONLY to deliberately create text whose language differs from the locale branch (the guard otherwise refuses, so e.g. Norwegian text can't silently land on the 'en' branch)"),
  },
  async ({ type, parentId, locale, name, data, slug, allowTypeMismatch, allowLanguageMismatch }) => {
    // Initial data takes the same coerce/validate verdict as update_content
    // (rule #3), inside createContent's own transaction — a body the caller sent
    // is never dropped (rule #1) and a refused one leaves no shell behind.
    const hasData = Boolean(data && Object.keys(data).length > 0);
    const created = await createContent(db, ctx(), {
      type,
      parentId: parentId ?? null,
      locale: locale ?? (await resolveDefaultLocale(db, ctx().siteId)),
      name,
      allowTypeMismatch,
      allowLanguageMismatch,
      data: hasData ? data : undefined,
      slug,
    });
    await mcpAudit("content.create", created.documentId, created.locale, hasData || slug !== undefined ? { withData: true } : undefined);
    // In-band nudges the agent reads from the result (the create still
    // succeeds — these situations are legal, but each is a real incident):
    //  - FILL: only when no data was provided — the draft is blank and must be
    //    filled with update_content (Harmonix shipped an empty post this way).
    //  - PLACE: a page at root usually means a forgotten parentId — a blog post
    //    at root renders with a generic template and looks empty when published.
    const hints: string[] = [];
    if (!hasData) {
      hints.push(
        `NEXT: this draft has NO content yet — call update_content {documentId:"${created.documentId}", data:{…}} ` +
          "(or set_field) to write the body and other fields now, then publish. Until then the page is blank.",
      );
    }
    if (created.kind === "page" && !parentId) {
      hints.push(
        "PLACEMENT: created at the TOP LEVEL — if it belongs under another page (e.g. a blog post under the blog/list page), " +
          "call `tree` to find the parent and move_content {documentId, parentId} BEFORE publishing; its URL and template depend on its position.",
      );
    }
    return hints.length ? { ...created, hint: hints.join(" ") } : created;
  });
tool(
  "update_content",
  [
    "Save the working draft of a content item. `data` maps field name → value.",
    "For LONG text/markdown values prefer set_field: a flat string parameter survives",
    "tool-call serialization that can mangle long strings nested inside `data`.",
    "IMPORTANT: each field's value shape depends on its content-type field TYPE —",
    "call get_content_type first. text/markdown → a plain string; richtext → a TipTap",
    "doc object {type:'doc',content:[…]}; contentArea → an ARRAY of block instances;",
    "reference → {documentId,type?}; select → one option-value string; image → an asset id.",
    "By default `data` is MERGED over the current draft — fields you omit are kept.",
    "Pass merge:false to REPLACE the whole map (then you must send every required field,",
    "or the next publish will fail validation).",
    "With merge:false, also pass the `revision` you got from get_content: the write is",
    "then refused (409) if a human editor changed the draft meanwhile, instead of",
    "overwriting them. Merged writes don't need it — they read current data at write time.",
  ].join(" "),
  { documentId: docId, locale: loc, name: z.string().optional().describe("New display name. Omit to keep it."), slug: z.string().nullable().optional().describe("New URL slug for a page; publishing it adds a 301 from the old URL automatically. Omit to keep it."), displayInNav: z.boolean().optional().describe("Whether the page appears in the site navigation. Omit to keep it."), data: z.record(z.string(), z.unknown()).describe("Field name → value, shaped per get_content_type's valueFormat. Pass {} to change only name/slug/displayInNav."), merge: z.boolean().optional().describe("Default true: shallow-merge data over the current draft. false = replace the whole field map"), revision: z.number().int().nonnegative().optional().describe("Optimistic concurrency: the `revision` from get_content. If a human (or another agent) has changed the draft since, the write is refused instead of overwriting their work. Recommended whenever merge:false"), allowLanguageMismatch: z.boolean().optional().describe("Set true ONLY to deliberately write text whose language differs from the locale branch (the guard otherwise refuses, so e.g. Norwegian text can't silently land on the 'en' branch)") },
  // merge defaults to TRUE here (agent-facing surface): a full replace that
  // silently drops required fields like `intro` passes the relaxed draft
  // validation but bricks every subsequent publish — the worst failure mode
  // an agent can hit. Replace semantics stay available via merge:false.
  async ({ documentId, locale, name, slug, displayInNav, data, merge, revision, allowLanguageMismatch }) => {
    const l = await locFor(documentId, locale);
    const updated = await updateContent(db, ctx(), documentId, l, { name, slug, displayInNav, data, merge: merge ?? true, revision, allowLanguageMismatch });
    await mcpAudit("content.update", documentId, l);
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
  { documentId: docId, locale: loc, field: z.string().describe("Field name from the content type (or 'name')"), value: z.string().describe("The plain string value"), allowLanguageMismatch: z.boolean().optional().describe("Set true ONLY to deliberately write text whose language differs from the locale branch (the guard otherwise refuses, so e.g. Norwegian text can't silently land on the 'en' branch)") },
  async ({ documentId, locale, field, value, allowLanguageMismatch }) => {
    const l = await locFor(documentId, locale);
    const updated =
      field === "name"
        ? await updateContent(db, ctx(), documentId, l, { name: value, data: {}, merge: true, allowLanguageMismatch })
        : await updateContent(db, ctx(), documentId, l, { data: { [field]: value }, merge: true, allowLanguageMismatch });
    await mcpAudit("content.update", documentId, l, { field });
    return updated;
  });
tool(
  "publish",
  [
    "Publish the working draft of a content item for a locale. The locale is a",
    "LANGUAGE BRANCH — publishing Norwegian text into 'en' puts it on the English",
    "site; a strong language/branch mismatch is refused unless allowLanguageMismatch is true.",
    "A future publishAt SCHEDULES the go-live instead: the draft stays unpublished (and",
    "invisible to readers) until then, and shows on the dashboard under Scheduled publishing.",
    "Call publish again with a new publishAt to reschedule, or without one to go live now.",
    "NEVER fake scheduling by putting the date in a data field — that publishes immediately.",
  ].join(" "),
  {
    documentId: docId,
    locale: loc,
    allowLanguageMismatch: z.boolean().optional().describe("Set true ONLY when publishing content whose language deliberately differs from the locale branch"),
    publishAt: isoInstant("publishAt").optional().describe('Future go-live time (ISO 8601, e.g. "2026-09-01T09:00:00Z"). Omit to publish immediately.'),
    expireAt: isoInstant("expireAt").optional().describe("When to unpublish automatically (ISO 8601). Must be after publishAt."),
  },
  async ({ documentId, locale, allowLanguageMismatch, publishAt, expireAt }) => {
    const l = await locFor(documentId, locale);
    if (publishAt || expireAt) {
      // Same chokepoint as the manage /schedule route. expireAt alone means
      // "publish now, expire then" — schedulePublish treats a now/past publishAt
      // as an immediate publish carrying the expiry.
      const scheduled = await schedulePublish(db, ctx(), documentId, l, {
        allowLanguageMismatch,
        publishAt: publishAt ? new Date(publishAt) : new Date(),
        expireAt: expireAt ? new Date(expireAt) : null,
      });
      await mcpAudit("content.schedule", documentId, l, { publishAt: publishAt ?? null, expireAt: expireAt ?? null });
      return scheduled;
    }
    const published = await publishContent(db, ctx(), documentId, l, { allowLanguageMismatch });
    await mcpAudit("content.publish", documentId, l);
    return published;
  });
tool(
  "copy_variant",
  [
    "Copy a document's working version (name, slug and EVERY field) from one locale",
    "to another, server-side and atomically. USE THIS to move content that landed in",
    "the wrong language branch — never re-type the data field by field (a real agent",
    "moved 4 of 9 fields by hand and published an article without its body).",
    "The target locale gets a draft; publish it separately.",
  ].join(" "),
  { documentId: docId, fromLocale: z.string().describe("Locale to copy FROM"), toLocale: z.string().describe("Locale to copy TO") },
  async ({ documentId, fromLocale, toLocale }) => {
    const copied = await copyVariant(db, ctx(), documentId, fromLocale, toLocale);
    await mcpAudit("content.copy_variant", documentId, toLocale, { fromLocale });
    return copied;
  });
tool(
  "unpublish",
  "Take a content item off the live site in one locale: delivery stops serving it there (its URL starts answering 404) and content areas that reference it drop it. Fires the content.unpublished webhook. The content and its version history are kept, so publish brings it back. Other locales are unaffected. To remove the item entirely use trash_content.",
  { documentId: docId, locale: loc },
  async ({ documentId, locale }) => {
    const l = await locFor(documentId, locale);
    const result = await unpublishContent(db, ctx(), documentId, l);
    await mcpAudit("content.unpublish", documentId, l);
    return result;
  });
tool(
  "discard_draft",
  "Throw away the unpublished draft changes of one locale, so the working version falls back to the published one. The live site is unchanged; the discarded draft cannot be recovered. Refused for content that was never published (there is nothing to fall back to) — use trash_content to remove that instead.",
  { documentId: docId, locale: loc },
  async ({ documentId, locale }) => { const l = await locFor(documentId, locale); await discardDraft(db, ctx(), documentId, l); await mcpAudit("content.discard_draft", documentId, l); return { ok: true }; });
tool(
  "move_content",
  "Move a page in the tree: give parentId to re-parent it (its URL path changes with its new position, and the old URL gets a 301 automatically), and/or beforeId/afterId to place it among its siblings. The page's whole subtree moves with it. Sibling order only sticks under a parent whose child sort is manual; a computed sort (name, date…) re-orders it. Returns {ok:true}.",
  {
    documentId: docId,
    parentId: z.string().nullable().optional().describe("documentId of the new parent page; null moves it to the top level. Omit to keep the current parent."),
    beforeId: z.string().nullable().optional().describe("Place it directly before this sibling (documentId)."),
    afterId: z.string().nullable().optional().describe("Place it directly after this sibling (documentId)."),
  },
  async ({ documentId, parentId, beforeId, afterId }) => { await moveContent(db, ctx(), documentId, { parentId, beforeId, afterId }); await mcpAudit("content.move", documentId); return { ok: true }; });
tool(
  "duplicate_content",
  "Copy a content item into a NEW unpublished document beside the original (same parent), named \"<name> (copy)\", with every field of each locale's working version. A copied page gets a fresh slug, so it never collides with the original's URL. Children are not copied. Returns the new item; edit it, then publish.",
  { documentId: docId, locale: loc },
  async ({ documentId, locale }) => {
    const copy = await cloneContent(db, ctx(), documentId, await locFor(documentId, locale));
    await mcpAudit("content.duplicate", copy.documentId, copy.locale, { source: documentId });
    return copy;
  });
tool(
  "trash_content",
  "Move a content item AND its whole page subtree to the trash: every locale is unpublished at once and disappears from delivery. Recoverable — restore_content brings it back (as drafts; publish again explicitly). Returns {trashed: <number of items>}. To only take it off the live site, use unpublish instead.",
  { documentId: docId },
  async ({ documentId }) => { const r = await softDelete(db, ctx(), documentId); await mcpAudit("content.trash", documentId); return r; });
tool(
  "restore_content",
  "Bring a trashed item back to its old place in the tree, together with the descendants that were trashed with it. Restored content is NOT republished — call publish for each locale that should go live. Refused if its parent is still in the trash or a live sibling took its URL meanwhile. Returns {restored: <count>}. Find trashed ids with list_trash.",
  { documentId: docId },
  async ({ documentId }) => { const r = await restoreContent(db, ctx(), documentId); await mcpAudit("content.restore", documentId); return r; });
tool(
  "list_trash",
  "List the trashed content you can see in this site, with documentId, type, kind, name and deletedAt. Use the documentId with restore_content.",
  {},
  () => listTrash(db, ctx()));
tool(
  "list_versions",
  "List a content item's version history in one locale, newest first: each version's id, versionNumber, status, whether it is the live one, name, and who created it when. Pass a version's `id` to restore_version to roll back.",
  { documentId: docId, locale: loc },
  async ({ documentId, locale }) => listVersions(db, ctx(), documentId, await locFor(documentId, locale)));
tool(
  "restore_version",
  "Roll back: copy an older version's content into the working draft of that locale. Nothing goes live until you publish; the version history keeps every earlier version. Returns the updated item.",
  { documentId: docId, locale: loc, versionId: z.number().describe("The version's `id` from list_versions (not its versionNumber).") },
  async ({ documentId, locale, versionId }) => {
    const l = await locFor(documentId, locale);
    const restored = await restoreVersion(db, ctx(), documentId, l, versionId);
    await mcpAudit("content.version_restore", documentId, l, { versionId });
    return restored;
  });
tool(
  "list_blocks",
  "List this site's SHARED blocks — reusable block documents (banners, forms, CTAs…) that pages place by reference in a content area, so one edit updates every page using them. Each has documentId, type, name, per-locale status and folderId. Edit one with get_content/update_content on its documentId. Inline blocks live inside a page's data and are not listed here.",
  {},
  () => listBlocks(db, ctx()));
tool(
  "list_globals",
  "List this site's global singletons (header, footer, site settings…). Globals are NOT in the page tree and are not blocks, so this is the only way to enumerate them; edit one with get_content/update_content/set_field on its documentId, like any other document.",
  {},
  () => listGlobals(db, ctx()),
);
tool(
  "list_pages",
  "List EVERY page you can see in this site as one flat array (documentId, name, type, parentId, per-locale status) — no tree walking needed. Use it to find a page by name or to pick a parent/reference target; use tree to see one level in display order.",
  {},
  () => listPages(db, ctx()));

/* ----------------------------- content model --------------------------- */
// Annotate each field with the JSON shape update_content expects for it, so an
// agent learns the encoding from the type itself (not by trial and error).
/** The read-side annotations withFieldFormats adds. A definition an agent read,
 *  edited and sent back carries them; they are ours, so drop them before the
 *  strict parse instead of refusing the write over our own keys. */
function withoutFieldFormats(def: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(def.fields)) return def;
  const fields = def.fields.map((f: unknown) => {
    if (!f || typeof f !== "object") return f;
    const copy = { ...(f as Record<string, unknown>) };
    delete copy.valueFormat;
    delete copy.valueExample;
    return copy;
  });
  return { ...def, fields };
}

function withFieldFormats<T extends { fields: FieldDef[] }>(def: T): T & { fields: Array<FieldDef & { valueFormat: string; valueExample: unknown }> } {
  return {
    ...def,
    fields: def.fields.map((f) => {
      const { format, example } = fieldFormatHint(f);
      return { ...f, valueFormat: format, valueExample: example };
    }),
  };
}
tool(
  "list_content_types",
  "List every content type in the instance (shared by all sites): its name, kind (page | block | global) and fields, each field annotated with valueFormat + valueExample — the JSON shape update_content expects. Large; when you already know the type, get_content_type returns just that one.",
  {},
  async () => { need("content.read"); return (await listContentTypes(db)).map(withFieldFormats); });
tool(
  "get_content_type",
  "Get one content type's definition: name, kind, displayName, schemaType and its fields (name, type, required, options, allowed blocks of a content area…). Each field includes valueFormat + valueExample — the exact JSON shape create_content/update_content expect. Call this before writing content of a type. Returns null for an unknown name.",
  { name: z.string().describe("Content type name, PascalCase, e.g. 'BlogPost' (as in a content item's `type`).") },
  async ({ name }) => { need("content.read"); const def = await getContentType(db, name); return def ? withFieldFormats(def) : def; });
tool(
  "create_content_type",
  "Create a new content type (the schema editors fill in) from a full ContentTypeDef. Content types are instance-wide, shared by every site, so this needs a token not limited to one site. Faster for common shapes: list_type_templates + instantiate_type_template. The definition is validated and a bad one is refused with the offending path.",
  { definition: z.record(z.string(), z.unknown()).describe("A ContentTypeDef: {name: 'PascalCase', kind: 'page'|'block'|'global', fields: [{name, type, …}], …}. Copy the shape of an existing one from get_content_type.") },
  async ({ definition }) => { requireCrossSiteToken("Content-type design"); const def = ContentTypeDef.parse(withoutFieldFormats(definition)); const r = await createContentType(db, ctx(), def); await mcpAudit("contenttype.create", null, null, { name: def.name, kind: def.kind }); return r; });
tool(
  "update_content_type",
  "Replace a content type's definition (add/remove/rename fields, change options). name and kind are immutable. Send the FULL definition — get_content_type, edit, send back; a field you leave out is removed from the schema. Existing content is not migrated: its stored values for removed fields are simply no longer shown or delivered. Instance-wide (all sites).",
  { name: z.string().describe("The existing type's name, e.g. 'BlogPost'."), definition: z.record(z.string(), z.unknown()).describe("The full updated ContentTypeDef (same shape get_content_type returns; its valueFormat/valueExample annotations are ignored).") },
  async ({ name, definition }) => { requireCrossSiteToken("Content-type design"); const r = await updateContentType(db, ctx(), name, ContentTypeDef.parse(withoutFieldFormats(definition))); await mcpAudit("contenttype.update", null, null, { name }); return r.next; });

/* --------------------- content-type template collection ------------------ */
// Named, reusable ContentTypeDef recipes: save a type as a template, then
// instantiate it back into a real content type (optionally under a new name).
tool("list_type_templates", "List all content-type templates — named ContentTypeDef recipes. Includes the BUILT-IN library (starter pages/blocks that ship with Paperboy, read-only) alongside stored templates. Each template's name is the content type name it materialises by default.", {},
  async () => { need("content.read"); return (await listTypeTemplates(db)).map(withFieldFormats); });
tool(
  "get_type_template",
  "Get one type template's full ContentTypeDef by name (stored or built-in), each field annotated with valueFormat + valueExample. Use it to inspect a template before instantiate_type_template, or as a starting definition for create_content_type.",
  { name: z.string().describe("Template name as listed by list_type_templates, e.g. 'FaqPage'.") },
  async ({ name }) => { need("content.read"); return withFieldFormats(await getTypeTemplate(db, name)); });
tool("create_type_template", "Save a content type definition as a reusable template (a starter/backup recipe). The template's name is the content type name instantiate materialises by default — use a name no existing template takes (built-in template names are reserved).", { definition: z.record(z.string(), z.unknown()).describe("Full ContentTypeDef, same shape as create_content_type") },
  async ({ definition }) => { requireCrossSiteToken("The type-template library"); const def = ContentTypeDef.parse(withoutFieldFormats(definition)); const r = await createTypeTemplate(db, ctx(), def); await mcpAudit("type_template.create", null, null, { name: def.name, kind: def.kind }); return r; });
tool(
  "update_type_template",
  "Replace a stored type template's definition (name and kind are immutable; built-in templates are read-only — copy one under a new name with create_type_template instead). Content types already instantiated from it are NOT changed; re-apply with instantiate_type_template {updateExisting:true}.",
  { name: z.string().describe("The stored template's name."), definition: z.record(z.string(), z.unknown()).describe("The full updated ContentTypeDef (same shape as create_content_type).") },
  async ({ name, definition }) => { requireCrossSiteToken("The type-template library"); const def = ContentTypeDef.parse(withoutFieldFormats(definition)); const r = await updateTypeTemplate(db, ctx(), name, def); await mcpAudit("type_template.update", null, null, { name }); return r.next; });
tool(
  "delete_type_template",
  "Permanently delete a stored type template from the library (built-ins can't be deleted). Content types instantiated from it, and their content, are NOT affected. Returns {ok:true}.",
  { name: z.string().describe("The stored template's name.") },
  async ({ name }) => { requireCrossSiteToken("The type-template library"); await deleteTypeTemplate(db, ctx(), name); await mcpAudit("type_template.delete", null, null, { name }); return { ok: true }; });
tool(
  "instantiate_type_template",
  "Materialise a type template into a real content type. Default: creates the type under the template's own name. " +
    "If that type already exists the call is REFUSED (409) — pass updateExisting: true to re-apply the template onto the existing type (kind must match; existing content is not migrated), " +
    "or asName: \"OtherName\" to create a type with a DIFFERENT name (must match ^[A-Z][a-zA-Z0-9]*$, e.g. \"CaseStudy\"). " +
    "Pass withBlocks: true to ALSO create the block types the template's content areas reference (recursively; existing types are left untouched) — recommended for built-ins like FaqPage so the set works out of the box.",
  {
    name: z.string().describe("Template name"),
    updateExisting: z.boolean().optional().describe("Overwrite the existing type of the same name from the template (default false)"),
    asName: z.string().optional().describe("Create the type under this name instead of the template's"),
    withBlocks: z.boolean().optional().describe("Also create the block types this template's content areas allow-list (default false)"),
  },
  async ({ name, updateExisting, asName, withBlocks }) => { requireCrossSiteToken("Content-type design");
    const r = await instantiateTypeTemplate(db, ctx(), name, { updateExisting, asName, withBlocks });
    await mcpAudit("type_template.instantiate", null, null, { template: name, type: r.name, action: r.action, ...(r.blocks ? { blocks: r.blocks } : {}) });
    return r;
  },
);
tool(
  "export_type_templates",
  "Export type templates as a portable JSON document ({format, version, exportedAt, templates}) that import_type_templates on another Paperboy instance accepts. Omit names to export everything (built-ins included).",
  { names: z.array(z.string()).optional().describe("Template names to export (default: all)") },
  async ({ names }) => {
    need("content.read");
    const templates = await exportTypeTemplates(db, names);
    return { format: TYPE_TEMPLATE_EXPORT_FORMAT, version: TYPE_TEMPLATE_EXPORT_VERSION, exportedAt: new Date().toISOString(), templates };
  },
);
tool(
  "import_type_templates",
  "Import type templates from an export document. Per-template outcome: new names are created; existing stored templates are skipped unless overwrite: true; built-in names are always skipped (they ship with every instance). Returns {created, updated, skipped:[{name, reason}]}.",
  {
    templates: z.array(z.record(z.string(), z.unknown())).min(1).max(200).describe("The export document's templates array (full ContentTypeDef objects)"),
    overwrite: z.boolean().optional().describe("Update existing stored templates from the import (default false)"),
  },
  async ({ templates, overwrite }) => { requireCrossSiteToken("The type-template library");
    const defs = templates.map((t) => ContentTypeDef.parse(t));
    const r = await importTypeTemplates(db, ctx(), defs, overwrite ?? false);
    await mcpAudit("type_template.import", null, null, { created: r.created, updated: r.updated, skipped: r.skipped.map((s) => s.name), overwrite: overwrite ?? false });
    return r;
  },
);

/* ---------------------------- form submissions --------------------------
 * Read-only from the agent's side, plus the two GDPR actions. There is no
 * `submit_form` tool on purpose: submitting is what a VISITOR does through the
 * public endpoint, and an agent that could post submissions would just be a
 * spam tool with a CMS login.
 *
 * These call the same db functions the REST routes do, so the permission checks
 * (`submission.read` / `submission.manage`) and the site scope are inherited
 * rather than re-implemented — an Author still cannot read visitor messages
 * here, exactly as over HTTP.
 */
tool("list_forms", "List the forms (Form blocks) in this site with formId, name, submission count and time of the last submission. Start here before list_form_submissions or export_form_submissions. Submissions are visitor personal data: requires the submission.read permission (Admin/Editor).", {},
  () => listForms(db, ctx()));
tool(
  "list_form_submissions",
  "List form submissions in this site, newest first, one page at a time. Answers come with a snapshot of the field labels as they were when submitted, so a later edit to the form does not rewrite history. Visitor personal data: requires submission.read. For a full copy as a file use export_form_submissions.",
  {
    formId: z.string().optional().describe("Limit to one form's submissions (its formId from list_forms). Omit for all forms."),
    limit: z.number().optional().describe("Page size, 1-200 (default 50)."),
    offset: z.number().optional().describe("Rows to skip, for paging (default 0)."),
  },
  ({ formId, limit, offset }) => listSubmissions(db, ctx(), { formId, limit, offset }),
);
tool(
  "get_form_submission",
  "Get one form submission in full: its answers with the field-label snapshot, the form it belongs to, when it was received and when retention deletes it. Requires submission.read.",
  { submissionId: z.string().describe("The submission's id from list_form_submissions.") },
  ({ submissionId }) => getSubmission(db, ctx(), submissionId));
tool(
  "export_form_submissions",
  "Export form submissions as CSV text (one row per submission, one column per field) and return it with the row count. This is a copy of visitor personal data: the export is audit-logged and requires submission.read.",
  { formId: z.string().optional().describe("Export only this form (formId from list_forms). Omit to export every form in the site.") },
  async ({ formId }) => {
    const res = await exportSubmissions(db, ctx(), formId);
    await mcpAudit("form.submissions_exported", formId ?? null, null, { rows: res.rows });
    return res;
  },
);
tool(
  "delete_form_submission",
  "Permanently delete ONE form submission (irreversible; audit-logged; requires submission.manage). Returns {ok:false} when no such submission exists. To erase everything one person sent, use erase_form_submissions.",
  { submissionId: z.string().describe("The submission's id from list_form_submissions.") },
  async ({ submissionId }) => {
    const ok = await deleteSubmission(db, ctx(), submissionId);
    await mcpAudit("form.submission_deleted", null, null, { submissionId, found: ok });
    return { ok };
  });
tool(
  "erase_form_submissions",
  "Data-subject erasure: delete EVERY submission in the active site whose answers contain this email address, in any field. Irreversible; requires submission.manage. Returns {deleted: <count>}; the audit log records that an erasure happened, never the address. Copies in database backups survive until the backups rotate.",
  { email: z.string().describe("The address to erase, matched case-insensitively across all answers.") },
  async ({ email }) => {
    const res = await eraseSubmissionsByEmail(db, ctx(), email);
    // The address is the subject of an erasure request — log that one happened
    // and how much it removed, never the address itself.
    await mcpAudit("form.submissions_erased", null, null, { deleted: res.deleted });
    return res;
  },
);

/* -------------------------------- media -------------------------------- */
tool(
  "list_assets",
  "List this site's media library (images and PDFs): each asset's documentId, filename, mime, size, public url, alt text, attribution for stock imports, and folder. An image field stores the asset's documentId — set it with set_field. To add files use upload_asset, create_upload_link or import_stock_image.",
  {},
  () => listAssets(db, ctx()));
tool(
  "update_asset_alt",
  "Set (overwrite) an image asset's alt text — the description screen readers announce and search engines index, wherever the image is used. Describe what the image shows in one sentence; use \"\" only for a purely decorative image. Returns the updated asset.",
  { documentId: z.string().describe("The asset's documentId from list_assets or an upload result."), alt: z.string().describe("The new alt text, e.g. 'Two hikers on a ridge above a fjord at sunset'.") },
  async ({ documentId, alt }) => { const r = await updateAssetAlt(db, ctx(), documentId, alt); await mcpAudit("asset.alt", documentId); return r; });
tool(
  "delete_asset",
  "Permanently delete a media asset: the database row and the stored file. Irreversible. Content that still points at it is not blocked: delivery resolves those fields to null, so the image silently disappears from those pages — clear or replace them first. Returns {ok:true}.",
  { documentId: z.string().describe("The asset's documentId from list_assets.") },
  async ({ documentId }) => { await deleteAsset(db, ctx(), documentId, UPLOADS_DIR); await mcpAudit("asset.delete", documentId); return { ok: true }; });
tool(
  "search_stock_images",
  "Search the configured stock photo provider (Settings → Stock images; Unsplash). Returns photo candidates with id, description and attribution. To USE a photo: call import_stock_image with its id, then set_field the returned asset documentId on an image field.",
  { query: z.string().min(1).max(200).describe("What the photo should show, e.g. 'mountain lake sunrise'") },
  ({ query }) => searchStockImages(db, ctx(), query, UNSPLASH_ACCESS_KEY),
);
tool(
  "import_stock_image",
  "Import a stock photo (by the id from search_stock_images) into the media library. Downloads the image, stores it as a regular asset with alt text + attribution, and returns the asset — set its documentId on an image field with set_field.",
  {
    providerId: z.string().min(1).max(200).describe("Photo id from search_stock_images"),
    alt: z.string().max(300).optional().describe("Alt text override (defaults to the provider's description)"),
  },
  async ({ providerId, alt }) => {
    const rec = await importStockImage(db, ctx(), { providerId, alt }, {
      envKey: UNSPLASH_ACCESS_KEY,
      save: saveToUploadsDir(UPLOADS_DIR),
    });
    await mcpAudit("asset.import", rec.documentId, null, { provider: rec.sourceMeta?.provider, providerId, mime: rec.mime, size: rec.size });
    return rec;
  },
);

tool(
  "create_upload_link",
  "Get a short-lived link for uploading LOCAL files (images, PDFs) into the media library — the way to upload files on your own machine, which this server can't read. POST them as multipart/form-data with the returned header, e.g. with curl (several -F file=@… per request is fine). The response lists each stored asset's documentId: set it on an image field with set_field, and give it alt text with update_asset_alt. The link uploads as you, into this site, and expires after 15 minutes.",
  {},
  async () => {
    if (!PUBLIC_URL) throw new Error("Upload links need PUBLIC_URL (the CMS's public origin, e.g. https://cms.example.com) set on the MCP server. Use upload_asset with a url or dataBase64 instead.");
    const link = await createUploadLink(db, ctx());
    await mcpAudit("upload_link.create", null, null, { expiresAt: link.expiresAt.toISOString() });
    const uploadUrl = `${PUBLIC_URL}/api/v1/uploads`;
    return {
      uploadUrl,
      headers: { Authorization: `Bearer ${link.token}` },
      expiresAt: link.expiresAt.toISOString(),
      example: `curl -H "Authorization: Bearer ${link.token}" -F file=@photo-1.jpg -F file=@photo-2.jpg ${uploadUrl}`,
      limits: "PNG, JPEG, GIF, WEBP or PDF; max 5 MB per file; up to 20 files per request",
    };
  },
);
tool(
  "upload_asset",
  "Add a file (PNG, JPEG, GIF, WEBP or PDF, max 5 MB) to the media library from a public URL or from base64 bytes, and return the asset — set its documentId on an image field with set_field. For files on YOUR machine prefer create_upload_link: base64 through a tool call costs roughly 1 token per 2-3 bytes.",
  {
    url: z.string().url().optional().describe("Public http(s) URL of the file itself (not a web page showing it)"),
    dataBase64: z.string().optional().describe("The file's bytes, base64-encoded (a data: URL prefix is accepted)"),
    filename: z.string().max(255).optional().describe("Display name in the media library, e.g. 'hero.jpg'"),
    alt: z.string().max(300).optional().describe("Alt text"),
  },
  async ({ url, dataBase64, filename, alt }) => {
    if (Boolean(url) === Boolean(dataBase64)) {
      throw new Error("Pass exactly one of url or dataBase64. Example: {\"url\": \"https://example.com/photo.jpg\", \"alt\": \"A calculator on a desk\"}");
    }
    const save = saveToUploadsDir(UPLOADS_DIR);
    const rec = url
      ? await importAssetFromUrl(db, ctx(), { url, filename, alt }, save)
      : await storeUploadedAsset(db, ctx(), { buf: decodeBase64(dataBase64!), filename, alt }, save);
    await mcpAudit("asset.upload", rec.documentId, null, { mime: rec.mime, size: rec.size, via: url ? "url" : "base64" });
    return rec;
  },
);

/** base64 → bytes, accepting a data: URL prefix and line breaks; refuses anything else. */
function decodeBase64(data: string): Buffer {
  const body = data.replace(/^data:[^;,]*;base64,/, "").replace(/\s+/g, "");
  if (!body || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(body)) {
    throw new Error("dataBase64 is not valid base64. Send the file's bytes base64-encoded, optionally as a data: URL (data:image/jpeg;base64,/9j/4AAQ…).");
  }
  return Buffer.from(body, "base64");
}

/* ------------------------------ delivery (read) ------------------------ */
const POPULATE_ARG = z.number().min(0).max(4).optional().describe("How many levels of references and shared blocks to resolve inline, 0-4 (default 0: references stay as ids).");
const PREVIEW_ARG = z.boolean().optional().describe("true = read the latest drafts as the preview pane shows them (needs site-wide read access). Default false: published content only, exactly what visitors get.");
const delv = { locale: loc, populate: POPULATE_ARG, preview: PREVIEW_ARG };
// Shared by every delivery_* description: what sets these reads apart from get_content.
const DELIVERY_NOTE = "Returns the item as the public Delivery API serves it — published only (unless preview), private fields removed, plus computed urlPath, fieldTypes and SEO metadata on pages — or null when nothing matches. Use get_content to read a draft for editing.";
tool("delivery_get_by_id", `Read one content item by documentId exactly as the website receives it. ${DELIVERY_NOTE}`, { documentId: docId, ...delv },
  async ({ documentId, locale, populate, preview }) => { needDelivery(preview); return deliveryGetById(db, persp(preview), ctx().siteId, documentId, (locale ?? (await resolveDefaultLocale(db, ctx().siteId))), populate); });
tool("delivery_get_by_slug", `Read one content item by its slug (the last URL segment). Slugs are unique only among siblings, so prefer delivery_get_by_path for a page's full URL. ${DELIVERY_NOTE}`, { slug: z.string().describe("The slug, without slashes, e.g. 'about-us'."), ...delv },
  async ({ slug, locale, populate, preview }) => { needDelivery(preview); return deliveryGetBySlug(db, persp(preview), ctx().siteId, slug, (locale ?? (await resolveDefaultLocale(db, ctx().siteId))), populate); });
tool("delivery_get_by_path", `Read the page a visitor gets at a URL path — the way to check what a live URL shows. ${DELIVERY_NOTE}`, { path: z.string().describe("The page's URL path without the locale prefix, e.g. '/blog/my-post'."), ...delv },
  async ({ path, locale, populate, preview }) => { needDelivery(preview); return deliveryGetByPath(db, persp(preview), ctx().siteId, path.split("/").filter(Boolean), (locale ?? (await resolveDefaultLocale(db, ctx().siteId))), populate); });
tool(
  "delivery_list",
  "List the published content of one type as the website receives it (e.g. every BlogPost for a listing). Supports pagination (limit/offset), sorting and equality filters on data fields; without sort it follows the parent's declared child order. Private fields are removed. Returns { items, total }.",
  {
    type: z.string().describe("Content type name, e.g. 'BlogPost'."),
    ...delv,
    limit: z.number().int().min(1).max(500).optional().describe("Page size, 1-500."),
    offset: z.number().int().min(0).optional().describe("Items to skip, for paging."),
    sort: z.string().optional().describe("name | createdAt | data.<field>; prefix - for descending"),
    filter: z.record(z.string(), z.string()).optional().describe("Equality filters on data fields, e.g. {\"author\": \"Jane\"}"),
  },
  async ({ type, locale, populate, preview, limit, offset, sort, filter }) => { needDelivery(preview); return deliveryList(db, persp(preview), ctx().siteId, type, (locale ?? (await resolveDefaultLocale(db, ctx().siteId))), populate, undefined, { limit, offset, sort, filter }); });
tool(
  "delivery_search",
  "Full-text search over the website's content (item names + public field text) in one locale, as visitors would search it: published only (unless preview), private fields never matched or returned. Returns { items, total }. To find content for editing, list_pages or tree are usually faster.",
  { query: z.string().min(1).max(200).describe("Words to search for, e.g. 'pricing plans'."), type: z.string().optional().describe("Only return items of this content type."), locale: loc, limit: z.number().int().min(1).max(100).optional().describe("Max results, 1-100."), preview: PREVIEW_ARG },
  async ({ query, type, locale, limit, preview }) => { needDelivery(preview); return deliverySearch(db, persp(preview), ctx().siteId, query, (locale ?? (await resolveDefaultLocale(db, ctx().siteId))), type, limit); });
tool("delivery_global", `Read a global singleton (header, footer, site settings…) by its type, as the website receives it. Find the types with list_globals. ${DELIVERY_NOTE}`, { type: z.string().describe("The global's content type name, e.g. 'SiteHeader'."), locale: loc, preview: PREVIEW_ARG },
  async ({ type, locale, preview }) => { needDelivery(preview); return deliveryGlobal(db, persp(preview), ctx().siteId, type, (locale ?? (await resolveDefaultLocale(db, ctx().siteId)))); });
tool("delivery_start", `Read this site's start page — the page served at / (set with set_start_page) — as the website receives it. Null when no start page is set. ${DELIVERY_NOTE}`, { locale: loc, populate: POPULATE_ARG, preview: PREVIEW_ARG },
  async ({ locale, populate, preview }) => { needDelivery(preview); return deliveryStartPage(db, persp(preview), ctx().siteId, (locale ?? (await resolveDefaultLocale(db, ctx().siteId))), populate); });

/* --------------------------------- site -------------------------------- */
tool(
  "list_sites",
  "List the sites in this instance and say which one this server acts in. This server is pinned to ONE site (PAPERBOY_SITE, a slug or id); content in another site is invisible to every tool here, so an empty tree or search may mean the wrong site, not missing content.",
  {},
  async () => ({
    activeSiteId: ctx().siteId,
    tokenScopedTo: tokenSite(),
    sites: (await reachableSites()).map((x) => ({ id: x.id, slug: x.slug, name: x.name })),
  }),
);
tool("get_site_config", "Get this site's configuration: startPageId (the page served at /, or null) and previewBaseUrl (the frontend origin the admin's preview frames). Read-only.", {}, () => getSiteConfig(db, ctx()));
tool("set_start_page", "Choose which page this site serves at / (the home page), or clear it with null. Takes effect immediately on the live site, in every locale the page is published in. Returns {ok:true}.", { documentId: z.string().nullable().describe("documentId of a page in this site, or null to clear.") },
  async ({ documentId }) => { await setStartPage(db, ctx(), documentId); await mcpAudit("site.start_page", documentId); return { ok: true }; });

/* ------------------------------- redirects ------------------------------ */
const REDIRECT_STATUS_ARG = z.union([z.literal(301), z.literal(302), z.literal(307), z.literal(308), z.literal(410)]).describe("301 permanent (default), 302/307 temporary, 308 permanent, 410 gone (no target).");
const REDIRECT_SOURCE_ARG = z.string().describe("Old path ('/old-page'), prefix ('/blog/*') or full URL on the old site.");
const REDIRECT_TARGET_ARG = z.string().nullable().optional().describe("Destination path or https:// URL. Use this OR targetDocumentId.");
const REDIRECT_TARGET_DOC_ARG = z.string().nullable().optional().describe("documentId of the destination page; the rule follows it if it moves. Use this OR target.");
const REDIRECT_TARGET_LOCALE_ARG = z.string().nullable().optional().describe("Locale of targetDocumentId to send visitors to. Omit for the site default.");
const REDIRECT_KEEP_QUERY_ARG = z.boolean().optional().describe("Carry the request's query string over to the target.");
const REDIRECT_NOTE_ARG = z.string().nullable().optional().describe("Free-text note for editors, e.g. 'old WordPress URL'.");
tool(
  "list_redirects",
  "List the site's redirect rules with each target's live URL, hit counts and problems (target-missing, target-unpublished, shadowed, chain, loop). Rules apply on the frontend ONLY where no published page answers the path. Pass targetDocumentId to see which old URLs point at one page.",
  { targetDocumentId: z.string().optional().describe("Only rules pointing at this page (documentId). Omit for all rules.") },
  ({ targetDocumentId }) => listRedirects(db, ctx(), { targetDocumentId }),
);
tool(
  "create_redirect",
  "Create a redirect rule. source: a path (\"/old-page\"), a prefix (\"/blog/*\" — the rest of the path is carried over) or a full URL on the old site (reduced to its path). Target: EITHER targetDocumentId (+ optional targetLocale) to follow a page wherever it moves, OR target = a path or https:// URL — a path that names a published page is stored as that page. status: 301 (default, permanent — passes link equity), 302/307 temporary, 308 permanent, 410 gone (no target). A target that is itself redirected is collapsed to the final destination; loops are refused. Publishing a new slug or moving a page creates 301s automatically — check list_redirects before adding one by hand.",
  { source: REDIRECT_SOURCE_ARG, target: REDIRECT_TARGET_ARG, targetDocumentId: REDIRECT_TARGET_DOC_ARG, targetLocale: REDIRECT_TARGET_LOCALE_ARG, status: REDIRECT_STATUS_ARG.optional(), keepQuery: REDIRECT_KEEP_QUERY_ARG, note: REDIRECT_NOTE_ARG },
  async (a) => { const r = await createRedirect(db, ctx(), a); await mcpAudit("redirect.create", null, null, { id: r.redirect.id, source: r.redirect.source }); return r; },
);
tool(
  "update_redirect",
  "Update a redirect rule by id (from list_redirects). Same fields and rules as create_redirect; omitted fields are unchanged.",
  { id: z.number().int().describe("The rule's id from list_redirects."), source: REDIRECT_SOURCE_ARG.optional(), target: REDIRECT_TARGET_ARG, targetDocumentId: REDIRECT_TARGET_DOC_ARG, targetLocale: REDIRECT_TARGET_LOCALE_ARG, status: REDIRECT_STATUS_ARG.optional(), keepQuery: REDIRECT_KEEP_QUERY_ARG, note: REDIRECT_NOTE_ARG },
  async ({ id, ...patch }) => { const r = await updateRedirect(db, ctx(), id, patch); await mcpAudit("redirect.update", null, null, { id }); return r; },
);
tool("delete_redirects", "Permanently delete redirect rules by id. The old URLs then answer 404 (or reach a page now published there) — check list_not_found afterwards. Returns {deleted: <count>}.", { ids: z.array(z.number().int()).min(1).describe("Rule ids from list_redirects.") },
  async ({ ids }) => { const deleted = await deleteRedirects(db, ctx(), ids); await mcpAudit("redirect.delete", null, null, { ids, deleted }); return { deleted }; });
tool(
  "test_redirect",
  "Follow a URL the way a visitor would: a published page answers first, then the rules, hop by hop. Returns each step (page, redirect, gone, external, not-found, loop) and the hop count. Use it to verify a migration: every old URL should end on a page in one hop.",
  { url: z.string().describe("A path ('/old-page?x=1') or full URL on this site.") },
  ({ url }) => testRedirect(db, ctx(), url),
);
tool(
  "list_not_found",
  "Paths that answered 404 on the frontend, most hits first (path only — no query string). coveredBy is the id of a rule that now answers the path. Create a redirect for the ones with real traffic.",
  {},
  () => listNotFound(db, ctx()),
);

/* ---------------------------- platform admin --------------------------- */
tool("list_users", "List every CMS user account (instance-wide): id, email, name, roles, section scopes, locked flag and createdAt. Requires the user.manage permission (Admin).", {}, () => listUsers(db, ctx()));
const ROLES_ARG = z.array(RoleName).describe("Admin = everything; Editor = all content + publish + form submissions; Author = write content within its sections; Viewer = read-only.");
const SECTIONS_ARG = z.array(z.string()).optional().describe("documentIds of top-level pages this user is limited to (its subtree). Omit or [] for the whole site.");
tool("create_user", "Create a CMS user account that signs in to the admin with this email and password (instance-wide, all sites). Admin only; needs a token not limited to one site. Returns {id}. Share the password with the person out of band; they can change it and enable 2FA themselves.", { email: z.string().email().describe("Sign-in email address; must be unique."), name: z.string().describe("Display name, e.g. 'Kari Nordmann'."), password: z.string().min(10).describe("Initial password, at least 10 characters."), roles: ROLES_ARG.min(1), sections: SECTIONS_ARG },
  async (a) => { requireCrossSiteToken("User management"); const id = await adminCreateUser(db, ctx(), a); await mcpAudit("user.create", null, null, { email: a.email, roles: a.roles }); return { id }; });
tool("update_user", "Change a user's name, roles and/or section scopes (Admin only). Omitted fields are kept; roles and sections REPLACE the current lists. Changes apply from the user's next request. Returns {ok:true}.", { id: z.string().describe("The user's id from list_users."), name: z.string().optional().describe("New display name."), roles: ROLES_ARG.optional(), sections: SECTIONS_ARG },
  async ({ id, ...rest }) => { requireCrossSiteToken("User management"); await adminUpdateUser(db, ctx(), id, rest); await mcpAudit("user.update", null, null, { id }); return { ok: true }; });
tool("delete_user", "Permanently delete a user account (Admin only): they can no longer sign in and their browser sessions end. Content they wrote stays. You cannot delete yourself or the last Admin. Irreversible. Returns {ok:true}.", { id: z.string().describe("The user's id from list_users.") },
  async ({ id }) => { requireCrossSiteToken("User management"); await adminDeleteUser(db, ctx(), id); await mcpAudit("user.delete", null, null, { id }); return { ok: true }; });
tool("list_delivery_keys", "List this site's Delivery API keys — the credentials a website uses to read content: id, name, type (public | preview) and timestamps. Secrets are never shown again after creation. Admin only.", {}, () => listDeliveryKeys(db, ctx()));
tool("create_delivery_key", "Mint a Delivery API key for this site (Admin only). A public key reads published content only — safe for a website build; a preview key also reads drafts, so keep it server-side. The secret is returned ONCE in this response; store it now.", { name: z.string().describe("Label for where it is used, e.g. 'Astro site production'."), type: z.enum(["public", "preview"]).describe("public = published only; preview = drafts too.") },
  async ({ name, type }) => { const r = await createDeliveryKey(db, ctx(), name, type); await mcpAudit("deliverykey.create", null, null, { name, type }); return r; });
tool("rename_delivery_key", "Change a Delivery API key's label (Admin only). The secret and its access are unchanged. Returns {ok:true}.", { id: z.number().describe("The key's id from list_delivery_keys."), name: z.string().min(1).describe("The new label.") },
  async ({ id, name }) => { await renameDeliveryKey(db, ctx(), id, name); await mcpAudit("deliverykey.rename", null, null, { id, name }); return { ok: true }; });
tool("revoke_delivery_key", "Revoke a Delivery API key (Admin only): every request using it is refused from now on, so a website still using it stops getting content. Irreversible — mint a new key with create_delivery_key. Returns {ok:true}.", { id: z.number().describe("The key's id from list_delivery_keys.") },
  async ({ id }) => { await revokeDeliveryKey(db, ctx(), id); await mcpAudit("deliverykey.revoke", null, null, { id }); return { ok: true }; });
tool("list_webhooks", "List this site's outbound webhooks: id, name, target url, subscribed events and status. Secrets are not shown. Admin only.", {}, () => listWebhooks(db, ctx()));
tool("create_webhook", "Subscribe a URL to this site's events (Admin only): Paperboy POSTs a JSON payload signed with HMAC-SHA256 on each event, e.g. to trigger a static-site rebuild. Private-network URLs are refused. The signing secret is returned ONCE; store it to verify deliveries.", { name: z.string().describe("Label, e.g. 'Netlify rebuild'."), url: z.string().describe("Public https:// endpoint to POST to."), events: z.array(z.string()).optional().describe("Events to send: content.published, content.unpublished, form.submitted. Omit or [] for all.") },
  async (a) => { const r = await createWebhook(db, ctx(), a); await mcpAudit("webhook.create", null, null, { name: a.name }); return r; });
tool("delete_webhook", "Permanently delete a webhook (Admin only); no further events are sent to its URL. Returns {ok:true}.", { id: z.number().describe("The webhook's id from list_webhooks.") },
  async ({ id }) => { await deleteWebhook(db, ctx(), id); await mcpAudit("webhook.delete", null, null, { id }); return { ok: true }; });
tool("list_audit", "Read the append-only audit log, newest first: who did what (create, publish, delete, login, export…), when, to which document, from which surface (ip 'mcp' = agent). Use it to find out who changed something. Requires audit.read and a token not limited to one site.",
  {
    limit: z.number().optional().describe("Rows to return, 1-500 (default 100)."),
    before: z.number().optional().describe("Paging cursor: the id of the oldest row you already have."),
    action: z.string().optional().describe("Action prefix, e.g. 'content.' (a whole category) or 'content.publish'."),
    actorUserId: z.string().optional().describe("Only actions by this user id (from list_users)."),
    documentId: z.string().optional().describe("Only actions on this document."),
    from: z.string().optional().describe("Earliest time, ISO 8601, e.g. '2026-10-01T00:00:00Z'."),
    to: z.string().optional().describe("Latest time, ISO 8601."),
  },
  (a) => { requireCrossSiteToken("The audit log"); return listAudit(db, ctx(), a); });
tool("list_locales", "List the enabled locales (language branches), in order, with which one is the default. Each content item has one variant per locale; pass these codes as `locale` to other tools so text lands in the branch matching its language.", {}, async () => { need("content.read"); return listLocales(db); });

/* ---------------------------------- AI --------------------------------- */
tool("ai_assist", "Run the CMS's writing assistant on a piece of text and return the result — it does NOT save anything; write the output yourself with set_field/update_content. Uses the model configured in Settings → AI (Anthropic or OpenAI-compatible). Without a configured model only meta_title, meta_description and summarize work (a basic truncation); the other tasks return an error saying so. Image alt text is not available here (it needs the image itself): write it and save with update_asset_alt.",
  {
    task: z.enum(AI_TASKS).describe("meta_title / meta_description = SEO text from the input; summarize; improve = polish grammar and flow; rewrite; variants = 3 alternatives as a JSON array; translate (needs targetLocale); write = 2-4 paragraphs about the topic in input; schema_fields = suggested fields for the schema.org @type named in input; alt_text is refused (see above)."),
    input: z.string().min(1).describe("The text to work on (or, for write, the topic/brief)."),
    targetLocale: z.string().optional().describe("Locale code of the output language, e.g. 'nb'. Required for translate; for improve/rewrite/variants it overrides 'same language as the input'."),
  },
  async (a) => { need("content.update"); return aiAssist(a, await resolveAiRuntimeConfig(db, AI_ENV)); });

/* --------------------------------- boot -------------------------------- */
/**
 * Resolve PAPERBOY_SITE (a site id or slug) to a site id. Unset → undefined,
 * which leaves getAccessContext on the Default site. A miss is fatal rather
 * than a silent fall back to Default: booting into the wrong site is exactly
 * the failure this exists to prevent.
 */
async function resolveActiveSiteId(): Promise<string | undefined> {
  if (!PAPERBOY_SITE) return bootTokenSiteId ?? undefined;
  const found = (await getSiteById(db, PAPERBOY_SITE)) ?? (await getSiteBySlug(db, PAPERBOY_SITE));
  if (found && bootTokenSiteId && found.id !== bootTokenSiteId) {
    // Fail loudly rather than quietly narrowing: the operator asked for a site
    // this credential cannot reach, and booting into a different one would look
    // like the config took effect.
    console.error(
      `[paperboy-mcp] PAPERBOY_SITE "${PAPERBOY_SITE}" conflicts with this token, which is scoped to site ${bootTokenSiteId}.`,
    );
    process.exit(1);
  }
  if (found) return found.id;
  // Self-teaching (agent-API rule #2): name what exists, so this is fixable
  // from the message alone without going to the database for slugs.
  const known = (await db.select({ id: schemaTables.site.id, slug: schemaTables.site.slug }).from(schemaTables.site))
    .map((x) => `${x.slug} (${x.id})`)
    .join(", ");
  console.error(
    `[paperboy-mcp] PAPERBOY_SITE "${PAPERBOY_SITE}" is not a site in this instance. Set it to one of these slugs or ids: ${known || "none"}`,
  );
  process.exit(1);
}

/**
 * This server as an OAuth protected resource (RFC 9728): a 401 names where the
 * resource metadata lives, which is how an MCP client finds the authorization
 * server. The metadata is also served here — the API serves the same document
 * at the public origin, but a deployment giving /mcp its own host needs this one.
 */
function oauthResourceServer(resource: string, httpPath: string) {
  const url = new URL(resource);
  const issuer = PUBLIC_URL ?? url.origin;
  const metadataUrl = `${url.origin}/.well-known/oauth-protected-resource${url.pathname === "/" ? "" : url.pathname}`;
  return {
    challenge: `Bearer resource_metadata="${metadataUrl}"`,
    resourceMetadata: {
      paths: ["/.well-known/oauth-protected-resource", `/.well-known/oauth-protected-resource${httpPath}`, `/.well-known/oauth-protected-resource${url.pathname}`],
      body: {
        resource,
        authorization_servers: [issuer],
        bearer_methods_supported: ["header"],
        scopes_supported: ["mcp"],
        resource_name: "Paperboy MCP",
      },
    },
  };
}

async function main(): Promise<void> {
  // Prefer a Paperboy-issued MCP token (Settings → MCP); fall back to
  // email+password. With OAuth in HTTP mode there may be neither: the process
  // then has no identity of its own, and every request brings its user.
  let userId: string | null = null;
  if (MCP_TOKEN) {
    const verified = await verifyMcpToken(db, MCP_TOKEN);
    if (!verified) {
      console.error("[paperboy-mcp] MCP_TOKEN is invalid or revoked");
      process.exit(1);
    }
    userId = verified.userId;
    bootTokenSiteId = verified.siteId;
  } else if (MCP_LOGIN) {
    userId = await verifyLogin(db, MCP_LOGIN.email, MCP_LOGIN.password);
  }
  const activeSiteId = await resolveActiveSiteId();
  // via:"mcp" — every write through this server is agent provenance: versions
  // record created_via='mcp' and drafts carry the needs-review flag.
  bootScope = userId
    ? { ctx: { ...(await getAccessContext(db, userId, activeSiteId)), via: "mcp" }, tokenSiteId: bootTokenSiteId }
    : // No process identity (OAuth only): a scope that can do nothing. Every
      // HTTP request replaces it with its own user's before any tool runs.
      { ctx: { userId: "", permissions: [], siteId: activeSiteId ?? "site_default", siteWide: false, readSiteWide: false, sections: [], via: "mcp" }, tokenSiteId: null };
  console.error(
    userId
      ? `[paperboy-mcp] authenticated (${userId}) via ${MCP_TOKEN ? "token" : "password"} — ${ctx().permissions.length} permissions, site ${ctx().siteId}`
      : `[paperboy-mcp] no process identity — every request signs in with OAuth (${MCP_PUBLIC_URL})`,
  );

  if (MCP_HTTP_PORT) {
    // HTTP mode is a remote, multi-request surface — it must be gated: by
    // OAuth, or by minted tokens (MCP_TOKEN proves the operator configured one).
    if (!MCP_TOKEN && !OAUTH) {
      console.error("[paperboy-mcp] MCP_HTTP_PORT requires MCP_TOKEN (used as the Bearer credential), or PUBLIC_URL for OAuth sign-in");
      process.exit(1);
    }
    // One transport+server per MCP session. The client gets a session id on
    // `initialize` and replays it via the `mcp-session-id` header; that's what
    // carries the protocol's init state across separate requests.
    const sessions = new Map<string, StreamableHTTPServerTransport>();
    // Idle/over-cap session reaper. onclose only fires on an explicit client
    // DELETE, so a crashed client would otherwise leak its transport forever.
    const lastSeen = new Map<string, number>();
    const SESSION_IDLE_MS = 30 * 60_000;
    const MAX_SESSIONS = 256;
    const reaper = setInterval(() => {
      const closed = sweepIdleSessions(sessions, lastSeen, Date.now(), SESSION_IDLE_MS, MAX_SESSIONS);
      if (closed) console.error(`[paperboy-mcp] reaped ${closed} idle/over-cap session(s)`);
    }, 5 * 60_000);
    if (typeof reaper.unref === "function") reaper.unref();
    const handle = makeMcpHttpHandler({
      httpPath: MCP_HTTP_PATH,
      authorize: async (req) => {
        const check = await bearerOk(req, userId);
        if (!check.ok) return null;
        // Roles/scopes are re-resolved per request so demoting the user or
        // narrowing its sections applies live, not at the next restart. It lands
        // in THIS request's scope, never a module variable, so requests from
        // different users and sites can be in flight at once without trading reach.
        const store = scope.getStore();
        if (store) {
          store.tokenSiteId = check.siteId;
          store.ctx = { ...(await getAccessContext(db, check.userId, check.siteId ?? activeSiteId)), via: "mcp" };
        }
        return check.userId;
      },
      ...(OAUTH ? oauthResourceServer(MCP_PUBLIC_URL!, MCP_HTTP_PATH) : {}),
      buildServer,
      sessions,
      lastSeen,
    });
    const http = createHttpServer((req, res) => {
      // Every request gets its OWN scope object, seeded from the process's and
      // then filled in by bearerOk from the token it presented. The tool call
      // downstream reads it through the same AsyncLocalStorage, so concurrent
      // requests never see each other's site.
      const store: Scope = { ...bootScope };
      // The handler contains its own try/catch; this .catch is a last-resort
      // backstop so a stray rejection can never become an unhandledRejection.
      void scope.run(store, () => handle(req, res)).catch((err) => {
        console.error("[paperboy-mcp] unhandled request error:", err);
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "internal error" }));
        }
      });
    });
    http.listen(MCP_HTTP_PORT, () => console.error(`[paperboy-mcp] ready on http :${MCP_HTTP_PORT}${MCP_HTTP_PATH}`));
  } else {
    const server = buildServer();
    await server.connect(new StdioServerTransport());
    console.error("[paperboy-mcp] ready on stdio");
  }
}
// Last-resort backstop: on this long-lived remote process a stray rejection
// must be logged and contained, never silently tear the process down.
process.on("unhandledRejection", (reason) => {
  console.error("[paperboy-mcp] unhandledRejection:", reason);
});

main().catch((err) => {
  console.error("[paperboy-mcp] fatal:", err);
  process.exit(1);
});
