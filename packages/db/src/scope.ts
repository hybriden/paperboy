import { and, eq, isNull } from "drizzle-orm";
import type { Permission } from "@paperboy/shared";
import type { Database } from "./client.js";
import { Errors } from "./errors.js";
import { contentItem } from "./schema.js";

/**
 * Per-request authorization context. This is the ONLY thing the data layer
 * trusts — never client-supplied flags. `siteWide` users (Admin/Editor) see all
 * sections; scoped users (e.g. Author) are restricted to `sections`.
 */
export interface AccessContext {
  userId: string;
  permissions: Permission[];
  /**
   * The ACTIVE site for this request (multisite partition). Every object-level
   * check and every list/tree/search query is confined to it — deny-by-default
   * across sites. Resolved in `getAccessContext` (default site until the admin
   * site switcher overrides it); never client-trusted beyond membership checks.
   */
  siteId: string;
  /**
   * Site-wide WRITE authority: may create/update/publish/delete any document in
   * the active site, ignoring section scope. Admin and Editor only.
   *
   * Deliberately NARROWER than readSiteWide. A read-only role (Viewer) grants
   * site-wide reading but must never confer site-wide writing — otherwise
   * `[Author, Viewer]`, whose permission set is the union (create/update from
   * Author), would write anywhere, since every scope gate is
   * `siteWide || sections.includes(...)`.
   */
  siteWide: boolean;
  /** Site-wide READ authority: Admin, Editor or Viewer. Gates list/tree/search
   *  visibility and the read side of loadAuthorized. */
  readSiteWide: boolean;
  sections: string[]; // allowed top-level section document_ids (within siteId)
  /**
   * Which surface this request came through — "mcp" for MCP agent writes,
   * "agent" for the in-product content agent (Build from brief), "web" for the
   * browser/API session. Drives provenance (content_version.created_via) and
   * the agent-review flag; never an authorization input.
   */
  via?: "mcp" | "agent" | "web";
}

/** Verb check (RBAC). Deny-by-default. */
export function requirePermission(ctx: AccessContext, perm: Permission): void {
  if (!ctx.permissions.includes(perm)) {
    throw Errors.forbidden(`Missing permission: ${perm}`);
  }
}

/**
 * Object-level authorization (BOLA/IDOR defense). Loads the item, confirms it
 * exists and is not soft-deleted, and verifies the caller's scope covers the
 * item's section. Returns the loaded item row so callers don't re-query.
 *
 * This runs INSIDE the data layer so no management endpoint can bypass it.
 */
export async function loadAuthorized(
  db: Database,
  ctx: AccessContext,
  documentId: string,
  intent: "read" | "write" = "write",
): Promise<typeof contentItem.$inferSelect> {
  const rows = await db
    .select()
    .from(contentItem)
    .where(and(eq(contentItem.documentId, documentId), isNull(contentItem.deletedAt)))
    .limit(1);
  const item = rows[0];
  if (!item) throw Errors.notFound("Content");
  // Site partition first (multisite): an item in another site is invisible to
  // this request — even to a site-wide user. Reported as not-found so a caller
  // can't probe which documentIds exist in other sites. Cross-site access is a
  // separate (super-admin) concept layered on later, not a siteWide bypass.
  if (item.siteId !== ctx.siteId) throw Errors.notFound("Content");
  // A read may use the wider read authority (Viewer sees the whole site); a
  // write must clear the narrower write authority. Default "write" is fail-safe:
  // a new caller that forgets the argument gets the stricter check.
  const wide = intent === "read" ? ctx.readSiteWide : ctx.siteWide;
  if (!wide) {
    const section = item.sectionId ?? item.documentId;
    if (!ctx.sections.includes(section)) {
      // Deny-by-default: caller is out of scope for this object.
      throw Errors.forbidden("Out of scope for this content");
    }
  }
  return item;
}
