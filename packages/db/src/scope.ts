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
  siteWide: boolean;
  sections: string[]; // allowed top-level section document_ids
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
): Promise<typeof contentItem.$inferSelect> {
  const rows = await db
    .select()
    .from(contentItem)
    .where(and(eq(contentItem.documentId, documentId), isNull(contentItem.deletedAt)))
    .limit(1);
  const item = rows[0];
  if (!item) throw Errors.notFound("Content");
  if (!ctx.siteWide) {
    const section = item.sectionId ?? item.documentId;
    if (!ctx.sections.includes(section)) {
      // Deny-by-default: caller is out of scope for this object.
      throw Errors.forbidden("Out of scope for this content");
    }
  }
  return item;
}
