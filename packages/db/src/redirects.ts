import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import {
  LocalePrefix,
  REDIRECT_CSV_COLUMNS,
  REDIRECT_STATUSES,
  type RedirectManifest,
  type RedirectManifestRule,
  type RedirectOrigin,
  type RedirectStatus,
  type SiteUrlScheme,
  formatRedirectSource,
  isNoise404,
  matchRedirect,
  normalizePath,
  parseCsv,
  parseRedirectSource,
  parseRedirectTarget,
  sitePath,
  toCsv,
} from "@paperboy/shared";
import type { Database } from "./client.js";
import { publishedPagePaths } from "./delivery.js";
import { Errors } from "./errors.js";
import { type AccessContext, requirePermission } from "./scope.js";
import { contentItem, contentVersion, locale, notFoundPath, redirect, site } from "./schema.js";
import { announceDeliveryChange } from "./webhooks.js";

/**
 * Redirects — per site, stored here, applied by the frontend.
 *
 * Rules (each one answers a failure the research turned up; docs/plans/2026-10-15-redirects.md):
 *  - **A rule fires only where no published page answers.** The frontend asks
 *    delivery for the page first and consults the manifest on a 404, so a stale
 *    rule can never hijack a live page. A rule whose source IS a live page is
 *    flagged "shadowed" instead of silently doing nothing.
 *  - **A target may be a PAGE, not a path.** It is resolved to the page's live
 *    URL when the manifest is built, so moving the page again never leaves a
 *    chain. A path typed into the target that names a live page is stored as
 *    that page for the same reason.
 *  - **One hop.** A path target that is itself redirected is collapsed to the
 *    final destination at write; a rule that would come back to its own source
 *    is refused. Rules already pointing at a new rule's source are re-pointed.
 *  - **Publishing or moving a page that changes its public URL creates a 301**
 *    from the old URL to the page, for its whole subtree (trackUrlChanges).
 *  - **No regex.** Exact paths and trailing "/*" prefixes cover real
 *    migrations; regex is where redirect managers get slow and over-match.
 */

const MAX_HOPS = 10;
/** Most 404 paths kept per site — the least recently seen go first. */
export const NOT_FOUND_CAP = 2000;
/** 404 paths not seen for this long are swept. */
export const NOT_FOUND_RETENTION_DAYS = 90;
export const MAX_IMPORT_ROWS = 5000;

type RedirectRow = typeof redirect.$inferSelect;

/* ------------------------------ the site's URL map ------------------------------ */

interface SiteUrls {
  scheme: SiteUrlScheme;
  locales: string[];
  /** `${documentId}|${locale}` → the path a visitor requests. */
  byDoc: Map<string, string>;
  /** normalized path → the page answering it. */
  byPath: Map<string, { documentId: string; locale: string }>;
}

async function siteScheme(db: Database, siteId: string): Promise<{ scheme: SiteUrlScheme; startPageId: string | null }> {
  const rows = await db
    .select({ defaultLocale: site.defaultLocale, localePrefix: site.localePrefix, startPageId: site.startPageId })
    .from(site)
    .where(eq(site.id, siteId))
    .limit(1);
  if (!rows[0]) throw Errors.notFound("Site");
  const prefix = LocalePrefix.safeParse(rows[0].localePrefix);
  return { scheme: { defaultLocale: rows[0].defaultLocale, localePrefix: prefix.success ? prefix.data : "always" }, startPageId: rows[0].startPageId };
}

/** The live URL of every published page in the site (or of the given pages). */
async function siteUrls(db: Database, siteId: string, documentIds?: string[]): Promise<SiteUrls> {
  const { scheme, startPageId } = await siteScheme(db, siteId);
  const locales = (await db.select({ code: locale.code }).from(locale).where(eq(locale.enabled, true))).map((l) => l.code);
  const byDoc = new Map<string, string>();
  const byPath = new Map<string, { documentId: string; locale: string }>();
  for (const p of await publishedPagePaths(db, siteId, documentIds)) {
    const own = sitePath(p.urlPath, p.locale, scheme);
    // The start page is served at the site root, and its own path still answers too.
    const served = p.documentId === startPageId ? sitePath("/", p.locale, scheme) : own;
    byDoc.set(`${p.documentId}|${p.locale}`, served);
    byPath.set(normalizePath(own), { documentId: p.documentId, locale: p.locale });
    byPath.set(normalizePath(served), { documentId: p.documentId, locale: p.locale });
  }
  return { scheme, locales, byDoc, byPath };
}

/* ------------------------------ manifest ------------------------------ */

