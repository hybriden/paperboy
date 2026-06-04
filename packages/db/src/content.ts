import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  type BlockSummary,
  type ContentDetail,
  type ContentTypeDef,
  type CreateContentRequest,
  type TreeNode,
  type UpdateContentRequest,
  coerceData,
  dataSchemaFor,
  fieldFormatHint,
} from "@paperboy/shared";
import type { Database } from "./client.js";
import { Errors } from "./errors.js";
import {
  type AccessContext,
  loadAuthorized,
  requirePermission,
} from "./scope.js";
import { auditLog, contentItem, contentReference, contentType, contentVersion, locale } from "./schema.js";
import { dispatchWebhooks } from "./webhooks.js";

/* ----------------------------- content types ----------------------------- */

export async function listContentTypes(db: Database): Promise<ContentTypeDef[]> {
  const rows = await db.select().from(contentType).orderBy(asc(contentType.name));
  return rows.map((r) => r.definition as ContentTypeDef);
}

/** Per-type usage: standalone items of that type, plus pages/blocks that embed
 *  it INLINE in a content area. `inlineIn` counts distinct documents (current
 *  published + working draft only, not historical versions). */
export interface ContentTypeUsage {
  items: number;
  inlineIn: number;
}
export async function contentTypeUsage(db: Database): Promise<Record<string, ContentTypeUsage>> {
  const usage: Record<string, ContentTypeUsage> = {};
  const bump = (t: string, k: keyof ContentTypeUsage) => {
    (usage[t] ??= { items: 0, inlineIn: 0 })[k]++;
  };

  // Standalone instances (pages, shared blocks, globals).
  const counts = await db
    .select({ type: contentItem.type, n: sql<number>`count(*)::int` })
    .from(contentItem)
    .where(isNull(contentItem.deletedAt))
    .groupBy(contentItem.type);
  for (const c of counts) (usage[c.type] ??= { items: 0, inlineIn: 0 }).items = c.n;

  // Inline block usage: scan only CURRENT content — the working draft and the
  // current-published row (any locale), never historical versions. A document
  // counts once per block type it embeds in either (union), so usage reflects
  // what's live or about to be, not stale history.
  const rows = await db
    .select({ documentId: contentVersion.documentId, status: contentVersion.status, isPub: contentVersion.isCurrentPublished, data: contentVersion.data })
    .from(contentVersion);
  const collectBlockTypes = (node: unknown, into: Set<string>): void => {
    if (Array.isArray(node)) {
      for (const n of node) collectBlockTypes(n, into);
    } else if (node && typeof node === "object") {
      const o = node as Record<string, unknown>;
      if (typeof o.blockType === "string") into.add(o.blockType);
      for (const v of Object.values(o)) collectBlockTypes(v, into);
    }
  };
  const byDoc = new Map<string, Set<string>>(); // documentId -> block types it embeds
  for (const r of rows) {
    if (r.status !== "draft" && !r.isPub) continue; // skip history
    const set = byDoc.get(r.documentId) ?? new Set<string>();
    collectBlockTypes(r.data, set);
    byDoc.set(r.documentId, set);
  }
  for (const types of byDoc.values()) {
    for (const t of types) bump(t, "inlineIn");
  }
  return usage;
}

export async function getContentType(db: Database, name: string): Promise<ContentTypeDef> {
  const rows = await db.select().from(contentType).where(eq(contentType.name, name)).limit(1);
  if (!rows[0]) throw Errors.notFound(`Content type '${name}'`);
  return rows[0].definition as ContentTypeDef;
}

/** Admin-only: create a new content type. The body must already be schema-valid. */
export async function createContentType(
  db: Database,
  ctx: AccessContext,
  def: ContentTypeDef,
): Promise<ContentTypeDef> {
  requirePermission(ctx, "contenttype.manage");
  const existing = await db.select().from(contentType).where(eq(contentType.name, def.name)).limit(1);
  if (existing[0]) throw Errors.conflict(`Content type '${def.name}' already exists`);
  await db.insert(contentType).values({
    name: def.name,
    displayName: def.displayName,
    kind: def.kind,
    description: def.description,
    icon: def.icon,
    definition: def,
  });
  return def;
}

/**
 * Admin-only: update a content type. `name` and `kind` are immutable (they key
 * existing content rows). Existing content is NOT migrated — renaming/retyping a
 * field orphans its stored JSONB value and adding a required field will block the
 * next re-publish of existing items (documented; the UI warns).
 */
/**
 * Delete a content type — only when NOTHING uses it. Guard is server-side: any
 * standalone item or inline embedding refuses the delete (409), so a type in use
 * can never be removed out from under existing content. Forward-only; a reseed
 * would recreate seed types.
 */
export async function deleteContentType(db: Database, ctx: AccessContext, name: string): Promise<void> {
  requirePermission(ctx, "contenttype.manage");
  const rows = await db.select().from(contentType).where(eq(contentType.name, name)).limit(1);
  if (!rows[0]) throw Errors.notFound(`Content type '${name}'`);
  const usage = (await contentTypeUsage(db))[name];
  if (usage && (usage.items > 0 || usage.inlineIn > 0)) {
    const parts = [usage.items ? `${usage.items} item(s)` : null, usage.inlineIn ? `embedded in ${usage.inlineIn} page(s)` : null].filter(Boolean);
    throw Errors.conflict(`'${name}' is still in use (${parts.join(", ")}). Remove those first.`);
  }
  await db.delete(contentType).where(eq(contentType.name, name));
}

export async function updateContentType(
  db: Database,
  ctx: AccessContext,
  name: string,
  def: ContentTypeDef,
): Promise<{ next: ContentTypeDef; prev: ContentTypeDef }> {
  requirePermission(ctx, "contenttype.manage");
  if (def.name !== name) throw Errors.badRequest("Content type name is immutable");
  const rows = await db.select().from(contentType).where(eq(contentType.name, name)).limit(1);
  if (!rows[0]) throw Errors.notFound(`Content type '${name}'`);
  const prev = rows[0].definition as ContentTypeDef;
  if (def.kind !== prev.kind) throw Errors.conflict("Content type kind is immutable");
  await db
    .update(contentType)
    .set({ displayName: def.displayName, description: def.description, icon: def.icon, definition: def })
    .where(eq(contentType.name, name));
  return { next: def, prev };
}

/** Which public/private exposure flags changed between two type versions (for audit). */
export function deliveryFlagDelta(prev: ContentTypeDef, next: ContentTypeDef): Record<string, string> {
  const prevMap = new Map(prev.fields.map((f) => [f.name, f.delivery]));
  const delta: Record<string, string> = {};
  for (const f of next.fields) {
    const before = prevMap.get(f.name);
    if (before && before !== f.delivery) delta[f.name] = `${before}→${f.delivery}`;
    else if (!before) delta[f.name] = `new:${f.delivery}`;
  }
  return delta;
}

/* -------------------------------- locales --------------------------------- */

export async function listLocales(db: Database) {
  return db.select().from(locale).where(eq(locale.enabled, true)).orderBy(asc(locale.sortIndex));
}

export async function getDefaultLocale(db: Database): Promise<string> {
  const rows = await db.select().from(locale).where(eq(locale.isDefault, true)).limit(1);
  if (!rows[0]) throw Errors.badRequest("No default locale configured");
  return rows[0].code;
}

/** All locales incl. disabled — powers the Languages management view. */
export async function listAllLocales(db: Database, ctx: AccessContext) {
  requirePermission(ctx, "contenttype.manage");
  return db.select().from(locale).orderBy(asc(locale.sortIndex));
}

// BCP-47-ish: a primary subtag plus optional region/script/variant subtags (e.g. "en", "nb", "en-US").
const LOCALE_CODE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

