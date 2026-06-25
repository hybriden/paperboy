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
  detectContentLanguage,
  expectedLanguageForLocale,
  fieldFormatHint,
  stripSeoGroup,
  tiptapToPlainText,
  withSeoGroup,
} from "@paperboy/shared";
import type { Database } from "./client.js";
import { Errors } from "./errors.js";
import {
  type AccessContext,
  loadAuthorized,
  requirePermission,
} from "./scope.js";
import { auditLog, contentItem, contentReference, contentType, contentVersion, locale } from "./schema.js";
import { getAgentReviewRequired } from "./site.js";
import { dispatchWebhooks } from "./webhooks.js";

/** Postgres unique-constraint violation (SQLSTATE 23505) — used to turn a losing
 *  concurrent write into a self-teaching 409 instead of an opaque 500. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

/* ----------------------------- content types ----------------------------- */

export async function listContentTypes(db: Database): Promise<ContentTypeDef[]> {
  const rows = await db.select().from(contentType).orderBy(asc(contentType.name));
  // Inject the reserved SEO group into every page kind (single read chokepoint).
  return rows.map((r) => withSeoGroup(r.definition as ContentTypeDef));
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

export interface ReferencingDoc {
  documentId: string;
  name: string;
  type: string;
  kind: string;
  fields: string[];
}

/**
 * "Used on": the documents that reference `documentId` — via a reference field
 * or a shared-block slot in a contentArea — read from the maintained
 * content_reference index (kept in sync on every save). Site-partitioned and
 * section-scoped exactly like getTree, so a cross-site or out-of-scope referrer
 * is never revealed.
 */
export async function findReferencingDocuments(
  db: Database,
  ctx: AccessContext,
  documentId: string,
): Promise<ReferencingDoc[]> {
  // Partition: the target must live in the active site (else not-found, like every other read).
  const target = await db
    .select({ documentId: contentItem.documentId })
    .from(contentItem)
    .where(and(eq(contentItem.documentId, documentId), eq(contentItem.siteId, ctx.siteId), isNull(contentItem.deletedAt)))
    .limit(1);
  if (!target[0]) throw Errors.notFound("Content");

  const rows = await db
    .select({
      fromDocumentId: contentReference.fromDocumentId,
      fieldName: contentReference.fieldName,
      type: contentItem.type,
      kind: contentItem.kind,
      sectionId: contentItem.sectionId,
    })
    .from(contentReference)
    .innerJoin(contentItem, eq(contentItem.documentId, contentReference.fromDocumentId))
    .where(and(eq(contentReference.toDocumentId, documentId), eq(contentItem.siteId, ctx.siteId), isNull(contentItem.deletedAt)));

  // Section scope: authors only see referrers inside their sections (mirrors getTree).
  const visible = rows.filter((r) => ctx.siteWide || ctx.sections.includes(r.sectionId ?? r.fromDocumentId));
  if (!visible.length) return [];

  // Display names from the current version — prefer the draft, else the published.
  const ids = [...new Set(visible.map((r) => r.fromDocumentId))];
  const names = await db
    .select({ documentId: contentVersion.documentId, name: contentVersion.name, status: contentVersion.status, isPub: contentVersion.isCurrentPublished })
    .from(contentVersion)
    .where(inArray(contentVersion.documentId, ids));
  const nameOf = new Map<string, string>();
  for (const n of names) {
    if (n.status !== "draft" && !n.isPub) continue; // skip history
    if (n.status === "draft" || !nameOf.has(n.documentId)) nameOf.set(n.documentId, n.name);
  }

  const byDoc = new Map<string, ReferencingDoc>();
  for (const r of visible) {
    const entry =
      byDoc.get(r.fromDocumentId) ??
      ({ documentId: r.fromDocumentId, name: nameOf.get(r.fromDocumentId) ?? r.fromDocumentId, type: r.type, kind: r.kind, fields: [] } satisfies ReferencingDoc);
    if (!entry.fields.includes(r.fieldName)) entry.fields.push(r.fieldName);
    byDoc.set(r.fromDocumentId, entry);
  }
  return [...byDoc.values()];
}

export async function getContentType(db: Database, name: string): Promise<ContentTypeDef> {
  const rows = await db.select().from(contentType).where(eq(contentType.name, name)).limit(1);
  if (!rows[0]) {
    // Self-teaching (rule 2): agents guess casings ("blog-post" for BlogPost —
    // real 2026-06-07 run). Hand them the actual names so one retry lands.
    const all = await db.select({ name: contentType.name }).from(contentType).orderBy(asc(contentType.name));
    throw Errors.notFound(`Content type '${name}' (available: ${all.map((t) => t.name).join(", ")})`);
  }
  // Inject the reserved SEO group (page kinds) — every consumer (validation,
  // coercion, delivery writes, MCP get) sees SEO automatically.
  return withSeoGroup(rows[0].definition as ContentTypeDef);
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
  // The reserved SEO group is system-managed: strip it from what we store so
  // it's defined once (in shared) and injected on read — never duplicated/stale.
  const stored = stripSeoGroup(def);
  await db.insert(contentType).values({
    name: stored.name,
    displayName: stored.displayName,
    kind: stored.kind,
    description: stored.description,
    icon: stored.icon,
    definition: stored,
  });
  return withSeoGroup(stored);
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
  const prev = withSeoGroup(rows[0].definition as ContentTypeDef);
  if (def.kind !== prev.kind) throw Errors.conflict("Content type kind is immutable");
  // Strip the reserved SEO group before storing (system-managed, injected on read).
  const stored = stripSeoGroup(def);
  await db
    .update(contentType)
    .set({ displayName: stored.displayName, description: stored.description, icon: stored.icon, definition: stored })
    .where(eq(contentType.name, name));
  return { next: withSeoGroup(stored), prev };
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
        eq(contentItem.siteId, ctx.siteId), // multisite: only the active site's tree
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
    .where(and(eq(contentItem.kind, "block"), isNull(contentItem.deletedAt), eq(contentItem.siteId, ctx.siteId)))
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
      folderId: item.folderId ?? null,
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
 * Walk a locale fallback chain (e.g. nb → en) from `code`, guarding against
 * cycles. Pure: callers load the locale rows however they like (delivery caches
 * them per request, this module queries fresh) so the walk itself can't drift.
 */
export function localeChainFrom(
  locales: { code: string; fallbackLocaleCode: string | null }[],
  code: string,
): string[] {
  const byCode = new Map(locales.map((l) => [l.code, l]));
  const chain: string[] = [];
  let cur: string | null = code;
  const guard = new Set<string>();
  while (cur && !guard.has(cur)) {
    guard.add(cur);
    chain.push(cur);
    cur = byCode.get(cur)?.fallbackLocaleCode ?? null;
  }
  return chain;
}

/** The locale fallback chain (e.g. nb → en), mirroring delivery's localeChain. */
async function localeFallbackChain(db: Database, loc: string): Promise<string[]> {
  return localeChainFrom(await db.select().from(locale), loc);
}

/**
 * Like workingSlug, but mirrors delivery's per-node semantics: pick the FIRST
 * locale in the fallback chain that has any version of this document, then use
 * THAT variant's slug (null slug stays null — no skipping). Without the chain,
 * a nb page under an en-only parent was live on the site while the editor
 * claimed "No URL yet" (2026-06-07).
 */
async function workingSlugAlongChain(db: Database, documentId: string, chain: string[]): Promise<string | null> {
  for (const code of chain) {
    const rows = await db
      .select()
      .from(contentVersion)
      .where(and(eq(contentVersion.documentId, documentId), eq(contentVersion.locale, code)))
      .orderBy(desc(contentVersion.versionNumber));
    if (!rows.length) continue;
    const row = rows.find((r) => r.status === "draft") ?? rows.find((r) => r.isCurrentPublished) ?? rows[0];
    return row?.slug ?? null;
  }
  return null;
}

/**
 * Resolve an OMITTED locale for a document-scoped operation (rule 5: safe
 * defaults). The static default ('en') silently FORKED a phantom variant when
 * an agent worked on a nb-only document and skipped the locale param
 * (2026-06-07: tags/publishDate landed in a near-empty en draft; the nb
 * article shipped without them). Resolution:
 *  - explicit locale → as given;
 *  - the site default locale, when the document has a variant there (or has
 *    no variants at all yet);
 *  - otherwise the document's SOLE locale;
 *  - otherwise (multiple locales, none the default) → self-teaching error.
 */
export async function resolveRequestedLocale(
  db: Database,
  documentId: string,
  requested?: string,
): Promise<string> {
  if (requested) return requested;
  const rows = await db
    .selectDistinct({ locale: contentVersion.locale })
    .from(contentVersion)
    .where(eq(contentVersion.documentId, documentId));
  const codes = rows.map((r) => r.locale);
  const defaults = await db.select().from(locale).where(eq(locale.isDefault, true)).limit(1);
  const def = defaults[0]?.code ?? "en";
  if (codes.length === 0 || codes.includes(def)) return def;
  if (codes.length === 1) return codes[0]!;
  throw Errors.badRequest(
    `This document has no '${def}' variant — it exists in: ${codes.join(", ")}. ` +
      `Pass locale explicitly (e.g. locale: "${codes[0]}") so the write doesn't fork a new language branch by accident.`,
  );
}

/**
 * Hierarchical URL for a page built from the chain of ancestor slugs (root→leaf),
 * e.g. /home/about/team. Pages only; returns null for blocks/globals. Cycle-safe.
 */
export async function computePath(db: Database, documentId: string, loc: string): Promise<string | null> {
  const segments: string[] = [];
  const guard = new Set<string>();
  const chain = await localeFallbackChain(db, loc);
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
    // Resolve each segment along the locale fallback chain — PARITY with
    // delivery's urlPathOf. A nb page under an en-only parent has a real URL.
    const slug = await workingSlugAlongChain(db, cur, chain);
    // No slug → NO URL (null), matching delivery's urlPathOf. Skipping the
    // segment instead made a slugless child claim its PARENT's path — a fresh
    // draft post "previewed" as the blog list page.
    if (!slug) return null;
    segments.unshift(slug);
    cur = item.parentId;
  }
  return `/${segments.join("/")}`;
}

/** True when a page sibling (same parent + locale) already uses this segment. */
async function slugTakenBySibling(
  db: Database,
  documentId: string,
  parentId: string | null,
  loc: string,
  slug: string,
  knownSiteId?: string,
): Promise<boolean> {
  // Scope siblings to the document's own site so two sites can each own a root
  // "/about" (slug uniqueness is per-site + per-parent + locale). For non-root
  // pages this is implied (siblings share a parent → a site); it matters for
  // roots (parentId === null), which would otherwise collide across sites.
  // knownSiteId lets createContent pass the site directly — its content_item row
  // isn't committed on this connection yet, so the self-lookup would miss it.
  let siteId = knownSiteId;
  if (!siteId) {
    const own = await db
      .select({ siteId: contentItem.siteId })
      .from(contentItem)
      .where(eq(contentItem.documentId, documentId))
      .limit(1);
    siteId = own[0]?.siteId;
  }
  const siblings = await db
    .select({ documentId: contentItem.documentId })
    .from(contentItem)
    .where(
      and(
        parentId === null ? isNull(contentItem.parentId) : eq(contentItem.parentId, parentId),
        eq(contentItem.kind, "page"),
        isNull(contentItem.deletedAt),
        ...(siteId ? [eq(contentItem.siteId, siteId)] : []),
      ),
    );
  for (const sib of siblings) {
    if (sib.documentId === documentId) continue;
    if ((await workingSlug(db, sib.documentId, loc)) === slug) return true;
  }
  return false;
}

/** Reject a URL segment already used by a page sibling (same parent + locale). */
async function assertSlugUnique(
  db: Database,
  documentId: string,
  parentId: string | null,
  loc: string,
  slug: string,
): Promise<void> {
  if (await slugTakenBySibling(db, documentId, parentId, loc, slug)) {
    throw Errors.conflict(`Another page already uses the URL segment "${slug}" here`);
  }
}

/** Kebab-case URL segment derived from a page name ("Hobby Projects" → "hobby-projects"). */
export function slugify(name: string): string | null {
  const s = name
    .toLowerCase()
    .replace(/æ/g, "ae")
    .replace(/ø/g, "o")
    .replace(/å/g, "a")
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics (é → e)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  return s || null;
}

/**
 * Auto-derive a unique URL segment from the page name (CMS-12 style): pages
 * get an address by default, agents/editors never have to remember the slug,
 * and a sibling collision quietly suffixes (-2, -3, …) instead of erroring.
 * Renames never touch an EXISTING slug (URL stability) — this only fills null.
 */
async function autoSlug(
  db: Database,
  documentId: string,
  parentId: string | null,
  loc: string,
  name: string,
  knownSiteId?: string,
): Promise<string | null> {
  const base = slugify(name);
  if (!base) return null;
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    if (!(await slugTakenBySibling(db, documentId, parentId, loc, candidate, knownSiteId))) return candidate;
  }
  return `${base}-${documentId.slice(0, 6).toLowerCase()}`;
}