function manifestRule(r: RedirectRow, urls: SiteUrls): RedirectManifestRule | null {
  let to: string | null = null;
  if (r.targetDocumentId) {
    to = urls.byDoc.get(`${r.targetDocumentId}|${r.targetLocale ?? urls.scheme.defaultLocale}`) ?? null;
    if (to === null) return null; // target not published: the rule is reported, not served
  } else if (r.targetPath) to = r.targetPath;
  else if (r.statusCode !== 410) return null;
  return { id: r.id, from: r.sourcePath, match: r.matchType === "prefix" ? "prefix" : "exact", to, status: r.statusCode as RedirectStatus, keepQuery: r.keepQuery };
}

/**
 * The site's rules as a frontend applies them (GET /delivery/redirects): page
 * targets resolved to their live URL, rules with an unpublished target left out.
 */
export async function buildRedirectManifest(db: Database, siteId: string): Promise<RedirectManifest> {
  const rows = await db.select().from(redirect).where(eq(redirect.siteId, siteId)).orderBy(asc(redirect.id));
  if (rows.length === 0) return { version: 1, rules: [] };
  const urls = await siteUrls(db, siteId);
  return { version: 1, rules: rows.map((r) => manifestRule(r, urls)).filter((r): r is RedirectManifestRule => r !== null) };
}

/* ------------------------------ reading ------------------------------ */

export type RedirectTargetView =
  | { kind: "page"; documentId: string; locale: string; name: string | null; url: string | null }
  | { kind: "path"; path: string }
  | { kind: "url"; url: string }
  | { kind: "gone" };

export interface RedirectProblem {
  code: "target-missing" | "target-unpublished" | "shadowed" | "chain" | "loop";
  message: string;
}

export interface RedirectView {
  id: number;
  source: string;
  sourcePath: string;
  match: "exact" | "prefix";
  target: RedirectTargetView;
  status: RedirectStatus;
  keepQuery: boolean;
  origin: RedirectOrigin;
  note: string | null;
  hits: number;
  lastHitAt: string | null;
  createdAt: string;
  updatedAt: string;
  problems: RedirectProblem[];
}

async function pageNames(db: Database, documentIds: string[]): Promise<Map<string, { name: string; trashed: boolean; siteId: string }>> {
  const out = new Map<string, { name: string; trashed: boolean; siteId: string }>();
  if (documentIds.length === 0) return out;
  const items = await db
    .select({ documentId: contentItem.documentId, deletedAt: contentItem.deletedAt, siteId: contentItem.siteId, kind: contentItem.kind })
    .from(contentItem)
    .where(inArray(contentItem.documentId, documentIds));
  const names = await db
    .selectDistinctOn([contentVersion.documentId], { documentId: contentVersion.documentId, name: contentVersion.name })
    .from(contentVersion)
    .where(inArray(contentVersion.documentId, documentIds))
    .orderBy(contentVersion.documentId, desc(contentVersion.isCurrentPublished), desc(contentVersion.id));
  const nameOf = new Map(names.map((n) => [n.documentId, n.name]));
  for (const it of items) {
    if (it.kind !== "page") continue;
    out.set(it.documentId, { name: nameOf.get(it.documentId) ?? it.documentId, trashed: it.deletedAt !== null, siteId: it.siteId });
  }
  return out;
}

function viewOf(
  r: RedirectRow,
  urls: SiteUrls,
  names: Map<string, { name: string; trashed: boolean; siteId: string }>,
  manifest: RedirectManifest,
): RedirectView {
  const problems: RedirectProblem[] = [];
  let target: RedirectTargetView;
  if (r.targetDocumentId) {
    const loc = r.targetLocale ?? urls.scheme.defaultLocale;
    const page = names.get(r.targetDocumentId);
    const url = urls.byDoc.get(`${r.targetDocumentId}|${loc}`) ?? null;
    target = { kind: "page", documentId: r.targetDocumentId, locale: loc, name: page?.name ?? null, url };
    if (!page || page.trashed || page.siteId !== r.siteId) {
      problems.push({ code: "target-missing", message: "The target page is deleted or in the trash. The rule is not served — pick a new target." });
    } else if (!url) {
      problems.push({ code: "target-unpublished", message: `The target page has no published "${loc}" version, so the rule is not served until it is published.` });
    }
  } else if (r.targetPath) {
    target = /^https?:\/\//i.test(r.targetPath) ? { kind: "url", url: r.targetPath } : { kind: "path", path: r.targetPath };
  } else target = { kind: "gone" };

  if (r.matchType === "exact" && urls.byPath.has(r.sourcePath)) {
    problems.push({ code: "shadowed", message: `A published page answers ${r.sourcePath}, so this rule never fires. Delete the rule, or unpublish that page.` });
  }
  if (target.kind === "path") {
    const next = matchRedirect({ version: 1, rules: manifest.rules.filter((m) => m.id !== r.id) }, target.path);
    if (normalizePath(target.path) === r.sourcePath) problems.push({ code: "loop", message: "The target is the source itself." });
    else if (next && !urls.byPath.has(normalizePath(target.path))) {
      problems.push({ code: "chain", message: `The target ${target.path} is itself redirected (to ${next.location ?? "410 Gone"}). Point straight at the final URL.` });
    }
  }
  return {
    id: r.id,
    source: formatRedirectSource(r.sourcePath, r.matchType === "prefix" ? "prefix" : "exact"),
    sourcePath: r.sourcePath,
    match: r.matchType === "prefix" ? "prefix" : "exact",
    target,
    status: r.statusCode as RedirectStatus,
    keepQuery: r.keepQuery,
    origin: (r.origin as RedirectOrigin) ?? "manual",
    note: r.note,
    hits: r.hits,
    lastHitAt: r.lastHitAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    problems,
  };
}