async function assertFallback(db: Database, code: string, fallback: string | null): Promise<void> {
  if (!fallback) return;
  if (fallback === code) throw Errors.badRequest("A language cannot fall back to itself");
  const row = await db.select({ code: locale.code }).from(locale).where(eq(locale.code, fallback)).limit(1);
  if (!row[0]) throw Errors.badRequest(`Fallback language "${fallback}" does not exist`);
}

export async function createLocale(
  db: Database,
  ctx: AccessContext,
  input: { code: string; displayName: string; fallbackLocaleCode?: string | null },
): Promise<void> {
  requirePermission(ctx, "contenttype.manage");
  const code = input.code.trim();
  const displayName = input.displayName.trim();
  if (!LOCALE_CODE.test(code)) throw Errors.badRequest('Invalid language code — use a BCP-47 tag like "en" or "en-US"');
  if (!displayName) throw Errors.badRequest("Display name is required");
  const existing = await db.select({ code: locale.code }).from(locale).where(eq(locale.code, code)).limit(1);
  if (existing[0]) throw Errors.conflict(`Language "${code}" already exists`);
  const fallback = input.fallbackLocaleCode?.trim() || null;
  await assertFallback(db, code, fallback);
  const max = await db.select({ m: sql<number>`coalesce(max(${locale.sortIndex}), -1)` }).from(locale);
  await db.insert(locale).values({
    code,
    displayName,
    isDefault: false,
    enabled: true,
    fallbackLocaleCode: fallback,
    sortIndex: (max[0]?.m ?? -1) + 1,
  });
}

export async function updateLocale(
  db: Database,
  ctx: AccessContext,
  code: string,
  patch: { displayName?: string; fallbackLocaleCode?: string | null; enabled?: boolean },
): Promise<void> {
  requirePermission(ctx, "contenttype.manage");
  const row = (await db.select().from(locale).where(eq(locale.code, code)).limit(1))[0];
  if (!row) throw Errors.notFound("Language");
  const updates: Partial<typeof locale.$inferInsert> = {};
  if (patch.displayName !== undefined) {
    const dn = patch.displayName.trim();
    if (!dn) throw Errors.badRequest("Display name is required");
    updates.displayName = dn;
  }
  if (patch.fallbackLocaleCode !== undefined) {
    const fallback = patch.fallbackLocaleCode?.trim() || null;
    await assertFallback(db, code, fallback);
    updates.fallbackLocaleCode = fallback;
  }
  if (patch.enabled !== undefined) {
    if (!patch.enabled && row.isDefault) throw Errors.conflict("Can’t disable the default language");
    updates.enabled = patch.enabled;
  }
  if (Object.keys(updates).length === 0) return;
  await db.update(locale).set(updates).where(eq(locale.code, code));
}

/** Permanently remove a locale. Blocked for the default and for locales that hold content. */
export async function deleteLocale(db: Database, ctx: AccessContext, code: string): Promise<void> {
  requirePermission(ctx, "contenttype.manage");
  const row = (await db.select().from(locale).where(eq(locale.code, code)).limit(1))[0];
  if (!row) throw Errors.notFound("Language");
  if (row.isDefault) throw Errors.conflict("Can’t delete the default language");
  const used = await db.select({ id: contentVersion.id }).from(contentVersion).where(eq(contentVersion.locale, code)).limit(1);
  if (used[0]) throw Errors.conflict("This language has content — disable it instead of deleting");
  await db.transaction(async (tx) => {
    // Drop dangling fallback pointers, then remove the locale itself.
    await tx.update(locale).set({ fallbackLocaleCode: null }).where(eq(locale.fallbackLocaleCode, code));
    await tx.delete(locale).where(eq(locale.code, code));
  });
}

/* ------------------------------ variant state ----------------------------- */

interface VariantState {
  status: "draft" | "published";
  hasUnpublishedChanges: boolean;
  name: string;
}

/** Per-locale publication state for one document (drives tree badges + editor). */
async function variantStates(
  db: Database,
  documentId: string,
): Promise<Record<string, VariantState>> {
  const rows = await db
    .select()
    .from(contentVersion)
    .where(eq(contentVersion.documentId, documentId));
  const byLocale: Record<string, VariantState> = {};
  for (const r of rows) {
    const cur = byLocale[r.locale] ?? {
      status: "draft" as const,
      hasUnpublishedChanges: false,
      name: r.name,
    };
    if (r.isCurrentPublished) {
      cur.status = "published";
      cur.name = r.name;
    }
    if (r.status === "draft") {
      cur.hasUnpublishedChanges = true;
      // Prefer the draft name as the freshest label.
      cur.name = r.name;
    }
    byLocale[r.locale] = cur;
  }
  return byLocale;
}

/* --------------------------------- tree ----------------------------------- */

export async function getTree(
  db: Database,
  ctx: AccessContext,
  parentId: string | null,
): Promise<TreeNode[]> {
  requirePermission(ctx, "content.read");
  // The content pane is the PAGE tree. Blocks are assets and
  // are listed separately (listBlocks); globals are config, not in the tree.
  const items = await db
    .select()
    .from(contentItem)
    .where(
      and(
        parentId === null ? isNull(contentItem.parentId) : eq(contentItem.parentId, parentId),
        eq(contentItem.kind, "page"),
        isNull(contentItem.deletedAt),
      ),
    )
    .orderBy(asc(contentItem.sortIndex), asc(contentItem.id));

  const visible = items.filter(
    (i) => ctx.siteWide || ctx.sections.includes(i.sectionId ?? i.documentId),
  );

  const nodes: TreeNode[] = [];
  for (const item of visible) {
    const states = await variantStates(db, item.documentId);
    const childCount = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(contentItem)
      .where(and(eq(contentItem.parentId, item.documentId), eq(contentItem.kind, "page"), isNull(contentItem.deletedAt)));
    const localesSummary: TreeNode["locales"] = {};
    for (const [code, s] of Object.entries(states)) {
      localesSummary[code] = { status: s.status, hasUnpublishedChanges: s.hasUnpublishedChanges };
    }
    const anyName = Object.values(states)[0]?.name ?? item.documentId;
    nodes.push({
      documentId: item.documentId,
      type: item.type,
      kind: item.kind as TreeNode["kind"],
      parentId: item.parentId,
      sortIndex: item.sortIndex,
      name: anyName,
      locales: localesSummary,
      hasChildren: (childCount[0]?.c ?? 0) > 0,
    });
  }
  return nodes;
}

/* ------------------------------ asset pane -------------------------------- */

/** Shared blocks (kind=block) for the assets pane — flat list with per-locale status. */
export async function listBlocks(db: Database, ctx: AccessContext): Promise<BlockSummary[]> {
  requirePermission(ctx, "content.read");
  const items = await db
    .select()
    .from(contentItem)
    .where(and(eq(contentItem.kind, "block"), isNull(contentItem.deletedAt)))
    .orderBy(asc(contentItem.id));
  const visible = items.filter((i) => ctx.siteWide || ctx.sections.includes(i.sectionId ?? i.documentId));
  const out: BlockSummary[] = [];
  for (const item of visible) {
    const states = await variantStates(db, item.documentId);
    const locales: BlockSummary["locales"] = {};
    for (const [code, s] of Object.entries(states)) {
      locales[code] = { status: s.status, hasUnpublishedChanges: s.hasUnpublishedChanges };
    }
    out.push({
      documentId: item.documentId,
      type: item.type,
      name: Object.values(states)[0]?.name ?? item.documentId,
      locales,
    });
  }
  return out;
}

/* ------------------------------ URL paths --------------------------------- */

/** Working slug for the editor's perspective (draft, else current published, else latest). */
async function workingSlug(db: Database, documentId: string, loc: string): Promise<string | null> {
  const rows = await db
    .select()
    .from(contentVersion)
    .where(and(eq(contentVersion.documentId, documentId), eq(contentVersion.locale, loc)))
    .orderBy(desc(contentVersion.versionNumber));
  const row = rows.find((r) => r.status === "draft") ?? rows.find((r) => r.isCurrentPublished) ?? rows[0];
  return row?.slug ?? null;
}

