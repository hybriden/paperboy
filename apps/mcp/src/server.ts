import { AsyncLocalStorage } from "node:async_hooks";
import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { HttpError, makeMcpHttpHandler, sweepIdleSessions } from "./http-handler.js";
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
  createExperiment,
  endExperiment,
  getExperiment,
  listExperiments,
  pauseExperiment,
  startExperiment,
  updateExperiment,
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
import { AI_TASKS, ContentTypeDef, type FieldDef, type Permission, ROLE_PERMISSIONS, RoleName, TYPE_TEMPLATE_EXPORT_FORMAT, TYPE_TEMPLATE_EXPORT_VERSION, aiAssist, fieldFormatHint, redactForLog } from "@paperboy/shared";
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
// stored in the CMS (Settings → AI provider) wins over these env fallbacks, and each
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
    "[paperboy-mcp] No credentials: set MCP_TOKEN (mint one in Settings → Agent access), or MCP_EMAIL and MCP_PASSWORD — or, in HTTP mode, PUBLIC_URL so clients sign in with OAuth",
  );
  process.exit(1);
}
const MCP_HTTP_PATH = process.env.MCP_HTTP_PATH ?? "/mcp";

function bearerOf(req: IncomingMessage): string | null {
  // \S+ can't overlap \s+, so a near-miss stays linear (CodeQL js/polynomial-redos).
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? "");
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
  // Settings → Agent access working until the container restarts.
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
      `This MCP token is scoped to the ${mine ? `'${mine.slug}'` : cap} site and cannot act in '${site}'. Mint a token for that site in Settings → Agent access, or one for every site.`,
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
        `Mint a token for every site in Settings → Agent access (scope: "Every site") and use that one.`,
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
  return audit(db, { siteId: ctx().siteId, actorUserId: ctx().userId, action, documentId: documentId ?? null, locale: locale ?? null, ip: "mcp", detail }).catch((err: unknown) =>
    console.error(`[paperboy-mcp] audit failed for ${action}:`, err),
  );
}

// Tool definitions are collected as registrations so a fresh McpServer can be
// built per stdio process and per stateless HTTP request. A stateless HTTP
// request needs its own server+transport to carry the MCP init handshake.
// `permission` (null = anyone signed in) decides whether the session's user
// is shown the tool at all; the wrapper also enforces it on every call.
type ToolRegistration = { name: string; permission: Permission | null; register: (server: McpServer) => void };
const registrations: ToolRegistration[] = [];

/**
 * What a session LISTS. The default is `content`: what an agent writing pages
 * needs. The rest is opt-in, per server (PAPERBOY_TOOLSETS) or per HTTP
 * connection (?toolsets=), because 64 tools in every listing — users, keys and
 * webhooks beside the page being written — made agents slower to pick the right
 * one. Roles still decide what may be CALLED; toolsets only decide what is
 * listed. Every tool is in exactly one toolset (checked as it registers).
 */
const TOOLSETS = {
  content: [
    "list_tree", "list_content", "get_content", "list_content_types", "list_sites", "list_versions",
    "create_content", "update_content", "set_field", "duplicate_content", "copy_variant", "move_content",
    "discard_draft", "restore_version", "publish_content", "unpublish_content", "trash_content", "restore_content",
    "list_assets", "upload_asset", "create_upload_link", "search_stock_images", "update_asset_alt", "delete_asset", "assist_writing",
  ],
  delivery: ["delivery_get", "delivery_list", "delivery_search"],
  schema: [
    "create_content_type", "update_content_type", "list_type_templates", "create_type_template", "update_type_template",
    "delete_type_template", "instantiate_type_template", "export_type_templates", "import_type_templates",
  ],
  redirects: ["list_redirects", "create_redirect", "update_redirect", "delete_redirect", "test_redirect", "list_not_found"],
  experiments: ["list_experiments", "get_experiment", "create_experiment", "update_experiment", "start_experiment", "pause_experiment", "end_experiment"],
  forms: ["list_forms", "list_form_submissions", "export_form_submissions", "erase_form_submissions"],
  admin: [
    "set_start_page", "list_users", "create_user", "update_user", "delete_user", "list_delivery_keys", "create_delivery_key",
    "rename_delivery_key", "revoke_delivery_key", "list_webhooks", "create_webhook", "delete_webhook", "list_audit",
  ],
} as const satisfies Record<string, readonly string[]>;
type Toolset = keyof typeof TOOLSETS;
const TOOLSET_NAMES = Object.keys(TOOLSETS) as Toolset[];
const TOOLSET_OF = new Map<string, Toolset>(TOOLSET_NAMES.flatMap((set) => TOOLSETS[set].map((name) => [name, set] as const)));

/** "content,redirects" | "all" | "" (the default) → the toolsets to list. An
 *  unknown name throws rather than falling back: a typo that silently listed
 *  the default would look like the setting worked. */
function parseToolsets(raw: string | null | undefined): Set<Toolset> {
  const names = (raw ?? "").split(",").map((n) => n.trim().toLowerCase()).filter(Boolean);
  if (names.length === 0) return new Set(["content"]);
  if (names.includes("all")) return new Set(TOOLSET_NAMES);
  const unknown = names.filter((n) => !Object.hasOwn(TOOLSETS, n));
  if (unknown.length) {
    throw new Error(`Unknown toolset ${unknown.map((n) => `"${n}"`).join(", ")}. Use a comma list of: ${TOOLSET_NAMES.join(", ")} — or all.`);
  }
  return new Set(names as Toolset[]);
}
const bootToolsets = (() => {
  try {
    return parseToolsets(process.env.PAPERBOY_TOOLSETS);
  } catch (err) {
    console.error(`[paperboy-mcp] PAPERBOY_TOOLSETS: ${(err as Error).message}`);
    process.exit(1);
  }
})();

/** Tools over data every site shares (writing content types, templates, users,
 *  the audit log, the AI config): a `site` argument would be ignored, so they
 *  don't offer one. A type's own scope is its `siteId`; listing types is per
 *  site (the shared ones plus that site's own). */
const INSTANCE_WIDE_TOOLS = new Set([
  "create_content_type", "update_content_type", "list_type_templates", "create_type_template",
  "update_type_template", "delete_type_template", "instantiate_type_template", "export_type_templates", "import_type_templates",
  "list_users", "create_user", "update_user", "delete_user", "list_audit", "assist_writing",
]);

/** Retired tool names (#121): calling one answers with what replaced it. */
const RETIRED_TOOLS: Record<string, string> = {
  list_trash: "list_trash was merged into list_content: call it with {kind: \"trash\"}.",
  list_locales: "list_locales was merged into list_sites: read its `locales` field.",
  import_stock_image: "import_stock_image was merged into upload_asset: call it with {stockImageId}.",
  delete_form_submission: "delete_form_submission was merged into erase_form_submissions: call it with {submissionId}.",
  publish: "publish was renamed to publish_content (same arguments).",
  unpublish: "unpublish was renamed to unpublish_content (same arguments).",
  ai_assist: "ai_assist was renamed to assist_writing (same arguments).",
};

const SITE_ARG = z
  .string()
  .optional()
  .describe(
    "Site slug or id to act in (multisite). Omit to use this server's default site. Call list_sites to see what exists — an empty tree or search usually means the wrong site, not missing content.",
  );

/** Writes that remove or take down data (MCP `destructiveHint`). Trash is
 *  absent on purpose: restore_content undoes it. */
const DESTRUCTIVE_TOOLS = new Set([
  "unpublish_content", "discard_draft", "copy_variant", "restore_version", "delete_asset", "erase_form_submissions",
  "delete_type_template", "delete_redirect", "delete_user", "revoke_delivery_key", "delete_webhook",
  // Ends a test for good; with apply it rewrites the page's area.
  "end_experiment",
  // Replace a whole definition or list: what the call leaves out is gone.
  "update_content_type", "update_type_template", "update_user", "import_type_templates", "instantiate_type_template",
]);
/** Writes where repeating the same call leaves the same state (MCP `idempotentHint`). */
const IDEMPOTENT_TOOLS = new Set([
  "update_content", "set_field", "move_content", "update_content_type", "update_type_template",
  "update_asset_alt", "set_start_page", "update_redirect", "update_user", "rename_delivery_key",
  "update_experiment", "start_experiment", "pause_experiment",
]);
/** Tools that reach a service outside this CMS (stock provider, AI model, arbitrary URL). */
const OPEN_WORLD_TOOLS = new Set(["search_stock_images", "upload_asset", "assist_writing"]);
const isReadOnlyTool = (name: string) => name === "assist_writing" || /^(list|get|delivery|search|test|export)_/.test(name);

function toolAnnotations(name: string): ToolAnnotations {
  const openWorldHint = OPEN_WORLD_TOOLS.has(name);
  if (isReadOnlyTool(name)) return { readOnlyHint: true, openWorldHint };
  return { readOnlyHint: false, destructiveHint: DESTRUCTIVE_TOOLS.has(name), idempotentHint: IDEMPOTENT_TOOLS.has(name), openWorldHint };
}