/** Every rule in the active site, each with its target's live URL and any problems. */
export async function listRedirects(db: Database, ctx: AccessContext, opts: { targetDocumentId?: string } = {}): Promise<RedirectView[]> {
  requirePermission(ctx, "content.read");
  const conditions = [eq(redirect.siteId, ctx.siteId)];
  if (opts.targetDocumentId) conditions.push(eq(redirect.targetDocumentId, opts.targetDocumentId));
  const rows = await db.select().from(redirect).where(and(...conditions)).orderBy(desc(redirect.updatedAt), desc(redirect.id));
  if (rows.length === 0) return [];
  const urls = await siteUrls(db, ctx.siteId);
  const all = opts.targetDocumentId ? await db.select().from(redirect).where(eq(redirect.siteId, ctx.siteId)) : rows;
  const manifest: RedirectManifest = { version: 1, rules: all.map((r) => manifestRule(r, urls)).filter((r): r is RedirectManifestRule => r !== null) };
  const names = await pageNames(db, [...new Set(rows.map((r) => r.targetDocumentId).filter((d): d is string => !!d))]);
  return rows.map((r) => viewOf(r, urls, names, manifest));
}

/* ------------------------------ writing ------------------------------ */

export interface RedirectInput {
  /** "/old-page", "/blog/*" or a full URL on the old site. */
  source: string;
  /** A path or absolute URL. A path that names a published page is stored as that page. */
  target?: string | null;
  /** Target a page directly (follows it if it moves). */
  targetDocumentId?: string | null;
  /** The page's locale to send visitors to (default: the site's default locale). */
  targetLocale?: string | null;
  status?: RedirectStatus;
  keepQuery?: boolean;
  note?: string | null;
}

type ResolvedTarget = { targetDocumentId: string | null; targetLocale: string | null; targetPath: string | null };

/**
 * Validate a rule and resolve its target to what gets stored: a page, a path
 * or a URL, collapsed past any rule it would chain through. Throws a
 * self-teaching 422 for anything it cannot store faithfully.
 */
