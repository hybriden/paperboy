import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { ChildSort, coerceData, dataSchemaFor, detectContentLanguage, duplicateFieldKeys, expectedLanguageForLocale, fieldFormatHint, generalBlockTypes, isFormType, MAX_INLINE_DEPTH, parseStoredContentTypeDef, sortByRule, stripSeoGroup, tiptapToPlainText, type BlockSummary, type BlockTypeResolver, type ContentDetail, type ContentTypeDef, type CreateContentRequest, type PageSummary, type TreeNode, type UpdateContentRequest, withSeoGroup } from "@paperboy/shared";
import type { Database, Queryable, Transaction } from "./client.js";
import { Errors, PG_UNIQUE_VIOLATION, pgErrorCode } from "./errors.js";
import {
  type AccessContext,
  loadAuthorized,
  requirePermission,
} from "./scope.js";
import { DEFAULT_SITE_ID, auditLog, contentItem, contentReference, contentType, contentVersion, locale, site } from "./schema.js";
import { getAgentReviewRequired } from "./site.js";
import { dispatchWebhooks } from "./webhooks.js";

const isUniqueViolation = (err: unknown): boolean => pgErrorCode(err) === PG_UNIQUE_VIOLATION;

/* ----------------------------- content types ----------------------------- */

export async function listContentTypes(db: Database): Promise<ContentTypeDef[]> {
  const rows = await db.select().from(contentType).orderBy(asc(contentType.name));
  // Inject the reserved SEO group into every page kind (single read chokepoint).
  return rows.map((r) => parseStoredContentTypeDef(r.definition));
}

/** Per-type usage: standalone items of that type, plus pages/blocks that embed
 *  it INLINE in a content area. `inlineIn` counts distinct documents — current
 *  published + working draft only, unless `includeHistory` (the delete guard:
 *  a historical version can be restored). */
