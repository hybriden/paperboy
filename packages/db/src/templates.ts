import { asc, eq } from "drizzle-orm";
import {
  BUILTIN_TYPE_TEMPLATE_NAMES,
  BUILTIN_TYPE_TEMPLATES,
  ContentTypeDef,
  parseStoredContentTypeDef,
  stripSeoGroup,
} from "@paperboy/shared";
import type { Database } from "./client.js";
import { Errors } from "./errors.js";
import { type AccessContext, requirePermission } from "./scope.js";
import { contentType, typeTemplate } from "./schema.js";
import { createContentType, getContentType, updateContentType } from "./content.js";

/**
 * The content-type template collection: named, reusable ContentTypeDef recipes.
 * A template's `name` is the content type name it materialises by default —
 * the same identity/content-type table relationship, stored separately so a
 * type can be deleted and recreated from the template, or kept around as a
 * starter (e.g. for a fresh site). RBAC mirrors content types (require
 * "contenttype.manage" server-side; deny-by-default).
 *
 * Two origins, one collection:
 *  - BUILT-IN templates (BUILTIN_TYPE_TEMPLATES in packages/shared) ship with
 *    the product on every instance, read-only — their names are reserved.
 *    Customising one = duplicate it under a new name (or tweak in the editor
 *    before creating the type).
 *  - STORED templates (the type_template table) are the user's own recipes,
 *    full CRUD. A stored row that predates the reserved-name rule shadows the
 *    built-in of the same name until it is deleted.
 */

/** A stored row shadows the built-in of the same name (legacy grace — new rows
 *  can't claim built-in names). */