async function resolveRule(
  db: Database,
  siteId: string,
  input: RedirectInput,
  urls: SiteUrls,
  others: RedirectRow[],
): Promise<{ sourcePath: string; matchType: "exact" | "prefix"; statusCode: RedirectStatus; keepQuery: boolean; note: string | null; collapsed: boolean } & ResolvedTarget> {
  const source = parseRedirectSource(input.source);
  if ("error" in source) throw Errors.validation(source.error, ["source"]);
  const statusCode = input.status ?? 301;
  if (!(REDIRECT_STATUSES as readonly number[]).includes(statusCode)) {
    throw Errors.validation(`Status must be one of ${REDIRECT_STATUSES.join(", ")} — 301 for a permanent move (the one that passes link equity), 410 for gone for good.`, ["status"]);
  }
  const note = input.note?.trim() ? input.note.trim().slice(0, 500) : null;
  const base = { sourcePath: source.path, matchType: source.match, statusCode, keepQuery: input.keepQuery ?? true, note, collapsed: false };

  if (statusCode === 410) {
    if (input.target?.trim() || input.targetDocumentId) throw Errors.validation("A 410 Gone rule has no target — clear the target, or pick 301 to send visitors somewhere.", ["target"]);
    return { ...base, targetDocumentId: null, targetLocale: null, targetPath: null };
  }

  let target: ResolvedTarget;
  if (input.targetDocumentId) {
    const page = (await pageNames(db, [input.targetDocumentId])).get(input.targetDocumentId);
    if (!page || page.trashed || page.siteId !== siteId) {
      throw Errors.validation(`Target page "${input.targetDocumentId}" is not a page in this site (it may be in the trash).`, ["targetDocumentId"]);
    }
    const loc = input.targetLocale?.trim() || urls.scheme.defaultLocale;
    if (!urls.locales.includes(loc)) throw Errors.validation(`Unknown or disabled locale "${loc}". Enabled: ${urls.locales.join(", ")}.`, ["targetLocale"]);
    target = { targetDocumentId: input.targetDocumentId, targetLocale: loc, targetPath: null };
  } else {
    const parsed = parseRedirectTarget(input.target ?? "");
    if ("error" in parsed) throw Errors.validation(parsed.error, ["target"]);
    if ("url" in parsed) target = { targetDocumentId: null, targetLocale: null, targetPath: parsed.url };
    else {
      const page = urls.byPath.get(normalizePath(parsed.path));
      target = page && !parsed.path.includes("?")
        ? { targetDocumentId: page.documentId, targetLocale: page.locale, targetPath: null }
        : { targetDocumentId: null, targetLocale: null, targetPath: parsed.path };
    }
  }

  // Collapse a path target past rules it would chain through, and refuse loops.
  let collapsed = false;
  const manifest: RedirectManifest = { version: 1, rules: others.map((r) => manifestRule(r, urls)).filter((r): r is RedirectManifestRule => r !== null) };
  const seen = new Set<string>([source.path]);
  for (let hop = 0; hop < MAX_HOPS && target.targetPath && !/^https?:\/\//i.test(target.targetPath); hop++) {
    const path = normalizePath(target.targetPath);
    if (seen.has(path)) {
      throw Errors.validation(
        hop === 0
          ? `The target ${target.targetPath} is the source itself — a rule can't redirect to itself.`
          : `This rule would loop: following ${target.targetPath} leads back to ${input.source}. Point it at a page or a URL that is not redirected.`,
        ["target"],
      );
    }
    seen.add(path);
    if (urls.byPath.has(path)) break; // a live page answers: final
    const next = matchRedirect(manifest, target.targetPath);
    if (!next) break;
    const via = others.find((o) => o.id === next.rule.id)!;
    if (next.status === 410 || next.location === null) {
      throw Errors.validation(`The target ${target.targetPath} is marked 410 Gone by another rule. Pick a live target, or make this rule a 410 too.`, ["target"]);
    }
    collapsed = true;
    target =
      via.targetDocumentId && next.rule.match === "exact"
        ? { targetDocumentId: via.targetDocumentId, targetLocale: via.targetLocale, targetPath: null }
        : { targetDocumentId: null, targetLocale: null, targetPath: next.location };
    if (target.targetDocumentId) {
      const served = urls.byDoc.get(`${target.targetDocumentId}|${target.targetLocale ?? urls.scheme.defaultLocale}`);
      if (served && normalizePath(served) === source.path) throw Errors.validation(`This rule would loop: ${target.targetPath ?? served} leads back to ${input.source}.`, ["target"]);
    }
  }
  if (target.targetDocumentId) {
    const served = urls.byDoc.get(`${target.targetDocumentId}|${target.targetLocale ?? urls.scheme.defaultLocale}`);
    if (served && normalizePath(served) === source.path && source.match === "exact") {
      throw Errors.validation(`The target page is published at ${served}, which is the source itself — a rule can't redirect to itself.`, ["target"]);
    }
  }
  return { ...base, ...target, collapsed };
}