export interface ContentTypeUsage {
  items: number;
  inlineIn: number;
}
export async function contentTypeUsage(db: Database, opts: { includeHistory?: boolean } = {}): Promise<Record<string, ContentTypeUsage>> {
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

  // Inline block usage: Postgres walks each version's JSONB for every nested
  // `blockType` (any depth), so only the type names cross the wire, never the
  // documents. A document counts once per block type it embeds (any locale).
  const rows = (await db.execute(sql`
    SELECT document_id, jsonb_path_query_array(data, '$.**.blockType') AS block_types
    FROM content_version
    ${opts.includeHistory ? sql`` : sql`WHERE status = 'draft' OR is_current_published`}
  `)) as unknown as { document_id: string; block_types: unknown[] }[];
  const byDoc = new Map<string, Set<string>>(); // documentId -> block types it embeds
  for (const r of rows) {
    const set = byDoc.get(r.document_id) ?? new Set<string>();
    for (const t of r.block_types) if (typeof t === "string") set.add(t);
    byDoc.set(r.document_id, set);
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
  requirePermission(ctx, "content.read");
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
  const visible = rows.filter((r) => ctx.readSiteWide || ctx.sections.includes(r.sectionId ?? r.fromDocumentId));
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

/** The enabled locale codes — what the coercion chokepoint may unwrap a {locale: value} map against. */
async function localeCodes(db: Database): Promise<string[]> {
  return (await listLocales(db)).map((l) => l.code);
}

// Self-teaching (rule 2): agents guess casings ("blog-post" for BlogPost —
// real 2026-06-07 run). Hand them the actual names so one retry lands.
const typeNotFound = (name: string, available: string[]) => Errors.notFound(`Content type '${name}' (available: ${available.join(", ")})`);

export async function getContentType(db: Queryable, name: string): Promise<ContentTypeDef> {
  const rows = await db.select().from(contentType).where(eq(contentType.name, name)).limit(1);
  if (!rows[0]) {
    const all = await db.select({ name: contentType.name }).from(contentType).orderBy(asc(contentType.name));
    throw typeNotFound(name, all.map((t) => t.name));
  }
  // Inject the reserved SEO group (page kinds) — every consumer (validation,
  // coercion, delivery writes, MCP get) sees SEO automatically.
  return parseStoredContentTypeDef(rows[0].definition);
}

/** Admin-only: create a new content type. The body must already be schema-valid. */
export async function createContentType(
  db: Queryable,
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
 * Delete a content type — only when NOTHING uses it. Guard is server-side: any
 * standalone item or inline embedding — in ANY version, history included, since
 * a restore would resurrect it — refuses the delete (409), so a type in use can
 * never be removed out from under existing content. Forward-only; a reseed
 * would recreate seed types.
 */
export async function deleteContentType(db: Database, ctx: AccessContext, name: string): Promise<void> {
  requirePermission(ctx, "contenttype.manage");
  const rows = await db.select().from(contentType).where(eq(contentType.name, name)).limit(1);
  if (!rows[0]) throw Errors.notFound(`Content type '${name}'`);
  const usage = (await contentTypeUsage(db, { includeHistory: true }))[name];
  if (usage && (usage.items > 0 || usage.inlineIn > 0)) {
    const parts = [usage.items ? `${usage.items} item(s)` : null, usage.inlineIn ? `embedded in ${usage.inlineIn} page(s), version history included` : null].filter(Boolean);
    throw Errors.conflict(`'${name}' is still in use (${parts.join(", ")}). Remove those first.`);
  }
  await db.delete(contentType).where(eq(contentType.name, name));
}

/**
 * Admin-only: update a content type. `name` and `kind` are immutable (they key
 * existing content rows). Existing content is NOT migrated — renaming/retyping a
 * field orphans its stored JSONB value and adding a required field will block the
 * next re-publish of existing items (documented; the UI warns).
 */
export async function updateContentType(
  db: Queryable,
  ctx: AccessContext,
  name: string,
  def: ContentTypeDef,
): Promise<{ next: ContentTypeDef; prev: ContentTypeDef }> {
  requirePermission(ctx, "contenttype.manage");
  if (def.name !== name) throw Errors.badRequest("Content type name is immutable");
  const rows = await db.select().from(contentType).where(eq(contentType.name, name)).limit(1);
  if (!rows[0]) throw Errors.notFound(`Content type '${name}'`);
  const prev = parseStoredContentTypeDef(rows[0].definition);
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

/**
 * The locale a request means when it doesn't say — for `siteId` if given.
 *
 * Never a hardcoded "en" pivot: on a Norwegian instance that would scaffold blank
 * `en` drafts and make delivery without `?locale=` return nothing.
 *
 * Order: the site's own `defaultLocale` → the globally default locale → "en" as an
 * absolute last resort (a brand-new database before any locale row exists).
 */
export async function resolveDefaultLocale(db: Database, siteId?: string): Promise<string> {
  if (siteId) {
    const rows = await db.select({ defaultLocale: site.defaultLocale }).from(site).where(eq(site.id, siteId)).limit(1);
    const code = rows[0]?.defaultLocale;
    if (code) return code;
  }
  const rows = await db.select({ code: locale.code }).from(locale).where(eq(locale.isDefault, true)).limit(1);
  return rows[0]?.code ?? "en";
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
  /** Working data (draft-preferred, like the name) — feeds data.<field> child sorting. Only loaded on request. */
  data?: Record<string, unknown>;
}

/** ORDER BY terms that put a (document, locale)'s WORKING version first: the
 *  draft, else the current published row, else the latest. */
const workingVersionFirst = [sql`(${contentVersion.status} = 'draft') desc`, desc(contentVersion.isCurrentPublished), desc(contentVersion.versionNumber)];

/**
 * Per-locale published/draft state for MANY documents in ONE query — one row per
 * (document, locale), its working version, so history never crosses the wire.
 * `data` (the JSONB) is fetched only when the caller sorts by a data field.
 */
async function variantStatesBatch(
  db: Database,
  documentIds: string[],
  withData = false,
): Promise<Map<string, Record<string, VariantState>>> {
  const out = new Map<string, Record<string, VariantState>>();
  if (!documentIds.length) return out;
  const rows = await db
    .selectDistinctOn([contentVersion.documentId, contentVersion.locale], {
      documentId: contentVersion.documentId,
      locale: contentVersion.locale,
      name: contentVersion.name,
      status: contentVersion.status,
      // The chosen row is the draft when one exists, which hides whether a published row also does.
      hasPublished: sql<boolean>`bool_or(${contentVersion.isCurrentPublished}) over (partition by ${contentVersion.documentId}, ${contentVersion.locale})`,
      data: withData ? contentVersion.data : sql<null>`null`,
    })
    .from(contentVersion)
    .where(inArray(contentVersion.documentId, documentIds))
    .orderBy(contentVersion.documentId, contentVersion.locale, ...workingVersionFirst);
  for (const r of rows) {
    let byLocale = out.get(r.documentId);
    if (!byLocale) {
      byLocale = {};
      out.set(r.documentId, byLocale);
    }
    byLocale[r.locale] = {
      status: r.hasPublished ? "published" : "draft",
      hasUnpublishedChanges: r.status === "draft",
      name: r.name,
      ...(withData ? { data: r.data as Record<string, unknown> } : {}),
    };
  }
  return out;
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
    (i) => ctx.readSiteWide || ctx.sections.includes(i.sectionId ?? i.documentId),
  );

  // The parent's declared child ordering. 'manual' keeps the sortIndex order the
  // query already applied; a computed rule re-sorts this level below.
  const rule = parentId
    ? ((await db.select({ cs: contentItem.childSort }).from(contentItem).where(eq(contentItem.documentId, parentId)).limit(1))[0]?.cs ?? "manual")
    : "manual";
  const bareRule = rule.startsWith("-") ? rule.slice(1) : rule;
  const dataField = bareRule.startsWith("data.") ? bareRule.slice(5) : null;
  // data.<field> values are read from the working version, preferring the site's
  // default locale — the same variant whose name the tree displays.
  const defaultLocale = dataField ? await resolveDefaultLocale(db, ctx.siteId) : null;

  // Two batched reads instead of 2 per node: all variant states in one query,
  // and one grouped count of which of these nodes have page children.
  const visibleIds = visible.map((i) => i.documentId);
  const statesById = await variantStatesBatch(db, visibleIds, dataField !== null);
  const childCounts = visibleIds.length
    ? await db
        .select({ parentId: contentItem.parentId, c: sql<number>`count(*)::int` })
        .from(contentItem)
        .where(and(inArray(contentItem.parentId, visibleIds), eq(contentItem.kind, "page"), isNull(contentItem.deletedAt)))
        .groupBy(contentItem.parentId)
    : [];
  const childCountBy = new Map(childCounts.map((r) => [r.parentId, r.c]));

  const rows: { node: TreeNode; createdAt: string; dataValue: unknown }[] = [];
  for (const item of visible) {
    const states = statesById.get(item.documentId) ?? {};
    const localesSummary: TreeNode["locales"] = {};
    for (const [code, s] of Object.entries(states)) {
      localesSummary[code] = { status: s.status, hasUnpublishedChanges: s.hasUnpublishedChanges };
    }
    const anyName = Object.values(states)[0]?.name ?? item.documentId;
    const dataState = dataField ? ((defaultLocale && states[defaultLocale]) || Object.values(states)[0]) : undefined;
    rows.push({
      node: {
        documentId: item.documentId,
        type: item.type,
        kind: item.kind as TreeNode["kind"],
        parentId: item.parentId,
        sortIndex: item.sortIndex,
        childSort: item.childSort,
        name: anyName,
        locales: localesSummary,
        hasChildren: (childCountBy.get(item.documentId) ?? 0) > 0,
      },
      createdAt: item.createdAt.toISOString(),
      dataValue: dataField ? dataState?.data?.[dataField] : undefined,
    });
  }
  const ordered =
    rule === "manual"
      ? rows
      : sortByRule(rows, rule, (r, field) =>
          field === "name" ? r.node.name : field === "createdAt" ? r.createdAt : field.startsWith("data.") ? r.dataValue : null,
        );
  return ordered.map((r) => r.node);
}

/* ------------------------------ asset pane -------------------------------- */

/** Shared blocks (kind=block) for the assets pane — flat list with per-locale status. */
/** Shared blocks — the asset pane's library. */
export async function listBlocks(db: Database, ctx: AccessContext): Promise<BlockSummary[]> {
  return listOfKind(db, ctx, "block");
}

/**
 * Globals — the per-site config singletons (header, footer, site settings).
 *
 * They are deliberately outside the page tree, which left them reachable only by
 * searching for a name you already knew: nothing listed them, so an editor with
 * three globals in the database saw none of them.
 */
export async function listGlobals(db: Database, ctx: AccessContext): Promise<BlockSummary[]> {
  return listOfKind(db, ctx, "global");
}

async function listOfKind(db: Database, ctx: AccessContext, kind: "block" | "global"): Promise<BlockSummary[]> {
  requirePermission(ctx, "content.read");
  const items = await db
    .select()
    .from(contentItem)
    .where(and(eq(contentItem.kind, kind), isNull(contentItem.deletedAt), eq(contentItem.siteId, ctx.siteId)))
    .orderBy(asc(contentItem.id));
  const visible = items.filter((i) => ctx.readSiteWide || ctx.sections.includes(i.sectionId ?? i.documentId));
  const blockStates = await variantStatesBatch(db, visible.map((i) => i.documentId));
  const out: BlockSummary[] = [];
  for (const item of visible) {
    const states = blockStates.get(item.documentId) ?? {};
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
async function workingSlug(db: Queryable, documentId: string, loc: string): Promise<string | null> {
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
  ctx?: AccessContext,
): Promise<string> {
  if (requested) return requested;
  // Authorize BEFORE discovering the document's locales: the "it exists in:
  // nb, de" error below is otherwise an existence/locale oracle for documents
  // the caller cannot see. A caller that passes a locale authorizes in its own
  // read/write path, so only this discovery branch needs the gate.
  if (ctx) await loadAuthorized(db, ctx, documentId, "read");
  const rows = await db
    .selectDistinct({ locale: contentVersion.locale })
    .from(contentVersion)
    .where(eq(contentVersion.documentId, documentId));
  const codes = rows.map((r) => r.locale);
  // The DOCUMENT'S OWN SITE decides the default, via resolveDefaultLocale — this
  // used to read only `locale.isDefault`, so on a site whose defaultLocale is `nb`
  // while the global default is still `en`, a locale-less MCP write resolved to `en`
  // and forked a phantom `en` branch. That is the 2026-06-07 incident this function
  // exists to prevent, reintroduced one level up. This is the resolver for EVERY MCP
  // write (apps/mcp/src/server.ts locFor), so it has to agree with the HTTP routes.
  const owner = await db
    .select({ siteId: contentItem.siteId })
    .from(contentItem)
    .where(eq(contentItem.documentId, documentId))
    .limit(1);
  const def = await resolveDefaultLocale(db, owner[0]?.siteId);
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

/**
 * The URL segments the page siblings under `parentId` hold in `loc` — each one's
 * working slug (draft, else current published, else latest) — excluding
 * `documentId` itself. One query, whatever the sibling count.
 */
async function siblingSlugs(
  db: Queryable,
  documentId: string,
  parentId: string | null,
  loc: string,
  knownSiteId?: string,
): Promise<Set<string>> {
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
  const rows = await db
    .selectDistinctOn([contentVersion.documentId], { slug: contentVersion.slug })
    .from(contentVersion)
    .innerJoin(contentItem, eq(contentItem.documentId, contentVersion.documentId))
    .where(
      and(
        parentId === null ? isNull(contentItem.parentId) : eq(contentItem.parentId, parentId),
        eq(contentItem.kind, "page"),
        isNull(contentItem.deletedAt),
        siteId ? eq(contentItem.siteId, siteId) : undefined,
        ne(contentItem.documentId, documentId),
        eq(contentVersion.locale, loc),
      ),
    )
    .orderBy(contentVersion.documentId, ...workingVersionFirst);
  return new Set(rows.map((r) => r.slug).filter((slug): slug is string => slug != null));
}

/** True when a page sibling (same parent + locale) already uses this segment. */
async function slugTakenBySibling(
  db: Queryable,
  documentId: string,
  parentId: string | null,
  loc: string,
  slug: string,
  knownSiteId?: string,
): Promise<boolean> {
  return (await siblingSlugs(db, documentId, parentId, loc, knownSiteId)).has(slug);
}

/** Reject a URL segment already used by a page sibling (same parent + locale). */
async function assertSlugUnique(
  db: Queryable,
  documentId: string,
  parentId: string | null,
  loc: string,
  slug: string,
): Promise<void> {
  if (await slugTakenBySibling(db, documentId, parentId, loc, slug)) {
    throw Errors.conflict(`Another page already uses the URL segment "${slug}" here`);
  }
}

/**
 * Serialize sibling-slug allocation for one (site, parent, locale) within `tx`
 * (xact-scoped advisory lock, released on commit/rollback). EVERY path that
 * writes a page's URL segment — create, save, restore, publish, move — checks
 * AND writes under this lock; a check outside it is a TOCTOU that lets two
 * concurrent writers commit the same segment (slug-race.test.ts).
 */
async function lockSiblingSlugs(tx: Transaction, siteId: string, parentId: string | null, loc: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`slug:${siteId}:${parentId ?? "root"}:${loc}`}))`);
}

/** A transaction holding the sibling-slug lock for `item`'s slot. Blocks and
 *  globals have no URL segment, so for them it is a plain transaction. */
async function withSiblingSlugLock<T>(
  db: Database,
  item: { kind: string; siteId: string; parentId: string | null },
  loc: string,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    if (item.kind === "page") await lockSiblingSlugs(tx, item.siteId, item.parentId, loc);
    return fn(tx);
  });
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
  db: Queryable,
  documentId: string,
  parentId: string | null,
  loc: string,
  name: string,
  knownSiteId?: string,
): Promise<string | null> {
  const base = slugify(name);
  if (!base) return null;
  const taken = await siblingSlugs(db, documentId, parentId, loc, knownSiteId);
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    if (!taken.has(candidate)) return candidate;
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

/**
 * A global is a per-site singleton: delivery serves the lowest id, so a second
 * live one would save fine and simply never be delivered. Every door that brings
 * a live global into a site — create, duplicate, restore — asks this.
 */
async function assertGlobalSingleton(db: Database, type: ContentTypeDef, siteId: string, exceptDocumentId?: string): Promise<void> {
  if (type.kind !== "global") return;
  const existing = await db
    .select({ documentId: contentItem.documentId })
    .from(contentItem)
    .where(
      and(
        eq(contentItem.type, type.name),
        eq(contentItem.siteId, siteId),
        isNull(contentItem.deletedAt),
        exceptDocumentId ? ne(contentItem.documentId, exceptDocumentId) : undefined,
      ),
    )
    .limit(1);
  if (existing[0]) {
    throw Errors.conflict(
      `A '${type.name}' global already exists in this site (${existing[0].documentId}) — globals are singletons and delivery would ignore a second one. Edit the existing one instead.`,
    );
  }
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
  const reg = await loadTypeRegistry(db);
  const type = requireType(reg, typeName);

  const documentId = nanoid(24);
  // A new top-level item is its own section.
  const effectiveSection = sectionId ?? documentId;
  if (!ctx.siteWide && !ctx.sections.includes(effectiveSection)) {
    throw Errors.forbidden("Cannot create content outside your sections");
  }

  // Children inherit the parent's site (loadAuthorized already confirmed the
  // parent is in the active site); a new root belongs to the active site.
  const effectiveSiteId = parent ? parent.siteId : ctx.siteId;

  await assertGlobalSingleton(db, type, effectiveSiteId);

  // Initial field values take the same verdict an update would (one chokepoint),
  // BEFORE anything is inserted — a 422 leaves no shell behind. Validation reads
  // must not run inside the transaction below (see Queryable).
  const data = req.data ? await prepareDraftData(db, ctx, type, reg, effectiveSiteId, req.locale, req.data, req.allowLanguageMismatch) : {};

  // Atomic create under the sibling-slug lock (S2-M9 TOCTOU). autoSlug runs inside
  // the tx and sees this row's own uncommitted item (so knownSiteId is passed) plus
  // committed siblings.
  await withSiblingSlugLock(db, { kind: type.kind, siteId: effectiveSiteId, parentId: req.parentId }, req.locale, async (tx) => {
    // APPEND after the existing siblings. A fixed sortIndex 0 sent every new
    // child to the FRONT of any manually curated order (and left automated
    // containers with an all-zero, insertion-ordered tree).
    const maxSort = await tx
      .select({ m: sql<number>`coalesce(max(${contentItem.sortIndex}), -1)` })
      .from(contentItem)
      .where(
        and(
          req.parentId ? eq(contentItem.parentId, req.parentId) : isNull(contentItem.parentId),
          eq(contentItem.siteId, effectiveSiteId),
        ),
      );
    await tx.insert(contentItem).values({
      documentId,
      type: type.name,
      kind: type.kind,
      parentId: req.parentId,
      sortIndex: (maxSort[0]?.m ?? -1) + 1,
      sectionId: effectiveSection,
      siteId: effectiveSiteId,
      createdBy: ctx.userId,
    });
    // A caller-chosen page slug must be unique among siblings, checked under the
    // same advisory lock that serializes autoSlug.
    if (req.slug && type.kind === "page" && (await slugTakenBySibling(tx, documentId, req.parentId, req.locale, req.slug, effectiveSiteId))) {
      throw Errors.conflict(`The URL segment '${req.slug}' is already used by a sibling page — choose another slug.`);
    }
    await tx.insert(contentVersion).values({
      documentId,
      locale: req.locale,
      status: "draft",
      isCurrentPublished: false,
      versionNumber: 1,
      name: req.name,
      // Pages get a URL segment from their name right away (CMS-12 style) —
      // uniquified among siblings; editors can change it in the URL chip.
      slug: req.slug ?? (type.kind === "page" ? await autoSlug(tx, documentId, req.parentId, req.locale, req.name, effectiveSiteId) : null),
      displayInNav: true,
      data,
      cv: 0,
      createdBy: ctx.userId,
      createdVia: ctx.via ?? null,
      needsReview: ctx.via === "mcp" || ctx.via === "agent",
    });
    if (req.data) await rebuildReferences(tx, documentId, req.locale, type, data, reg.blockTypes);
  });
  if (req.data) await recordRichTextCoercion(db, ctx, documentId, req.locale, type, req.data, data);

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
  const item = await loadAuthorized(db, ctx, documentId, "read");

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
      // Nothing stored for this locale yet, so there is no draft to conflict
      // with; the first save inserts (and races on the one-draft index instead).
      revision: 0,
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
    // The token belongs to the DRAFT row (the only row updateContent mutates in
    // place). When there is no draft yet, 0 means "expect an insert" — matching a
    // published row's own revision here would let a save target the wrong row.
    revision: draft ? draft.revision : 0,
  };
}

/* ------------------------------ update/save ------------------------------- */

/** The top-level content fields a Zod parse error refers to (deduped, in order),
 *  so the API can hand them to the admin for inline display. */
function failedFields(err: { issues?: Array<{ path: readonly PropertyKey[] }> }): string[] {
  const names = (err.issues ?? [])
    .map((i) => i.path.find((p) => typeof p === "string"))
    .filter((p): p is string => typeof p === "string");
  return [...new Set(names)];
}

/** Turn a Zod parse error into a concise, human message naming the field(s). */
function formatValidation(err: { issues?: Array<{ path: readonly PropertyKey[]; message: string }> }): string {
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
  err: { issues?: Array<{ path: readonly PropertyKey[]; message: string }> },
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
 * Every content type installed, read ONCE per write: the walks below visit
 * every level of a document, and coercion, validation and the reference
 * rebuild all need the same lookup. `blockTypes` is the sync resolver those
 * chokepoints take (coerceData lives in packages/shared and cannot query).
 */
interface TypeRegistry {
  known: Map<string, { kind: string; nestedOnly: boolean; def: ContentTypeDef }>;
  /** Names a content area can legally hold, for the self-teaching refusal. */
  placeable: string[];
  /** Every installed name, for `optionsFromContentTypes` fields. */
  installed: string[];
  blockTypes: BlockTypeResolver;
}

async function loadTypeRegistry(db: Database): Promise<TypeRegistry> {
  const rows = await db
    .select({ name: contentType.name, kind: contentType.kind, definition: contentType.definition })
    .from(contentType)
    .orderBy(asc(contentType.name));
  const known = new Map<string, { kind: string; nestedOnly: boolean; def: ContentTypeDef }>();
  for (const r of rows) {
    // Same normalization as getContentType (SEO group injected), so a def read
    // here validates and coerces exactly like one read there.
    const def = parseStoredContentTypeDef(r.definition);
    known.set(r.name, { kind: r.kind, nestedOnly: def.nestedOnly === true, def });
  }
  // The hint lists what an area with no allow-list actually accepts: general
  // blocks and pages. A PART would be refused two checks later, so naming it
  // here sent the caller straight into the next refusal.
  const typed = [...known].map(([name, e]) => ({ name, kind: e.kind, nestedOnly: e.nestedOnly }));
  const general = new Set(generalBlockTypes(typed).map((t) => t.name));
  return {
    known,
    placeable: typed.filter((t) => t.kind === "page" || general.has(t.name)).map((t) => t.name),
    installed: rows.map((r) => r.name),
    blockTypes: (name) => known.get(name)?.def,
  };
}

/** The installed type by name, from the registry this write already loaded. */
function requireType(reg: TypeRegistry, name: string): ContentTypeDef {
  const def = reg.known.get(name)?.def;
  if (!def) throw typeNotFound(name, reg.installed);
  return def;
}

/** What a write may point at: the content_item essentials of a referenced document. */
type TargetRow = { documentId: string; siteId: string; type: string; kind: string; deletedAt: Date | null };

/** Every documentId a document points at — reference fields and content-area
 *  `ref`s, through the same inline levels the placement guard walks. */
function collectTargetIds(type: ContentTypeDef, data: Record<string, unknown>, reg: TypeRegistry, depth: number, out: Set<string>): void {
  for (const f of type.fields) {
    const v = data[f.name];
    if (v == null) continue;
    if (f.type === "reference" && typeof v === "object") {
      const id = (v as { documentId?: unknown }).documentId;
      if (typeof id === "string" && id) out.add(id);
    }
    if (f.type === "contentArea" && Array.isArray(v)) {
      for (const b of v as Array<{ blockType?: string; ref?: unknown; inline?: unknown }>) {
        if (typeof b?.ref === "string" && b.ref) out.add(b.ref);
        const entry = b?.blockType ? reg.known.get(b.blockType) : undefined;
        if (entry && depth < MAX_INLINE_DEPTH && b.inline && typeof b.inline === "object" && !Array.isArray(b.inline)) {
          collectTargetIds(entry.def, b.inline as Record<string, unknown>, reg, depth + 1, out);
        }
      }
    }
  }
}

/**
 * The referenced document, or a self-teaching refusal when it cannot be pointed
 * at. Another site's document reads as unknown — deny-by-default, exactly as
 * every management read treats it — and that is what closes the cross-site
 * reference gap at write time.
 */
function resolveTarget(targets: Map<string, TargetRow>, siteId: string, id: string, subject: string): TargetRow {
  const target = targets.get(id);
  if (!target || target.siteId !== siteId) {
    throw Errors.validation(
      `${subject} references "${id}", which does not exist in this site — it would deliver nothing. ` +
        `Reference the documentId of an existing document in this site, or clear it.`,
    );
  }
  if (target.deletedAt) {
    throw Errors.validation(`${subject} references "${id}", which is in the trash. Restore it first, or reference another document.`);
  }
  return target;
}

/**
 * Placement rules, applied at EVERY level of the document.
 *
 * This used to walk `type.fields` and stop there, while the schema layer in
 * packages/shared deliberately returned on an unknown block type because "the db
 * layer already refuses it". Both statements were true at the top level and
 * false below it — two guards each deferring to the other — so a mistyped type
 * nested inside another block (`FormTextFeild` among a Form's fields, a typo'd
 * accordion item) saved 200, PUBLISHED 200, and delivered
 * `{blockType:"FormTextFeild", data:{}, fieldTypes:{}}`. The question vanished
 * from the form and the caller collected two successes: the HerooBlock incident
 * one level deeper.
 *
 * `where` accumulates the path, because a refusal that cannot say WHERE turns a
 * one-step fix into a guess (rule #2).
 */
function assertPlacement(
  type: ContentTypeDef,
  data: Record<string, unknown>,
  reg: TypeRegistry,
  targets: Map<string, TargetRow>,
  siteId: string,
  where: string,
  depth: number,
): void {
  // Where this field sits. Empty at the top level, so the messages agents have
  // been reading since the HerooBlock fix stay byte-identical there.
  const at = depth === 0 ? "" : `In ${where}: `;
  for (const f of type.fields) {
    const v = data[f.name];
    if (v == null) continue;

    // Fields whose value names a content type (e.g. a ListPage's listedType) must
    // reference an INSTALLED type — never a hardcoded "fantasy" option. A list
    // page pointing at a non-existent type lists nothing and traps agents the
    // placement guard sends to create it (2026-06-07 incident).
    if (f.optionsFromContentTypes) {
      for (const val of (Array.isArray(v) ? v : [v]).filter((x) => typeof x === "string")) {
        if (!reg.installed.includes(val as string)) {
          throw Errors.validation(
            `Field "${f.name}" must be an installed content type, but "${String(val)}" does not exist. ` +
              `Available: ${reg.installed.join(", ")}. (Create that content type first, or pick one of these.)`,
          );
        }
      }
    }

    if (f.type === "reference" && typeof v === "object") {
      const id = (v as { documentId?: unknown }).documentId;
      if (typeof id === "string" && id) {
        // Enforced on the target's REAL type; the client's `type` is only a hint.
        const target = resolveTarget(targets, siteId, id, `${at}Field "${f.name}"`);
        if (f.allowedTypes.length && !f.allowedTypes.includes(target.type)) {
          throw Errors.validation(`${at}Field "${f.name}" does not allow references to "${target.type}"`);
        }
      }
    }

    if (f.type === "contentArea" && Array.isArray(v)) {
      const blocks = v as Array<{ blockType?: string; ref?: unknown; inline?: unknown }>;
      for (const [i, b] of blocks.entries()) {
        const bt = b?.blockType;
        if (!bt) continue;
        const here = `${where} -> "${f.name}"[${i}] (${bt})`;

        // An UNKNOWN blockType is rejected regardless of allowedBlocks. The default
        // `allowedBlocks: []` documents "any block", which used to mean "no check at
        // all": {blockType:"HerooBlock", inline:{titel:"Hi"}} saved 200, PUBLISHED
        // 200, and delivered `data:{}, fieldTypes:{}` — the inline payload silently
        // vanished. Three successes and a blank page is the retry loop rule #1 exists
        // to prevent, so the type must at least exist. Self-teaching (rule #2).
        const entry = reg.known.get(bt);
        if (!entry) {
          throw Errors.validation(
            `${at}Content area "${f.name}" got blockType "${bt}", which is not an installed content type — ` +
              `its inline data would be silently dropped at delivery. Available: ${reg.placeable.join(", ")}. ` +
              `(Create that block type first, or use one of these.)`,
          );
        }

        // `allowedBlocks` constrains BLOCK types only. A page dropped into a
        // content area is rendered as a teaser (Optimizely-style) and is always
        // placeable — its type name is never in allowedBlocks.
        if (f.allowedBlocks.length && !f.allowedBlocks.includes(bt) && entry.kind !== "page") {
          throw Errors.validation(`${at}Content area "${f.name}" does not allow block "${bt}"`);
        }

        // "Any block" means any GENERAL block. A nested-only type is a PART of
        // one specific parent (a Form's field blocks), so an area that never
        // named it has not opted in — and a part placed loose in a page body
        // delivers a block no frontend can render, the same success-then-blank
        // failure the unknown-blockType branch above exists to stop.
        if (!f.allowedBlocks.length && entry.nestedOnly) {
          throw Errors.validation(
            `${at}Content area "${f.name}" does not accept "${bt}": it is a PART, only used inside another type ` +
              `(its own parent lists it in that area's allowed blocks). This area allows any GENERAL block. ` +
              `Place it inside the type it belongs to, or — if you really mean it here — add "${bt}" to ` +
              `this area's allowedBlocks on content type "${type.name}".`,
          );
        }

        // A shared reference must point at what it says it points at. Delivery
        // resolves the target's REAL type and drops anything it cannot see, so a
        // ref to a Form under blockType "HeroBlock", to a trashed block, or to
        // another site's document saved and published a block that rendered
        // nothing (rule #1). Pages stay placeable — they render as teasers.
        if (typeof b.ref === "string" && b.ref) {
          const subject = `${at}Content area "${f.name}"[${i}]`;
          const target = resolveTarget(targets, siteId, b.ref, subject);
          if (target.kind !== "block" && target.kind !== "page") {
            throw Errors.validation(
              `${subject} references "${b.ref}", which is a ${target.kind} ("${target.type}") — only shared blocks and pages can be placed in a content area.`,
            );
          }
          if (target.type !== bt) {
            throw Errors.validation(
              `${subject} says blockType "${bt}", but "${b.ref}" is a "${target.type}". Set blockType to "${target.type}" — or reference a ${bt}.`,
            );
          }
        }

        // Down into the block's own payload. A shared reference carries none.
        const inline = b?.inline;
        if (!inline || typeof inline !== "object" || Array.isArray(inline)) continue;
        // Submissions are posted against a Form's documentId, and delivery
        // attaches `content.form` to an ITEM only — an inline Form has neither,
        // so it is authorable and dead at delivery.
        if (isFormType(bt)) {
          throw Errors.validation(
            `${at}Content area "${f.name}"[${i}] holds an INLINE Form. A Form must be placed as a SHARED block — ` +
              `submissions are posted against its documentId, which an inline block does not have. Create the Form under ` +
              `Blocks and reference it here: {"blockType":"Form","ref":"<the Form's documentId>","inline":null}.`,
          );
        }
        if (depth >= MAX_INLINE_DEPTH) {
          // REFUSED, not waved through. Coercion and schema validation walk
          // exactly MAX_INLINE_DEPTH inline levels, so anything below would reach
          // storage unchecked — and an unchecked level is precisely the hole this
          // guard closes, with nesting the cheapest way to reach it.
          throw Errors.validation(
            `Content areas nest at most ${MAX_INLINE_DEPTH} levels deep, and ${here} is level ${depth + 1}, so its ` +
              `payload cannot be checked. Flatten the structure — nothing renders content nested this far.`,
          );
        }
        assertPlacement(entry.def, inline as Record<string, unknown>, reg, targets, siteId, here, depth + 1);
      }
    }
  }
}

