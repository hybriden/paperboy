import { asc, eq } from "drizzle-orm";
import { ContentTypeDef, parseStoredContentTypeDef, stripSeoGroup } from "@paperboy/shared";
import type { Database } from "./client.js";
import { Errors } from "./errors.js";
import { type AccessContext, requirePermission } from "./scope.js";
import { contentType, typeTemplate } from "./schema.js";
import { createContentType, updateContentType } from "./content.js";

/**
 * The content-type template collection: named, reusable ContentTypeDef recipes.
 * A template's `name` is the content type name it materialises by default —
 * the same identity/content-type table relationship, stored separately so a
 * type can be deleted and recreated from the template, or kept around as a
 * starter (e.g. for a fresh site). RBAC mirrors content types (require
 * "contenttype.manage" server-side; deny-by-default).
 */

export async function listTypeTemplates(db: Database): Promise<ContentTypeDef[]> {
  const rows = await db.select().from(typeTemplate).orderBy(asc(typeTemplate.name));
  // Same read chokepoint as content types: normalise stored shape + inject SEO.
  return rows.map((r) => parseStoredContentTypeDef(r.definition));
}

export async function getTypeTemplate(db: Database, name: string): Promise<ContentTypeDef> {
  const rows = await db.select().from(typeTemplate).where(eq(typeTemplate.name, name)).limit(1);
  if (!rows[0]) {
    // Self-teaching (agent-API rule 2): hand the caller the real names to retry with.
    const all = await db.select({ name: typeTemplate.name }).from(typeTemplate).orderBy(asc(typeTemplate.name));
    throw Errors.notFound(`Type template '${name}' (available: ${all.length ? all.map((t) => t.name).join(", ") : "none"})`);
  }
  return parseStoredContentTypeDef(rows[0].definition);
}

/** Admin-only: save a new template. The body must already be schema-valid. */
export async function createTypeTemplate(
  db: Database,
  ctx: AccessContext,
  def: ContentTypeDef,
): Promise<ContentTypeDef> {
  requirePermission(ctx, "contenttype.manage");
  const existing = await db.select().from(typeTemplate).where(eq(typeTemplate.name, def.name)).limit(1);
  if (existing[0]) throw Errors.conflict(`Type template '${def.name}' already exists`);
  // The reserved SEO group is system-managed (stripped at write, injected on
  // read) — exactly like content_type, so a template can never drift from it.
  const stored = stripSeoGroup(def);
  await db.insert(typeTemplate).values({
    name: stored.name,
    displayName: stored.displayName,
    kind: stored.kind,
    description: stored.description,
    icon: stored.icon,
    definition: stored,
  });
  return parseStoredContentTypeDef(stored);
}

/**
 * Admin-only: update a template. `name` and `kind` are immutable (name is the
 * key instantiate targets; kind mismatch would 409 on instantiation anyway).
 */
export async function updateTypeTemplate(
  db: Database,
  ctx: AccessContext,
  name: string,
  def: ContentTypeDef,
): Promise<{ next: ContentTypeDef; prev: ContentTypeDef }> {
  requirePermission(ctx, "contenttype.manage");
  if (def.name !== name) throw Errors.badRequest("Type template name is immutable");
  const rows = await db.select().from(typeTemplate).where(eq(typeTemplate.name, name)).limit(1);
  if (!rows[0]) throw Errors.notFound(`Type template '${name}'`);
  const prev = parseStoredContentTypeDef(rows[0].definition);
  if (def.kind !== prev.kind) throw Errors.conflict("Template kind is immutable");
  const stored = stripSeoGroup(def);
  await db
    .update(typeTemplate)
    .set({ displayName: stored.displayName, description: stored.description, icon: stored.icon, definition: stored })
    .where(eq(typeTemplate.name, name));
  return { next: parseStoredContentTypeDef(stored), prev };
}

/** Admin-only: delete a template. Instantiated types are independent — deleting
 *  the recipe never touches the types (or their content) created from it. */
export async function deleteTypeTemplate(db: Database, ctx: AccessContext, name: string): Promise<void> {
  requirePermission(ctx, "contenttype.manage");
  const rows = await db.select().from(typeTemplate).where(eq(typeTemplate.name, name)).limit(1);
  if (!rows[0]) throw Errors.notFound(`Type template '${name}'`);
  await db.delete(typeTemplate).where(eq(typeTemplate.name, name));
}

export interface InstantiateResult {
  /** The resulting content type (with the reserved SEO group, as read). */
  type: ContentTypeDef;
  /** The type name it materialised under (asName may differ from the template). */
  name: string;
  /** "created" = new type, "updated" = existing type overwritten from the template. */
  action: "created" | "updated";
}

/**
 * Admin-only: materialise a template into a real content type.
 *
 * Default target is the template's own name (it's a recipe FOR that type).
 * `asName` targets a different (new) type name instead — one recipe, many
 * variants. If the target type already exists this REFUSES with 409 unless
 * `updateExisting: true` (rule #1: a destructive overwrite must be explicit,
 * and the error says exactly how to make it happen). Overwriting runs through
 * the SAME updateContentType chokepoint as an ordinary type edit — kind
 * mismatch 409s, existing content keeps its rows (fields are re-shaped, not
 * migrated, exactly like a normal rename/retype — the UI documents that).
 */
export interface InstantiateOptions {
  updateExisting?: boolean;
  asName?: string;
}

export async function instantiateTypeTemplate(
  db: Database,
  ctx: AccessContext,
  templateName: string,
  opts: InstantiateOptions = {},
): Promise<InstantiateResult> {
  requirePermission(ctx, "contenttype.manage");
  const template = await getTypeTemplate(db, templateName);
  let def = template;
  if (opts.asName && opts.asName !== template.name) {
    // Rename + re-validate: an invalid target name must 422 with the format
    // spelled out, not persist a broken type row.
    def = ContentTypeDefOrReject({ ...template, name: opts.asName }, templateName);
  }
  const existing = await db.select({ id: contentType.id }).from(contentType).where(eq(contentType.name, def.name)).limit(1);
  if (existing[0]) {
    if (!opts.updateExisting) {
      throw Errors.conflict(
        `Content type '${def.name}' already exists — refusing to overwrite it implicitly. ` +
          `Pass updateExisting: true to re-apply template '${templateName}' onto it ` +
          `(kind must match, existing content is not migrated), or asName to create a type with a different name.`,
      );
    }
    const { next } = await updateContentType(db, ctx, def.name, def);
    return { type: next, name: def.name, action: "updated" };
  }
  const created = await createContentType(db, ctx, def);
  return { type: created, name: def.name, action: "created" };
}

/** Validate a renamed definition, turning schema failures into the
 *  self-teaching bad-request the rest of the API uses (naming the rule). */
function ContentTypeDefOrReject(def: unknown, templateName: string): ContentTypeDef {
  try {
    return stripSeoGroup(ContentTypeDef.parse(def));
  } catch (e) {
    throw Errors.badRequest(
      `asName is not a valid content type name for template '${templateName}' — ` +
        `must match ^[A-Z][a-zA-Z0-9]*$ (PascalCase, no spaces). Example: "CaseStudy" (underlying: ${(e as Error).message})`,
    );
  }
}