/** Rules pointing at `sourcePath` by path now point where it points, so a new rule never adds a hop. */
async function repointChainsInto(db: Database, siteId: string, saved: RedirectRow): Promise<number> {
  if (saved.matchType !== "exact") return 0;
  const rows = await db.select().from(redirect).where(and(eq(redirect.siteId, siteId)));
  let n = 0;
  for (const r of rows) {
    if (r.id === saved.id || !r.targetPath || /^https?:\/\//i.test(r.targetPath)) continue;
    if (normalizePath(r.targetPath) !== saved.sourcePath) continue;
    if (saved.statusCode === 410) continue; // leave it: the editor sees the chain warning and decides
    await db
      .update(redirect)
      .set({ targetDocumentId: saved.targetDocumentId, targetLocale: saved.targetLocale, targetPath: saved.targetPath, updatedAt: new Date() })
      .where(eq(redirect.id, r.id));
    n++;
  }
  return n;
}

async function siteRules(db: Database, siteId: string): Promise<RedirectRow[]> {
  return db.select().from(redirect).where(eq(redirect.siteId, siteId));
}

export async function createRedirect(
  db: Database,
  ctx: AccessContext,
  input: RedirectInput,
  origin: RedirectOrigin = "manual",
): Promise<{ redirect: RedirectView; collapsed: boolean; repointed: number }> {
  requirePermission(ctx, "content.publish");
  const urls = await siteUrls(db, ctx.siteId);
  const others = await siteRules(db, ctx.siteId);
  const r = await resolveRule(db, ctx.siteId, input, urls, others);
  const clash = others.find((o) => o.sourcePath === r.sourcePath);
  if (clash) throw Errors.conflict(`A rule for ${formatRedirectSource(clash.sourcePath, clash.matchType as "exact" | "prefix")} already exists (id ${clash.id}) — edit that rule instead.`);
  const { collapsed, ...values } = r;
  const [row] = await db.insert(redirect).values({ ...values, siteId: ctx.siteId, origin, createdBy: ctx.userId }).returning();
  const repointed = await repointChainsInto(db, ctx.siteId, row!);
  const [view] = await viewsFor(db, ctx.siteId, [row!.id]);
  announceDeliveryChange(db, ctx.siteId, "redirects");
  return { redirect: view!, collapsed, repointed };
}

export async function updateRedirect(
  db: Database,
  ctx: AccessContext,
  id: number,
  patch: Partial<RedirectInput>,
): Promise<{ redirect: RedirectView; collapsed: boolean; repointed: number }> {
  requirePermission(ctx, "content.publish");
  const existing = (await db.select().from(redirect).where(and(eq(redirect.id, id), eq(redirect.siteId, ctx.siteId))).limit(1))[0];
  if (!existing) throw Errors.notFound("Redirect");
  const urls = await siteUrls(db, ctx.siteId);
  const currentTarget =
    patch.target !== undefined || patch.targetDocumentId !== undefined
      ? { target: patch.target ?? null, targetDocumentId: patch.targetDocumentId ?? null, targetLocale: patch.targetLocale ?? null }
      : { target: existing.targetPath, targetDocumentId: existing.targetDocumentId, targetLocale: patch.targetLocale ?? existing.targetLocale };
  const merged: RedirectInput = {
    source: patch.source ?? formatRedirectSource(existing.sourcePath, existing.matchType as "exact" | "prefix"),
    ...currentTarget,
    status: patch.status ?? (existing.statusCode as RedirectStatus),
    keepQuery: patch.keepQuery ?? existing.keepQuery,
    note: patch.note !== undefined ? patch.note : existing.note,
  };
  const others = (await siteRules(db, ctx.siteId)).filter((o) => o.id !== id);
  const r = await resolveRule(db, ctx.siteId, merged, urls, others);
  const clash = others.find((o) => o.sourcePath === r.sourcePath);
  if (clash) throw Errors.conflict(`A rule for ${clash.sourcePath} already exists (id ${clash.id}).`);
  const { collapsed, ...values } = r;
  const [row] = await db.update(redirect).set({ ...values, origin: existing.origin === "auto" ? "manual" : existing.origin, updatedAt: new Date() }).where(eq(redirect.id, id)).returning();
  const repointed = await repointChainsInto(db, ctx.siteId, row!);
  const [view] = await viewsFor(db, ctx.siteId, [id]);
  announceDeliveryChange(db, ctx.siteId, "redirects");
  return { redirect: view!, collapsed, repointed };
}

export async function deleteRedirects(db: Database, ctx: AccessContext, ids: number[]): Promise<number> {
  requirePermission(ctx, "content.publish");
  if (ids.length === 0) return 0;
  const gone = await db.delete(redirect).where(and(eq(redirect.siteId, ctx.siteId), inArray(redirect.id, ids))).returning({ id: redirect.id });
  if (gone.length) announceDeliveryChange(db, ctx.siteId, "redirects");
  return gone.length;
}

async function viewsFor(db: Database, siteId: string, ids: number[]): Promise<RedirectView[]> {
  const all = await siteRules(db, siteId);
  const urls = await siteUrls(db, siteId);
  const manifest: RedirectManifest = { version: 1, rules: all.map((r) => manifestRule(r, urls)).filter((r): r is RedirectManifestRule => r !== null) };
  const rows = all.filter((r) => ids.includes(r.id));
  const names = await pageNames(db, rows.map((r) => r.targetDocumentId).filter((d): d is string => !!d));
  return rows.map((r) => viewOf(r, urls, names, manifest));
}

/* ------------------------------ testing a URL ------------------------------ */

export interface RedirectTestStep {
  path: string;
  /** What answered this path. */
  result: "page" | "redirect" | "gone" | "external" | "not-found" | "loop";
  ruleId?: number;
  status?: RedirectStatus;
  location?: string | null;
  page?: { documentId: string; locale: string };
}

/**
 * Follow a URL the way a visitor would: a published page answers first, then
 * the rules, hop by hop, until a page, an external URL, a 410, a 404 or a loop.
 * The admin's "Test a URL" box and MCP `test_redirect` both run this.
 */
export async function testRedirect(db: Database, ctx: AccessContext, url: string): Promise<{ steps: RedirectTestStep[]; hops: number }> {
  requirePermission(ctx, "content.read");
  let current = url.trim();
  if (/^https?:\/\//i.test(current)) {
    const u = new URL(current);
    current = u.pathname + u.search;
  }
  if (!current.startsWith("/")) current = `/${current}`;
  const urls = await siteUrls(db, ctx.siteId);
  const manifest = await buildRedirectManifest(db, ctx.siteId);
  const steps: RedirectTestStep[] = [];
  const seen = new Set<string>();
  for (let i = 0; i <= MAX_HOPS; i++) {
    const path = normalizePath(current);
    if (seen.has(path)) {
      steps.push({ path: current, result: "loop" });
      break;
    }
    seen.add(path);
    const page = urls.byPath.get(path);
    if (page) {
      steps.push({ path: current, result: "page", page });
      break;
    }
    const hit = matchRedirect(manifest, current);
    if (!hit) {
      steps.push({ path: current, result: "not-found" });
      break;
    }
    if (hit.location === null) {
      steps.push({ path: current, result: "gone", ruleId: hit.rule.id, status: hit.status, location: null });
      break;
    }
    if (/^https?:\/\//i.test(hit.location)) {
      steps.push({ path: current, result: "external", ruleId: hit.rule.id, status: hit.status, location: hit.location });
      break;
    }
    steps.push({ path: current, result: "redirect", ruleId: hit.rule.id, status: hit.status, location: hit.location });
    current = hit.location;
  }
  return { steps, hops: steps.filter((s) => s.result === "redirect" || s.result === "external").length };
}

/* ------------------------------ automatic redirects ------------------------------ */

async function subtreeOf(db: Database, documentId: string): Promise<string[]> {
  const rows = await db.execute<{ document_id: string }>(sql`
    WITH RECURSIVE t AS (
      SELECT document_id FROM content_item WHERE document_id = ${documentId}
      UNION
      SELECT c.document_id FROM content_item c JOIN t ON c.parent_id = t.document_id WHERE c.deleted_at IS NULL
    ) SELECT document_id FROM t`);
  return [...rows].map((r) => r.document_id);
}

/**
 * Run a change that may move published URLs (publish, move, scheduled
 * publish) and give every page in the subtree whose public URL changed a 301
 * from its old URL. Bookkeeping must never fail the change itself, so its
 * errors are logged, not thrown.
 */
export async function trackUrlChanges<T>(db: Database, siteId: string, documentId: string, change: () => Promise<T>): Promise<T> {
  let before: SiteUrls | null = null;
  let docs: string[] = [];
  try {
    docs = await subtreeOf(db, documentId);
    before = await siteUrls(db, siteId, docs);
  } catch (err) {
    console.error(`[paperboy] redirect tracking (before) failed for ${documentId}:`, err);
  }
  const result = await change();
  if (!before) return result;
  try {
    const after = await siteUrls(db, siteId, docs);
    for (const [key, oldPath] of before.byDoc) {
      const newPath = after.byDoc.get(key);
      if (!newPath || normalizePath(newPath) === normalizePath(oldPath)) continue;
      const [doc, loc] = key.split("|") as [string, string];
      await recordMovedUrl(db, siteId, normalizePath(oldPath), normalizePath(newPath), doc, loc);
    }
  } catch (err) {
    console.error(`[paperboy] redirect tracking (after) failed for ${documentId}:`, err);
  }
  return result;
}

async function recordMovedUrl(db: Database, siteId: string, oldPath: string, newPath: string, documentId: string, loc: string): Promise<void> {
  // Renamed back: the auto rule from the URL it now has again is dead weight.
  await db
    .delete(redirect)
    .where(and(eq(redirect.siteId, siteId), eq(redirect.sourcePath, newPath), eq(redirect.origin, "auto"), eq(redirect.targetDocumentId, documentId)));
  const existing = (await db.select().from(redirect).where(and(eq(redirect.siteId, siteId), eq(redirect.sourcePath, oldPath))).limit(1))[0];
  if (existing) {
    // An editor's own rule for that path stays theirs; an automatic one follows the page.
    if (existing.origin === "auto") {
      await db.update(redirect).set({ targetDocumentId: documentId, targetLocale: loc, targetPath: null, statusCode: 301, updatedAt: new Date() }).where(eq(redirect.id, existing.id));
    }
    return;
  }
  await db.insert(redirect).values({ siteId, sourcePath: oldPath, matchType: "exact", targetDocumentId: documentId, targetLocale: loc, statusCode: 301, keepQuery: true, origin: "auto" });
  // Rules that pointed at the old URL by path now point at the page.
  await db
    .update(redirect)
    .set({ targetDocumentId: documentId, targetLocale: loc, targetPath: null, updatedAt: new Date() })
    .where(and(eq(redirect.siteId, siteId), sql`lower(rtrim(${redirect.targetPath}, '/')) = ${oldPath}`));
}

/* ------------------------------ traffic (hits + 404s) ------------------------------ */

/**
 * Record what the frontend saw: rules it applied, and paths that answered 404.
 * Called by the public traffic endpoint with a delivery key, which pins the
 * site. Paths only — no query string, no IP, no user agent.
 */
export async function recordTraffic(db: Database, siteId: string, input: { redirectHits?: number[]; notFound?: string[] }): Promise<{ hits: number; notFound: number }> {
  let hits = 0;
  const counts = new Map<number, number>();
  for (const id of input.redirectHits ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const [id, n] of counts) {
    const updated = await db
      .update(redirect)
      .set({ hits: sql`${redirect.hits} + ${n}`, lastHitAt: new Date() })
      .where(and(eq(redirect.id, id), eq(redirect.siteId, siteId)))
      .returning({ id: redirect.id });
    hits += updated.length ? n : 0;
  }
  const paths = new Map<string, number>();
  for (const raw of input.notFound ?? []) {
    const path = normalizePath(raw);
    if (isNoise404(path)) continue;
    paths.set(path, (paths.get(path) ?? 0) + 1);
  }
  for (const [path, n] of paths) {
    await db
      .insert(notFoundPath)
      .values({ siteId, path, hits: n })
      .onConflictDoUpdate({ target: [notFoundPath.siteId, notFoundPath.path], set: { hits: sql`${notFoundPath.hits} + ${n}`, lastSeen: new Date() } });
  }
  return { hits, notFound: [...paths.values()].reduce((a, b) => a + b, 0) };
}

export interface NotFoundView {
  path: string;
  hits: number;
  firstSeen: string;
  lastSeen: string;
  /** A rule now answers this path (it 404'd before the rule existed). */
  coveredBy: number | null;
}

export async function listNotFound(db: Database, ctx: AccessContext): Promise<NotFoundView[]> {
  requirePermission(ctx, "content.read");
  const rows = await db.select().from(notFoundPath).where(eq(notFoundPath.siteId, ctx.siteId)).orderBy(desc(notFoundPath.hits), desc(notFoundPath.lastSeen)).limit(NOT_FOUND_CAP);
  const manifest = rows.length ? await buildRedirectManifest(db, ctx.siteId) : { version: 1 as const, rules: [] };
  return rows.map((r) => ({
    path: r.path,
    hits: r.hits,
    firstSeen: r.firstSeen.toISOString(),
    lastSeen: r.lastSeen.toISOString(),
    coveredBy: matchRedirect(manifest, r.path)?.rule.id ?? null,
  }));
}

export async function deleteNotFound(db: Database, ctx: AccessContext, paths: string[]): Promise<number> {
  requirePermission(ctx, "content.publish");
  if (paths.length === 0) return 0;
  const gone = await db
    .delete(notFoundPath)
    .where(and(eq(notFoundPath.siteId, ctx.siteId), inArray(notFoundPath.path, paths.map(normalizePath))))
    .returning({ path: notFoundPath.path });
  return gone.length;
}

/**
 * Hourly: drop 404 paths unseen for NOT_FOUND_RETENTION_DAYS, paths the noise
 * filter now rejects (logged before it knew them), and keep each site under NOT_FOUND_CAP.
 */
export async function runRedirectRetention(db: Database, now: Date = new Date()): Promise<{ notFoundSwept: number }> {
  const cutoff = new Date(now.getTime() - NOT_FOUND_RETENTION_DAYS * 24 * 3600 * 1000);
  const old = await db.delete(notFoundPath).where(lt(notFoundPath.lastSeen, cutoff)).returning({ path: notFoundPath.path });
  // The table is capped per site, so reading every path is bounded.
  const noisy = [...new Set((await db.select({ path: notFoundPath.path }).from(notFoundPath)).map((r) => r.path).filter(isNoise404))];
  const noise = noisy.length ? await db.delete(notFoundPath).where(inArray(notFoundPath.path, noisy)).returning({ path: notFoundPath.path }) : [];
  const over = await db.execute<{ site_id: string; path: string }>(sql`
    DELETE FROM not_found_path n USING (
      SELECT site_id, path FROM (
        SELECT site_id, path, row_number() OVER (PARTITION BY site_id ORDER BY last_seen DESC) AS rn FROM not_found_path
      ) ranked WHERE rn > ${NOT_FOUND_CAP}
    ) x WHERE n.site_id = x.site_id AND n.path = x.path RETURNING n.path`);
  return { notFoundSwept: old.length + noise.length + [...over].length };
}

/* ------------------------------ CSV import / export ------------------------------ */

export async function exportRedirectsCsv(db: Database, ctx: AccessContext): Promise<string> {
  const rows = await listRedirects(db, ctx);
  const target = (t: RedirectTargetView) => (t.kind === "page" ? (t.url ?? "") : t.kind === "path" ? t.path : t.kind === "url" ? t.url : "");
  return toCsv([
    [...REDIRECT_CSV_COLUMNS, "origin", "hits", "lastHitAt"],
    ...rows.map((r) => [r.source, target(r.target), r.status, r.keepQuery, r.note, r.origin, r.hits, r.lastHitAt]),
  ]);
}

export interface ImportRowResult {
  line: number;
  source: string;
  target: string;
  action: "create" | "update" | "unchanged" | "error";
  message?: string;
}

const HEADER_ALIASES: Record<(typeof REDIRECT_CSV_COLUMNS)[number], string[]> = {
  source: ["source", "from", "old", "old url", "fra"],
  target: ["target", "to", "new", "new url", "destination", "til"],
  status: ["status", "type", "code", "status code"],
  keepQuery: ["keepquery", "keep query", "query"],
  note: ["note", "comment", "notat"],
};

/**
 * Import rules from CSV (source,target[,status,keepQuery,note]; a header row is
 * optional). With `dryRun`, nothing is written and every row reports what it
 * WOULD do — the admin shows that preview before the editor commits. An
 * existing source is updated, never duplicated; bad rows are reported per line
 * and skipped, never fatal to the rest.
 */
export async function importRedirects(db: Database, ctx: AccessContext, csv: string, opts: { dryRun: boolean }): Promise<{ rows: ImportRowResult[]; created: number; updated: number; errors: number }> {
  requirePermission(ctx, "content.publish");
  const table = parseCsv(csv);
  if (table.length > MAX_IMPORT_ROWS + 1) throw Errors.validation(`At most ${MAX_IMPORT_ROWS} rows per import — split the file.`);
  const head = (table[0] ?? []).map((h) => h.trim().toLowerCase());
  const hasHeader = head.some((h) => HEADER_ALIASES.source.includes(h));
  const col = (name: keyof typeof HEADER_ALIASES, fallback: number) => {
    if (!hasHeader) return fallback;
    const i = head.findIndex((h) => HEADER_ALIASES[name].includes(h));
    return i;
  };
  const idx = { source: col("source", 0), target: col("target", 1), status: col("status", 2), keepQuery: col("keepQuery", 3), note: col("note", 4) };
  const data = hasHeader ? table.slice(1) : table;

  const urls = await siteUrls(db, ctx.siteId);
  const rules = await siteRules(db, ctx.siteId);
  const results: ImportRowResult[] = [];
  const seenInFile = new Set<string>();
  let created = 0;
  let updated = 0;
  let errors = 0;
  for (let i = 0; i < data.length; i++) {
    const cells = data[i]!;
    const cell = (j: number) => (j >= 0 ? (cells[j] ?? "").trim() : "");
    const line = i + (hasHeader ? 2 : 1);
    const source = cell(idx.source);
    const targetRaw = cell(idx.target);
    const statusRaw = cell(idx.status);
    const status = statusRaw ? Number(statusRaw.replace(/[^0-9]/g, "")) : targetRaw ? 301 : 410;
    const keepRaw = cell(idx.keepQuery).toLowerCase();
    const input: RedirectInput = {
      source,
      target: status === 410 ? null : targetRaw,
      status: status as RedirectStatus,
      keepQuery: keepRaw ? !["false", "0", "no", "nei"].includes(keepRaw) : true,
      note: cell(idx.note) || null,
    };
    try {
      const existingIdx = rules.findIndex((r) => { const p = parseRedirectSource(source); return !("error" in p) && r.sourcePath === p.path; });
      const existing = existingIdx >= 0 ? rules[existingIdx]! : null;
      const others = rules.filter((r) => r !== existing);
      const r = await resolveRule(db, ctx.siteId, input, urls, others);
      if (seenInFile.has(r.sourcePath)) throw Errors.validation(`${source} appears twice in this file — keep one row.`);
      seenInFile.add(r.sourcePath);
      const { collapsed: _collapsed, ...values } = r;
      const same =
        existing &&
        existing.matchType === values.matchType &&
        existing.targetDocumentId === values.targetDocumentId &&
        existing.targetPath === values.targetPath &&
        existing.statusCode === values.statusCode &&
        existing.keepQuery === values.keepQuery;
      const action: ImportRowResult["action"] = existing ? (same ? "unchanged" : "update") : "create";
      results.push({ line, source, target: targetRaw, action });
      if (opts.dryRun || action === "unchanged") {
        // Later rows in the same file see this one, as they would after a real import.
        if (!existing) rules.push({ ...values, id: -line, siteId: ctx.siteId, origin: "import", hits: 0, lastHitAt: null, createdBy: null, createdAt: new Date(), updatedAt: new Date() } as RedirectRow);
        continue;
      }
      if (existing) {
        const [row] = await db.update(redirect).set({ ...values, updatedAt: new Date() }).where(eq(redirect.id, existing.id)).returning();
        rules[existingIdx] = row!;
        await repointChainsInto(db, ctx.siteId, row!);
        updated++;
      } else {
        const [row] = await db.insert(redirect).values({ ...values, siteId: ctx.siteId, origin: "import", createdBy: ctx.userId }).returning();
        rules.push(row!);
        await repointChainsInto(db, ctx.siteId, row!);
        created++;
      }
    } catch (err) {
      errors++;
      results.push({ line, source, target: targetRaw, action: "error", message: (err as Error).message });
    }
  }
  if (opts.dryRun) {
    created = results.filter((r) => r.action === "create").length;
    updated = results.filter((r) => r.action === "update").length;
  }
  if (!opts.dryRun && created + updated > 0) announceDeliveryChange(db, ctx.siteId, "redirects");
  return { rows: results, created, updated, errors };
}