/**
 * Enforce per-field placement rules ("allowed types"): a contentArea only accepts
 * blocks whose type is in `allowedBlocks`; a reference only accepts targets whose
 * type is in `allowedTypes`. Empty list = unrestricted. This makes the editor hint
 * a real, write-enforced invariant (an API client cannot bypass it), at every
 * level of the document. Every target is loaded ONCE and checked against what it
 * really is — existing, in `siteId` (the document's own site: shared blocks are
 * site-wide, so the section scope is the wrong partition), not trashed, and of
 * the type the write claims. Throws Errors.validation on the first violation.
 *
 * Called from `updateContent` and from `assertDraftPublishable`, so save and
 * publish are held to the same rules by construction.
 */
async function assertAllowedTypes(db: Database, type: ContentTypeDef, data: Record<string, unknown>, siteId: string, reg: TypeRegistry): Promise<void> {
  const ids = new Set<string>();
  collectTargetIds(type, data, reg, 0, ids);
  const targets = new Map<string, TargetRow>();
  if (ids.size > 0) {
    const rows = await db
      .select({ documentId: contentItem.documentId, siteId: contentItem.siteId, type: contentItem.type, kind: contentItem.kind, deletedAt: contentItem.deletedAt })
      .from(contentItem)
      .where(inArray(contentItem.documentId, [...ids]));
    for (const r of rows) targets.set(r.documentId, r);
  }
  assertPlacement(type, data, reg, targets, siteId, `content type "${type.name}"`, 0);
}