/**
 * Hierarchical URL for a page built from the chain of ancestor slugs (root→leaf),
 * e.g. /home/about/team. Pages only; returns null for blocks/globals. Cycle-safe.
 */
export async function computePath(db: Database, documentId: string, loc: string): Promise<string | null> {
  const segments: string[] = [];
  const guard = new Set<string>();
  let cur: string | null = documentId;
  while (cur && !guard.has(cur)) {
    guard.add(cur);
    const rows: (typeof contentItem.$inferSelect)[] = await db
      .select()
      .from(contentItem)
      .where(eq(contentItem.documentId, cur))
      .limit(1);
    const item = rows[0];
    if (!item || item.kind !== "page") return null;
    const slug = await workingSlug(db, cur, loc);
    if (slug) segments.unshift(slug);
    cur = item.parentId;
  }
  return `/${segments.join("/")}`;
}

/** Reject a URL segment already used by a page sibling (same parent + locale). */
async function assertSlugUnique(
  db: Database,
  documentId: string,
  parentId: string | null,
  loc: string,
  slug: string,
): Promise<void> {
  const siblings = await db
    .select({ documentId: contentItem.documentId })
    .from(contentItem)
    .where(
      and(
        parentId === null ? isNull(contentItem.parentId) : eq(contentItem.parentId, parentId),
        eq(contentItem.kind, "page"),
        isNull(contentItem.deletedAt),
      ),
    );
  for (const sib of siblings) {
    if (sib.documentId === documentId) continue;
    if ((await workingSlug(db, sib.documentId, loc)) === slug) {
      throw Errors.conflict(`Another page already uses the URL segment "${slug}" here`);
    }
  }
}

/* ------------------------------- create ----------------------------------- */

export async function createContent(
  db: Database,
  ctx: AccessContext,
  req: CreateContentRequest,
): Promise<ContentDetail> {
  requirePermission(ctx, "content.create");
  const type = await getContentType(db, req.type);

  let sectionId: string | null = null;
  let parent: typeof contentItem.$inferSelect | null = null;
  if (req.parentId) {
    parent = await loadAuthorized(db, ctx, req.parentId);
    sectionId = parent.sectionId ?? parent.documentId;
  }

  const documentId = nanoid(24);
  // A new top-level item is its own section.
  const effectiveSection = sectionId ?? documentId;
  if (!ctx.siteWide && !ctx.sections.includes(effectiveSection)) {
    throw Errors.forbidden("Cannot create content outside your sections");
  }

  await db.insert(contentItem).values({
    documentId,
    type: type.name,
    kind: type.kind,
    parentId: req.parentId,
    sortIndex: 0,
    sectionId: effectiveSection,
    createdBy: ctx.userId,
  });
  await db.insert(contentVersion).values({
    documentId,
    locale: req.locale,
    status: "draft",
    isCurrentPublished: false,
    versionNumber: 1,
    name: req.name,
    slug: null,
    displayInNav: true,
    data: {},
    cv: 0,
    createdBy: ctx.userId,
  });

  return getContent(db, ctx, documentId, req.locale);
}

/* ------------------------------ read (mgmt) ------------------------------- */

/**
 * Management read: returns the WORKING perspective for the editor — the draft
 * if one exists, otherwise the current published version. Falls back across the
 * locale chain only for read display when the requested locale has no version.
 */
export async function getContent(
  db: Database,
  ctx: AccessContext,
  documentId: string,
  loc: string,
): Promise<ContentDetail> {
  requirePermission(ctx, "content.read");
  const item = await loadAuthorized(db, ctx, documentId);

  const rows = await db
    .select()
    .from(contentVersion)
    .where(and(eq(contentVersion.documentId, documentId), eq(contentVersion.locale, loc)))
    .orderBy(desc(contentVersion.versionNumber));

  const draft = rows.find((r) => r.status === "draft");
  const published = rows.find((r) => r.isCurrentPublished);
  // Working perspective: draft, else live published, else the latest version
  // (e.g. an unpublished item is no longer live but is still editable).
  const working = draft ?? published ?? rows[0];

  if (!working) {
    // No variant exists for this locale yet — return a blank, NON-persisted
    // draft scaffold so the editor can create the translation. The first save
    // (updateContent) materialises the row.
    const anyName = await db
      .select({ name: contentVersion.name })
      .from(contentVersion)
      .where(eq(contentVersion.documentId, documentId))
      .orderBy(desc(contentVersion.versionNumber))
      .limit(1);
    return {
      documentId: item.documentId,
      type: item.type,
      kind: item.kind as ContentDetail["kind"],
      parentId: item.parentId,
      sortIndex: item.sortIndex,
      locale: loc,
      status: "draft",
      hasUnpublishedChanges: false,
      versionNumber: 0,
      name: anyName[0]?.name ?? "Untitled",
      slug: null,
      urlPath: null,
      displayInNav: true,
      data: {},
      publishAt: null,
      expireAt: null,
      updatedAt: new Date().toISOString(),
      updatedBy: null,
    };
  }

  const urlPath = item.kind === "page" ? await computePath(db, documentId, loc) : null;
  return {
    documentId: item.documentId,
    type: item.type,
    kind: item.kind as ContentDetail["kind"],
    parentId: item.parentId,
    sortIndex: item.sortIndex,
    locale: loc,
    status: published ? "published" : "draft",
    hasUnpublishedChanges: Boolean(draft),
    versionNumber: working.versionNumber,
    name: working.name,
    slug: working.slug,
    urlPath,
    displayInNav: working.displayInNav,
    data: working.data as Record<string, unknown>,
    publishAt: working.publishAt ? working.publishAt.toISOString() : null,
    expireAt: working.expireAt ? working.expireAt.toISOString() : null,
    updatedAt: working.createdAt.toISOString(),
    updatedBy: working.createdBy,
  };
}

/* ------------------------------ update/save ------------------------------- */

/** Turn a Zod parse error into a concise, human message naming the field(s). */
function formatValidation(err: { issues?: Array<{ path: (string | number)[]; message: string }> }): string {
  const issues = err.issues ?? [];
  if (!issues.length) return "Some fields are invalid";
  return issues
    .slice(0, 6)
    .map((i) => {
      const field = i.path.filter((p) => typeof p === "string").join(".") || "value";
      const msg = i.message === "Required" ? "is required" : i.message;
      return `${field}: ${msg}`;
    })
    .join("; ");
}

/**
 * Like formatValidation, but appends each failing field's expected JSON shape
 * and an example — so a caller (notably an MCP agent) can self-correct rather
 * than guess. e.g. `intro: Expected string, received object — 'intro' is a text
 * field; send a plain string (example: "Some text")`.
 */
function formatDataValidation(
  err: { issues?: Array<{ path: (string | number)[]; message: string }> },
  type: ContentTypeDef,
): string {
  const issues = err.issues ?? [];
  if (!issues.length) return "Some fields are invalid";
  return issues
    .slice(0, 6)
    .map((i) => {
      const path = i.path.filter((p) => typeof p === "string") as string[];
      const field = path.join(".") || "value";
      const base = i.message === "Required" ? "is required" : i.message;
      const def = type.fields.find((f) => f.name === path[0]);
      if (!def) return `${field}: ${base}`;
      const { format, example } = fieldFormatHint(def);
      return `${field}: ${base} — '${def.name}' is a ${def.type} field; send ${format} (example: ${JSON.stringify(example)})`;
    })
    .join("; ");
}