function tool<S extends z.ZodRawShape>(
  name: string,
  permission: Permission | null,
  description: string,
  shape: S,
  run: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
): void {
  if (!TOOLSET_OF.has(name)) throw new Error(`MCP tool ${name} is in no toolset: add it to TOOLSETS in apps/mcp/src/server.ts`);
  registrations.push({ name, permission, register: (server) => {
    const cb = async (raw: z.infer<z.ZodObject<S>> & { site?: string }) => {
      try {
        // `site` is ours, not the handler's: strip it before the args reach a
        // data-layer schema that would reject the unknown key.
        const { site, ...args } = (raw ?? {}) as { site?: string };
        const result = await scope.run(
          site ? { ...cur(), ctx: await ctxForSite(site) } : cur(),
          () => {
            // Roles are re-resolved per request, so a session listed this tool
            // under permissions its user may since have lost.
            if (permission) need(permission);
            return run(args as z.infer<z.ZodObject<S>>);
          },
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
    // Multisite: every per-site tool takes an optional `site`, so one server reaches
    // every site in the instance. Omitted, it acts in PAPERBOY_SITE (else the Default).
    const inputSchema = INSTANCE_WIDE_TOOLS.has(name) ? shape : { ...shape, site: SITE_ARG };
    server.registerTool(name, { description: withPermission(description, permission), inputSchema, annotations: toolAnnotations(name) }, cb as never);
  } });
}

/** State the permission a tool needs, from the same declaration that enforces
 *  it, so a description can never claim a different gate than the server applies. */
function withPermission(description: string, permission: Permission | null): string {
  if (!permission || description.includes(permission)) return description;
  const roles = RoleName.options.filter((role) => ROLE_PERMISSIONS[role].includes(permission));
  // An Author's content permissions stop at its sections (deny-by-default in the query layer).
  const scoped = roles.includes("Author") && permission.startsWith("content.") ? " — an Author only within their own sections" : "";
  return `${description} Requires the ${permission} permission (${roles.join(", ")}${scoped}).`;
}

const toolsetList =(sets: Iterable<Toolset>) => TOOLSET_NAMES.filter((n) => new Set(sets).has(n)).join(",");

/** Build a server listing the tools of `toolsets` that the current user's role
 *  can call: an Author never sees user, key, webhook or audit tools it would be
 *  refused, and a content-only session doesn't see the admin ones. */
function buildServer(toolsets: ReadonlySet<Toolset> = bootToolsets): McpServer {
  const others = TOOLSET_NAMES.filter((n) => !toolsets.has(n));
  const server = new McpServer(
    { name: "paperboy", version: "0.1.0" },
    {
      instructions:
        `Paperboy CMS. Listing the ${toolsetList(toolsets)} toolset(s).` +
        (others.length ? ` Also available: ${others.join(", ")} (set PAPERBOY_TOOLSETS on the server or ?toolsets= on the MCP URL, e.g. ?toolsets=${toolsetList(toolsets)},${others[0]}; "all" lists everything).` : ""),
    },
  );
  const granted = new Set(ctx().permissions);
  const unlisted = new Map<string, string>(Object.entries(RETIRED_TOOLS));
  for (const { name, permission, register } of registrations) {
    if (permission && !granted.has(permission)) continue;
    const set = TOOLSET_OF.get(name)!;
    if (toolsets.has(set)) {
      register(server);
    } else {
      const wanted = toolsetList([...toolsets, set]);
      unlisted.set(name, `${name} is in the "${set}" toolset, which this connection doesn't list. Enable it with PAPERBOY_TOOLSETS=${wanted} on the server, or ?toolsets=${wanted} on the MCP URL.`);
    }
  }
  answerUnlistedTools(server, unlisted);
  return server;
}

/**
 * A call to a tool this session doesn't list answers with how to reach it (rule
 * #2) instead of the SDK's bare "Tool X not found". The SDK has no hook for
 * that, so this wraps its tools/call handler; mcp-toolsets.test.ts pins the
 * behaviour, so an SDK upgrade that moves the handler fails there, not silently.
 */
function answerUnlistedTools(server: McpServer, unlisted: ReadonlyMap<string, string>): void {
  type Handler = (request: { params?: { name?: string } }, extra: unknown) => Promise<unknown>;
  const handlers = (server.server as unknown as { _requestHandlers: Map<string, Handler> })._requestHandlers;
  const inner = handlers.get("tools/call");
  if (!inner) return; // no tool registered at all: there is no tools/call to answer
  handlers.set("tools/call", (request, extra) => {
    const name = request.params?.name ?? "";
    const why = unlisted.get(name);
    if (!why) return inner(request, extra);
    console.error(`[paperboy-mcp] tool ${name} refused: ${why}`);
    return Promise.resolve({ content: [{ type: "text", text: `Error: ${why}` }], isError: true });
  });
}

const loc = z.string().optional().describe("Locale code. Omit for the document's own locale (its site-default variant, else its only variant).");
const docId = z.string().describe("The item's documentId (stable across locales and versions), e.g. from list_tree, list_content or get_content.");
/** Strict ISO instant — a bare local time has no timezone and would publish at a server-dependent moment (rule 1: reject, don't guess). */
const isoInstant = (field: string) =>
  z.string().datetime({
    offset: true,
    message: `${field} must be a full ISO 8601 datetime with timezone, e.g. "2026-09-01T09:00:00Z" — a bare "2026-09-01T09:00" has no timezone and is ambiguous`,
  });

/* ------------------------------- content ------------------------------- */
tool(
  "list_tree", "content.read",
  "List ONE level of the page tree: the direct children of parentId, or the top-level pages when it is omitted, in the order the container sorts them, the whole level in one call. Returns an array of nodes, each with documentId, type, name, per-locale status and hasChildren — call list_tree again with a node's documentId to go deeper. Trashed pages are left out, and a page without children (or a parentId that matches nothing) gives [] rather than an error, so check hasChildren first. Use it to find the parentId for create_content/move_content. For every page at once use list_content {kind:'page'}; shared blocks and globals are not in the tree (list_content with kind block or global).",
  { parentId: z.string().optional().describe("documentId of the page whose children to list. Omit for the top level.") },
  ({ parentId }) => getTree(db, ctx(), parentId ?? null));
tool(
  "get_content", "content.read",
  "Read one content item for editing: its working version (the draft if one exists, else the published version) in one locale, with name, slug, status, revision and the full `data` field map. Read this before update_content so you merge into current values, and pass its `revision` when replacing with merge:false. `data` maps each field name to its value in the shape list_content_types reports (valueFormat). An unknown documentId, or one from another site, is refused as not found (pass `site` for another site); omit locale for the item's own language. This is the editing view; for the public view (published only, private fields removed) use delivery_get, in the delivery toolset.",
  { documentId: docId, locale: loc },
  async ({ documentId, locale }) => getContent(db, ctx(), documentId, await locFor(documentId, locale)));
tool(
  "create_content", "content.create",
  [
    "Create a new content item (page, block or global) as an unpublished draft, filled in ONE call:",
    "pass its fields in `data` (shapes from list_content_types {name}). Without `data` you get an",
    "empty shell that stays blank until update_content/set_field fills it.",
    "A page's position decides its URL and the template that renders it, so find the right",
    "parentId with list_tree (blog posts go under their blog page); omit it only for top-level",
    "sections. Under a list page, omit `type` to inherit the type it lists — a mismatch is refused,",
    "since the item would never appear on that list.",
    "Returns the new item in the get_content shape (documentId, locale, revision, data…), plus a",
    "`hint` when it still needs filling or placing. Then publish_content. To copy an existing item",
    "instead, use duplicate_content.",
  ].join(" "),
  {
    type: z.string().optional().describe("Content type name. Under a list-page parent, OMIT to inherit the type that page lists; a mismatch is refused unless allowTypeMismatch."),
    parentId: z.string().nullable().optional().describe("documentId of the parent page. Required in practice for pages — find it with `list_tree`. Omit only for top-level pages."),
    locale: z.string().optional().describe("The LANGUAGE BRANCH for this content — MATCH the language you are writing (Norwegian content → 'nb', English → 'en'). list_sites reports the site's branches (`locales`). Defaults to the site default locale, which is usually English."),
    name: z.string().describe("Display name of the item (also the source of a page's auto slug), e.g. 'Summer sale 2026'."),
    data: z.record(z.string(), z.unknown()).optional().describe("Initial field values (field name → value), same shapes as update_content. Provide this to create a FILLED draft in one call. Call list_content_types {name} first for the field names/shapes."),
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
          "(or set_field) to write the body and other fields now, then publish_content. Until then the page is blank.",
      );
    }
    if (created.kind === "page" && !parentId) {
      hints.push(
        "PLACEMENT: created at the TOP LEVEL — if it belongs under another page (e.g. a blog post under the blog/list page), " +
          "call `list_tree` to find the parent and move_content {documentId, parentId} BEFORE publishing; its URL and template depend on its position.",
      );
    }
    return hints.length ? { ...created, hint: hints.join(" ") } : created;
  });
tool(
  "update_content", "content.update",
  [
    "Save fields into a content item's working draft; nothing goes live until publish_content.",
    "Each value's shape follows its field type (list_content_types {name} gives valueFormat):",
    "text/markdown → string; richtext → TipTap doc {type:'doc',content:[…]}; contentArea → array",
    "of block instances; reference → {documentId}; image → asset documentId.",
    "`data` is MERGED over the draft by default, so omitted fields are kept; merge:false replaces",
    "the whole map (send every required field, and the get_content `revision` so a concurrent",
    "human edit is refused with 409 instead of overwritten).",
    "For one LONG text/markdown value use set_field: nested long strings can be mangled in transit.",
    "A value of the wrong shape is refused with the field, the expected shape and an example; text",
    "in another language than the branch is refused unless allowLanguageMismatch. An agent's edit",
    "marks the draft for review and cancels a pending scheduled publish of it.",
    "Returns the saved draft in the get_content shape, with its new revision.",
  ].join(" "),
  { documentId: docId, locale: loc, name: z.string().optional().describe("New display name. Omit to keep it."), slug: z.string().nullable().optional().describe("New URL slug for a page; publishing it adds a 301 from the old URL automatically. Omit to keep it."), displayInNav: z.boolean().optional().describe("Whether the page appears in the site navigation. Omit to keep it."), data: z.record(z.string(), z.unknown()).describe("Field name → value, shaped per the valueFormat list_content_types {name} reports. Pass {} to change only name/slug/displayInNav."), merge: z.boolean().optional().describe("Default true: shallow-merge data over the current draft. false = replace the whole field map"), revision: z.number().int().nonnegative().optional().describe("Optimistic concurrency: the `revision` from get_content. If a human (or another agent) has changed the draft since, the write is refused instead of overwriting their work. Recommended whenever merge:false"), allowLanguageMismatch: z.boolean().optional().describe("Set true ONLY to deliberately write text whose language differs from the locale branch (the guard otherwise refuses, so e.g. Norwegian text can't silently land on the 'en' branch)") },
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
  "set_field", "content.update",
  [
    "Write ONE field of an item's draft as a plain string; the other fields are kept. It is the",
    "safest way to send long text or Markdown, because a flat string survives client",
    "serialization that can mangle long strings nested in update_content's `data`.",
    "`field` is a text, markdown, select, datetime or image field from list_content_types {name}",
    "(an image takes an asset documentId), or `name` for the item's display name; `value` is the",
    "field's whole new value. For richtext, contentArea or reference fields, or several fields at",
    "once, use update_content. A value the field can't take is refused with the expected shape and",
    "an example; text in another language than the locale branch is refused unless",
    "allowLanguageMismatch. Like any agent edit, it cancels a pending scheduled publish.",
    "Returns the saved draft in the get_content shape; publish_content separately.",
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
  "publish_content", "content.publish",
  [
    "Make a content item's working draft live in one locale (a LANGUAGE BRANCH: Norwegian",
    "text published into 'en' lands on the English site, so a clear mismatch is refused).",
    "A future publishAt SCHEDULES it instead: it stays invisible until then; call again with a",
    "new publishAt to reschedule, or without one to go live now. expireAt unpublishes it",
    "automatically later. Never fake a schedule with a date field — that publishes now.",
    "A changed slug or position gets a 301 from the old URL. Fires content.published.",
    "Refused when there is nothing new to publish, when required fields are empty (the error",
    "names them), or, if the site requires human review of agent drafts, until an editor approves",
    "it. Returns the item in the get_content shape with its new status.",
    "To take it down use unpublish_content; to drop unpublished edits, discard_draft.",
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
  "copy_variant", "content.update",
  [
    "Copy a document's working version (name, slug and EVERY field) from one locale",
    "to another, server-side and atomically. USE THIS to move content that landed in",
    "the wrong language branch — re-typing it field by field loses fields.",
    "It REPLACES the target locale's draft (its unpublished edits are lost; its published",
    "version stays live until you publish_content the copy). The text is copied as-is: to",
    "translate it afterwards, run assist_writing {task:'translate'} and save with set_field.",
    "Returns the target locale's new draft in the get_content shape. To copy into a NEW",
    "item instead, use duplicate_content.",
  ].join(" "),
  { documentId: docId, fromLocale: z.string().describe("Locale to copy FROM, e.g. 'en' (list_sites → locales)."), toLocale: z.string().describe("Locale to copy TO; must differ from fromLocale.") },
  async ({ documentId, fromLocale, toLocale }) => {
    const copied = await copyVariant(db, ctx(), documentId, fromLocale, toLocale);
    await mcpAudit("content.copy_variant", documentId, toLocale, { fromLocale });
    return copied;
  });
tool(
  "unpublish_content", "content.publish",
  "Take a content item off the live site in one locale: delivery stops serving it there (its URL starts answering 404) and content areas that reference it drop it. Fires the content.unpublished webhook. The content and its version history are kept, so publish_content brings it back. Name the item by documentId and the branch by locale (omit it for the item's own language); other locales are unaffected. Returns the item in the get_content shape, now unpublished in that locale. To remove the item entirely use trash_content.",
  { documentId: docId, locale: loc },
  async ({ documentId, locale }) => {
    const l = await locFor(documentId, locale);
    const result = await unpublishContent(db, ctx(), documentId, l);
    await mcpAudit("content.unpublish", documentId, l);
    return result;
  });
tool(
  "discard_draft", "content.update",
  "Throw away the unpublished draft changes of one item (documentId) in one locale (omitted: the item's own language), so the working version falls back to the published one. The live site is unchanged; the discarded draft cannot be recovered. Refused for content that was never published (there is nothing to fall back to) — use trash_content to remove that instead. To roll back to an older version rather than the live one, use restore_version. Returns {ok:true}.",
  { documentId: docId, locale: loc },
  async ({ documentId, locale }) => { const l = await locFor(documentId, locale); await discardDraft(db, ctx(), documentId, l); await mcpAudit("content.discard_draft", documentId, l); return { ok: true }; });
tool(
  "move_content", "content.update",
  "Move a page in the page tree: parentId re-parents it (its URL path follows its new position, and the old URL gets a 301 automatically), beforeId/afterId place it among its siblings. Its whole subtree moves with it. Refused when the new parent is the page itself, is not a page, or lies outside your sections. Sibling order only sticks under a parent with a manual child sort; a computed sort (name, date…) re-orders it. Returns {ok:true}. To change only the URL's last segment, set a new slug with update_content instead; blocks and globals are not in the tree.",
  {
    documentId: docId,
    parentId: z.string().nullable().optional().describe("documentId of the new parent page; null moves it to the top level. Omit to keep the current parent."),
    beforeId: z.string().nullable().optional().describe("Place it directly before this sibling (documentId)."),
    afterId: z.string().nullable().optional().describe("Place it directly after this sibling (documentId)."),
  },
  async ({ documentId, parentId, beforeId, afterId }) => { await moveContent(db, ctx(), documentId, { parentId, beforeId, afterId }); await mcpAudit("content.move", documentId); return { ok: true }; });
tool(
  "duplicate_content", "content.create",
  "Copy a content item into a NEW unpublished document beside the original (same parent), named \"<name> (copy)\", with every field of each locale's working version. A copied page gets a fresh slug, so it never collides with the original's URL. Children are not copied. locale only picks which language of the copy comes back. Returns the new item in the get_content shape; edit it, then publish_content. To copy one language into another locale of the SAME item use copy_variant; to start from nothing use create_content.",
  { documentId: docId, locale: z.string().optional().describe("Which locale of the copy to return in the result. Every locale is copied regardless. Omit for the document's own locale.") },
  async ({ documentId, locale }) => {
    const copy = await cloneContent(db, ctx(), documentId, await locFor(documentId, locale));
    await mcpAudit("content.duplicate", copy.documentId, copy.locale, { source: documentId });
    return copy;
  });
tool(
  "trash_content", "content.delete",
  "Move a content item (by documentId) AND its whole page subtree to the trash: every locale is unpublished at once and disappears from delivery, so there is no locale to pass. Recoverable — restore_content brings it back (as drafts; publish again explicitly). An unknown documentId is refused as not found. Returns {trashed: <number of items>}. To only take it off the live site, use unpublish_content instead.",
  { documentId: docId },
  async ({ documentId }) => { const r = await softDelete(db, ctx(), documentId); await mcpAudit("content.trash", documentId); return r; });
tool(
  "restore_content", "content.delete",
  "Bring a trashed item back to its old place in the tree, together with the descendants that were trashed with it. Restored content is NOT republished — call publish_content for each locale that should go live. Refused if its parent is still in the trash (restore that first) or a live sibling took its URL meanwhile. There is no locale to pass: every language comes back. Returns {restored: <count>}. Find trashed ids with list_content {kind:'trash'}. To roll back an item that is not trashed, use restore_version instead.",
  { documentId: docId },
  async ({ documentId }) => { const r = await restoreContent(db, ctx(), documentId); await mcpAudit("content.restore", documentId); return r; });
tool(
  "list_versions", "content.read",
  "List a content item's version history in one locale, newest first and complete (no paging); locale picks the language branch (omitted: the item's own). Each version's id, versionNumber, status, whether it is the live one, name, and who created it when. An unknown documentId is refused as not found. Use it to find what to roll back to — pass a version's `id` (not its versionNumber) to restore_version. For the current draft itself, use get_content.",
  { documentId: docId, locale: loc },
  async ({ documentId, locale }) => listVersions(db, ctx(), documentId, await locFor(documentId, locale)));
tool(
  "restore_version", "content.update",
  "Roll back an item to an older version: copy that version's name, slug and fields into the working draft of one locale. versionId is the version's `id` from list_versions of the SAME locale, not its versionNumber. It REPLACES the current draft of that locale, so unpublished edits there are lost; published versions stay in the history (a rollback can itself be rolled back), and nothing goes live until you publish_content. Returns the new draft in the get_content shape. To bring back a TRASHED item use restore_content; to simply drop unpublished edits use discard_draft.",
  { documentId: docId, locale: loc, versionId: z.number().describe("The version's `id` from list_versions (not its versionNumber).") },
  async ({ documentId, locale, versionId }) => {
    const l = await locFor(documentId, locale);
    const restored = await restoreVersion(db, ctx(), documentId, l, versionId);
    await mcpAudit("content.version_restore", documentId, l, { versionId });
    return restored;
  });
tool(
  "list_content", "content.read",
  "List EVERY item of one kind in this site that you can see, as one flat array (documentId, name, type, per-locale status, plus parentId for pages and folderId for blocks) — no tree walking needed. " +
    "kind 'page': pages, to find one by name or pick a parent/reference target (list_tree shows one level in display order). " +
    "kind 'block': SHARED blocks — reusable block documents (banners, forms, CTAs…) that pages place by reference, so one edit updates every page using them; inline blocks live inside a page's data and are not listed. " +
    "kind 'global': singletons (header, footer, site settings…), which are neither in the page tree nor blocks, so this is the only way to enumerate them. " +
    "kind 'trash': items removed with trash_content (any kind), newest first, with deletedAt; nothing is purged automatically, and restore_content brings one back. " +
    "Everything comes back in one call (no paging). Edit any of them with get_content/update_content on its documentId.",
  { kind: z.enum(["page", "block", "global", "trash"]).describe("Which kind of content to list: page, block, global, or trash (what trash_content removed).") },
  ({ kind }) =>
    kind === "page" ? listPages(db, ctx()) : kind === "block" ? listBlocks(db, ctx()) : kind === "global" ? listGlobals(db, ctx()) : listTrash(db, ctx()));

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
  "list_content_types", "content.read",
  "Read the content model of a site: the types every site shares plus the site's own (`siteId` null = shared). Pass name to get ONE type's definition — name, kind, displayName, schemaType and fields (name, type, required, options, allowed blocks of a content area…); an unknown name is refused with the list of real names. Call this before writing content of a type. " +
    "Each field carries valueFormat + valueExample: the exact JSON shape create_content/update_content expect. These are LIVE types editors fill in; reusable type recipes (templates) live in the schema toolset. Omit name to get every full definition, which is large, so prefer name.",
  { name: z.string().optional().describe("Content type name, PascalCase, e.g. 'BlogPost' (as in a content item's `type`). Omit to list all.") },
  async ({ name }) => {
    return name === undefined ? (await listContentTypes(db, ctx().siteId)).map(withFieldFormats) : withFieldFormats(await getContentType(db, name, ctx().siteId));
  });
tool(
  "create_content_type", "contenttype.manage",
  "Create a new content type (the schema editors fill in) from a full ContentTypeDef. Set definition.siteId to a site id (see list_sites) for a type only that site uses, or leave it out/null to share it with every site. Names are unique across every site, and designing types needs a token not limited to one site. Faster for common shapes: list_type_templates + instantiate_type_template. The definition is validated and a bad one is refused with the offending path; an existing name is refused (409) — change that type with update_content_type. Returns the stored definition.",
  { definition: z.record(z.string(), z.unknown()).describe("A ContentTypeDef: {name: 'PascalCase', kind: 'page'|'block'|'global', fields: [{name, type, …}], …}. Copy the shape of an existing one from list_content_types {name}.") },
  async ({ definition }) => { requireCrossSiteToken("Content-type design"); const def = ContentTypeDef.parse(withoutFieldFormats(definition)); const r = await createContentType(db, ctx(), def); await mcpAudit("contenttype.create", null, null, { name: def.name, kind: def.kind }); return r; });
tool(
  "update_content_type", "contenttype.manage",
  "Replace a content type's definition (add/remove/rename fields, change options). name and kind are immutable. Send the FULL definition — read it with list_content_types {name}, edit, send back; a field you leave out is removed from the schema. Existing content is not migrated: its stored values for removed fields are simply no longer shown or delivered. siteId binds the type to one site (null = shared, omitted = unchanged); binding is refused while another site holds content of it. Needs contenttype.manage and a token for every site. Returns the new definition. To add a type instead, create_content_type.",
  { name: z.string().describe("The existing type's name, e.g. 'BlogPost'."), definition: z.record(z.string(), z.unknown()).describe("The full updated ContentTypeDef (same shape list_content_types {name} returns; its valueFormat/valueExample annotations are ignored).") },
  async ({ name, definition }) => { requireCrossSiteToken("Content-type design"); const r = await updateContentType(db, ctx(), name, ContentTypeDef.parse(withoutFieldFormats(definition))); await mcpAudit("contenttype.update", null, null, { name }); return r.next; });

/* --------------------- content-type template collection ------------------ */
// Named, reusable ContentTypeDef recipes: save a type as a template, then
// instantiate it back into a real content type (optionally under a new name).
tool(
  "list_type_templates", "content.read",
  "Read the type-template library — named ContentTypeDef RECIPES, not live types: the BUILT-IN starters that ship with Paperboy (read-only) plus stored templates. Pass name to get one template's full definition (to inspect before instantiate_type_template, or as a starting point for create_content_type); omit it to get every template's full definition (large). " +
    "Each field carries valueFormat + valueExample. A template's name is the content type name it materialises by default. For the types editors fill in today, see list_content_types.",
  { name: z.string().optional().describe("Template name, e.g. 'FaqPage'. Omit to list all.") },
  async ({ name }) => (name === undefined ? (await listTypeTemplates(db)).map(withFieldFormats) : withFieldFormats(await getTypeTemplate(db, name))));
tool("create_type_template", "contenttype.manage", "Save a ContentTypeDef as a reusable TEMPLATE in the library — a recipe, not a live type: nothing becomes editable until instantiate_type_template turns it into a content type. Use it to keep a starter/backup of a type or to move it to another instance via export_type_templates; to create a type editors can use right now, call create_content_type instead. The template's name is the type name it materialises by default and must not clash with an existing or built-in template. Instance-wide: requires contenttype.manage and a token for every site. Returns the stored template.", { definition: z.record(z.string(), z.unknown()).describe("Full ContentTypeDef, same shape as create_content_type") },
  async ({ definition }) => { requireCrossSiteToken("The type-template library"); const def = ContentTypeDef.parse(withoutFieldFormats(definition)); const r = await createTypeTemplate(db, ctx(), def); await mcpAudit("type_template.create", null, null, { name: def.name, kind: def.kind }); return r; });
tool(
  "update_type_template", "contenttype.manage",
  "Replace a stored type template's definition (name and kind are immutable; built-in templates are read-only — copy one under a new name with create_type_template instead). Content types already instantiated from it are NOT changed; re-apply with instantiate_type_template {updateExisting:true}. Requires contenttype.manage and a token for every site. Returns the new definition.",
  { name: z.string().describe("The stored template's name."), definition: z.record(z.string(), z.unknown()).describe("The full updated ContentTypeDef (same shape as create_content_type).") },
  async ({ name, definition }) => { requireCrossSiteToken("The type-template library"); const def = ContentTypeDef.parse(withoutFieldFormats(definition)); const r = await updateTypeTemplate(db, ctx(), name, def); await mcpAudit("type_template.update", null, null, { name }); return r.next; });
tool(
  "delete_type_template", "contenttype.manage",
  "Permanently delete a stored type template from the library (built-ins can't be deleted). Content types instantiated from it, and their content, are NOT affected — so this only tidies the library; to change or retire a type editors use, edit the type itself with update_content_type. To keep a copy first, export_type_templates {names:[name]}. Returns {ok:true}.",
  { name: z.string().describe("The stored template's name.") },
  async ({ name }) => { requireCrossSiteToken("The type-template library"); await deleteTypeTemplate(db, ctx(), name); await mcpAudit("type_template.delete", null, null, { name }); return { ok: true }; });
tool(
  "instantiate_type_template", "contenttype.manage",
  "Materialise a type template into a real content type. Default: creates the type under the template's own name. " +
    "If that type already exists the call is REFUSED (409) — pass updateExisting: true to re-apply the template onto the existing type (kind must match; existing content is not migrated), " +
    "or asName: \"OtherName\" to create a type with a DIFFERENT name (must match ^[A-Z][a-zA-Z0-9]*$, e.g. \"CaseStudy\"). " +
    "Pass withBlocks: true to ALSO create the block types the template's content areas reference (recursively; existing types are left untouched) — recommended for built-ins like FaqPage so the set works out of the box. " +
    "Returns {name, action: 'created' | 'updated', type, blocks?}. Browse templates with list_type_templates; to design a type from scratch use create_content_type.",
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
  "export_type_templates", "content.read",
  "Export type templates as a portable JSON document ({format, version, exportedAt, templates}) to move them to another Paperboy instance (import_type_templates there) or keep a backup. To read or inspect templates here, list_type_templates is simpler. Omit names to export everything (built-ins included). Read-only.",
  { names: z.array(z.string()).optional().describe("Template names to export (default: all)") },
  async ({ names }) => {
    const templates = await exportTypeTemplates(db, names);
    return { format: TYPE_TEMPLATE_EXPORT_FORMAT, version: TYPE_TEMPLATE_EXPORT_VERSION, exportedAt: new Date().toISOString(), templates };
  },
);
tool(
  "import_type_templates", "contenttype.manage",
  "Import type templates from the document export_type_templates produces (on this or another Paperboy instance) into the library. Per-template outcome: new names are created; existing stored templates are skipped unless overwrite: true; built-in names are always skipped (they ship with every instance). Templates are recipes: nothing becomes editable until instantiate_type_template. Requires contenttype.manage and a token for every site. Returns {created, updated, skipped:[{name, reason}]}.",
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
tool("list_forms", "submission.read", "List every form (Form block) in this site, all at once and in no set order, with formId, name, submission count and time of the last submission. Trashed forms are included, since their submissions are still stored. Start here before list_form_submissions or export_form_submissions. A form is a shared Form block: edit its questions with get_content/update_content on its formId. Submissions are visitor personal data: requires the submission.read permission (Admin/Editor).", {},
  () => listForms(db, ctx()));
tool(
  "list_form_submissions", "submission.read",
  "Read form submissions in this site. Pass submissionId to get ONE in full (answers, field-label snapshot, form, received and retention-expiry times); otherwise get a page of them, newest first. Answers keep the field labels as they were when submitted, so a later edit to the form does not rewrite history. Visitor personal data: requires submission.read. For a full copy as a file use export_form_submissions.",
  {
    submissionId: z.string().optional().describe("Return just this submission. Other filters are ignored."),
    formId: z.string().optional().describe("Limit to one form's submissions (its formId from list_forms). Omit for all forms."),
    limit: z.number().optional().describe("Page size, 1-200 (default 50)."),
    offset: z.number().optional().describe("Rows to skip, for paging (default 0)."),
  },
  ({ submissionId, formId, limit, offset }) => (submissionId ? getSubmission(db, ctx(), submissionId) : listSubmissions(db, ctx(), { formId, limit, offset })),
);
tool(
  "export_form_submissions", "submission.read",
  "Export ALL matching form submissions in one go (no paging) as CSV text, returned as {csv, rows}. Columns: Submitted at, Submission ID, Locale, then one column per field labelled as when answered (fields from older versions of the form included). Cells that a spreadsheet would run as a formula are escaped. This is a copy of visitor personal data: the export is audit-logged and requires submission.read. To read submissions as JSON, page through list_form_submissions instead.",
  { formId: z.string().optional().describe("Export only this form (formId from list_forms). Omit to export every form in the site.") },
  async ({ formId }) => {
    const res = await exportSubmissions(db, ctx(), formId);
    await mcpAudit("form.submissions_exported", formId ?? null, null, { rows: res.rows });
    return res;
  },
);
tool(
  "erase_form_submissions", "submission.manage",
  "Permanently delete form submissions, either ONE by submissionId (e.g. spam or a test entry) or, for a data-subject erasure request, EVERY submission in this site whose answers contain an email address, in any field. Pass exactly one of the two. Irreversible; audit-logged without the address; requires submission.manage. Returns {deleted: <count>} (0 when nothing matched). Copies in database backups survive until the backups rotate. To review first, use list_form_submissions.",
  {
    submissionId: z.string().optional().describe("Delete just this submission (its id from list_form_submissions)."),
    email: z.string().optional().describe("Erase every submission containing this address, matched case-insensitively across all answers."),
  },
  async ({ submissionId, email }) => {
    if (Boolean(submissionId) === Boolean(email)) {
      throw new Error('Pass exactly one of submissionId or email. Example: {"email": "kari@example.com"} to erase everything one person sent, or {"submissionId": "sub_…"} for one entry.');
    }
    if (submissionId) {
      const found = await deleteSubmission(db, ctx(), submissionId);
      await mcpAudit("form.submission_deleted", null, null, { submissionId, found });
      return { deleted: found ? 1 : 0 };
    }
    const res = await eraseSubmissionsByEmail(db, ctx(), email!);
    // The address is the subject of an erasure request — log that one happened
    // and how much it removed, never the address itself.
    await mcpAudit("form.submissions_erased", null, null, { deleted: res.deleted });
    return res;
  },
);

/* -------------------------------- media -------------------------------- */
tool(
  "list_assets", "content.read",
  "List this site's whole media library (images and PDFs), newest first, in one call (no paging, so a big library is a big response): each asset's documentId, filename, mime, size, public url, alt text, attribution for stock imports, and folder. Media is per site: pass `site` to see another site's library. An empty library gives []. Use it to reuse an existing image: an image field stores the asset's documentId, set with set_field. To add a new file use upload_asset (URL, base64 or stock photo) or create_upload_link (files on your machine).",
  {},
  () => listAssets(db, ctx()));
tool(
  "update_asset_alt", "content.update",
  "Set (overwrite) an image asset's alt text — the description screen readers announce and search engines index. Alt text belongs to the ASSET, not to a page: every page showing the image picks up the change, and set_field/update_content cannot set it. documentId is the asset's (from list_assets or an upload), not a page's; an unknown one is refused as not found. Describe what the image shows in one sentence; use \"\" only for a purely decorative image. Returns the updated asset with its new alt. assist_writing cannot write alt text (it needs the image itself), so look at the image and write it.",
  { documentId: z.string().describe("The asset's documentId from list_assets or an upload result."), alt: z.string().describe("The new alt text, e.g. 'Two hikers on a ridge above a fjord at sunset'.") },
  async ({ documentId, alt }) => { const r = await updateAssetAlt(db, ctx(), documentId, alt); await mcpAudit("asset.alt", documentId); return r; });
tool(
  "delete_asset", "content.delete",
  "Permanently delete a media asset — by the asset's documentId from list_assets, not a page's — removing the database row and the stored file. Irreversible. Content that still points at it is not blocked: delivery resolves those fields to null, so the image silently disappears from those pages — clear or replace them first. To stop using an image on one page, just clear that field with set_field and keep the asset. Returns {ok:true}.",
  { documentId: z.string().describe("The asset's documentId from list_assets.") },
  async ({ documentId }) => { await deleteAsset(db, ctx(), documentId, UPLOADS_DIR); await mcpAudit("asset.delete", documentId); return { ok: true }; });
tool(
  "search_stock_images", "content.read",
  "Search the configured stock photo provider (Settings → Stock images; Unsplash) for photos to use on a page. Returns up to 24 candidates, best match first, each with id, description and attribution; nothing is stored yet. To USE one: upload_asset {stockImageId: <its id>} imports it into the media library, then set_field the returned asset documentId on an image field. Refused with a hint when no provider key is configured. To reuse a photo you already have, list_assets.",
  { query: z.string().min(1).max(200).describe("What the photo should show, e.g. 'mountain lake sunrise'") },
  ({ query }) => searchStockImages(db, ctx(), query, UNSPLASH_ACCESS_KEY),
);
tool(
  "create_upload_link", "content.create",
  "Get a 15-minute link for uploading LOCAL files (images, PDFs) into the media library — the way to upload files on your own machine, which this server can't read. POST them as multipart/form-data with the returned header, e.g. with curl (several -F file=@… per request is fine). The response lists each stored asset's documentId: set it on an image field with set_field, and give it alt text with update_asset_alt. The link uploads as you, into this site (pass `site` to upload into another), and expires after 15 minutes. Returns {uploadUrl, headers, expiresAt, example, limits}: PNG, JPEG, GIF, WEBP or PDF, max 5 MB per file, up to 20 files per request. Refused when the server has no PUBLIC_URL configured — then use upload_asset with dataBase64. For a file at a public URL, or a stock photo, use upload_asset instead.",
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
  "upload_asset", "content.create",
  "Add a file (PNG, JPEG, GIF, WEBP or PDF, max 5 MB) to the media library from exactly one source: a public URL, base64 bytes, or a stock photo id from search_stock_images (stored with its attribution). Returns the new asset — set its documentId on an image field with set_field. Each call stores a NEW asset, even for a file already in the library (reuse one via list_assets). A URL must be publicly reachable: private-network addresses are refused at every redirect hop, and a download over 5 MB is cut off with an error. For files on YOUR machine prefer create_upload_link: base64 through a tool call costs roughly 1 token per 2-3 bytes.",
  {
    url: z.string().url().optional().describe("Public http(s) URL of the file itself (not a web page showing it)"),
    dataBase64: z.string().optional().describe("The file's bytes, base64-encoded (a data: URL prefix is accepted)"),
    stockImageId: z.string().min(1).max(200).optional().describe("A photo id from search_stock_images; the image is downloaded from the stock provider."),
    filename: z.string().max(255).optional().describe("Display name in the media library, e.g. 'hero.jpg' (url and base64 only; a stock photo is named by the provider)"),
    alt: z.string().max(300).optional().describe("Alt text (for a stock photo, defaults to the provider's description)"),
  },
  async ({ url, dataBase64, stockImageId, filename, alt }) => {
    if ([url, dataBase64, stockImageId].filter(Boolean).length !== 1) {
      throw new Error("Pass exactly one of url, dataBase64 or stockImageId. Example: {\"url\": \"https://example.com/photo.jpg\", \"alt\": \"A calculator on a desk\"}");
    }
    if (stockImageId) {
      if (filename) throw new Error("filename can't be set for a stock photo (the provider names it): send stockImageId without filename.");
      const rec = await importStockImage(db, ctx(), { providerId: stockImageId, alt }, { envKey: UNSPLASH_ACCESS_KEY, save: saveToUploadsDir(UPLOADS_DIR) });
      await mcpAudit("asset.import", rec.documentId, null, { provider: rec.sourceMeta?.provider, providerId: stockImageId, mime: rec.mime, size: rec.size });
      return rec;
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
const deliveryLocale = async (locale?: string) => locale ?? (await resolveDefaultLocale(db, ctx().siteId));
tool(
  "delivery_get", "content.read",
  "Read ONE item exactly as the website receives it from the public Delivery API — the way to check what visitors see. " +
    "Name it by exactly one of: path (a page's URL, e.g. '/blog/my-post' — the usual choice), documentId, slug, global (a singleton's type, e.g. 'SiteHeader'), or start:true (the page served at /). " +
    "Returns published content only (unless preview), private fields removed, plus computed urlPath, fieldTypes and SEO metadata on pages — or null when nothing matches. " +
    "To read a draft for editing use get_content; for many items use delivery_list or delivery_search.",
  {
    path: z.string().optional().describe("A page's URL path without the locale prefix, e.g. '/blog/my-post'."),
    documentId: z.string().optional().describe("The item's documentId."),
    slug: z.string().optional().describe("Last URL segment, e.g. 'about-us'. Unique only among siblings — prefer path."),
    global: z.string().optional().describe("Content type of a global singleton (header, footer…), e.g. 'SiteHeader'. Find them with list_content {kind:'global'}."),
    start: z.boolean().optional().describe("true = the site's start page (set with set_start_page)."),
    ...delv,
  },
  async ({ path, documentId, slug, global, start, locale, populate, preview }) => {
    const given = Object.entries({ path, documentId, slug, global, start }).filter(([, v]) => v !== undefined && v !== false);
    if (given.length !== 1) {
      throw new Error(
        `Name the item by exactly ONE of path, documentId, slug, global or start:true (got ${given.length ? given.map(([k]) => k).join(" + ") : "none"}). Example: {"path": "/blog/my-post"}`,
      );
    }
    needDelivery(preview);
    const p = persp(preview);
    const site = ctx().siteId;
    const l = await deliveryLocale(locale);
    if (path !== undefined) return deliveryGetByPath(db, p, site, path.split("/").filter(Boolean), l, populate);
    if (documentId !== undefined) return deliveryGetById(db, p, site, documentId, l, populate);
    if (slug !== undefined) return deliveryGetBySlug(db, p, site, slug, l, populate);
    if (global !== undefined) return deliveryGlobal(db, p, site, global, l);
    return deliveryStartPage(db, p, site, l, populate);
  },
);
tool(
  "delivery_list", "content.read",
  "List the published content of one type as the website receives it (e.g. every BlogPost for a listing page), to check what a frontend's list shows. Pages with limit/offset (total tells you how many exist), sorts by sort, and filters on exact data-field values; without sort it follows the parent's declared child order. Private fields are removed. Returns { items, total }. To find items by words use delivery_search; for one item, delivery_get; to edit, list_content.",
  {
    type: z.string().describe("Content type name, e.g. 'BlogPost'."),
    ...delv,
    limit: z.number().int().min(1).max(500).optional().describe("Page size, 1-500."),
    offset: z.number().int().min(0).optional().describe("Items to skip, for paging."),
    sort: z.string().optional().describe("name | createdAt | data.<field>; prefix - for descending"),
    filter: z.record(z.string(), z.string()).optional().describe("Equality filters on data fields, e.g. {\"author\": \"Jane\"}"),
  },
  async ({ type, locale, populate, preview, limit, offset, sort, filter }) => { needDelivery(preview); return deliveryList(db, persp(preview), ctx().siteId, type, (await deliveryLocale(locale)), populate, undefined, { limit, offset, sort, filter }); });
tool(
  "delivery_search", "content.read",
  "Full-text search over the website's content (item names + public field text) in one locale, as a site search box would: published only (unless preview), private fields never matched or returned. Best match first, 20 results by default (limit up to 100). Returns { items, total }. To list every item of a type use delivery_list; to find content for editing, list_content or list_tree are usually faster.",
  { query: z.string().min(1).max(200).describe("Words to search for, e.g. 'pricing plans'."), type: z.string().optional().describe("Only return items of this content type."), locale: loc, limit: z.number().int().min(1).max(100).optional().describe("Max results, 1-100."), preview: PREVIEW_ARG },
  async ({ query, type, locale, limit, preview }) => { needDelivery(preview); return deliverySearch(db, persp(preview), ctx().siteId, query, (await deliveryLocale(locale)), type, limit); });

/* --------------------------------- site -------------------------------- */
tool(
  "list_sites", "content.read",
  "Report where this server acts and in which languages. Returns: sites (every site you can reach: id, slug, name), activeSiteId, tokenScopedTo (the one site your token is limited to, or null), activeSite (startPageId — the page served at /, or null — and previewBaseUrl, where the admin previews a page as {previewBaseUrl}/{locale}{urlPath}), and locales (enabled language branches in order: code, displayName, isDefault, fallback). " +
    "It lists no content (use list_tree or list_content for that). Use it to pick the `locale` matching the language you write, so text lands in the right branch, and a slug to pass as `site` to other tools (pass `site` here too to see that site's setup). Content in another site is invisible to every tool, so an empty tree or search usually means the wrong site, not missing content.",
  {},
  async () => {
    const { startPageId, previewBaseUrl } = await getSiteConfig(db, ctx());
    return {
      activeSiteId: ctx().siteId,
      tokenScopedTo: tokenSite(),
      activeSite: { startPageId, previewBaseUrl },
      sites: (await reachableSites()).map((x) => ({ id: x.id, slug: x.slug, name: x.name })),
      locales: (await listLocales(db)).map((l) => ({ code: l.code, displayName: l.displayName, isDefault: l.isDefault, fallback: l.fallbackLocaleCode })),
    };
  },
);
tool("set_start_page", "content.publish", "Choose which page this site serves at / (the home page), or clear it with null. Only a page in this site can be chosen (anything else is refused). Takes effect immediately on the live site, in every locale the page is published in (visitors only ever get a published version, so publish it first). The current start page is list_sites' activeSite.startPageId. Returns {ok:true}.", { documentId: z.string().nullable().describe("documentId of a page in this site, or null to clear.") },
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
  "list_redirects", "content.read",
  "List this site's redirect rules, most recently changed first and all at once (no paging), each with its target's live URL, hit count and problems (target-missing, target-unpublished, shadowed, chain, loop). Rules apply on the frontend ONLY where no published page answers the path. Pass targetDocumentId to see which old URLs point at one page. To check how one URL resolves use test_redirect; for old URLs that still 404, list_not_found.",
  { targetDocumentId: z.string().optional().describe("Only rules pointing at this page (documentId). Omit for all rules.") },
  ({ targetDocumentId }) => listRedirects(db, ctx(), { targetDocumentId }),
);
tool(
  "create_redirect", "content.publish",
  "Create a redirect rule. source: a path (\"/old-page\"), a prefix (\"/blog/*\" — the rest of the path is carried over) or a full URL on the old site (reduced to its path). Target: EITHER targetDocumentId (+ optional targetLocale) to follow a page wherever it moves, OR target = a path or https:// URL — a path that names a published page is stored as that page. status: 301 (default, permanent — passes link equity), 302/307 temporary, 308 permanent, 410 gone (no target). A target that is itself redirected is collapsed to the final destination; loops and a second rule for the same source are refused. Live from the frontend's next manifest fetch. Returns {redirect, collapsed, repointed}: the stored rule, whether its target was collapsed, and how many existing rules were re-pointed at it. Publishing a new slug or moving a page creates 301s automatically — check list_redirects before adding one by hand.",
  { source: REDIRECT_SOURCE_ARG, target: REDIRECT_TARGET_ARG, targetDocumentId: REDIRECT_TARGET_DOC_ARG, targetLocale: REDIRECT_TARGET_LOCALE_ARG, status: REDIRECT_STATUS_ARG.optional(), keepQuery: REDIRECT_KEEP_QUERY_ARG, note: REDIRECT_NOTE_ARG },
  async (a) => { const r = await createRedirect(db, ctx(), a); await mcpAudit("redirect.create", null, null, { id: r.redirect.id, source: r.redirect.source }); return r; },
);
tool(
  "update_redirect", "content.publish",
  "Change an existing redirect rule by id (from list_redirects): a new target, status, source, keepQuery or note. Same fields and rules as create_redirect (collapsing, loop refusal); omitted fields are unchanged, and an unknown id is refused. Requires content.publish. Returns the same {redirect, collapsed, repointed} as create_redirect. To remove a rule use delete_redirect.",
  { id: z.number().int().describe("The rule's id from list_redirects."), source: REDIRECT_SOURCE_ARG.optional(), target: REDIRECT_TARGET_ARG, targetDocumentId: REDIRECT_TARGET_DOC_ARG, targetLocale: REDIRECT_TARGET_LOCALE_ARG, status: REDIRECT_STATUS_ARG.optional(), keepQuery: REDIRECT_KEEP_QUERY_ARG, note: REDIRECT_NOTE_ARG },
  async ({ id, ...patch }) => { const r = await updateRedirect(db, ctx(), id, patch); await mcpAudit("redirect.update", null, null, { id }); return r; },
);
tool("delete_redirect", "content.publish", "Permanently delete one redirect rule, or several at once, by id (requires content.publish). Irreversible. The old URLs then answer 404 (or reach a page now published there) — check list_not_found afterwards. To point a rule somewhere else instead, use update_redirect. Returns {deleted: <count>}; ids that don't exist are not counted.", { ids: z.array(z.number().int()).min(1).describe("Rule ids from list_redirects.") },
  async ({ ids }) => { const deleted = await deleteRedirects(db, ctx(), ids); await mcpAudit("redirect.delete", null, null, { ids, deleted }); return { deleted }; });
tool(
  "test_redirect", "content.read",
  "Follow a URL the way a visitor would: a published page answers first, then the rules, hop by hop. Returns each step (page, redirect, gone, external, not-found, loop) and the hop count, without changing anything. Use it to verify a migration — every old URL should end on a page in one hop — or after create_redirect/update_redirect. For all rules at once use list_redirects.",
  { url: z.string().describe("A path ('/old-page?x=1') or full URL on this site.") },
  ({ url }) => testRedirect(db, ctx(), url),
);
tool(
  "list_not_found", "content.read",
  "List URL paths visitors hit that answered 404 on the website, as reported by the frontend: path (no query string), hits, firstSeen, lastSeen, and coveredBy — the id of a redirect rule that now answers it, or null. Most hits first, up to 2000. Use it after a migration or slug change: create_redirect for uncovered paths with real traffic, then test_redirect to verify. No visitor data is stored, and entries older than 90 days are dropped.",
  {},
  () => listNotFound(db, ctx()),
);

/* ---------------------------- A/B experiments --------------------------- */
const EXPERIMENT_ID_ARG = z.number().int().positive().describe("The experiment's id, from list_experiments or create_experiment.");
const EXPERIMENT_ARMS_ARG = z
  .array(
    z.object({
      key: z.enum(["a", "b", "c", "d"]).optional().describe("'b', 'c' or 'd' for an alternative (assigned in order when omitted); 'a' only to set the control's weight."),
      label: z.string().nullable().optional().describe("A short name editors see, e.g. 'Benefit headline'."),
      weight: z.number().int().min(0).max(100).optional().describe("Share of visitors, relative to the other versions (default 50)."),
      blocks: z.array(z.record(z.string(), z.unknown())).optional().describe("The version's block instances, exactly as the content area holds them: [{key, blockType, display: 'automatic', inline: {…fields…}, ref: null}], or a shared block {…, inline: null, ref: '<documentId>'}. Read the area with get_content first and change a copy."),
    }),
  )
  .min(1)
  .max(4)
  .describe("The alternatives to the page's own area (version A): 1–3 versions, optionally plus {key: 'a', weight} for the control's share.");
const EXPERIMENT_NAME_ARG = z.string().describe("What is tested, e.g. 'Hero headline: benefit vs. feature'.");
const EXPERIMENT_HYPOTHESIS_ARG = z.string().nullable().optional().describe("Why the change should win, in one sentence.");
const EXPERIMENT_GOAL_ARG = z.string().optional().describe("'form' (default: a form on the page is submitted) or 'event:<name>' that the frontend reports, e.g. 'event:signup'.");
const EXPERIMENT_BASELINE_ARG = z.number().nullable().optional().describe("Today's conversion rate as a fraction, e.g. 0.04. With mde it sets the sample size no winner is named before.");
const EXPERIMENT_MDE_ARG = z.number().nullable().optional().describe("Smallest RELATIVE lift worth detecting, e.g. 0.2 for +20 %.");
const EXPERIMENT_ENDS_ARG = z.string().nullable().optional().describe("ISO date-time when it ends by itself (no winner), e.g. '2026-12-01T00:00:00Z'.");
tool(
  "list_experiments", "content.read",
  "List this site's A/B experiments (tests of one content area of a page against up to three alternative versions), newest change first, each with its status (draft, running, paused, ended), versions and results so far, plus a plain-language verdict. Filter by status or page. For one experiment's daily numbers use get_experiment.",
  { status: z.enum(["draft", "running", "paused", "ended"]).optional().describe("Only experiments in this state."), documentId: z.string().optional().describe("Only experiments on this page.") },
  (a) => listExperiments(db, ctx(), a),
);
tool(
  "get_experiment", "content.read",
  "One A/B experiment: its plan, versions (with their blocks), exposures and conversions per version, the comparison of each version with A, daily counts, and verdict.summary, which never names a winner before every version has the planned number of visitors ('Not conclusive yet: 420 of 1600'). Read verdict.summary rather than judging the rates yourself.",
  { id: EXPERIMENT_ID_ARG },
  ({ id }) => getExperiment(db, ctx(), id),
);
tool(
  "create_experiment", "content.update",
  "Set up an A/B test (as a draft) of one content area of a published page: version A is the area as published, and you give 1–3 alternative block lists. Each version is validated exactly like the area (allowed blocks, field formats), with errors naming the version. Plan it with baselineRate and mde so the result can be trusted. Nothing changes for visitors until start_experiment. Created by an agent it is flagged for review: with agent review on, a human must start it.",
  {
    documentId: z.string().describe("The page's documentId."),
    locale: z.string().describe("The language branch under test, e.g. 'en'."),
    area: z.string().describe("The content-area field name, e.g. 'mainArea' (list_content_types shows a type's fields)."),
    name: EXPERIMENT_NAME_ARG,
    hypothesis: EXPERIMENT_HYPOTHESIS_ARG,
    goal: EXPERIMENT_GOAL_ARG,
    baselineRate: EXPERIMENT_BASELINE_ARG,
    mde: EXPERIMENT_MDE_ARG,
    endsAt: EXPERIMENT_ENDS_ARG,
    arms: EXPERIMENT_ARMS_ARG,
  },
  async (a) => { const e = await createExperiment(db, ctx(), a); await mcpAudit("experiment.create", e.documentId, e.locale, { id: e.id, area: e.area }); return e; },
);
tool(
  "update_experiment", "content.update",
  "Change a draft or paused A/B experiment: its name, plan, goal, end date or versions (arms replaces all of them). A running experiment is refused, so call pause_experiment first: changing versions mid-test would mix two tests in one count. An ended experiment is history and can't change.",
  {
    id: EXPERIMENT_ID_ARG,
    name: EXPERIMENT_NAME_ARG.optional(),
    hypothesis: EXPERIMENT_HYPOTHESIS_ARG,
    goal: EXPERIMENT_GOAL_ARG,
    baselineRate: EXPERIMENT_BASELINE_ARG,
    mde: EXPERIMENT_MDE_ARG,
    endsAt: EXPERIMENT_ENDS_ARG,
    arms: EXPERIMENT_ARMS_ARG.optional(),
  },
  async ({ id, ...patch }) => { const e = await updateExperiment(db, ctx(), id, patch); await mcpAudit("experiment.update", e.documentId, e.locale, { id }); return e; },
);
tool(
  "start_experiment", "content.publish",
  "Start (or resume) an A/B experiment: from the frontend's next fetch, visitors are split between the versions and counted. The page must be published, and an area has one live experiment at a time. If an agent set it up and the site requires agent review, it waits for a human to start it.",
  { id: EXPERIMENT_ID_ARG },
  async ({ id }) => { const e = await startExperiment(db, ctx(), id); await mcpAudit("experiment.start", e.documentId, e.locale, { id }); return e; },
);
tool(
  "pause_experiment", "content.publish",
  "Pause a running A/B experiment: every visitor sees version A and nothing is counted until start_experiment resumes it. Pausing is also how to edit its versions (update_experiment refuses a running one). The counts so far are kept.",
  { id: EXPERIMENT_ID_ARG },
  async ({ id }) => { const e = await pauseExperiment(db, ctx(), id); await mcpAudit("experiment.pause", e.documentId, e.locale, { id }); return e; },
);
tool(
  "end_experiment", "content.publish",
  "End an A/B experiment for good; visitors see the page's area again. winner names the version that won (leave it out when the result was inconclusive). With a winner other than 'a', apply 'draft' (default) writes its blocks into the area as a draft for review, 'publish' also publishes it, and 'none' only records it. Losing versions and results are kept. Check get_experiment's verdict first and don't name a winner it doesn't support.",
  {
    id: EXPERIMENT_ID_ARG,
    winner: z.enum(["a", "b", "c", "d"]).nullable().optional().describe("The winning version, or omit for none."),
    apply: z.enum(["draft", "publish", "none"]).optional().describe("What to do with a winner other than A: 'draft' (default), 'publish' or 'none'."),
  },
  async ({ id, ...opts }) => { const r = await endExperiment(db, ctx(), id, opts); await mcpAudit("experiment.end", r.experiment.documentId, r.experiment.locale, { id, winner: r.experiment.winner, applied: r.applied }); return r; },
);

/* ---------------------------- platform admin --------------------------- */
tool("list_users", "user.manage", "List every CMS user account (admin editors, not website visitors), oldest first, all in one call (no paging): id, email, name, roles, section scopes, locked flag and createdAt. Users are shared by every site. Requires user.manage (Admin). Use an id from here with update_user or delete_user; to add someone, create_user.", {}, () => listUsers(db, ctx()));
const ROLES_ARG = z.array(RoleName).describe("Admin = everything; Editor = all content + publish + form submissions; Author = write content within its sections; Viewer = read-only.");
const SECTIONS_ARG = z.array(z.string()).optional().describe("documentIds of top-level pages this user is limited to (its subtree). Omit or [] for the whole site.");
tool("create_user", "user.manage", "Create a CMS user account (an editor of the admin, not a website visitor) that signs in with this email and password. Users and roles are instance-wide, so they apply in every site; sections narrow what they can edit. Admin only, with a token not limited to one site. Returns {id}; fails if the email is taken. Give the password to the person out of band — they can change it and enable 2FA themselves. To change an existing account use update_user.", { email: z.string().email().describe("Sign-in email address; must be unique."), name: z.string().describe("Display name, e.g. 'Kari Nordmann'."), password: z.string().min(10).describe("Initial password, at least 10 characters."), roles: ROLES_ARG.min(1), sections: SECTIONS_ARG },
  async (a) => { requireCrossSiteToken("User management"); const id = await adminCreateUser(db, ctx(), a); await mcpAudit("user.create", null, null, { email: a.email, roles: a.roles }); return { id }; });
tool("update_user", "user.manage", "Change a user's name, roles and/or section scopes (Admin only). Omitted fields are kept; roles and sections REPLACE the current lists. Changes apply from the user's next request. Use it to promote, demote or narrow someone; removing every role locks them out without deleting the account (delete_user removes it). Taking Admin from the last Admin is refused. Users span every site, so it needs a token for every site. Returns {ok:true}.", { id: z.string().describe("The user's id from list_users."), name: z.string().optional().describe("New display name."), roles: ROLES_ARG.optional(), sections: SECTIONS_ARG },
  async ({ id, ...rest }) => { requireCrossSiteToken("User management"); await adminUpdateUser(db, ctx(), id, rest); await mcpAudit("user.update", null, null, { id }); return { ok: true }; });
tool("delete_user", "user.manage", "Permanently delete a user account (Admin only): they can no longer sign in and their browser sessions end. Content they wrote stays. You cannot delete yourself or the last Admin. Irreversible, and users span every site (needs a token for every site). To only take away access, remove their roles with update_user instead. Returns {ok:true}.", { id: z.string().describe("The user's id from list_users.") },
  async ({ id }) => { requireCrossSiteToken("User management"); await adminDeleteUser(db, ctx(), id); await mcpAudit("user.delete", null, null, { id }); return { ok: true }; });
tool("list_delivery_keys", "deliverykey.manage", "List this site's Delivery API keys — the credentials a website uses to read content — newest first, all at once: id, name, type (public | preview) and timestamps. Secrets are never shown again after creation, so a lost one means a new key (create_delivery_key). Use an id from here with rename_delivery_key or revoke_delivery_key. Admin only.", {}, () => listDeliveryKeys(db, ctx()));
tool("create_delivery_key", "deliverykey.manage", "Mint a Delivery API key for this site (Admin only). A public key reads published content only — safe for a website build; a preview key also reads drafts, so keep it server-side. Returns {key}: the secret, shown ONCE — store it now. Manage existing keys with list_delivery_keys, rename_delivery_key and revoke_delivery_key.", { name: z.string().describe("Label for where it is used, e.g. 'Astro site production'."), type: z.enum(["public", "preview"]).describe("public = published only; preview = drafts too.") },
  async ({ name, type }) => { const r = await createDeliveryKey(db, ctx(), name, type); await mcpAudit("deliverykey.create", null, null, { name, type }); return r; });
tool("rename_delivery_key", "deliverykey.manage", "Change a Delivery API key's label (Admin only), e.g. after a site moves hosts. The secret, its type and its access are unchanged, so nothing using it breaks. To cut a key off use revoke_delivery_key; a key's type can't change, so mint a new one with create_delivery_key. Returns {ok:true}.", { id: z.number().describe("The key's id from list_delivery_keys."), name: z.string().min(1).describe("The new label.") },
  async ({ id, name }) => { await renameDeliveryKey(db, ctx(), id, name); await mcpAudit("deliverykey.rename", null, null, { id, name }); return { ok: true }; });
tool("revoke_delivery_key", "deliverykey.manage", "Revoke a Delivery API key (Admin only): every request using it is refused from now on, so a website still using it stops getting content. Irreversible — mint a new key with create_delivery_key (and deploy it) BEFORE revoking one a live site uses. To change only its label, use rename_delivery_key. Returns {ok:true}.", { id: z.number().describe("The key's id from list_delivery_keys.") },
  async ({ id }) => { await revokeDeliveryKey(db, ctx(), id); await mcpAudit("deliverykey.revoke", null, null, { id }); return { ok: true }; });
tool("list_webhooks", "webhook.manage", "List this site's outbound webhooks, newest first, all at once: id, name, target url, subscribed events and status. Secrets are not shown. Use it to check what a frontend's cache or rebuild hook is subscribed to; to change one, delete_webhook then create_webhook (there is no update). Admin only.", {}, () => listWebhooks(db, ctx()));
tool("create_webhook", "webhook.manage", "Subscribe a URL to this site's events (Admin only): Paperboy POSTs a JSON payload signed with HMAC-SHA256 on each event, e.g. to trigger a static-site rebuild or purge a cache. Private-network URLs are refused. Each POST carries the event in x-paperboy-event and the signature in x-paperboy-signature (sha256=<hex HMAC of the body>). Returns {id, secret}: the signing secret is shown ONCE, so store it to verify deliveries. See existing hooks with list_webhooks; remove one with delete_webhook.", { name: z.string().describe("Label, e.g. 'Netlify rebuild'."), url: z.string().describe("Public https:// endpoint to POST to."), events: z.array(z.string()).optional().describe("Events to send: content.published, content.unpublished, delivery.changed (output changed without a publish: moves, sorting, settings…), form.submitted. Omit or [] for every event EXCEPT form.submitted, which carries visitor personal data and must be named.") },
  async (a) => { const r = await createWebhook(db, ctx(), a); await mcpAudit("webhook.create", null, null, { name: a.name }); return r; });
tool("delete_webhook", "webhook.manage", "Permanently delete one of this site's webhooks (Admin only). Events are sent at the moment they happen and never queued, so nothing is pending: from now on its URL simply receives no more events, and its signing secret is gone. Irreversible. There is no update_webhook — to change a URL or event list, delete it and create_webhook again (the new one gets a new secret). Returns {ok:true}.", { id: z.number().describe("The webhook's id from list_webhooks.") },
  async ({ id }) => { await deleteWebhook(db, ctx(), id); await mcpAudit("webhook.delete", null, null, { id }); return { ok: true }; });
tool("list_audit", "audit.read", "Read the append-only audit log, newest first: who did what (create, publish, delete, login, export…), when, to which document, from which surface (ip 'mcp' = agent). Each row has id, ts, actorUserId, action, documentId, locale, ip and detail. Use it to find out who changed something; for what an item looked like before, use list_versions instead. Requires audit.read and a token not limited to one site.",
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

/* ---------------------------------- AI --------------------------------- */
tool("assist_writing", "content.update", "Run the CMS's writing assistant on a piece of text: SEO titles and descriptions, summaries, polishing, rewrites, variants, translation, drafting from a brief, schema.org field suggestions. Returns {result, provider}: result is the text (for variants, a JSON array of 3 strings). It saves nothing — write the result with set_field or update_content. It uses the model set in Settings → AI provider; without one, only meta_title, meta_description and summarize work (by truncation) and the rest are refused with a hint. It cannot write image alt text, since it never sees the image: write that yourself and save it with update_asset_alt.",
  {
    task: z.enum(AI_TASKS).describe("meta_title / meta_description = SEO text from the input; summarize; improve = polish grammar and flow; rewrite; variants = 3 alternatives as a JSON array; translate (needs targetLocale); write = 2-4 paragraphs about the topic in input; schema_fields = suggested fields for the schema.org @type named in input; alt_text is refused (see above)."),
    input: z.string().min(1).describe("The text to work on (or, for write, the topic/brief)."),
    targetLocale: z.string().optional().describe("Locale code of the output language, e.g. 'nb'. Required for translate; for improve/rewrite/variants it overrides 'same language as the input'."),
  },
  async (a) => { return aiAssist(a, await resolveAiRuntimeConfig(db, AI_ENV)); });

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
  const registered = new Set(registrations.map((r) => r.name));
  const missing = [...TOOLSET_OF.keys()].filter((name) => !registered.has(name));
  if (missing.length) throw new Error(`TOOLSETS names tools that are not registered: ${missing.join(", ")}`);
  // Prefer a Paperboy-issued MCP token (Settings → Agent access); fall back to
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
      // A connector's URL carries its toolsets (?toolsets=content,admin), fixed for
      // the session it opens; without one, the server's PAPERBOY_TOOLSETS applies.
      buildServer: (req) => {
        const asked = new URL(req.url ?? "/", "http://mcp").searchParams.get("toolsets");
        if (asked === null) return buildServer();
        try {
          return buildServer(parseToolsets(asked));
        } catch (err) {
          throw new HttpError(400, (err as Error).message);
        }
      },
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