/* ------------------------------- create ----------------------------------- */

/**
 * The `listedType` a ListPage declares (the content type it lists), or null
 * when the parent isn't a list page / has no listedType set. Read from any
 * version (listedType is non-localized).
 */
async function listedTypeOf(db: Database, parentDocumentId: string): Promise<string | null> {
  const rows = await db
    .select({ data: contentVersion.data })
    .from(contentVersion)
    .where(eq(contentVersion.documentId, parentDocumentId))
    .orderBy(desc(contentVersion.versionNumber))
    .limit(1);
  const listed = (rows[0]?.data as Record<string, unknown> | undefined)?.listedType;
  return typeof listed === "string" && listed ? listed : null;
}

export async function createContent(
  db: Database,
  ctx: AccessContext,
  req: CreateContentRequest,
): Promise<ContentDetail> {
  requirePermission(ctx, "content.create");

  let sectionId: string | null = null;
  let parent: typeof contentItem.$inferSelect | null = null;
  if (req.parentId) {
    parent = await loadAuthorized(db, ctx, req.parentId);
    sectionId = parent.sectionId ?? parent.documentId;
  }

  // A ListPage parent declares the type it lists (listedType). Children of a
  // DIFFERENT type publish fine but never appear on the list page — invisible
  // content (2026-06-07: "an article per repo under Projects" created BlogPosts
  // under an ArticlePage list; none showed up). So the listed type is the
  // source of truth here:
  //  - type omitted    → inherit listedType (safe default, rule 5)
  //  - type mismatched  → refuse for agent provenance with a self-teaching
  //    error + an allowTypeMismatch escape hatch; humans (deliberate sub-pages)
  //    are never blocked.
  const listedType = req.parentId ? await listedTypeOf(db, req.parentId) : null;
  let typeName = req.type ?? listedType;
  if (!typeName) throw Errors.badRequest("A content type is required (no parent list page to infer it from)");
  if (
    req.type &&
    listedType &&
    req.type !== listedType &&
    (ctx.via === "mcp" || ctx.via === "agent") &&
    !req.allowTypeMismatch
  ) {
    throw Errors.validation(
      `The parent list page lists '${listedType}', but you are creating a '${req.type}' — it would publish but NEVER appear on that list page. ` +
        `Create a '${listedType}' instead (omit the type to inherit it), choose a different parent, ` +
        `or pass allowTypeMismatch: true if a sub-page of another type is intended.`,
    );
  }
  const type = await getContentType(db, typeName);

  const documentId = nanoid(24);
  // A new top-level item is its own section.
  const effectiveSection = sectionId ?? documentId;
  if (!ctx.siteWide && !ctx.sections.includes(effectiveSection)) {
    throw Errors.forbidden("Cannot create content outside your sections");
  }

  // Children inherit the parent's site (loadAuthorized already confirmed the
  // parent is in the active site); a new root belongs to the active site.
  const effectiveSiteId = parent ? parent.siteId : ctx.siteId;

  // Atomic create: a per-(site, parent, locale) advisory lock serializes sibling
  // slug allocation so two concurrent creates of the same name can't both pick the
  // same segment (S2-M9 TOCTOU). autoSlug runs inside the tx and sees this row's
  // own uncommitted item (so knownSiteId is passed) plus committed siblings.
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`slug:${effectiveSiteId}:${req.parentId ?? "root"}:${req.locale}`}))`);
    await tx.insert(contentItem).values({
      documentId,
      type: type.name,
      kind: type.kind,
      parentId: req.parentId,
      sortIndex: 0,
      sectionId: effectiveSection,
      siteId: effectiveSiteId,
      createdBy: ctx.userId,
    });
    await tx.insert(contentVersion).values({
      documentId,
      locale: req.locale,
      status: "draft",
      isCurrentPublished: false,
      versionNumber: 1,
      name: req.name,
      // Pages get a URL segment from their name right away (CMS-12 style) —
      // uniquified among siblings; editors can change it in the URL chip.
      slug: type.kind === "page" ? await autoSlug(db, documentId, req.parentId, req.locale, req.name, effectiveSiteId) : null,
      displayInNav: true,
      data: {},
      cv: 0,
      createdBy: ctx.userId,
      createdVia: ctx.via ?? null,
      needsReview: ctx.via === "mcp" || ctx.via === "agent",
    });
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
      updatedVia: null,
      needsReview: false,
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
    updatedVia: (working.createdVia as "mcp" | "agent" | "web" | null) ?? null,
    needsReview: working.needsReview,
  };
}

/* ------------------------------ update/save ------------------------------- */

/** The top-level content fields a Zod parse error refers to (deduped, in order),
 *  so the API can hand them to the admin for inline display. */
function failedFields(err: { issues?: Array<{ path: (string | number)[] }> }): string[] {
  const names = (err.issues ?? [])
    .map((i) => i.path.find((p) => typeof p === "string"))
    .filter((p): p is string => typeof p === "string");
  return [...new Set(names)];
}

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
  const lines = issues
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
  // Steer to the transport-safe tool (rule 4): when a long-content field got an
  // OBJECT, the most common real cause is the CLIENT mangling a long nested
  // string to {} in transit (a 2026-06-05 agent retried that 9 times — it could
  // never learn the content was destroyed before it reached us). A flat
  // top-level string parameter survives.
  const longContentGotObject = issues.some((i) => {
    const def = type.fields.find((f) => f.name === i.path.find((p) => typeof p === "string"));
    return (
      def != null &&
      (def.type === "text" || def.type === "markdown" || def.type === "richtext") &&
      /received object/i.test(i.message)
    );
  });
  return longContentGotObject
    ? `${lines}. If you SENT a string and it arrived as an object/{}, your client mangled the nested value in transit — write long text with set_field {documentId, field, value} (a flat top-level string survives serialization).`
    : lines;
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
/** The set of installed content-type names (for content-type-referencing fields). */
async function installedTypeNames(db: Database): Promise<string[]> {
  const rows = await db.select({ name: contentType.name }).from(contentType).orderBy(asc(contentType.name));
  return rows.map((r) => r.name);
}

async function assertAllowedTypes(db: Database, type: ContentTypeDef, data: Record<string, unknown>): Promise<void> {
  // Fields whose value names a content type (e.g. a ListPage's listedType) must
  // reference an INSTALLED type — never a hardcoded "fantasy" option. A list
  // page pointing at a non-existent type lists nothing and traps agents the
  // placement guard sends to create it (2026-06-07 incident).
  const installed = type.fields.some((f) => f.optionsFromContentTypes) ? await installedTypeNames(db) : [];
  for (const f of type.fields) {
    if (!f.optionsFromContentTypes) continue;
    const raw = data[f.name];
    if (raw == null) continue;
    const vals = (Array.isArray(raw) ? raw : [raw]).filter((x) => typeof x === "string");
    for (const val of vals) {
      if (!installed.includes(val)) {
        throw Errors.validation(
          `Field "${f.name}" must be an installed content type, but "${val}" does not exist. ` +
            `Available: ${installed.join(", ")}. (Create that content type first, or pick one of these.)`,
        );
      }
    }
  }
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
          // `allowedBlocks` constrains BLOCK types only. A page dropped into a
          // content area is rendered as a teaser (Optimizely-style) and is
          // always placeable — its type name is never in allowedBlocks.
          const btDef = await db.select().from(contentType).where(eq(contentType.name, bt)).limit(1);
          if (btDef[0]?.kind === "page") continue;
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
  const data = coerceData(type, merged, loc);

  // Draft save: relaxed validation (required fields not enforced). On failure
  // the message names each field's expected JSON shape (with an example), so an
  // agent can self-correct instead of guessing.
  const parsed = dataSchemaFor(type, false).safeParse(data);
  if (!parsed.success) throw Errors.validation(formatDataValidation(parsed.error, type), failedFields(parsed.error));
  // Placement rules ARE enforced even on draft save (allowed blocks / ref types).
  await assertAllowedTypes(db, type, data);

  // Agent write-time language guard: refuse strongly language-mismatched content
  // BEFORE it lands on the wrong locale branch. A draft is never re-checked
  // until publish, so without this an agent that forgets to switch locale leaves
  // (e.g.) a Norwegian page sitting silently on the 'en' branch (2026-06-08).
  // Agent provenance only — a human editor is never second-guessed; escape hatch
  // for deliberate cross-language writes. Mirrors the publish guard.
  if ((ctx.via === "mcp" || ctx.via === "agent") && !req.allowLanguageMismatch) {
    const mm = branchLanguageMismatch(type, data, loc);
    if (mm) {
      throw Errors.validation(
        `The text you're writing is ${mm.detected === "nb" ? "Norwegian (nb)" : "English (en)"}, but locale '${loc}' is the ${mm.expected === "nb" ? "Norwegian (nb)" : "English (en)"} branch — ` +
          `agent writes must match the branch language so content doesn't land on the wrong site. ` +
          `Write this into the '${mm.detected}' branch instead: pass locale: "${mm.detected}" to create_content / update_content / set_field (create the document in '${mm.detected}' first if it doesn't exist yet). ` +
          `If writing ${mm.detected} text into '${loc}' is INTENDED, repeat with allowLanguageMismatch: true.`,
      );
    }
  }

  // Forensic trail (2026-06-08): a richtext "body" that arrives as a Markdown
  // string (set_field) or as a doc-ish value gets transformed by the coercion
  // chokepoint into the stored TipTap doc. If that transform is ever wrong, the
  // bad draft is overwritten by the next save and the original input is lost —
  // the incident becomes undiagnosable. Record a durable, truncated breadcrumb
  // of the RAW input whenever coercion did real work on a richtext field, so a
  // future "malformed body" report is reproducible from the audit log alone.
  await recordRichTextCoercion(db, ctx, documentId, loc, type, merged, data);

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

  // Backfill a missing URL segment from the name when the caller doesn't
  // address the slug at all (existing slugs are never touched — URL stability).
  const backfillSlug = async (currentSlug: string | null, name: string): Promise<string | null> =>
    req.slug === undefined && currentSlug == null && item.kind === "page"
      ? autoSlug(db, documentId, item.parentId, loc, name)
      : currentSlug;

  if (existing[0]) {
    const name = req.name ?? existing[0].name;
    const slug = req.slug !== undefined ? req.slug : await backfillSlug(existing[0].slug, name);
    await db
      .update(contentVersion)
      .set({
        name,
        slug,
        displayInNav: req.displayInNav ?? existing[0].displayInNav,
        data,
        createdBy: ctx.userId,
        createdAt: new Date(),
        // Provenance: an agent (mcp) write flags the draft for human review; a
        // human (web) write clears it — the human has seen the content.
        createdVia: ctx.via ?? null,
        needsReview: ctx.via === "mcp" || ctx.via === "agent",
      })
      .where(eq(contentVersion.id, existing[0].id));
  } else {
    // No working draft yet (editing a published OR an unpublished item): seed a
    // draft from the best available base — the live published version, else the
    // latest version of any status. Using the latest version is what prevents an
    // unpublished page (no current-published row) from losing its name/slug on
    // the next edit.
    const maxV = await nextVersionNumber(db, documentId, loc);
    const sameLocale = (await currentPublished(db, documentId, loc)) ?? (await latestVersion(db, documentId, loc));
    // First write in a NEW locale: fork identity (name/slug/nav) from the newest
    // version in any other locale — never the "Untitled" placeholder. An agent
    // that writes fields without addressing the name otherwise publishes a
    // placeholder (2026-06-06 incident: nb forked as "Untitled", went live at
    // /untitled while the en draft held the real name).
    const fork = sameLocale ? null : await latestVersionAnyLocale(db, documentId);
    const base = sameLocale ?? fork;
    const name = req.name ?? base?.name ?? "Untitled";
    let slug: string | null;
    if (req.slug !== undefined) {
      slug = req.slug;
    } else if (sameLocale || !fork) {
      slug = await backfillSlug(sameLocale?.slug ?? null, name);
    } else if (req.name !== undefined || !fork.slug) {
      // Forking with an explicit name (or no source slug): the URL follows the
      // name the caller chose for THIS locale, not the source locale's slug.
      slug = item.kind === "page" ? await autoSlug(db, documentId, item.parentId, loc, name) : null;
    } else {
      // Inherit the source locale's slug (it may be editor-customised), unless a
      // sibling in this locale already uses it — then re-derive from the name.
      slug = (await slugTakenBySibling(db, documentId, item.parentId, loc, fork.slug))
        ? await autoSlug(db, documentId, item.parentId, loc, name)
        : fork.slug;
    }
    try {
      await db.insert(contentVersion).values({
        documentId,
        locale: loc,
        status: "draft",
        isCurrentPublished: false,
        versionNumber: maxV,
        name,
        slug,
        displayInNav: req.displayInNav ?? base?.displayInNav ?? true,
        data,
        createdBy: ctx.userId,
        createdVia: ctx.via ?? null,
        needsReview: ctx.via === "mcp" || ctx.via === "agent",
      });
    } catch (err) {
      // A concurrent write seeded the single working draft first (the
      // content_version_one_draft partial unique index held the invariant). Turn
      // the raw 23505 into a self-teaching 409 instead of an opaque 500 (S2-L5).
      if (isUniqueViolation(err)) {
        throw Errors.conflict("A draft for this locale was just created by a concurrent edit — re-read the content and retry your update.");
      }
      throw err;
    }
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

/**
 * The newest version row across ALL locales — the fork base when the target
 * locale has no version yet, so a new locale inherits name/slug instead of
 * materialising as "Untitled".
 */
async function latestVersionAnyLocale(db: Database, documentId: string) {
  const rows = await db
    .select()
    .from(contentVersion)
    .where(eq(contentVersion.documentId, documentId))
    .orderBy(desc(contentVersion.createdAt), desc(contentVersion.id))
    .limit(1);
  return rows[0] ?? null;
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
  if (!parsed.success) {
    // Tell the (often agentic) caller HOW to recover, not just what's wrong:
    // the draft is salvageable with a partial update — no need to rebuild it.
    throw Errors.validation(
      formatValidation(parsed.error) +
        " — the DRAFT is missing/has invalid fields (drafts save with relaxed validation; publish is strict)." +
        " Fix it with update_content using merge:true and ONLY the offending fields, then publish again.",
      failedFields(parsed.error),
    );
  }
  await assertAllowedTypes(db, type, draft.data as Record<string, unknown>);
  // Placeholder names are never publishable (agent-API rule 1: no
  // garbage-in-success-out). "Untitled" is the auto-default a version gets when
  // nobody ever set its name — publishing one put a live page at /untitled
  // titled "Untitled" (2026-06-06 incident). Self-teaching per rule 2.
  if (/^Untitled( \(copy\))?$/.test(draft.name)) {
    throw Errors.validation(
      `This ${loc} version is still named "${draft.name}" — the auto-placeholder, not a real name. ` +
        `Set the real name first via update_content {documentId, locale: "${loc}", name: "<the title>"} ` +
        `(or set_field {field: "name"}), then publish again.`,
    );
  }
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
  try {
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
  } catch (err) {
    // A concurrent publish promoted this variant first (content_version_one_published
    // held the single-published invariant). Self-teaching 409, not an opaque 500 (S2-L5).
    if (isUniqueViolation(err)) {
      throw Errors.conflict("This content was just published by a concurrent operation — re-read it and retry.");
    }
    throw err;
  }
}

/**
 * Copy a document's working variant (draft, else live published, else latest)
 * from one locale to another, server-side and atomically — name, slug and the
 * ENTIRE data map. Exists because "re-send the data yourself" recovery is how
 * content gets lost: after a language-guard refusal, a real agent re-typed
 * only 4 of 9 fields into the right branch and published an article without
 * its body (2026-06-07). Goes through updateContent, so coercion, validation
 * and the single-draft invariant all apply; slug collisions in the target
 * locale fall back to auto-derivation from the name.
 */
export async function copyVariant(
  db: Database,
  ctx: AccessContext,
  documentId: string,
  fromLocale: string,
  toLocale: string,
): Promise<ContentDetail> {
  requirePermission(ctx, "content.update");
  if (fromLocale === toLocale) throw Errors.badRequest("fromLocale and toLocale are the same — nothing to copy");
  const item = await loadAuthorized(db, ctx, documentId);
  const src =
    (await db
      .select()
      .from(contentVersion)
      .where(
        and(
          eq(contentVersion.documentId, documentId),
          eq(contentVersion.locale, fromLocale),
          eq(contentVersion.status, "draft"),
        ),
      )
      .limit(1))[0] ??
    (await currentPublished(db, documentId, fromLocale)) ??
    (await latestVersion(db, documentId, fromLocale));
  if (!src) throw Errors.notFound(`No '${fromLocale}' version of this document`);
  // Keep the source slug when it is free among the target locale's siblings;
  // otherwise let updateContent derive a unique one from the name.
  const slugFree =
    src.slug == null || !(await slugTakenBySibling(db, documentId, item.parentId, toLocale, src.slug));
  return updateContent(db, ctx, documentId, toLocale, {
    name: src.name,
    ...(slugFree && src.slug != null ? { slug: src.slug } : {}),
    displayInNav: src.displayInNav,
    data: src.data as Record<string, unknown>,
    merge: false,
  });
}

/**
 * The language of a draft's human-readable text vs the language its locale
 * branch expects — the shared core of the agent language/branch guards. Returns
 * the mismatch, or null when there's no strong signal (detectContentLanguage →
 * "unknown") or the branch is outside the detector's vocabulary.
 *
 * Includes `richtext` bodies (flattened to plain text): the bulk of a page's
 * language signal usually lives in the body, and omitting it (the original
 * publish guard did) let a Norwegian article whose only text-field is a short
 * title slip the check (2026-06-08).
 */
function branchLanguageMismatch(
  type: ContentTypeDef,
  data: Record<string, unknown>,
  loc: string,
): { detected: "en" | "nb"; expected: "en" | "nb" } | null {
  const expected = expectedLanguageForLocale(loc);
  if (!expected) return null; // branch language outside the detector's vocabulary
  const parts: string[] = [];
  for (const f of type.fields) {
    if (!f.localized) continue;
    const v = data[f.name];
    if (f.type === "text" || f.type === "markdown") {
      if (typeof v === "string") parts.push(v);
    } else if (f.type === "richtext" && v && typeof v === "object") {
      const t = tiptapToPlainText(v);
      if (t) parts.push(t);
    }
  }
  const detected = detectContentLanguage(parts.join("\n\n"));
  if (detected === "unknown" || expected === "unknown" || detected === expected) return null;
  return { detected: detected as "en" | "nb", expected: expected as "en" | "nb" };
}

/**
 * Durable forensic breadcrumb for richtext coercion. Records the RAW (pre-
 * coercion) input of any richtext field that the chokepoint actually
 * transformed — a Markdown string parsed into a doc, or a doc-ish value
 * normalized to the editor schema. A clean doc stored unchanged is NOT logged
 * (no transform, no risk). Truncated so the audit row stays small. Append-only;
 * best-effort (a logging failure must never fail the write).
 */
async function recordRichTextCoercion(
  db: Database,
  ctx: AccessContext,
  documentId: string,
  loc: string,
  type: ContentTypeDef,
  rawData: Record<string, unknown>,
  coercedData: Record<string, unknown>,
): Promise<void> {
  const fields = type.fields
    .filter((f) => f.type === "richtext" && f.name in rawData)
    .map((f) => {
      const raw = rawData[f.name];
      if (raw == null) return null;
      const isString = typeof raw === "string";
      const changed = JSON.stringify(raw) !== JSON.stringify(coercedData[f.name]);
      if (!isString && !changed) return null; // already a clean doc, stored verbatim
      return {
        field: f.name,
        inputKind: isString ? "markdown-string" : Array.isArray(raw) ? "array" : "doc-normalized",
        input: JSON.stringify(raw).slice(0, 600),
      };
    })
    .filter((x): x is { field: string; inputKind: string; input: string } => x != null);
  if (!fields.length) return;
  try {
    await db.insert(auditLog).values({
      actorUserId: ctx.userId ?? null,
      action: "content.richtext_coerced",
      documentId,
      locale: loc,
      ip: ctx.via === "mcp" ? "mcp" : (ctx.via ?? null),
      detail: { fields },
    });
  } catch {
    // forensics are best-effort — never break a content write to log one
  }
}

/**
 * Agent-publish language/branch guard (2026-06-07: an agent wrote a Norwegian
 * article and published it into 'en' — a Norwegian post went live on the
 * English blog). Only fires for agent provenance (via mcp/agent); a HUMAN
 * pressing Publish has seen the content and is never second-guessed. Only
 * fires on a STRONG signal (see detectContentLanguage) — "unknown" passes.
 */
async function assertLanguageMatchesBranch(
  db: Database,
  item: typeof contentItem.$inferSelect,
  loc: string,
  draft: typeof contentVersion.$inferSelect,
): Promise<void> {
  const type = await getContentType(db, item.type);
  const mm = branchLanguageMismatch(type, draft.data as Record<string, unknown>, loc);
  if (!mm) return;
  throw Errors.validation(
    `This draft's text is ${mm.detected === "nb" ? "Norwegian (nb)" : "English (en)"}, but you are publishing the '${loc}' language branch — ` +
      `it would go live on the wrong site language. Move the WHOLE draft in one call: ` +
      `copy_variant {documentId, fromLocale: "${loc}", toLocale: "${mm.detected}"} (copies name, slug and EVERY field — do not re-type the data), ` +
      `then publish {locale: "${mm.detected}"}, then discard_draft {locale: "${loc}"} if this branch was created by mistake. ` +
      `If publishing ${mm.detected} text in '${loc}' is INTENDED, repeat publish with allowLanguageMismatch: true.`,
  );
}

export async function publishContent(
  db: Database,
  ctx: AccessContext,
  documentId: string,
  loc: string,
  opts?: { allowLanguageMismatch?: boolean },
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

  // Agent-review gate (opt-in via Settings → MCP): an agent cannot publish its
  // own unreviewed draft — a human must approve it first (or edit it, which
  // clears the flag). Self-teaching: the error tells the agent exactly what
  // unblocks it. Human publishes are never gated (publishing IS reviewing).
  if (ctx.via === "mcp" && draft?.needsReview && (await getAgentReviewRequired(db))) {
    throw Errors.forbidden(
      "This draft was written by an agent and the site requires human review before publishing " +
        "(Settings → MCP → Agent review). Ask a human to approve it in the editor, or via " +
        `POST /manage/content/${documentId}/review?locale=${loc}. The flag also clears when a human edits the draft.`,
    );
  }

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
  // Agent provenance only — never second-guess a human editor.
  if ((ctx.via === "mcp" || ctx.via === "agent") && !opts?.allowLanguageMismatch) {
    await assertLanguageMatchesBranch(db, item, loc, draft);
  }
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
    // Per-row guard (mirrors the promote loop): one bad row must not abort the
    // rest of the tick. Compute the path BEFORE demoting, so a failure can't leave
    // a row demoted-without-its-unpublished-webhook (the next tick won't re-scan a
    // no-longer-published row, so that event would be lost permanently).
    try {
      const item = (
        await db.select().from(contentItem).where(eq(contentItem.documentId, s.documentId)).limit(1)
      )[0];
      const urlPath = item && item.kind === "page" ? await computePath(db, s.documentId, s.locale) : null;
      await db.update(contentVersion).set({ isCurrentPublished: false }).where(eq(contentVersion.id, s.id));
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
    } catch (err) {
      // Leave a trail (rule #6 spirit) and keep going; the row stays published and
      // is retried next tick (it wasn't demoted if the failure was before the UPDATE).
      await db
        .insert(auditLog)
        .values({ action: "content.schedule_failed", documentId: s.documentId, locale: s.locale, detail: { reason: err instanceof Error ? err.message : String(err) } })
        .catch(() => undefined);
      failed++;
    }
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

/**
 * Delete ONE language variant of a document: every version of that doc in that
 * locale (draft + published + history) plus its outgoing references. The locale
 * becomes untranslated again (getContent → versionNumber 0), so the editor's
 * "Translate from …" offer reappears — the way to re-translate a variant that
 * was filled wrong. Distinct from discardDraft (keeps the published version) and
 * trash (removes the WHOLE document). Refuses to delete the document's ONLY
 * remaining locale — that would orphan the item; trash it instead.
 */
export async function deleteVariant(
  db: Database,
  ctx: AccessContext,
  documentId: string,
  loc: string,
): Promise<{ ok: true; deleted: number }> {
  requirePermission(ctx, "content.delete");
  await loadAuthorized(db, ctx, documentId); // not-found / cross-site guard
  const rows = await db
    .select({ locale: contentVersion.locale })
    .from(contentVersion)
    .where(eq(contentVersion.documentId, documentId));
  const locales = new Set(rows.map((r) => r.locale));
  if (!locales.has(loc)) throw Errors.badRequest(`No '${loc}' version exists to delete.`);
  if (locales.size <= 1) {
    throw Errors.badRequest(
      `Cannot delete the only language version ('${loc}') of this content — move the whole page to trash instead.`,
    );
  }
  // References are keyed (fromDocumentId, fromLocale) — drop this locale's first.
  await db
    .delete(contentReference)
    .where(and(eq(contentReference.fromDocumentId, documentId), eq(contentReference.fromLocale, loc)));
  const deleted = await db
    .delete(contentVersion)
    .where(and(eq(contentVersion.documentId, documentId), eq(contentVersion.locale, loc)))
    .returning({ id: contentVersion.id });
  return { ok: true, deleted: deleted.length };
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
      // Acyclicity is re-checked INSIDE the write tx under a per-site lock (S2-M10),
      // so a concurrent opposing reparent can't interleave between check and write
      // and commit a cycle. (This pre-tx load only validates the destination/scope.)
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
      // Serialize structural moves within the site so the acyclicity check and the
      // reparent write are atomic — two opposing concurrent reparents can't both
      // pass and form a cycle. The advisory xact lock auto-releases on commit/rollback.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`move:${ctx.siteId}`}))`);
      if (targetParentId !== null) {
        // Re-walk up from the destination against COMMITTED state under the lock.
        const guard = new Set<string>();
        let cur: string | null = targetParentId;
        while (cur && !guard.has(cur)) {
          guard.add(cur);
          if (cur === documentId) throw Errors.conflict("Cannot move a page under its own descendant");
          const rows: { parentId: string | null }[] = await tx
            .select({ parentId: contentItem.parentId })
            .from(contentItem)
            .where(eq(contentItem.documentId, cur))
            .limit(1);
          cur = rows[0]?.parentId ?? null;
        }
      }
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
    .where(and(eq(contentItem.kind, "page"), isNull(contentItem.deletedAt), eq(contentItem.siteId, ctx.siteId)))
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
        eq(contentItem.siteId, ctx.siteId), // multisite: search is confined to the active site
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
      createdVia: contentVersion.createdVia,
      needsReview: contentVersion.needsReview,
      publishAt: contentVersion.publishAt,
      expireAt: contentVersion.expireAt,
    })
    .from(contentVersion)
    .where(and(eq(contentVersion.documentId, documentId), eq(contentVersion.locale, loc)))
    .orderBy(desc(contentVersion.versionNumber));
}