/** The current working data for a variant: the draft's, else the published version's, else {}. */
async function workingData(db: Database, documentId: string, loc: string): Promise<Record<string, unknown>> {
  const rows = await db
    .select()
    .from(contentVersion)
    .where(and(eq(contentVersion.documentId, documentId), eq(contentVersion.locale, loc)));
  const draft = rows.find((r) => r.status === "draft");
  const published = rows.find((r) => r.isCurrentPublished);
  return ((draft ?? published)?.data as Record<string, unknown> | undefined) ?? {};
}

/**
 * Enforce per-field placement rules ("allowed types"): a contentArea
 * only accepts blocks whose type is in `allowedBlocks`; a reference only accepts
 * targets whose type is in `allowedTypes`. Empty list = unrestricted. This makes
 * the editor hint a real, write-enforced invariant (an API client cannot bypass
 * it). Throws Errors.validation on the first violation.
 */
function assertAllowedTypes(type: ContentTypeDef, data: Record<string, unknown>): void {
  for (const f of type.fields) {
    const v = data[f.name];
    if (v == null) continue;
    if (f.type === "reference" && f.allowedTypes.length && typeof v === "object") {
      const rt = (v as { type?: string }).type;
      if (rt && !f.allowedTypes.includes(rt)) {
        throw Errors.validation(`Field "${f.name}" does not allow references to "${rt}"`);
      }
    }
    if (f.type === "contentArea" && f.allowedBlocks.length && Array.isArray(v)) {
      for (const b of v as Array<{ blockType?: string }>) {
        const bt = b?.blockType;
        if (bt && !f.allowedBlocks.includes(bt)) {
          throw Errors.validation(`Content area "${f.name}" does not allow block "${bt}"`);
        }
      }
    }
  }
}

/** Reads, validates and persists references for a (document, locale) data blob. */
async function rebuildReferences(
  db: Database,
  documentId: string,
  loc: string,
  type: ContentTypeDef,
  data: Record<string, unknown>,
): Promise<void> {
  await db
    .delete(contentReference)
    .where(
      and(
        eq(contentReference.fromDocumentId, documentId),
        eq(contentReference.fromLocale, loc),
      ),
    );
  const refs: (typeof contentReference.$inferInsert)[] = [];
  for (const f of type.fields) {
    const v = data[f.name];
    if (v == null) continue;
    if (f.type === "reference" && typeof v === "object") {
      const rv = v as { documentId?: string; type?: string };
      if (rv.documentId)
        refs.push({
          fromDocumentId: documentId,
          fromLocale: loc,
          toDocumentId: rv.documentId,
          toType: rv.type ?? "",
          fieldName: f.name,
        });
    }
    if (f.type === "contentArea" && Array.isArray(v)) {
      for (const block of v as Array<{ ref?: string | null; blockType?: string }>) {
        if (block?.ref)
          refs.push({
            fromDocumentId: documentId,
            fromLocale: loc,
            toDocumentId: block.ref,
            toType: block.blockType ?? "",
            fieldName: f.name,
          });
      }
    }
  }
  if (refs.length) await db.insert(contentReference).values(refs);
}

export async function updateContent(
  db: Database,
  ctx: AccessContext,
  documentId: string,
  loc: string,
  req: UpdateContentRequest,
): Promise<ContentDetail> {
  requirePermission(ctx, "content.update");
  const item = await loadAuthorized(db, ctx, documentId);
  const type = await getContentType(db, item.type);

  // Merge mode: shallow-merge the patch over the current working data so a
  // caller can change one field without round-tripping the whole map.
  const merged = req.merge ? { ...(await workingData(db, documentId, loc)), ...req.data } : req.data;
  // Tolerant coercion: fix the unambiguous field-shape mistakes agents make
  // (single block → array, doc → text, string → doc) before validating.
  const data = coerceData(type, merged);

  // Draft save: relaxed validation (required fields not enforced). On failure
  // the message names each field's expected JSON shape (with an example), so an
  // agent can self-correct instead of guessing.
  const parsed = dataSchemaFor(type, false).safeParse(data);
  if (!parsed.success) throw Errors.validation(formatDataValidation(parsed.error, type));
  // Placement rules ARE enforced even on draft save (allowed blocks / ref types).
  assertAllowedTypes(type, data);

  // URL segments must be unique among page siblings (per locale) so paths are unambiguous.
  if (item.kind === "page" && req.slug) {
    await assertSlugUnique(db, documentId, item.parentId, loc, req.slug);
  }

  // Find or create the working draft (single-draft invariant).
  const existing = await db
    .select()
    .from(contentVersion)
    .where(
      and(
        eq(contentVersion.documentId, documentId),
        eq(contentVersion.locale, loc),
        eq(contentVersion.status, "draft"),
      ),
    )
    .limit(1);

  if (existing[0]) {
    await db
      .update(contentVersion)
      .set({
        name: req.name ?? existing[0].name,
        slug: req.slug !== undefined ? req.slug : existing[0].slug,
        displayInNav: req.displayInNav ?? existing[0].displayInNav,
        data,
        createdBy: ctx.userId,
        createdAt: new Date(),
      })
      .where(eq(contentVersion.id, existing[0].id));
  } else {
    // No working draft yet (editing a published OR an unpublished item): seed a
    // draft from the best available base — the live published version, else the
    // latest version of any status. Using the latest version is what prevents an
    // unpublished page (no current-published row) from losing its name/slug on
    // the next edit.
    const maxV = await nextVersionNumber(db, documentId, loc);
    const base = (await currentPublished(db, documentId, loc)) ?? (await latestVersion(db, documentId, loc));
    await db.insert(contentVersion).values({
      documentId,
      locale: loc,
      status: "draft",
      isCurrentPublished: false,
      versionNumber: maxV,
      name: req.name ?? base?.name ?? "Untitled",
      slug: req.slug !== undefined ? req.slug : (base?.slug ?? null),
      displayInNav: req.displayInNav ?? base?.displayInNav ?? true,
      data,
      createdBy: ctx.userId,
    });
  }

  await rebuildReferences(db, documentId, loc, type, data);
  return getContent(db, ctx, documentId, loc);
}

async function nextVersionNumber(db: Database, documentId: string, loc: string): Promise<number> {
  const rows = await db
    .select({ m: sql<number>`coalesce(max(${contentVersion.versionNumber}),0)::int` })
    .from(contentVersion)
    .where(and(eq(contentVersion.documentId, documentId), eq(contentVersion.locale, loc)));
  return (rows[0]?.m ?? 0) + 1;
}

/** The highest-versionNumber row for a variant, regardless of status. */
async function latestVersion(db: Database, documentId: string, loc: string) {
  const rows = await db
    .select()
    .from(contentVersion)
    .where(and(eq(contentVersion.documentId, documentId), eq(contentVersion.locale, loc)))
    .orderBy(desc(contentVersion.versionNumber))
    .limit(1);
  return rows[0] ?? null;
}