/** Persists the outgoing references of a (document, locale) data blob, in the
 *  same transaction as the version write it indexes. */
async function rebuildReferences(
  tx: Transaction,
  documentId: string,
  loc: string,
  type: ContentTypeDef,
  data: Record<string, unknown>,
  blockTypes: BlockTypeResolver,
): Promise<void> {
  // Collected first, THEN delete+insert in the caller's transaction: a crash
  // between the delete and the insert would otherwise leave the document with
  // zero outgoing references and nothing to rebuild them — and
  // findReferencingDocuments (what an editor consults before deleting a page)
  // reads exactly this table.
  const refs: (typeof contentReference.$inferInsert)[] = [];
  const add = (toDocumentId: string, toType: string, fieldName: string) => {
    refs.push({ fromDocumentId: documentId, fromLocale: loc, toDocumentId, toType, fieldName });
  };

  /**
   * Collect the outgoing references of one field set. Recurses into a content
   * area's INLINE block data, because a block's own reference and link fields
   * point at content just as much as a top-level field does — the front page's
   * hero CTA is an inline block, so tracking only the top level would miss the
   * links that matter most. Walks the same MAX_INLINE_DEPTH levels as coercion,
   * schema validation and the placement guard, so every link a document can
   * legally hold is tracked.
   */
  const collect = (fields: ContentTypeDef["fields"], values: Record<string, unknown>, prefix: string, depth: number) => {
    for (const f of fields) {
      const v = values[f.name];
      if (v == null) continue;
      const path = prefix ? `${prefix}.${f.name}` : f.name;
      if (f.type === "reference" && typeof v === "object") {
        const rv = v as { documentId?: string; type?: string };
        if (rv.documentId) add(rv.documentId, rv.type ?? "", path);
      }
      // An INTERNAL link is a reference: that is the whole point of storing the
      // documentId instead of a path. Recording it here is what makes link
      // integrity possible — which pages link here, and what breaks if this one
      // is deleted or unpublished.
      if (f.type === "link" && typeof v === "object") {
        const lv = v as { documentId?: string };
        if (lv.documentId) add(lv.documentId, "", path);
      }
      if (f.type === "contentArea" && Array.isArray(v)) {
        for (const block of v as Array<{ ref?: string | null; blockType?: string; inline?: unknown }>) {
          if (block?.ref) add(block.ref, block.blockType ?? "", path);
          if (depth <= 0 || !block?.inline || typeof block.inline !== "object") continue;
          const blockDef = blockTypes(block.blockType ?? "");
          if (blockDef) collect(blockDef.fields, block.inline as Record<string, unknown>, path, depth - 1);
        }
      }
    }
  };
  collect(type.fields, data, "", MAX_INLINE_DEPTH);
  await tx
    .delete(contentReference)
    .where(and(eq(contentReference.fromDocumentId, documentId), eq(contentReference.fromLocale, loc)));
  if (refs.length) await tx.insert(contentReference).values(refs);
}