function mergeWithBuiltins(stored: ContentTypeDef[]): ContentTypeDef[] {
  const storedNames = new Set(stored.map((t) => t.name));
  const builtins = BUILTIN_TYPE_TEMPLATES.filter((t) => !storedNames.has(t.name)).map((t) =>
    parseStoredContentTypeDef(t),
  );
  return [...stored, ...builtins].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export async function listTypeTemplates(db: Database): Promise<ContentTypeDef[]> {
  const rows = await db.select().from(typeTemplate).orderBy(asc(typeTemplate.name));
  // Same read chokepoint as content types: normalise stored shape + inject SEO.
  return mergeWithBuiltins(rows.map((r) => parseStoredContentTypeDef(r.definition)));
}

export async function getTypeTemplate(db: Database, name: string): Promise<ContentTypeDef> {
  const rows = await db.select().from(typeTemplate).where(eq(typeTemplate.name, name)).limit(1);
  if (rows[0]) return parseStoredContentTypeDef(rows[0].definition);
  const builtin = BUILTIN_TYPE_TEMPLATES.find((t) => t.name === name);
  if (builtin) return parseStoredContentTypeDef(builtin);
  // Self-teaching (agent-API rule 2): hand the caller the real names to retry with.
  const all = (await listTypeTemplates(db)).map((t) => t.name);
  throw Errors.notFound(`Type template '${name}' (available: ${all.length ? all.join(", ") : "none"})`);
}

/** Admin-only: save a new template. The body must already be schema-valid. */
export async function createTypeTemplate(
  db: Database,
  ctx: AccessContext,
  def: ContentTypeDef,
): Promise<ContentTypeDef> {
  requirePermission(ctx, "contenttype.manage");
  if (BUILTIN_TYPE_TEMPLATE_NAMES.has(def.name)) {
    throw Errors.conflict(
      `'${def.name}' is a built-in template (read-only, ships with every instance). ` +
        `Save yours under a different name (e.g. '${def.name}Custom'), or instantiate the built-in directly.`,
    );
  }
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
 * Built-ins are read-only — only a stored row can be updated.
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
  if (!rows[0]) {
    if (BUILTIN_TYPE_TEMPLATE_NAMES.has(name)) {
      throw Errors.conflict(
        `'${name}' is a built-in template and read-only. Create your own copy under a new name instead ` +
          `(same definition, different name), then edit that.`,
      );
    }
    throw Errors.notFound(`Type template '${name}'`);
  }
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
 *  the recipe never touches the types (or their content) created from it.
 *  Built-ins can't be deleted; a legacy stored row shadowing one can (the
 *  built-in resurfaces). */
export async function deleteTypeTemplate(db: Database, ctx: AccessContext, name: string): Promise<void> {
  requirePermission(ctx, "contenttype.manage");
  const rows = await db.select().from(typeTemplate).where(eq(typeTemplate.name, name)).limit(1);
  if (!rows[0]) {
    if (BUILTIN_TYPE_TEMPLATE_NAMES.has(name)) {
      throw Errors.conflict(`'${name}' is a built-in template and can't be deleted — it ships with the product.`);
    }
    throw Errors.notFound(`Type template '${name}'`);
  }
  await db.delete(typeTemplate).where(eq(typeTemplate.name, name));
}

export interface InstantiateResult {
  /** The resulting content type (with the reserved SEO group, as read). */
  type: ContentTypeDef;
  /** The type name it materialised under (asName may differ from the template). */
  name: string;
  /** "created" = new type, "updated" = existing type overwritten from the template. */
  action: "created" | "updated";
  /** Only when withBlocks: what happened to the block types the template's
   *  content areas reference. */
  blocks?: { created: string[]; existing: string[]; missing: string[] };
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
 *
 * `withBlocks` also creates the BLOCK types the template's content areas
 * allow-list (recursively — an FAQ page pulls in its topic and question
 * blocks), so one instantiation yields a working set. Existing types are left
 * untouched (never overwritten); names with no template are reported back as
 * `missing`.
 */
export interface InstantiateOptions {
  updateExisting?: boolean;
  asName?: string;
  withBlocks?: boolean;
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
  let result: InstantiateResult;
  if (existing[0]) {
    if (!opts.updateExisting) {
      throw Errors.conflict(
        `Content type '${def.name}' already exists — refusing to overwrite it implicitly. ` +
          `Pass updateExisting: true to re-apply template '${templateName}' onto it ` +
          `(kind must match, existing content is not migrated), or asName to create a type with a different name.`,
      );
    }
    const { next } = await updateContentType(db, ctx, def.name, def);
    result = { type: next, name: def.name, action: "updated" };
  } else {
    const created = await createContentType(db, ctx, def);
    result = { type: created, name: def.name, action: "created" };
  }
  if (opts.withBlocks) result.blocks = await instantiateReferencedBlocks(db, ctx, def);
  return result;
}

/** Block type names a definition's content areas allow-list. */
function referencedBlockNames(def: ContentTypeDef): string[] {
  const names = new Set<string>();
  for (const f of def.fields) {
    if (f.type !== "contentArea") continue;
    for (const b of f.allowedBlocks) names.add(b);
  }
  return [...names];
}

/** Create the block types a definition references (recursively), create-only. */
async function instantiateReferencedBlocks(
  db: Database,
  ctx: AccessContext,
  def: ContentTypeDef,
): Promise<{ created: string[]; existing: string[]; missing: string[] }> {
  const created: string[] = [];
  const existing: string[] = [];
  const missing: string[] = [];
  const queue = referencedBlockNames(def);
  const seen = new Set<string>([def.name, ...queue]);
  const enqueue = (names: string[]) => {
    for (const sub of names) {
      if (!seen.has(sub)) {
        seen.add(sub);
        queue.push(sub);
      }
    }
  };
  while (queue.length) {
    const name = queue.shift()!;
    const already = await db.select({ id: contentType.id }).from(contentType).where(eq(contentType.name, name)).limit(1);
    if (already[0]) {
      existing.push(name);
      // The type exists, but ITS content areas may still reference missing
      // blocks (e.g. FaqTopicBlock created earlier, QuestionBlock not) —
      // follow the existing type's own definition so the set completes.
      enqueue(referencedBlockNames(await getContentType(db, name)));
      continue;
    }
    let tpl: ContentTypeDef;
    try {
      tpl = await getTypeTemplate(db, name);
    } catch {
      missing.push(name); // an allowedBlocks hint with no template behind it
      continue;
    }
    if (tpl.kind !== "block") {
      missing.push(name); // allowedBlocks must name block types
      continue;
    }
    await createContentType(db, ctx, tpl);
    created.push(name);
    enqueue(referencedBlockNames(tpl));
  }
  return { created, existing, missing };
}

/** Export the (merged) collection, optionally filtered by name — self-teaching
 *  404 when a requested name doesn't exist. */
export async function exportTypeTemplates(db: Database, names?: string[]): Promise<ContentTypeDef[]> {
  const all = await listTypeTemplates(db);
  if (!names || names.length === 0) return all;
  const byName = new Map(all.map((t) => [t.name, t]));
  const unknown = names.filter((n) => !byName.has(n));
  if (unknown.length) {
    throw Errors.notFound(
      `Type template(s) ${unknown.join(", ")} (available: ${all.map((t) => t.name).join(", ")})`,
    );
  }
  return names.map((n) => byName.get(n)!);
}

export interface ImportResult {
  created: string[];
  updated: string[];
  skipped: { name: string; reason: string }[];
}

/**
 * Admin-only: import templates (from an export document). Per-template
 * outcome, never all-or-nothing: new names are created; existing stored
 * templates are skipped unless `overwrite` (then updated through the same
 * chokepoint as a manual edit — kind stays immutable); built-in names are
 * always skipped (they ship with every instance). Every skip carries the
 * reason, so the caller can see exactly what to change (rule #2).
 */
export async function importTypeTemplates(
  db: Database,
  ctx: AccessContext,
  templates: ContentTypeDef[],
  overwrite = false,
): Promise<ImportResult> {
  requirePermission(ctx, "contenttype.manage");
  const result: ImportResult = { created: [], updated: [], skipped: [] };
  for (const def of templates) {
    if (BUILTIN_TYPE_TEMPLATE_NAMES.has(def.name)) {
      result.skipped.push({ name: def.name, reason: "built-in template (read-only) — it already ships with every instance" });
      continue;
    }
    try {
      const rows = await db.select({ id: typeTemplate.id }).from(typeTemplate).where(eq(typeTemplate.name, def.name)).limit(1);
      if (rows[0]) {
        if (!overwrite) {
          result.skipped.push({ name: def.name, reason: "already exists — pass overwrite: true to update it from the import" });
          continue;
        }
        await updateTypeTemplate(db, ctx, def.name, def);
        result.updated.push(def.name);
      } else {
        await createTypeTemplate(db, ctx, def);
        result.created.push(def.name);
      }
    } catch (e) {
      // e.g. kind mismatch on overwrite — keep importing the rest, report why.
      result.skipped.push({ name: def.name, reason: (e as Error).message });
    }
  }
  return result;
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