/**
 * Human approval of an agent-written draft: clears the review flag (and
 * records who approved in created_via staying intact — the audit log carries
 * the approver). Requires content.update; the editor exposes it as "Approve".
 */
export async function markReviewed(
  db: Database,
  ctx: AccessContext,
  documentId: string,
  loc: string,
): Promise<ContentDetail> {
  requirePermission(ctx, "content.update");
  await loadAuthorized(db, ctx, documentId);
  // Clear the flag on the WORKING version: the draft when one exists, but ALSO
  // the current published row — an agent that publishes directly leaves no
  // draft behind, and a draft-only update made Approve a silent no-op on such
  // documents (2026-06-07: the editor badge sat on the published version and
  // the button "did nothing" — 200 OK, zero rows touched).
  await db
    .update(contentVersion)
    .set({ needsReview: false })
    .where(
      and(
        eq(contentVersion.documentId, documentId),
        eq(contentVersion.locale, loc),
        or(eq(contentVersion.status, "draft"), eq(contentVersion.isCurrentPublished, true)),
      ),
    );
  return getContent(db, ctx, documentId, loc);
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
  const data = coerceData(type, src.data as Record<string, unknown>, loc);
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
    const data = coerceData(type, row.data as Record<string, unknown>, code);
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
  if (item.siteId !== ctx.siteId) throw Errors.notFound("Content"); // multisite: not in the active site
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
    .where(and(sql`${contentItem.deletedAt} is not null`, eq(contentItem.siteId, ctx.siteId)))
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
    .where(and(sql`${contentItem.deletedAt} is not null`, eq(contentItem.siteId, ctx.siteId)));
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