/**
 * The ONE path from a caller's raw field map to storable draft data: tolerant
 * coercion, relaxed (draft) validation with self-teaching errors, placement
 * rules, and the agent language guard. Shared by create and update so a value
 * gets exactly one verdict no matter which call carried it. Reads only — safe
 * to run before a transaction opens (its lookups must never borrow a second
 * pool connection from inside one).
 */
async function prepareDraftData(
  db: Database,
  ctx: AccessContext,
  type: ContentTypeDef,
  reg: TypeRegistry,
  siteId: string,
  loc: string,
  raw: Record<string, unknown>,
  allowLanguageMismatch?: boolean,
): Promise<Record<string, unknown>> {
  // Tolerant coercion: fix the unambiguous field-shape mistakes agents make
  // (single block → array, doc → text, string → doc) before validating.
  const data = coerceData(type, raw, loc, reg.blockTypes, await localeCodes(db));

  // Draft save: relaxed validation (required fields not enforced). On failure
  // the message names each field's expected JSON shape (with an example), so an
  // agent can self-correct instead of guessing.
  // The resolver makes this validate INLINE block payloads too, not just the
  // document's own fields — a malformed block used to persist and fail only in
  // the visitor's browser (see contentAreaSchemaFor).
  const parsed = dataSchemaFor(type, false, reg.blockTypes).safeParse(data);
  if (!parsed.success) throw Errors.validation(formatDataValidation(parsed.error, type), failedFields(parsed.error));
  // Placement rules ARE enforced even on draft save (allowed blocks / ref types).
  await assertAllowedTypes(db, type, data, siteId, reg);

  // Agent write-time language guard: refuse strongly language-mismatched content
  // BEFORE it lands on the wrong locale branch. A draft is never re-checked
  // until publish, so without this an agent that forgets to switch locale leaves
  // (e.g.) a Norwegian page sitting silently on the 'en' branch (2026-06-08).
  // Agent provenance only — a human editor is never second-guessed; escape hatch
  // for deliberate cross-language writes. Mirrors the publish guard.
  if ((ctx.via === "mcp" || ctx.via === "agent") && !allowLanguageMismatch) {
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
  return data;
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
  const reg = await loadTypeRegistry(db);
  const type = requireType(reg, item.type);

  // Merge mode: shallow-merge the patch over the current working data so a
  // caller can change one field without round-tripping the whole map.
  const merged = req.merge ? { ...(await workingData(db, documentId, loc)), ...req.data } : req.data;
  const data = await prepareDraftData(db, ctx, type, reg, item.siteId, loc, merged, req.allowLanguageMismatch);

  // Forensic trail (2026-06-08): a richtext "body" that arrives as a Markdown
  // string (set_field) or as a doc-ish value gets transformed by the coercion
  // chokepoint into the stored TipTap doc. If that transform is ever wrong, the
  // bad draft is overwritten by the next save and the original input is lost —
  // the incident becomes undiagnosable. Record a durable, truncated breadcrumb
  // of the RAW input whenever coercion did real work on a richtext field, so a
  // future "malformed body" report is reproducible from the audit log alone.
  await recordRichTextCoercion(db, ctx, documentId, loc, type, merged, data);

  await withSiblingSlugLock(db, item, loc, async (tx) => {
    // URL segments must be unique among page siblings (per locale) so paths are unambiguous.
    if (item.kind === "page" && req.slug) {
      await assertSlugUnique(tx, documentId, item.parentId, loc, req.slug);
    }

    // Find or create the working draft (single-draft invariant).
    const existing = await tx
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
        ? autoSlug(tx, documentId, item.parentId, loc, name)
        : currentSlug;

    if (existing[0]) {
      const name = req.name ?? existing[0].name;
      const slug = req.slug !== undefined ? req.slug : await backfillSlug(existing[0].slug, name);
      // Optimistic concurrency (see migration 0016). The revision match lives in the
      // WHERE clause, not in a JS comparison against the row we read above: two
      // concurrent saves would both pass a check-then-write and the second would
      // still clobber. Matching in the UPDATE makes the loser affect zero rows.
      const updated = await tx
        .update(contentVersion)
        .set({
          name,
          slug,
          displayInNav: req.displayInNav ?? existing[0].displayInNav,
          data,
          revision: sql`${contentVersion.revision} + 1`,
          createdBy: ctx.userId,
          createdAt: new Date(),
          // Provenance: an agent (mcp) write flags the draft for human review; a
          // human (web) write clears it — the human has seen the content.
          createdVia: ctx.via ?? null,
          needsReview: ctx.via === "mcp" || ctx.via === "agent",
        })
        .where(
          and(
            eq(contentVersion.id, existing[0].id),
            req.revision === undefined ? undefined : eq(contentVersion.revision, req.revision),
          ),
        )
        .returning({ id: contentVersion.id });
      if (!updated[0]) {
        // Self-teaching (rule #2): name the cause, the surface that moved it, and
        // the one-step recovery. This message is what an editor and an agent both
        // read to recover, so it has to carry the whole recipe.
        throw Errors.conflict(
          `This content was changed by someone else since you loaded it (revision ${req.revision} is no longer current). ` +
            `Your save was refused so their work isn't overwritten. ` +
            `Re-read the content (GET /manage/content/${documentId}?locale=${loc}), re-apply your change to the fresh data, and save again with the new revision. ` +
            `To patch a single field without a revision conflict, send merge: true — it merges over whatever is current.`,
        );
      }
    } else {
      // Reaching the INSERT branch means there is NO draft row right now. A caller
      // that asserted a specific non-zero revision was therefore looking at a draft
      // that has since been consumed — published (promoted away) or discarded
      // (deleted) — so its snapshot is stale and this branch would silently
      // re-insert it, regressing the live page on the next publish. `revision: 0` is
      // the honest "I know there is no draft" and is still accepted (getContent
      // reports 0 for a draft-less document), as is omitting it entirely.
      if (req.revision !== undefined && req.revision !== 0) {
        throw Errors.conflict(
          `The draft you were editing no longer exists — it was published or discarded since you loaded it (revision ${req.revision} is gone). ` +
            `Your save was refused so it can't overwrite the newer state. ` +
            `Re-read the content (GET /manage/content/${documentId}?locale=${loc}), re-apply your change, and save again with the revision it returns.`,
        );
      }
      // No working draft yet (editing a published OR an unpublished item): seed a
      // draft from the best available base — the live published version, else the
      // latest version of any status. Using the latest version is what prevents an
      // unpublished page (no current-published row) from losing its name/slug on
      // the next edit.
      const maxV = await nextVersionNumber(tx, documentId, loc);
      const sameLocale = (await currentPublished(tx, documentId, loc)) ?? (await latestVersion(tx, documentId, loc));
      // First write in a NEW locale: fork identity (name/slug/nav) from the newest
      // version in any other locale — never the "Untitled" placeholder. An agent
      // that writes fields without addressing the name otherwise publishes a
      // placeholder (2026-06-06 incident: nb forked as "Untitled", went live at
      // /untitled while the en draft held the real name).
      const fork = sameLocale ? null : await latestVersionAnyLocale(tx, documentId);
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
        slug = item.kind === "page" ? await autoSlug(tx, documentId, item.parentId, loc, name) : null;
      } else {
        // Inherit the source locale's slug (it may be editor-customised), unless a
        // sibling in this locale already uses it — then re-derive from the name.
        slug = (await slugTakenBySibling(tx, documentId, item.parentId, loc, fork.slug))
          ? await autoSlug(tx, documentId, item.parentId, loc, name)
          : fork.slug;
      }
      try {
        await tx.insert(contentVersion).values({
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

    await rebuildReferences(tx, documentId, loc, type, data, reg.blockTypes);
  });
  return getContent(db, ctx, documentId, loc);
}

async function nextVersionNumber(db: Queryable, documentId: string, loc: string): Promise<number> {
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
async function latestVersionAnyLocale(db: Queryable, documentId: string) {
  const rows = await db
    .select()
    .from(contentVersion)
    .where(eq(contentVersion.documentId, documentId))
    .orderBy(desc(contentVersion.createdAt), desc(contentVersion.id))
    .limit(1);
  return rows[0] ?? null;
}

/** The highest-versionNumber row for a variant, regardless of status. */
async function latestVersion(db: Queryable, documentId: string, loc: string) {
  const rows = await db
    .select()
    .from(contentVersion)
    .where(and(eq(contentVersion.documentId, documentId), eq(contentVersion.locale, loc)))
    .orderBy(desc(contentVersion.versionNumber))
    .limit(1);
  return rows[0] ?? null;
}

async function currentPublished(db: Queryable, documentId: string, loc: string) {
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
  const reg = await loadTypeRegistry(db);
  const type = requireType(reg, item.type);
  const parsed = dataSchemaFor(type, true, reg.blockTypes).safeParse(draft.data);
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
  await assertAllowedTypes(db, type, draft.data as Record<string, unknown>, item.siteId, reg);
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
  // A form stores one answer per key, so two fields sharing one means the
  // second never reaches a visitor — formSpecFrom keeps the first. The admin
  // warns while editing, but an agent writing over MCP/REST has no admin to
  // read: without this the publish succeeded and served a form missing a
  // question nobody was told about (agent-API rule 1, rule 2 for the wording).
  if (isFormType(item.type)) {
    const area = (draft.data as { fields?: unknown }).fields;
    const clashes = [...duplicateFieldKeys(Array.isArray(area) ? area : [])];
    if (clashes.length > 0) {
      throw Errors.validation(
        `This form has two fields with the same key: ${clashes.map((k) => `"${k}"`).join(", ")}. ` +
          "A form stores one answer per key, so only the first field would reach visitors. " +
          "Give each field its own `name` in the fields area — e.g. \"email\" and \"workEmail\" " +
          "— then publish again. Labels may repeat; keys may not.",
      );
    }
  }
  // Early, unlocked sibling-slug check so a SCHEDULED publish fails at scheduling
  // time, not at go-live; promoteDraft re-checks under the lock before writing.
  if (item.kind === "page" && draft.slug) {
    await assertSlugUnique(db, item.documentId, item.parentId, loc, draft.slug);
  }
}

/**
 * Core publish promotion (NO RBAC — callers authorize). Demotes the prior
 * current-published row and promotes `draftId` to live, allocating a fresh cv
 * atomically and clearing its scheduled publish_at. Any expire_at already on the
 * row is preserved (it becomes the live row's expiry). Shared by the manual
 * publish route AND the scheduled-publish ticker. A page's URL segment is
 * re-checked against its siblings under the slug lock, on the row as it is NOW
 * (a concurrent save may have changed it since the caller read it).
 */
async function promoteDraft(
  db: Database,
  item: Pick<typeof contentItem.$inferSelect, "documentId" | "kind" | "siteId" | "parentId">,
  loc: string,
  draftId: number,
  actorUserId: string | null,
): Promise<void> {
  const { documentId } = item;
  try {
    await withSiblingSlugLock(db, item, loc, async (tx) => {
      if (item.kind === "page") {
        const [row] = await tx.select({ slug: contentVersion.slug }).from(contentVersion).where(eq(contentVersion.id, draftId));
        if (row?.slug) await assertSlugUnique(tx, documentId, item.parentId, loc, row.slug);
      }
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

/**
 * Fan a publish/unpublish out to the site's webhooks WITHOUT blocking the write.
 * Lives in the query layer so every surface that promotes or demotes a row —
 * REST, MCP, the scheduler — announces it; when only the manage route fired
 * these, an agent publish over MCP never triggered a rebuild. Per-hook failures
 * are recorded in webhook_delivery by dispatchWebhooks; only a failure to
 * dispatch at all is logged here.
 */
function announceContent(
  db: Database,
  event: "content.published" | "content.unpublished",
  item: { siteId: string; documentId: string; type: string; kind: string },
  loc: string,
  name: string,
  urlPath: string | null,
): void {
  void dispatchWebhooks(db, { event, siteId: item.siteId, documentId: item.documentId, type: item.type, kind: item.kind, locale: loc, name, urlPath, at: new Date().toISOString() }).catch(
    (err: unknown) => console.error(`[paperboy] ${event} webhook dispatch failed for ${item.documentId}:`, err),
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
    await promoteDraft(db, item, loc, latest.id, ctx.userId);
    const published = await getContent(db, ctx, documentId, loc);
    announceContent(db, "content.published", item, loc, published.name, published.urlPath);
    return published;
  }

  await assertDraftPublishable(db, item, loc, draft);
  // Agent provenance only — never second-guess a human editor.
  if ((ctx.via === "mcp" || ctx.via === "agent") && !opts?.allowLanguageMismatch) {
    await assertLanguageMatchesBranch(db, item, loc, draft);
  }
  await promoteDraft(db, item, loc, draft.id, ctx.userId);
  const published = await getContent(db, ctx, documentId, loc);
  announceContent(db, "content.published", item, loc, published.name, published.urlPath);
  return published;
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
    await promoteDraft(db, item, loc, draft.id, ctx.userId);
    announceContent(db, "content.published", item, loc, draft.name, item.kind === "page" ? await computePath(db, documentId, loc) : null);
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
      const reg = await loadTypeRegistry(db);
      const parsed = dataSchemaFor(requireType(reg, item.type), true, reg.blockTypes).safeParse(d.data);
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
      await promoteDraft(db, item, d.locale, d.id, d.createdBy);
      const urlPath = item.kind === "page" ? await computePath(db, d.documentId, d.locale) : null;
      await dispatchWebhooks(db, {
        event: "content.published",
        siteId: item.siteId,
        documentId: d.documentId,
        type: item.type,
        kind: item.kind,
        locale: d.locale,
        name: d.name,
        urlPath,
        at: new Date().toISOString(),
      });
      published++;
    } catch (err) {
      // Leave a trail rather than swallow it (rule #6 spirit) — mirrors the
      // validation branch and the expire loop, so a failed scheduled publish is
      // diagnosable from the audit log (L7).
      await db
        .insert(auditLog)
        .values({ action: "content.schedule_failed", documentId: d.documentId, locale: d.locale, detail: { reason: err instanceof Error ? err.message : String(err) } })
        .catch(() => undefined);
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
        siteId: item?.siteId ?? DEFAULT_SITE_ID,
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
  const item = await loadAuthorized(db, ctx, documentId);
  // The path is computed BEFORE demoting — afterwards the page is no longer publicly resolvable.
  const live = await currentPublished(db, documentId, loc);
  const urlPath = live && item.kind === "page" ? await computePath(db, documentId, loc) : null;
  // ponytail: the fresh cv only versions the withdrawn ROW; the LIST ETag (max cv
  // over returned items) stays byte-identical, so a CDN keeps serving the
  // withdrawn item — open, pinned by withdrawal-invalidates-cache.test.ts.
  const cvRow = await db.execute(sql`SELECT nextval('cv_seq') AS v`);
  const cv = Number((cvRow as unknown as Array<{ v: string }>)[0]?.v ?? 0);
  await db
    .update(contentVersion)
    .set({ isCurrentPublished: false, cv })
    .where(
      and(
        eq(contentVersion.documentId, documentId),
        eq(contentVersion.locale, loc),
        eq(contentVersion.isCurrentPublished, true),
      ),
    );
  if (live) announceContent(db, "content.unpublished", item, loc, live.name, urlPath);
  return getContent(db, ctx, documentId, loc);
}

/**
 * Throw away the draft and fall back to the published version.
 *
 * Refuses when the draft is the document's LAST version anywhere — a page that
 * was created but never published has nothing to fall back to, so discarding
 * would delete the only version and leave the `content_item` row behind with
 * none. That ghost still sits in the page tree (named after its own documentId,
 * since there is no version to read a name from) and opens a broken editor.
 * Live 2026-07-27: three MCP-created BlogPosts under /blog were tidied up this
 * way and became un-editable rows in the tree. `deleteVariant` refuses the same
 * move for the same reason — trash removes a whole document, discard does not.
 */
export async function discardDraft(
  db: Database,
  ctx: AccessContext,
  documentId: string,
  loc: string,
): Promise<void> {
  requirePermission(ctx, "content.update");
  await loadAuthorized(db, ctx, documentId);
  const others = await db
    .select({ id: contentVersion.id })
    .from(contentVersion)
    .where(
      and(
        eq(contentVersion.documentId, documentId),
        // Anything the document would still own after the delete below.
        or(ne(contentVersion.locale, loc), ne(contentVersion.status, "draft")),
      ),
    )
    .limit(1);
  if (others.length === 0) {
    throw Errors.badRequest(
      "This page has never been published, so there is no version to fall back to — discarding its only draft would leave an empty page in the tree. Move the page to trash instead to remove it.",
    );
  }
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
  // References are keyed (fromDocumentId, fromLocale); both deletes land together.
  const deleted = await db.transaction(async (tx) => {
    await tx
      .delete(contentReference)
      .where(and(eq(contentReference.fromDocumentId, documentId), eq(contentReference.fromLocale, loc)));
    return tx
      .delete(contentVersion)
      .where(and(eq(contentVersion.documentId, documentId), eq(contentVersion.locale, loc)))
      .returning({ id: contentVersion.id });
  });
  return { ok: true, deleted: deleted.length };
}

/* --------------------------------- move ----------------------------------- */

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
  }

  await db.transaction(async (tx) => {
    if (reparent) {
      // Serialize structural moves within the site so the acyclicity check and the
      // reparent write are atomic — two opposing concurrent reparents can't both
      // pass and form a cycle. The advisory xact lock auto-releases on commit/rollback.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`move:${ctx.siteId}`}))`);
      // Sibling URL-segment uniqueness at the destination, for every locale that
      // has a segment — under the same lock a save into that slot takes.
      const localeRows = await tx
        .select({ locale: contentVersion.locale })
        .from(contentVersion)
        .where(eq(contentVersion.documentId, documentId));
      for (const locale of new Set(localeRows.map((r) => r.locale))) {
        const slug = await workingSlug(tx, documentId, locale);
        if (!slug) continue;
        await lockSiblingSlugs(tx, item.siteId, targetParentId, locale);
        await assertSlugUnique(tx, documentId, targetParentId, locale, slug);
      }
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
          .where(
            and(
              inArray(contentItem.parentId, frontier),
              // Children inherit their parent's site, so a cross-site child should
              // be impossible — belt-and-braces so a stray row can never have its
              // section rewritten from another tenant's move.
              eq(contentItem.siteId, item.siteId),
              isNull(contentItem.deletedAt),
            ),
          );
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
          // MUST be site-filtered: `isNull(parentId)` matches the roots of EVERY
          // site, so without this a reorder in one site renumbered every other
          // site's root order (and their nav + deliveryList ordering with it).
          eq(contentItem.siteId, item.siteId),
          isNull(contentItem.deletedAt),
        ),
      )
      .orderBy(asc(contentItem.sortIndex), asc(contentItem.id));
    const ids = siblings.map((s) => s.documentId).filter((id) => id !== documentId);
    let insertAt = ids.length;
    if (opts.beforeId && ids.includes(opts.beforeId)) insertAt = ids.indexOf(opts.beforeId);
    else if (opts.afterId && ids.includes(opts.afterId)) insertAt = ids.indexOf(opts.afterId) + 1;
    ids.splice(insertAt, 0, documentId);
    await tx.execute(sql`
      UPDATE content_item AS c SET sort_index = v.i
      FROM (VALUES ${sql.join(ids.map((id, i) => sql`(${id}::text, ${i * 10}::int)`), sql`, `)}) AS v(id, i)
      WHERE c.document_id = v.id`);
  });
}

/**
 * Declare how a container page orders its children: "manual" (the drag-and-drop
 * tree order), or a computed rule — "name" | "createdAt" | "data.<field>",
 * "-" prefix for descending. The admin tree AND delivery's default list order
 * both follow the rule, so editors and readers see the same sequence.
 */
export async function setChildSort(
  db: Database,
  ctx: AccessContext,
  documentId: string,
  rule: string,
): Promise<void> {
  requirePermission(ctx, "content.update");
  const item = await loadAuthorized(db, ctx, documentId);
  if (item.kind !== "page") throw Errors.badRequest("Child ordering applies to pages (containers), not blocks or globals");
  const parsed = ChildSort.safeParse(rule);
  if (!parsed.success) {
    throw Errors.validation(parsed.error.issues[0]?.message ?? "Invalid childSort rule");
  }
  await db.update(contentItem).set({ childSort: parsed.data }).where(eq(contentItem.documentId, documentId));
}

/** Flat list of all pages in scope (id, name, parentId) — powers the "Move to" picker. */
export async function listPages(db: Database, ctx: AccessContext): Promise<PageSummary[]> {
  requirePermission(ctx, "content.read");
  const items = await db
    .select()
    .from(contentItem)
    .where(and(eq(contentItem.kind, "page"), isNull(contentItem.deletedAt), eq(contentItem.siteId, ctx.siteId)))
    .orderBy(asc(contentItem.sortIndex), asc(contentItem.id));
  const visible = items.filter((i) => ctx.readSiteWide || ctx.sections.includes(i.sectionId ?? i.documentId));
  const pageStates = await variantStatesBatch(db, visible.map((i) => i.documentId));
  const out: PageSummary[] = [];
  for (const item of visible) {
    const states = pageStates.get(item.documentId) ?? {};
    const locales: PageSummary["locales"] = {};
    for (const [code, s] of Object.entries(states)) {
      locales[code] = { status: s.status, hasUnpublishedChanges: s.hasUnpublishedChanges };
    }
    out.push({
      documentId: item.documentId,
      name: Object.values(states)[0]?.name ?? item.documentId,
      parentId: item.parentId,
      type: item.type,
      locales,
    });
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
 * Content search (⌘K): case-insensitive substring match on the CURRENT versions'
 * name/URL segment (working draft or live published — never history) across
 * every in-scope document (pages + blocks), not just the loaded tree.
 * Deny-by-default scope (siteWide or section-scoped); excludes trash. One hit
 * per document, preferring the published-then-latest matching version.
 *
 * ILIKE on name/slug rather than the `fts` column: the palette promises
 * substring matches on titles, while fts is word-prefix matching over body text
 * too — different results, not a faster path to the same ones.
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
  if (!ctx.readSiteWide && ctx.sections.length === 0) return [];
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
  // Escape LIKE metacharacters (Postgres default ESCAPE is backslash).
  const pattern = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;

  const rows = await db
    .selectDistinctOn([contentVersion.documentId], {
      documentId: contentVersion.documentId,
      locale: contentVersion.locale,
      name: contentVersion.name,
      type: contentItem.type,
      kind: contentItem.kind,
    })
    .from(contentVersion)
    .innerJoin(contentItem, eq(contentItem.documentId, contentVersion.documentId))
    .where(
      and(
        isNull(contentItem.deletedAt),
        eq(contentItem.siteId, ctx.siteId), // multisite: search is confined to the active site
        ctx.readSiteWide ? undefined : inArray(sql`coalesce(${contentItem.sectionId}, ${contentItem.documentId})`, ctx.sections),
        or(eq(contentVersion.status, "draft"), eq(contentVersion.isCurrentPublished, true)),
        or(ilike(contentVersion.name, pattern), ilike(contentVersion.slug, pattern)),
      ),
    )
    .orderBy(contentVersion.documentId, desc(contentVersion.isCurrentPublished), desc(contentVersion.versionNumber))
    .limit(limit);

  const hits: SearchHit[] = rows.map((r) => ({
    documentId: r.documentId,
    type: r.type,
    kind: r.kind as SearchHit["kind"],
    name: r.name,
    locale: r.locale,
    urlPath: null,
  }));
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
  await loadAuthorized(db, ctx, documentId, "read");
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
  await loadAuthorized(db, ctx, documentId, "read");
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
  const reg = await loadTypeRegistry(db);
  const type = requireType(reg, item.type);

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
  const data = coerceData(type, src.data as Record<string, unknown>, loc, reg.blockTypes, await localeCodes(db));

  await withSiblingSlugLock(db, item, loc, async (tx) => {
    // Slug must stay unique among page siblings (the source slug may now collide).
    if (item.kind === "page" && src.slug) {
      await assertSlugUnique(tx, documentId, item.parentId, loc, src.slug);
    }
    const existingDraft = await tx
      .select()
      .from(contentVersion)
      .where(and(eq(contentVersion.documentId, documentId), eq(contentVersion.locale, loc), eq(contentVersion.status, "draft")))
      .limit(1);
    if (existingDraft[0]) {
      await tx
        .update(contentVersion)
        // revision: this is an in-place draft write like any other. Without the bump
        // an editor holding the pre-restore token saved straight over the restore —
        // 200, no conflict, and no history trace of what was lost.
        .set({ name: src.name, slug: src.slug, displayInNav: src.displayInNav, data, revision: sql`${contentVersion.revision} + 1`, createdBy: ctx.userId, createdAt: new Date(), comment: `Restored from v${src.versionNumber}` })
        .where(eq(contentVersion.id, existingDraft[0].id));
    } else {
      await tx.insert(contentVersion).values({
        documentId,
        locale: loc,
        status: "draft",
        isCurrentPublished: false,
        versionNumber: await nextVersionNumber(tx, documentId, loc),
        name: src.name,
        slug: src.slug,
        displayInNav: src.displayInNav,
        data,
        createdBy: ctx.userId,
        comment: `Restored from v${src.versionNumber}`,
      });
    }
    await rebuildReferences(tx, documentId, loc, type, data, reg.blockTypes);
  });
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
  const reg = await loadTypeRegistry(db);
  const type = requireType(reg, src.type);
  await assertGlobalSingleton(db, type, src.siteId);

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

  const locales = await localeCodes(db);
  await db.transaction(async (tx) => {
    await tx.insert(contentItem).values({
      documentId: newId,
      type: src.type,
      kind: src.kind,
      parentId: src.parentId,
      sortIndex: (src.sortIndex ?? 0) + 1,
      sectionId: newSection,
      // Inherit the SOURCE's site and folder. Omitting siteId let the column
      // DEFAULT ('site_default') apply, so duplicating inside any other site wrote
      // the copy into the Default site — and the getContent below then 404'd on the
      // active-site check, leaving an orphan copy in another tenant's tree.
      siteId: src.siteId,
      folderId: src.folderId,
      createdBy: ctx.userId,
    });
    for (const [code, row] of byLocale) {
      // Coerce on clone for the same reason as restoreVersion: the source data
      // may predate the richtext sanitizer.
      const data = coerceData(type, row.data as Record<string, unknown>, code, reg.blockTypes, locales);
      await tx.insert(contentVersion).values({
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
      await rebuildReferences(tx, newId, code, type, data, reg.blockTypes);
    }
    // If the source had no version at all, seed an empty draft so the doc is editable.
    if (byLocale.size === 0) {
      await tx.insert(contentVersion).values({
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
  });
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

  const now = new Date();
  return db.transaction(async (tx) => {
    // Collect the subtree (guarded downward BFS) in the same transaction that trashes it.
    const ids = [documentId];
    const visited = new Set<string>([documentId]);
    let frontier = [documentId];
    while (frontier.length) {
      const kids = await tx
        .select({ documentId: contentItem.documentId })
        .from(contentItem)
        .where(and(inArray(contentItem.parentId, frontier), isNull(contentItem.deletedAt)));
      const next = kids.map((k) => k.documentId).filter((id) => !visited.has(id));
      next.forEach((id) => { visited.add(id); ids.push(id); });
      frontier = next;
    }
    await tx.update(contentItem).set({ deletedAt: now }).where(inArray(contentItem.documentId, ids));
    // Bump cv on the way out, same reason as unpublishContent: delivery's ETag is
    // derived from the cv of the rows it returned, so trashing without bumping left
    // the ETag byte-identical and a CDN kept serving the trashed pages.
    const cvRow = await tx.execute(sql`SELECT nextval('cv_seq') AS v`);
    const cv = Number((cvRow as unknown as Array<{ v: string }>)[0]?.v ?? 0);
    await tx
      .update(contentVersion)
      .set({ isCurrentPublished: false, cv })
      .where(and(inArray(contentVersion.documentId, ids), eq(contentVersion.isCurrentPublished, true)));
    return { trashed: ids.length };
  });
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
  await assertGlobalSingleton(db, await getContentType(db, item.type), item.siteId, item.documentId);

  // Restore the item + ONLY the descendants trashed in the SAME sweep. softDelete
  // stamps one shared `deletedAt` across a sweep and skips already-trashed nodes,
  // so a descendant with a different timestamp was trashed separately (earlier) and
  // must stay trashed (S2-M8) — restoring it would resurrect content the user never
  // asked back. Scope both the walk and the update to the parent's sweep timestamp.
  const ts = item.deletedAt;
  return db.transaction(async (tx) => {
    const ids = [documentId];
    const visited = new Set<string>([documentId]);
    let frontier = [documentId];
    while (frontier.length) {
      const kids = await tx
        .select({ documentId: contentItem.documentId })
        .from(contentItem)
        .where(and(inArray(contentItem.parentId, frontier), eq(contentItem.deletedAt, ts)));
      const next = kids.map((k) => k.documentId).filter((id) => !visited.has(id));
      next.forEach((id) => { visited.add(id); ids.push(id); });
      frontier = next;
    }
    await tx.update(contentItem).set({ deletedAt: null }).where(and(inArray(contentItem.documentId, ids), eq(contentItem.deletedAt, ts)));
    return { restored: ids.length };
  });
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
  const visible = rows.filter((i) => ctx.readSiteWide || ctx.sections.includes(i.sectionId ?? i.documentId));
  const trashStates = await variantStatesBatch(db, visible.map((i) => i.documentId));
  const out: { documentId: string; type: string; kind: string; name: string; deletedAt: string }[] = [];
  for (const item of visible) {
    const states = trashStates.get(item.documentId) ?? {};
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