async function currentPublished(db: Database, documentId: string, loc: string) {
  const rows = await db
    .select()
    .from(contentVersion)
    .where(
      and(
        eq(contentVersion.documentId, documentId),
        eq(contentVersion.locale, loc),
        eq(contentVersion.isCurrentPublished, true),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/* -------------------------------- publish --------------------------------- */

/** Strict pre-publish checks: full validation, placement rules, sibling slug uniqueness. */
async function assertDraftPublishable(
  db: Database,
  item: typeof contentItem.$inferSelect,
  loc: string,
  draft: typeof contentVersion.$inferSelect,
): Promise<void> {
  const type = await getContentType(db, item.type);
  const parsed = dataSchemaFor(type, true).safeParse(draft.data);
  if (!parsed.success) throw Errors.validation(formatValidation(parsed.error));
  assertAllowedTypes(type, draft.data as Record<string, unknown>);
  // Defence-in-depth: sibling URL segments stay unique at publish time too.
  if (item.kind === "page" && draft.slug) {
    await assertSlugUnique(db, item.documentId, item.parentId, loc, draft.slug);
  }
}

/**
 * Core publish promotion (NO RBAC — callers authorize). Demotes the prior
 * current-published row and promotes `draftId` to live, allocating a fresh cv
 * atomically and clearing its scheduled publish_at. Any expire_at already on the
 * row is preserved (it becomes the live row's expiry). Shared by the manual
 * publish route AND the scheduled-publish ticker.
 */
async function promoteDraft(
  db: Database,
  documentId: string,
  loc: string,
  draftId: number,
  actorUserId: string | null,
): Promise<void> {
  await db.transaction(async (tx) => {
    // Allocate the cache-version atomically with the promotion.
    const cvRow = await tx.execute(sql`SELECT nextval('cv_seq') AS v`);
    const cv = Number((cvRow as unknown as Array<{ v: string }>)[0]?.v ?? 0);
    // Demote previous published row for this variant.
    await tx
      .update(contentVersion)
      .set({ isCurrentPublished: false })
      .where(
        and(
          eq(contentVersion.documentId, documentId),
          eq(contentVersion.locale, loc),
          eq(contentVersion.isCurrentPublished, true),
        ),
      );
    // Promote the draft to the live published version for this variant.
    await tx
      .update(contentVersion)
      .set({ status: "published", isCurrentPublished: true, cv, createdBy: actorUserId, publishAt: null })
      .where(eq(contentVersion.id, draftId));
  });
}

export async function publishContent(
  db: Database,
  ctx: AccessContext,
  documentId: string,
  loc: string,
): Promise<ContentDetail> {
  requirePermission(ctx, "content.publish");
  const item = await loadAuthorized(db, ctx, documentId);

  const draftRows = await db
    .select()
    .from(contentVersion)
    .where(
      and(
        eq(contentVersion.documentId, documentId),
        eq(contentVersion.locale, loc),
        eq(contentVersion.status, "draft"),
      ),
    )
    .limit(1);
  const draft = draftRows[0];
  if (!draft) {
    // Unpublish → publish must round-trip. Unpublishing only demotes the live
    // row (no draft is left behind), so with no draft to promote, re-promote
    // the latest version of this variant instead of refusing.
    const latest = await latestVersion(db, documentId, loc);
    if (!latest || latest.isCurrentPublished) {
      throw Errors.conflict("Nothing to publish (no draft changes)");
    }
    await assertDraftPublishable(db, item, loc, latest);
    await promoteDraft(db, documentId, loc, latest.id, ctx.userId);
    return getContent(db, ctx, documentId, loc);
  }

  await assertDraftPublishable(db, item, loc, draft);
  await promoteDraft(db, documentId, loc, draft.id, ctx.userId);
  return getContent(db, ctx, documentId, loc);
}

/* ---------------------------- scheduled publish --------------------------- */

/**
 * Schedule a draft to publish at `publishAt` and/or expire at `expireAt`.
 * - future `publishAt`: the draft keeps the schedule; the ticker
 *   (runScheduledPublish) promotes it when due. Validated strictly NOW so a
 *   scheduled publish can't silently fail later.
 * - now/past `publishAt`: publishes immediately (carrying `expireAt`).
 * - null `publishAt`: (re)sets/clears expiry on the draft and/or the live
 *   published row, and cancels any pending scheduled publish.
 */
export async function schedulePublish(
  db: Database,
  ctx: AccessContext,
  documentId: string,
  loc: string,
  opts: { publishAt: Date | null; expireAt: Date | null },
): Promise<ContentDetail> {
  requirePermission(ctx, "content.publish");
  const item = await loadAuthorized(db, ctx, documentId);
  const now = new Date();

  if (opts.expireAt && opts.publishAt && opts.expireAt <= opts.publishAt) {
    throw Errors.badRequest("Expiry must be after the publish time");
  }

  const draft = (
    await db
      .select()
      .from(contentVersion)
      .where(
        and(
          eq(contentVersion.documentId, documentId),
          eq(contentVersion.locale, loc),
          eq(contentVersion.status, "draft"),
        ),
      )
      .limit(1)
  )[0];

  // Future scheduled publish of the working draft.
  if (opts.publishAt && opts.publishAt > now) {
    if (!draft) throw Errors.conflict("Nothing to schedule (no draft changes)");
    await assertDraftPublishable(db, item, loc, draft);
    await db
      .update(contentVersion)
      .set({ publishAt: opts.publishAt, expireAt: opts.expireAt ?? null })
      .where(eq(contentVersion.id, draft.id));
    return getContent(db, ctx, documentId, loc);
  }

  // Immediate publish (publishAt now/past), carrying the requested expiry.
  if (opts.publishAt) {
    if (!draft) throw Errors.conflict("Nothing to publish (no draft changes)");
    await assertDraftPublishable(db, item, loc, draft);
    await db
      .update(contentVersion)
      .set({ publishAt: null, expireAt: opts.expireAt ?? null })
      .where(eq(contentVersion.id, draft.id));
    await promoteDraft(db, documentId, loc, draft.id, ctx.userId);
    // Manual publish fires its webhook from the route; this query-layer path fires
    // its own (fire-and-forget, same payload) so integrations see the publish.
    const urlPath = item.kind === "page" ? await computePath(db, documentId, loc) : null;
    void dispatchWebhooks(db, {
      event: "content.published",
      documentId,
      type: item.type,
      kind: item.kind,
      locale: loc,
      name: draft.name,
      urlPath,
      at: new Date().toISOString(),
    }).catch(() => undefined);
    return getContent(db, ctx, documentId, loc);
  }

  // No publishAt: (re)set/clear expiry, cancel any pending scheduled publish.
  if (draft) {
    await db
      .update(contentVersion)
      .set({ publishAt: null, expireAt: opts.expireAt ?? null })
      .where(eq(contentVersion.id, draft.id));
  }
  const published = await currentPublished(db, documentId, loc);
  if (published) {
    await db
      .update(contentVersion)
      .set({ expireAt: opts.expireAt ?? null })
      .where(eq(contentVersion.id, published.id));
  }
  if (!draft && !published) throw Errors.conflict("Nothing to schedule");
  return getContent(db, ctx, documentId, loc);
}

/**
 * Promote due scheduled drafts and expire due published rows. SYSTEM action (no
 * ctx): the schedule was authorized when set. Idempotent and safe to run on an
 * interval; fires the same publish/unpublish webhooks as the manual path. `now`
 * is injectable for tests.
 */
export async function runScheduledPublish(
  db: Database,
  now: Date = new Date(),
): Promise<{ published: number; expired: number; failed: number }> {
  let published = 0;
  let expired = 0;
  let failed = 0;

  // --- promote due scheduled drafts ---
  const due = await db
    .select()
    .from(contentVersion)
    .where(
      and(
        eq(contentVersion.status, "draft"),
        isNotNull(contentVersion.publishAt),
        lte(contentVersion.publishAt, now),
      ),
    );
  for (const d of due) {
    try {
      const item = (
        await db
          .select()
          .from(contentItem)
          .where(and(eq(contentItem.documentId, d.documentId), isNull(contentItem.deletedAt)))
          .limit(1)
      )[0];
      if (!item) {
        // Document gone/trashed — drop the stale schedule.
        await db.update(contentVersion).set({ publishAt: null }).where(eq(contentVersion.id, d.id));
        continue;
      }
      const type = await getContentType(db, item.type);
      const parsed = dataSchemaFor(type, true).safeParse(d.data);
      if (!parsed.success) {
        // Re-validation failed (e.g. the type changed since scheduling). Leave as
        // a draft, drop the schedule, and record why so the editor can see it.
        await db.update(contentVersion).set({ publishAt: null }).where(eq(contentVersion.id, d.id));
        await db.insert(auditLog).values({
          action: "content.schedule_failed",
          documentId: d.documentId,
          locale: d.locale,
          detail: { reason: formatValidation(parsed.error) },
        });
        failed++;
        continue;
      }
      await promoteDraft(db, d.documentId, d.locale, d.id, d.createdBy);
      const urlPath = item.kind === "page" ? await computePath(db, d.documentId, d.locale) : null;
      await dispatchWebhooks(db, {
        event: "content.published",
        documentId: d.documentId,
        type: item.type,
        kind: item.kind,
        locale: d.locale,
        name: d.name,
        urlPath,
        at: new Date().toISOString(),
      });
      published++;
    } catch {
      failed++;
    }
  }

  // --- expire due published rows ---
  const stale = await db
    .select()
    .from(contentVersion)
    .where(
      and(
        eq(contentVersion.isCurrentPublished, true),
        isNotNull(contentVersion.expireAt),
        lte(contentVersion.expireAt, now),
      ),
    );
  for (const s of stale) {
    await db.update(contentVersion).set({ isCurrentPublished: false }).where(eq(contentVersion.id, s.id));
    const item = (
      await db.select().from(contentItem).where(eq(contentItem.documentId, s.documentId)).limit(1)
    )[0];
    const urlPath = item && item.kind === "page" ? await computePath(db, s.documentId, s.locale) : null;
    await dispatchWebhooks(db, {
      event: "content.unpublished",
      documentId: s.documentId,
      type: item?.type ?? "",
      kind: item?.kind ?? "",
      locale: s.locale,
      name: s.name,
      urlPath,
      at: new Date().toISOString(),
    });
    expired++;
  }

  return { published, expired, failed };
}

export async function unpublishContent(
  db: Database,
  ctx: AccessContext,
  documentId: string,
  loc: string,
): Promise<ContentDetail> {
  requirePermission(ctx, "content.publish");
  await loadAuthorized(db, ctx, documentId);
  await db
    .update(contentVersion)
    .set({ isCurrentPublished: false })
    .where(
      and(
        eq(contentVersion.documentId, documentId),
        eq(contentVersion.locale, loc),
        eq(contentVersion.isCurrentPublished, true),
      ),
    );
  return getContent(db, ctx, documentId, loc);
}

export async function discardDraft(
  db: Database,
  ctx: AccessContext,
  documentId: string,
  loc: string,
): Promise<void> {
  requirePermission(ctx, "content.update");
  await loadAuthorized(db, ctx, documentId);
  await db
    .delete(contentVersion)
    .where(
      and(
        eq(contentVersion.documentId, documentId),
        eq(contentVersion.locale, loc),
        eq(contentVersion.status, "draft"),
      ),
    );
}

/* --------------------------------- move ----------------------------------- */

/**
 * Reorder a content item among its siblings (same parent). `beforeId`/`afterId`
 * name the sibling to drop next to; omit both to move to the end. Reorder-only
 * (parent is not changed). Renumbers the whole sibling group by 10s.
 */
/**
 * Move a page within the hierarchy. `parentId === undefined` → reorder among the
 * current siblings (sortIndex only). Otherwise RE-PARENT to `parentId` (a page)
 * or to top level (`null`), with guards: destination scope, parent-must-be-page,
 * cycle prevention, per-locale sibling slug-uniqueness, and a sectionId cascade
 * over the moved subtree — all atomic. URLs recompute automatically; moving under
 * an unpublished parent is allowed (it simply isn't reachable by public path yet).
 */
export async function moveContent(
  db: Database,
  ctx: AccessContext,
  documentId: string,
  opts: { parentId?: string | null; beforeId?: string | null; afterId?: string | null },
): Promise<void> {
  requirePermission(ctx, "content.update");
  const item = await loadAuthorized(db, ctx, documentId);

  const reparent = opts.parentId !== undefined && opts.parentId !== item.parentId;
  let targetParentId: string | null = item.parentId;
  let newSection: string = item.sectionId ?? item.documentId;

  if (reparent) {
    const newParentId = opts.parentId ?? null;
    if (newParentId === null) {
      // Top level → the page becomes its own section root.
      newSection = documentId;
      if (!ctx.siteWide && !ctx.sections.includes(documentId)) {
        throw Errors.forbidden("Cannot move content to a section outside your scope");
      }
    } else {
      if (newParentId === documentId) throw Errors.conflict("Cannot move a page under itself");
      const newParent = await loadAuthorized(db, ctx, newParentId); // scope-checks the destination
      if (newParent.kind !== "page") throw Errors.badRequest("Pages can only be nested under pages");
      // Cycle prevention: walk up from the destination; reaching the moved page = its own descendant.
      const guard = new Set<string>();
      let cur: string | null = newParentId;
      while (cur && !guard.has(cur)) {
        guard.add(cur);
        if (cur === documentId) throw Errors.conflict("Cannot move a page under its own descendant");
        const rows: { parentId: string | null }[] = await db
          .select({ parentId: contentItem.parentId })
          .from(contentItem)
          .where(eq(contentItem.documentId, cur))
          .limit(1);
        cur = rows[0]?.parentId ?? null;
      }
      newSection = newParent.sectionId ?? newParent.documentId;
      if (!ctx.siteWide && !ctx.sections.includes(newSection)) {
        throw Errors.forbidden("Cannot move content into a section outside your scope");
      }
    }
    targetParentId = newParentId;

    // Sibling URL-segment uniqueness at the destination, for every locale that has a segment.
    const localeRows = await db
      .select({ locale: contentVersion.locale })
      .from(contentVersion)
      .where(eq(contentVersion.documentId, documentId));
    for (const locale of new Set(localeRows.map((r) => r.locale))) {
      const slug = await workingSlug(db, documentId, locale);
      if (slug) await assertSlugUnique(db, documentId, targetParentId, locale, slug);
    }
  }

  await db.transaction(async (tx) => {
    if (reparent) {
      await tx
        .update(contentItem)
        .set({ parentId: targetParentId, sectionId: newSection })
        .where(eq(contentItem.documentId, documentId));
      // Cascade the new section to the whole moved subtree (guarded downward BFS).
      const visited = new Set<string>([documentId]);
      let frontier = [documentId];
      while (frontier.length) {
        const kids = await tx
          .select({ documentId: contentItem.documentId })
          .from(contentItem)
          .where(and(inArray(contentItem.parentId, frontier), isNull(contentItem.deletedAt)));
        const next = kids.map((k) => k.documentId).filter((id) => !visited.has(id));
        next.forEach((id) => visited.add(id));
        if (next.length) {
          await tx.update(contentItem).set({ sectionId: newSection }).where(inArray(contentItem.documentId, next));
        }
        frontier = next;
      }
    }

    // Order within the destination sibling group (now includes the moved node).
    const siblings = await tx
      .select({ documentId: contentItem.documentId })
      .from(contentItem)
      .where(
        and(
          targetParentId === null ? isNull(contentItem.parentId) : eq(contentItem.parentId, targetParentId),
          isNull(contentItem.deletedAt),
        ),
      )
      .orderBy(asc(contentItem.sortIndex), asc(contentItem.id));
    const ids = siblings.map((s) => s.documentId).filter((id) => id !== documentId);
    let insertAt = ids.length;
    if (opts.beforeId && ids.includes(opts.beforeId)) insertAt = ids.indexOf(opts.beforeId);
    else if (opts.afterId && ids.includes(opts.afterId)) insertAt = ids.indexOf(opts.afterId) + 1;
    ids.splice(insertAt, 0, documentId);
    for (let i = 0; i < ids.length; i++) {
      await tx.update(contentItem).set({ sortIndex: i * 10 }).where(eq(contentItem.documentId, ids[i]!));
    }
  });
}

/** Flat list of all pages in scope (id, name, parentId) — powers the "Move to" picker. */
export async function listPages(
  db: Database,
  ctx: AccessContext,
): Promise<{ documentId: string; name: string; parentId: string | null; type: string }[]> {
  requirePermission(ctx, "content.read");
  const items = await db
    .select()
    .from(contentItem)
    .where(and(eq(contentItem.kind, "page"), isNull(contentItem.deletedAt)))
    .orderBy(asc(contentItem.sortIndex), asc(contentItem.id));
  const visible = items.filter((i) => ctx.siteWide || ctx.sections.includes(i.sectionId ?? i.documentId));
  const out: { documentId: string; name: string; parentId: string | null; type: string }[] = [];
  for (const item of visible) {
    const states = await variantStates(db, item.documentId);
    out.push({ documentId: item.documentId, name: Object.values(states)[0]?.name ?? item.documentId, parentId: item.parentId, type: item.type });
  }
  return out;
}

/* -------------------------------- search ---------------------------------- */

export interface SearchHit {
  documentId: string;
  type: string;
  kind: "page" | "block" | "global";
  name: string;
  locale: string;
  urlPath: string | null;
}

/**
 * Full-text-ish content search (Phase A): case-insensitive match on the version
 * name/URL segment across EVERY in-scope document (pages + blocks), not just the
 * loaded tree. Deny-by-default scope (siteWide or section-scoped); excludes trash.
 * One hit per document, preferring the published-then-latest matching version.
 */
export async function searchContent(
  db: Database,
  ctx: AccessContext,
  query: string,
  opts: { limit?: number } = {},
): Promise<SearchHit[]> {
  requirePermission(ctx, "content.read");
  const q = query.trim();
  if (q.length < 1) return [];
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
  // Escape LIKE metacharacters (Postgres default ESCAPE is backslash).
  const pattern = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;

  const rows = await db
    .select({
      documentId: contentVersion.documentId,
      locale: contentVersion.locale,
      name: contentVersion.name,
      type: contentItem.type,
      kind: contentItem.kind,
      sectionId: contentItem.sectionId,
    })
    .from(contentVersion)
    .innerJoin(contentItem, eq(contentItem.documentId, contentVersion.documentId))
    .where(
      and(
        isNull(contentItem.deletedAt),
        or(ilike(contentVersion.name, pattern), ilike(contentVersion.slug, pattern)),
      ),
    )
    .orderBy(
      asc(contentVersion.documentId),
      desc(contentVersion.isCurrentPublished),
      desc(contentVersion.versionNumber),
    );

  const seen = new Set<string>();
  const hits: SearchHit[] = [];
  for (const r of rows) {
    if (seen.has(r.documentId)) continue;
    if (!(ctx.siteWide || ctx.sections.includes(r.sectionId ?? r.documentId))) continue;
    seen.add(r.documentId);
    hits.push({
      documentId: r.documentId,
      type: r.type,
      kind: r.kind as SearchHit["kind"],
      name: r.name,
      locale: r.locale,
      urlPath: null,
    });
    if (hits.length >= limit) break;
  }
  // Hierarchical URL only for the (bounded) page hits.
  for (const h of hits) {
    if (h.kind === "page") h.urlPath = await computePath(db, h.documentId, h.locale);
  }
  return hits;
}

/* -------------------------------- versions -------------------------------- */

export async function listVersions(
  db: Database,
  ctx: AccessContext,
  documentId: string,
  loc: string,
) {
  requirePermission(ctx, "content.read");
  await loadAuthorized(db, ctx, documentId);
  return db
    .select({
      id: contentVersion.id,
      versionNumber: contentVersion.versionNumber,
      status: contentVersion.status,
      isCurrentPublished: contentVersion.isCurrentPublished,
      name: contentVersion.name,
      createdAt: contentVersion.createdAt,
      createdBy: contentVersion.createdBy,
      publishAt: contentVersion.publishAt,
      expireAt: contentVersion.expireAt,
    })
    .from(contentVersion)
    .where(and(eq(contentVersion.documentId, documentId), eq(contentVersion.locale, loc)))
    .orderBy(desc(contentVersion.versionNumber));
}

/**
 * Full payload of one historical version (for the compare/diff view). Scope-checked
 * like every read; the version must belong to (documentId, loc).
 */
export async function getVersion(
  db: Database,
  ctx: AccessContext,
  documentId: string,
  loc: string,
  versionId: number,
) {
  requirePermission(ctx, "content.read");
  await loadAuthorized(db, ctx, documentId);
  const rows = await db
    .select()
    .from(contentVersion)
    .where(
      and(
        eq(contentVersion.id, versionId),
        eq(contentVersion.documentId, documentId),
        eq(contentVersion.locale, loc),
      ),
    )
    .limit(1);
  const v = rows[0];
  if (!v) throw Errors.notFound("Version");
  return {
    id: v.id,
    versionNumber: v.versionNumber,
    status: v.status as "draft" | "published",
    isCurrentPublished: v.isCurrentPublished,
    name: v.name,
    slug: v.slug,
    displayInNav: v.displayInNav,
    data: v.data as Record<string, unknown>,
    createdAt: v.createdAt.toISOString(),
    createdBy: v.createdBy,
  };
}

/**
 * Restore a historical version's payload as the working draft (like
 * "republish a previous version" — but as a draft the editor can review before
 * publishing). The named version must belong to (documentId, loc). Reuses the
 * single-draft invariant: updates the existing draft, else seeds a new one.
 */
export async function restoreVersion(
  db: Database,
  ctx: AccessContext,
  documentId: string,
  loc: string,
  versionId: number,
): Promise<ContentDetail> {
  requirePermission(ctx, "content.update");
  const item = await loadAuthorized(db, ctx, documentId);
  const type = await getContentType(db, item.type);

  const srcRows = await db
    .select()
    .from(contentVersion)
    .where(and(eq(contentVersion.id, versionId), eq(contentVersion.documentId, documentId), eq(contentVersion.locale, loc)))
    .limit(1);
  const src = srcRows[0];
  if (!src) throw Errors.notFound("Version");

  // Coerce on restore too: a historic version may predate the richtext
  // sanitizer and still contain editor-breaking TipTap (one such node blanks
  // the whole doc in the admin), so it must not re-enter the working draft raw.
  const data = coerceData(type, src.data as Record<string, unknown>);
  // Slug must stay unique among page siblings (the source slug may now collide).
  if (item.kind === "page" && src.slug) {
    await assertSlugUnique(db, documentId, item.parentId, loc, src.slug);
  }

  const existingDraft = await db
    .select()
    .from(contentVersion)
    .where(and(eq(contentVersion.documentId, documentId), eq(contentVersion.locale, loc), eq(contentVersion.status, "draft")))
    .limit(1);
  if (existingDraft[0]) {
    await db
      .update(contentVersion)
      .set({ name: src.name, slug: src.slug, displayInNav: src.displayInNav, data, createdBy: ctx.userId, createdAt: new Date(), comment: `Restored from v${src.versionNumber}` })
      .where(eq(contentVersion.id, existingDraft[0].id));
  } else {
    await db.insert(contentVersion).values({
      documentId,
      locale: loc,
      status: "draft",
      isCurrentPublished: false,
      versionNumber: await nextVersionNumber(db, documentId, loc),
      name: src.name,
      slug: src.slug,
      displayInNav: src.displayInNav,
      data,
      createdBy: ctx.userId,
      comment: `Restored from v${src.versionNumber}`,
    });
  }
  await rebuildReferences(db, documentId, loc, type, data);
  return getContent(db, ctx, documentId, loc);
}

/* --------------------------------- clone ---------------------------------- */

/**
 * Duplicate a content item as a sibling. Copies the working version of EVERY
 * locale (draft, else published, else latest) into fresh drafts on a new
 * document. Page slugs are cleared (forces re-entry → URL uniqueness). The new
 * document inherits type/kind/parent/section and lands at the end of its group.
 */
export async function cloneContent(
  db: Database,
  ctx: AccessContext,
  documentId: string,
  loc: string,
): Promise<ContentDetail> {
  requirePermission(ctx, "content.create");
  const src = await loadAuthorized(db, ctx, documentId);
  const type = await getContentType(db, src.type);

  const newId = nanoid(24);
  const section = src.sectionId ?? src.documentId;
  // New top-level page becomes its own section; otherwise inherits source's.
  const newSection = src.parentId ? section : newId;
  if (!ctx.siteWide && !ctx.sections.includes(newSection)) {
    throw Errors.forbidden("Cannot duplicate content outside your sections");
  }

  // Snapshot each locale's working version.
  const allRows = await db
    .select()
    .from(contentVersion)
    .where(eq(contentVersion.documentId, documentId))
    .orderBy(desc(contentVersion.versionNumber));
  const byLocale = new Map<string, typeof contentVersion.$inferSelect>();
  for (const r of allRows) {
    const cur = byLocale.get(r.locale);
    // Prefer draft, then current published, then latest (first seen = highest version).
    if (!cur || (r.status === "draft" && cur.status !== "draft") || (r.isCurrentPublished && cur.status !== "draft" && !cur.isCurrentPublished)) {
      byLocale.set(r.locale, r);
    }
  }

  await db.insert(contentItem).values({
    documentId: newId,
    type: src.type,
    kind: src.kind,
    parentId: src.parentId,
    sortIndex: (src.sortIndex ?? 0) + 1,
    sectionId: newSection,
    createdBy: ctx.userId,
  });
  let count = 0;
  for (const [code, row] of byLocale) {
    // Coerce on clone for the same reason as restoreVersion: the source data
    // may predate the richtext sanitizer.
    const data = coerceData(type, row.data as Record<string, unknown>);
    await db.insert(contentVersion).values({
      documentId: newId,
      locale: code,
      status: "draft",
      isCurrentPublished: false,
      versionNumber: 1,
      name: `${row.name} (copy)`,
      slug: src.kind === "page" ? null : row.slug,
      displayInNav: row.displayInNav,
      data,
      createdBy: ctx.userId,
    });
    await rebuildReferences(db, newId, code, type, data);
    count++;
  }
  // If the source had no version at all, seed an empty draft so the doc is editable.
  if (count === 0) {
    await db.insert(contentVersion).values({
      documentId: newId,
      locale: loc,
      status: "draft",
      isCurrentPublished: false,
      versionNumber: 1,
      name: "Untitled (copy)",
      slug: null,
      displayInNav: true,
      data: {},
      createdBy: ctx.userId,
    });
  }
  return getContent(db, ctx, newId, loc);
}

/* --------------------------------- trash ---------------------------------- */

/** Load an item INCLUDING soft-deleted, with the same scope check as loadAuthorized. */
async function loadAnyState(
  db: Database,
  ctx: AccessContext,
  documentId: string,
): Promise<typeof contentItem.$inferSelect> {
  const rows = await db.select().from(contentItem).where(eq(contentItem.documentId, documentId)).limit(1);
  const item = rows[0];
  if (!item) throw Errors.notFound("Content");
  if (!ctx.siteWide && !ctx.sections.includes(item.sectionId ?? item.documentId)) {
    throw Errors.forbidden("Out of scope for this content");
  }
  return item;
}

/**
 * Soft-delete to trash: marks the item AND its whole page subtree `deletedAt`
 * and unpublishes every locale (so trashed content vanishes from delivery
 * immediately — no-leak). Recoverable via restoreContent. Atomic.
 */
export async function softDelete(
  db: Database,
  ctx: AccessContext,
  documentId: string,
): Promise<{ trashed: number }> {
  requirePermission(ctx, "content.delete");
  await loadAuthorized(db, ctx, documentId);

  // Collect the moved subtree (guarded downward BFS).
  const ids = [documentId];
  const visited = new Set<string>([documentId]);
  let frontier = [documentId];
  while (frontier.length) {
    const kids = await db
      .select({ documentId: contentItem.documentId })
      .from(contentItem)
      .where(and(inArray(contentItem.parentId, frontier), isNull(contentItem.deletedAt)));
    const next = kids.map((k) => k.documentId).filter((id) => !visited.has(id));
    next.forEach((id) => { visited.add(id); ids.push(id); });
    frontier = next;
  }

  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.update(contentItem).set({ deletedAt: now }).where(inArray(contentItem.documentId, ids));
    await tx
      .update(contentVersion)
      .set({ isCurrentPublished: false })
      .where(and(inArray(contentVersion.documentId, ids), eq(contentVersion.isCurrentPublished, true)));
  });
  return { trashed: ids.length };
}

/** Restore from trash (clears deletedAt). Republishing is a separate, explicit step. */
export async function restoreContent(
  db: Database,
  ctx: AccessContext,
  documentId: string,
): Promise<{ restored: number }> {
  requirePermission(ctx, "content.delete");
  const item = await loadAnyState(db, ctx, documentId);
  if (!item.deletedAt) throw Errors.conflict("Item is not in the trash");
  // Cannot restore into a still-trashed parent (would orphan the subtree).
  if (item.parentId) {
    const p = await db.select({ deletedAt: contentItem.deletedAt }).from(contentItem).where(eq(contentItem.documentId, item.parentId)).limit(1);
    if (p[0]?.deletedAt) throw Errors.conflict("Restore the parent page first");
  }

  // Restore the item + descendants that were trashed in the same sweep.
  const ids = [documentId];
  const visited = new Set<string>([documentId]);
  let frontier = [documentId];
  while (frontier.length) {
    const kids = await db
      .select({ documentId: contentItem.documentId })
      .from(contentItem)
      .where(inArray(contentItem.parentId, frontier));
    const next = kids.map((k) => k.documentId).filter((id) => !visited.has(id));
    next.forEach((id) => { visited.add(id); ids.push(id); });
    frontier = next;
  }
  await db.update(contentItem).set({ deletedAt: null }).where(inArray(contentItem.documentId, ids));
  return { restored: ids.length };
}

/** List trashed items in scope (each with its display name) — powers the Trash view. */
export async function listTrash(
  db: Database,
  ctx: AccessContext,
): Promise<{ documentId: string; type: string; kind: string; name: string; deletedAt: string }[]> {
  requirePermission(ctx, "content.read");
  const rows = await db
    .select()
    .from(contentItem)
    .where(sql`${contentItem.deletedAt} is not null`)
    .orderBy(desc(contentItem.deletedAt));
  const visible = rows.filter((i) => ctx.siteWide || ctx.sections.includes(i.sectionId ?? i.documentId));
  const out: { documentId: string; type: string; kind: string; name: string; deletedAt: string }[] = [];
  for (const item of visible) {
    const states = await variantStates(db, item.documentId);
    out.push({
      documentId: item.documentId,
      type: item.type,
      kind: item.kind,
      name: Object.values(states)[0]?.name ?? item.documentId,
      deletedAt: item.deletedAt!.toISOString(),
    });
  }
  return out;
}

/** Permanently delete every trashed item in scope (with its versions + outgoing references). */
export async function emptyTrash(
  db: Database,
  ctx: AccessContext,
): Promise<{ purged: number }> {
  requirePermission(ctx, "content.delete");
  const rows = await db
    .select({ documentId: contentItem.documentId, sectionId: contentItem.sectionId })
    .from(contentItem)
    .where(sql`${contentItem.deletedAt} is not null`);
  const ids = rows
    .filter((i) => ctx.siteWide || ctx.sections.includes(i.sectionId ?? i.documentId))
    .map((i) => i.documentId);
  if (ids.length === 0) return { purged: 0 };
  await db.transaction(async (tx) => {
    await tx.delete(contentReference).where(inArray(contentReference.fromDocumentId, ids));
    await tx.delete(contentVersion).where(inArray(contentVersion.documentId, ids));
    await tx.delete(contentItem).where(inArray(contentItem.documentId, ids));
  });
  return { purged: ids.length };
}
