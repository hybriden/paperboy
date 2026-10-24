import { and, asc, desc, eq, inArray, lt, lte, sql } from "drizzle-orm";
import {
  EXPERIMENT_ARMS,
  EXPERIMENT_GOAL,
  EXPERIMENT_MODES,
  type ArmResult,
  type ExperimentMode,
  type ExperimentStatus,
  type ExperimentVerdict,
  experimentVerdict,
  parseStoredContentTypeDef,
} from "@paperboy/shared";
import type { Database } from "./client.js";
import { prepareAreaBlocks, publishContent, updateContent } from "./content.js";
import { Errors, PG_UNIQUE_VIOLATION, pgErrorCode } from "./errors.js";
import { type AccessContext, loadAuthorized, requirePermission } from "./scope.js";
import { contentItem, contentType, contentVersion, experiment, experimentArm, experimentStat, site } from "./schema.js";
import { getAgentReviewRequired } from "./site.js";
import { announceDeliveryChange } from "./webhooks.js";

/**
 * A/B experiments (#125; decisions in docs/plans/2026-10-22-ab-testing.md).
 *
 *  - **One content area of one page in one locale.** Version A is the page's
 *    own published area; B–D are alternative block lists stored here, each
 *    validated exactly like the area itself (prepareAreaBlocks).
 *  - **Delivery ships the versions, the frontend picks** (liveExperiments,
 *    folded into the page by delivery.ts). Starting, pausing and ending bump
 *    the experiment's cv so the page's ETag changes, and announce
 *    delivery.changed "experiment".
 *  - **Counts only**: exposures and conversions per version per day. No
 *    visitor id, IP or user agent reaches Paperboy.
 *  - **No winner before the planned sample size** (experimentVerdict).
 *  - **Ending with a winner is a normal edit**: its blocks go into the area as
 *    a draft through updateContent, and optionally get published.
 */

export const MAX_EVENTS = 100;
/** Daily counts older than this are swept; the experiment row keeps its verdict inputs. */
export const STAT_RETENTION_DAYS = 400;

type ExperimentRow = typeof experiment.$inferSelect;
type ArmRow = typeof experimentArm.$inferSelect;

export interface ExperimentArmInput {
  key?: string;
  label?: string | null;
  weight?: number;
  /** Block instances, exactly as the content area would hold them. Ignored for A. */
  blocks?: unknown;
}

export interface ExperimentInput {
  documentId: string;
  locale: string;
  area: string;
  name: string;
  hypothesis?: string | null;
  goal?: string;
  baselineRate?: number | null;
  mde?: number | null;
  endsAt?: string | null;
  /** The alternatives (B–D), optionally with A's weight. A is added at 50 when absent. */
  arms: ExperimentArmInput[];
}

export interface ExperimentView {
  id: number;
  documentId: string;
  locale: string;
  area: string;
  pageName: string | null;
  name: string;
  hypothesis: string | null;
  status: ExperimentStatus;
  goal: string;
  baselineRate: number | null;
  mde: number | null;
  endsAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  endReason: string | null;
  winner: string | null;
  needsReview: boolean;
  createdVia: string | null;
  createdAt: string;
  updatedAt: string;
  arms: { key: string; label: string | null; weight: number; blocks: unknown[] | null }[];
  results: ArmResult[];
  verdict: ExperimentVerdict;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

async function nextCv(db: Database): Promise<number> {
  const rows = (await db.execute(sql`SELECT nextval('cv_seq') AS v`)) as unknown as Array<{ v: string | number }>;
  return Number(rows[0]!.v);
}

async function armsOf(db: Database, ids: number[]): Promise<Map<number, ArmRow[]>> {
  const map = new Map<number, ArmRow[]>(ids.map((id) => [id, []]));
  if (!ids.length) return map;
  const rows = await db.select().from(experimentArm).where(inArray(experimentArm.experimentId, ids)).orderBy(asc(experimentArm.key));
  for (const r of rows) map.get(r.experimentId)?.push(r);
  return map;
}

async function totalsOf(db: Database, ids: number[]): Promise<Map<string, { exposures: number; conversions: number }>> {
  const map = new Map<string, { exposures: number; conversions: number }>();
  if (!ids.length) return map;
  const rows = await db
    .select({ id: experimentStat.experimentId, arm: experimentStat.arm, exposures: sql<number>`sum(${experimentStat.exposures})::int`, conversions: sql<number>`sum(${experimentStat.conversions})::int` })
    .from(experimentStat)
    .where(inArray(experimentStat.experimentId, ids))
    .groupBy(experimentStat.experimentId, experimentStat.arm);
  for (const r of rows) map.set(`${r.id}:${r.arm}`, { exposures: Number(r.exposures), conversions: Number(r.conversions) });
  return map;
}

async function viewsOf(db: Database, rows: ExperimentRow[]): Promise<ExperimentView[]> {
  const ids = rows.map((r) => r.id);
  const [arms, totals] = await Promise.all([armsOf(db, ids), totalsOf(db, ids)]);
  const docIds = [...new Set(rows.map((r) => r.documentId))];
  const names = new Map<string, string>();
  if (docIds.length) {
    const vs = await db
      .select({ documentId: contentVersion.documentId, locale: contentVersion.locale, name: contentVersion.name, published: contentVersion.isCurrentPublished })
      .from(contentVersion)
      .where(inArray(contentVersion.documentId, docIds));
    for (const v of vs) if (!names.has(`${v.documentId}:${v.locale}`) || v.published) names.set(`${v.documentId}:${v.locale}`, v.name);
  }
  return rows.map((r) => {
    const own = arms.get(r.id) ?? [];
    const counted = own.map((a) => ({ key: a.key, weight: a.weight, ...(totals.get(`${r.id}:${a.key}`) ?? { exposures: 0, conversions: 0 }) }));
    const { verdict, results } = experimentVerdict(counted, { baselineRate: r.baselineRate, mde: r.mde });
    return {
      id: r.id,
      documentId: r.documentId,
      locale: r.locale,
      area: r.area,
      pageName: names.get(`${r.documentId}:${r.locale}`) ?? null,
      name: r.name,
      hypothesis: r.hypothesis,
      status: r.status as ExperimentStatus,
      goal: r.goal,
      baselineRate: r.baselineRate,
      mde: r.mde,
      endsAt: iso(r.endsAt),
      startedAt: iso(r.startedAt),
      endedAt: iso(r.endedAt),
      endReason: r.endReason,
      winner: r.winner,
      needsReview: r.needsReview,
      createdVia: r.createdVia,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      arms: own.map((a) => ({ key: a.key, label: a.label, weight: a.weight, blocks: (a.blocks as unknown[] | null) ?? null })),
      results,
      verdict,
    };
  });
}

/** Loads one experiment of the active site, with the caller's scope over its page checked. */
async function loadExperiment(db: Database, ctx: AccessContext, id: number, intent: "read" | "write"): Promise<ExperimentRow> {
  const row = (await db.select().from(experiment).where(and(eq(experiment.id, id), eq(experiment.siteId, ctx.siteId))).limit(1))[0];
  if (!row) throw Errors.notFound("Experiment");
  await loadAuthorized(db, ctx, row.documentId, intent);
  return row;
}

export async function listExperiments(db: Database, ctx: AccessContext, opts: { status?: ExperimentStatus; documentId?: string } = {}): Promise<ExperimentView[]> {
  requirePermission(ctx, "content.read");
  const rows = await db
    .select({ e: experiment, sectionId: contentItem.sectionId })
    .from(experiment)
    .leftJoin(contentItem, eq(contentItem.documentId, experiment.documentId))
    .where(
      and(
        eq(experiment.siteId, ctx.siteId),
        opts.status ? eq(experiment.status, opts.status) : undefined,
        opts.documentId ? eq(experiment.documentId, opts.documentId) : undefined,
      ),
    )
    .orderBy(desc(experiment.updatedAt));
  // Section-scoped readers see experiments on their own sections only, like the pages.
  const visible = rows.filter((r) => ctx.readSiteWide || ctx.sections.includes(r.sectionId ?? r.e.documentId)).map((r) => r.e);
  return viewsOf(db, visible);
}

export async function getExperiment(db: Database, ctx: AccessContext, id: number): Promise<ExperimentView & { daily: { day: string; arm: string; exposures: number; conversions: number }[] }> {
  requirePermission(ctx, "content.read");
  const row = await loadExperiment(db, ctx, id, "read");
  const [view] = await viewsOf(db, [row]);
  const daily = await db
    .select({ day: experimentStat.day, arm: experimentStat.arm, exposures: experimentStat.exposures, conversions: experimentStat.conversions })
    .from(experimentStat)
    .where(eq(experimentStat.experimentId, id))
    .orderBy(asc(experimentStat.day), asc(experimentStat.arm));
  return { ...view!, daily };
}

function validatePlan(input: Partial<ExperimentInput>): void {
  if (input.name !== undefined && !input.name.trim()) throw Errors.validation("name: give the experiment a name, e.g. \"Hero headline: benefit vs. feature\".", ["name"]);
  if (input.goal !== undefined && !EXPERIMENT_GOAL.test(input.goal)) {
    throw Errors.validation(`goal: "${input.goal}" isn't a goal. Use "form" (a form on the page is submitted) or "event:<name>" (lowercase letters, digits, _ . -; the frontend reports it), e.g. "event:signup".`, ["goal"]);
  }
  if (input.baselineRate != null && !(input.baselineRate > 0 && input.baselineRate < 1)) {
    throw Errors.validation("baselineRate: today's conversion rate as a fraction between 0 and 1, e.g. 0.04 for 4 %.", ["baselineRate"]);
  }
  if (input.mde != null && !(input.mde > 0 && input.mde <= 10)) {
    throw Errors.validation("mde: the smallest RELATIVE lift worth detecting, as a fraction, e.g. 0.2 for +20 %.", ["mde"]);
  }
  if (input.endsAt != null && Number.isNaN(Date.parse(input.endsAt))) throw Errors.validation("endsAt: an ISO date-time, e.g. \"2026-12-01T00:00:00Z\".", ["endsAt"]);
}

/** Normalizes the arms: A first (weight only), then the alternatives with validated blocks. */
async function prepareArms(db: Database, item: { type: string; siteId: string }, loc: string, area: string, arms: ExperimentArmInput[]): Promise<{ key: string; label: string | null; weight: number; blocks: unknown[] | null }[]> {
  if (!Array.isArray(arms)) throw Errors.validation("arms: a list of versions, e.g. [{\"label\": \"Shorter headline\", \"blocks\": [ …blocks as in the area… ]}].", ["arms"]);
  const control = arms.find((a) => a.key === "a");
  const alternatives = arms.filter((a) => a.key !== "a");
  if (alternatives.length < 1 || alternatives.length > 3) {
    throw Errors.validation(`arms: give 1–3 alternatives to the page's own area (version A), got ${alternatives.length}. Each is {label?, weight?, blocks: [ …block instances as in the content area… ]}.`, ["arms"]);
  }
  const free = EXPERIMENT_ARMS.filter((k) => k !== "a" && !alternatives.some((a) => a.key === k));
  const out: { key: string; label: string | null; weight: number; blocks: unknown[] | null }[] = [{ key: "a", label: control?.label ?? null, weight: control?.weight ?? 50, blocks: null }];
  for (const a of alternatives) {
    const key = a.key ?? free.shift();
    if (!key || !(EXPERIMENT_ARMS as readonly string[]).includes(key) || out.some((o) => o.key === key)) {
      throw Errors.validation(`arms: version keys are "b", "c" and "d" (A is the page itself), each used once; got "${a.key}".`, ["arms"]);
    }
    try {
      const blocks = await prepareAreaBlocks(db, item.type, item.siteId, loc, area, a.blocks ?? []);
      out.push({ key, label: a.label ?? null, weight: a.weight ?? 50, blocks });
    } catch (err) {
      // Name the version: the same block error can come from B or C.
      if (err instanceof Error) err.message = `Version ${key.toUpperCase()}: ${err.message}`;
      throw err;
    }
  }
  for (const o of out) {
    if (!Number.isInteger(o.weight) || o.weight < 0 || o.weight > 100) throw Errors.validation(`arms: weight is a whole number 0–100 (a share of visitors); version ${o.key.toUpperCase()} has ${o.weight}.`, ["arms"]);
  }
  if (out.every((o) => o.weight === 0)) throw Errors.validation("arms: at least one version needs a weight above 0.", ["arms"]);
  return out;
}

const viaAgent = (ctx: AccessContext): boolean => ctx.via === "mcp" || ctx.via === "agent";

export async function createExperiment(db: Database, ctx: AccessContext, input: ExperimentInput): Promise<ExperimentView> {
  requirePermission(ctx, "content.update");
  const item = await loadAuthorized(db, ctx, input.documentId);
  if (item.kind !== "page") throw Errors.validation(`An experiment tests an area of a PAGE; ${input.documentId} is a ${item.kind}. To test a shared block, experiment on the area of a page that uses it.`, ["documentId"]);
  validatePlan(input);
  const arms = await prepareArms(db, item, input.locale, input.area, input.arms);
  const [row] = await db
    .insert(experiment)
    .values({
      siteId: ctx.siteId,
      documentId: input.documentId,
      locale: input.locale,
      area: input.area,
      name: input.name.trim(),
      hypothesis: input.hypothesis ?? null,
      goal: input.goal ?? "form",
      baselineRate: input.baselineRate ?? null,
      mde: input.mde ?? null,
      endsAt: input.endsAt ? new Date(input.endsAt) : null,
      needsReview: viaAgent(ctx),
      createdBy: ctx.userId,
      createdVia: ctx.via ?? "web",
    })
    .returning();
  await db.insert(experimentArm).values(arms.map((a) => ({ experimentId: row!.id, ...a })));
  return (await viewsOf(db, [row!]))[0]!;
}

export async function updateExperiment(db: Database, ctx: AccessContext, id: number, patch: Partial<Omit<ExperimentInput, "documentId" | "locale" | "area">>): Promise<ExperimentView> {
  requirePermission(ctx, "content.update");
  const row = await loadExperiment(db, ctx, id, "write");
  if (row.status === "running") throw Errors.conflict("This experiment is running, so its versions can't change mid-test (the counts so far would mix two different tests). Pause it first, edit, then start it again.");
  if (row.status === "ended") throw Errors.conflict("This experiment has ended and is kept as history with its results. Create a new experiment to test again.");
  validatePlan(patch);
  const item = await loadAuthorized(db, ctx, row.documentId);
  const arms = patch.arms ? await prepareArms(db, item, row.locale, row.area, patch.arms) : null;
  await db.transaction(async (tx) => {
    await tx
      .update(experiment)
      .set({
        ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
        ...(patch.hypothesis !== undefined ? { hypothesis: patch.hypothesis } : {}),
        ...(patch.goal !== undefined ? { goal: patch.goal } : {}),
        ...(patch.baselineRate !== undefined ? { baselineRate: patch.baselineRate } : {}),
        ...(patch.mde !== undefined ? { mde: patch.mde } : {}),
        ...(patch.endsAt !== undefined ? { endsAt: patch.endsAt ? new Date(patch.endsAt) : null } : {}),
        // A human edit is a review; an agent's edit needs one again.
        needsReview: viaAgent(ctx) ? true : false,
        updatedAt: new Date(),
      })
      .where(eq(experiment.id, id));
    if (arms) {
      await tx.delete(experimentArm).where(eq(experimentArm.experimentId, id));
      await tx.insert(experimentArm).values(arms.map((a) => ({ experimentId: id, ...a })));
    }
  });
  return (await viewsOf(db, [(await db.select().from(experiment).where(eq(experiment.id, id)))[0]!]))[0]!;
}

async function isPublished(db: Database, documentId: string, loc: string): Promise<boolean> {
  const rows = await db
    .select({ id: contentVersion.id })
    .from(contentVersion)
    .where(and(eq(contentVersion.documentId, documentId), eq(contentVersion.locale, loc), eq(contentVersion.isCurrentPublished, true)))
    .limit(1);
  return rows.length > 0;
}

export async function startExperiment(db: Database, ctx: AccessContext, id: number): Promise<ExperimentView> {
  requirePermission(ctx, "content.publish");
  const row = await loadExperiment(db, ctx, id, "write");
  if (row.status === "running") return (await viewsOf(db, [row]))[0]!;
  if (row.status === "ended") throw Errors.conflict("This experiment has ended. Create a new one to test again.");
  if (viaAgent(ctx) && row.needsReview && (await getAgentReviewRequired(db))) {
    throw Errors.forbidden(
      "This experiment was set up by an agent and the site requires human review first (Settings → Agent access → agent review). " +
        "It is waiting for approval: a human starts it from the page's experiment panel, which is the review.",
    );
  }
  if (!(await isPublished(db, row.documentId, row.locale))) {
    throw Errors.conflict(`Version A is the page's PUBLISHED area, and this page has no published '${row.locale}' version. Publish the page first, then start the experiment.`);
  }
  try {
    await db
      .update(experiment)
      .set({ status: "running", startedAt: row.startedAt ?? new Date(), cv: await nextCv(db), needsReview: viaAgent(ctx) ? row.needsReview : false, updatedAt: new Date() })
      .where(eq(experiment.id, id));
  } catch (err) {
    if (pgErrorCode(err) !== PG_UNIQUE_VIOLATION) throw err;
    const other = (await db.select().from(experiment).where(and(eq(experiment.documentId, row.documentId), eq(experiment.locale, row.locale), eq(experiment.area, row.area), inArray(experiment.status, ["running", "paused"]))).limit(1))[0];
    throw Errors.conflict(`Area '${row.area}' already has a live experiment ("${other?.name ?? "?"}", id ${other?.id ?? "?"}, ${other?.status ?? "running"}). End that one first: one experiment per area at a time.`);
  }
  announceDeliveryChange(db, row.siteId, "experiment", row.documentId);
  return (await viewsOf(db, [(await db.select().from(experiment).where(eq(experiment.id, id)))[0]!]))[0]!;
}

export async function pauseExperiment(db: Database, ctx: AccessContext, id: number): Promise<ExperimentView> {
  requirePermission(ctx, "content.publish");
  const row = await loadExperiment(db, ctx, id, "write");
  if (row.status !== "running") throw Errors.conflict(`Only a running experiment can be paused; this one is ${row.status}.`);
  const [next] = await db.update(experiment).set({ status: "paused", cv: await nextCv(db), updatedAt: new Date() }).where(eq(experiment.id, id)).returning();
  announceDeliveryChange(db, row.siteId, "experiment", row.documentId);
  return (await viewsOf(db, [next!]))[0]!;
}

export type WinnerApply = "draft" | "publish" | "none";

/**
 * Ends an experiment. With a winner other than A and apply "draft", its blocks
 * become the area's draft (a normal edit: coercion, revision, review); with
 * "publish" that draft is published too. Losing versions are kept.
 */
export async function endExperiment(db: Database, ctx: AccessContext, id: number, opts: { winner?: string | null; apply?: WinnerApply } = {}): Promise<{ experiment: ExperimentView; applied: WinnerApply }> {
  requirePermission(ctx, "content.publish");
  const row = await loadExperiment(db, ctx, id, "write");
  if (row.status === "ended") throw Errors.conflict("This experiment has already ended.");
  const arms = (await armsOf(db, [id])).get(id) ?? [];
  const winner = opts.winner ?? null;
  if (winner && !arms.some((a) => a.key === winner)) throw Errors.validation(`winner: one of ${arms.map((a) => `"${a.key}"`).join(", ")}, or leave it out to end without one.`, ["winner"]);
  const apply: WinnerApply = winner && winner !== "a" ? (opts.apply ?? "draft") : "none";
  if (apply !== "none") {
    // Applied BEFORE the experiment ends: if the version no longer validates
    // (the content type changed), the editor learns it with the test still intact.
    const blocks = arms.find((a) => a.key === winner)!.blocks ?? [];
    await updateContent(db, ctx, row.documentId, row.locale, { merge: true, data: { [row.area]: blocks } });
    if (apply === "publish") await publishContent(db, ctx, row.documentId, row.locale);
  }
  const [next] = await db
    .update(experiment)
    .set({ status: "ended", endedAt: new Date(), endReason: "manual", winner, cv: await nextCv(db), updatedAt: new Date() })
    .where(eq(experiment.id, id))
    .returning();
  if (row.status !== "draft") announceDeliveryChange(db, row.siteId, "experiment", row.documentId);
  return { experiment: (await viewsOf(db, [next!]))[0]!, applied: apply };
}

/* ------------------------------- delivery --------------------------------- */

export interface LiveExperiment {
  id: number;
  documentId: string;
  locale: string;
  area: string;
  goal: string;
  status: string;
  cv: number;
  arms: { key: string; weight: number; blocks: unknown[] | null }[];
}

/** The experiments delivery ships for a site: running ones, plus drafts and paused ones under preview. */
export async function liveExperiments(db: Database, siteId: string, preview: boolean): Promise<LiveExperiment[]> {
  const rows = await db
    .select()
    .from(experiment)
    .where(and(eq(experiment.siteId, siteId), inArray(experiment.status, preview ? ["draft", "running", "paused"] : ["running"])));
  const arms = await armsOf(db, rows.map((r) => r.id));
  return rows.map((r) => ({
    id: r.id,
    documentId: r.documentId,
    locale: r.locale,
    area: r.area,
    goal: r.goal,
    status: r.status,
    cv: r.cv,
    arms: (arms.get(r.id) ?? []).map((a) => ({ key: a.key, weight: a.weight, blocks: (a.blocks as unknown[] | null) ?? null })),
  }));
}

/* -------------------------------- counting -------------------------------- */

export interface ExperimentEvents {
  exposures?: { experimentId: number; arm: string }[];
  conversions?: { experimentId: number; arm: string; goal?: string }[];
}

/**
 * Counts what the frontend reported, for RUNNING experiments of this site only.
 * Anything else (unknown, ended, another site's, a version that doesn't exist,
 * a goal the experiment doesn't track) is ignored and counted, never an error:
 * a page cached before an experiment ended must not start failing.
 */
export async function recordExperimentEvents(db: Database, siteId: string, events: ExperimentEvents): Promise<{ exposures: number; conversions: number; ignored: number }> {
  const exposures = (events.exposures ?? []).slice(0, MAX_EVENTS);
  const conversions = (events.conversions ?? []).slice(0, MAX_EVENTS);
  const ids = [...new Set([...exposures, ...conversions].map((e) => e.experimentId))];
  if (!ids.length) return { exposures: 0, conversions: 0, ignored: 0 };
  const running = await db.select({ id: experiment.id, goal: experiment.goal }).from(experiment).where(and(eq(experiment.siteId, siteId), eq(experiment.status, "running"), inArray(experiment.id, ids)));
  const arms = await armsOf(db, running.map((r) => r.id));
  const goals = new Map(running.map((r) => [r.id, r.goal]));
  const valid = (e: { experimentId: number; arm: string }) => goals.has(e.experimentId) && (arms.get(e.experimentId) ?? []).some((a) => a.key === e.arm);
  const tally = new Map<string, { id: number; arm: string; exposures: number; conversions: number }>();
  const bump = (e: { experimentId: number; arm: string }, field: "exposures" | "conversions") => {
    const k = `${e.experimentId}:${e.arm}`;
    const t = tally.get(k) ?? { id: e.experimentId, arm: e.arm, exposures: 0, conversions: 0 };
    t[field]++;
    tally.set(k, t);
  };
  const counted = { exposures: 0, conversions: 0 };
  for (const e of exposures) {
    if (!valid(e)) continue;
    bump(e, "exposures");
    counted.exposures++;
  }
  for (const c of conversions) {
    if (!valid(c) || (c.goal !== undefined && c.goal !== goals.get(c.experimentId))) continue;
    bump(c, "conversions");
    counted.conversions++;
  }
  for (const t of tally.values()) {
    await db
      .insert(experimentStat)
      .values({ experimentId: t.id, arm: t.arm, day: sql`current_date`, exposures: t.exposures, conversions: t.conversions })
      .onConflictDoUpdate({
        target: [experimentStat.experimentId, experimentStat.arm, experimentStat.day],
        set: { exposures: sql`${experimentStat.exposures} + ${t.exposures}`, conversions: sql`${experimentStat.conversions} + ${t.conversions}` },
      });
  }
  return { ...counted, ignored: exposures.length + conversions.length - counted.exposures - counted.conversions };
}

/** A form submission that carried the page's versions: a conversion for those whose goal is "form". */
export async function recordFormConversions(db: Database, siteId: string, experiments: { id: number; arm: string }[]): Promise<void> {
  await recordExperimentEvents(db, siteId, { conversions: experiments.map((e) => ({ experimentId: e.id, arm: e.arm, goal: "form" })) });
}

/* --------------------------------- ticker --------------------------------- */

/**
 * Ends experiments whose time is up or whose page no longer carries them:
 * past ends_at, page trashed, unpublished, moved to another site, or the area
 * gone from the content type. No winner; the page returns to its control.
 * Also sweeps daily counts past STAT_RETENTION_DAYS.
 */
export async function runExperimentTicker(db: Database, now: Date = new Date()): Promise<{ ended: { id: number; siteId: string; documentId: string; reason: string }[]; statsSwept: number }> {
  const live = await db.select().from(experiment).where(inArray(experiment.status, ["running", "paused"]));
  const ended: { id: number; siteId: string; documentId: string; reason: string }[] = [];
  for (const e of live) {
    const reason = await endReasonFor(db, e, now);
    if (!reason) continue;
    await db.update(experiment).set({ status: "ended", endedAt: now, endReason: reason, cv: await nextCv(db), updatedAt: now }).where(eq(experiment.id, e.id));
    announceDeliveryChange(db, e.siteId, "experiment", e.documentId);
    ended.push({ id: e.id, siteId: e.siteId, documentId: e.documentId, reason });
  }
  const cutoff = new Date(now.getTime() - STAT_RETENTION_DAYS * 86_400_000).toISOString().slice(0, 10);
  const swept = await db.delete(experimentStat).where(lt(experimentStat.day, cutoff)).returning({ id: experimentStat.experimentId });
  return { ended, statsSwept: swept.length };
}

async function endReasonFor(db: Database, e: ExperimentRow, now: Date): Promise<string | null> {
  if (e.endsAt && e.endsAt <= now) return "ends-at";
  const item = (await db.select().from(contentItem).where(eq(contentItem.documentId, e.documentId)).limit(1))[0];
  if (!item || item.deletedAt) return "page-trashed";
  if (item.siteId !== e.siteId) return "page-moved";
  if (!(await isPublished(db, e.documentId, e.locale))) return "page-unpublished";
  const type = (await db.select({ definition: contentType.definition }).from(contentType).where(eq(contentType.name, item.type)).limit(1))[0];
  const def = type ? parseStoredContentTypeDef(type.definition) : null;
  if (!def?.fields.some((f) => f.name === e.area && f.type === "contentArea")) return "area-removed";
  return null;
}

/* -------------------------------- settings -------------------------------- */

export interface ExperimentSettings {
  mode: ExperimentMode;
  warnDays: number;
  /** Live experiments that have run longer than warnDays (the dashboard's warning). */
  overdue: number[];
}

export async function getExperimentSettings(db: Database, ctx: AccessContext, now: Date = new Date()): Promise<ExperimentSettings> {
  requirePermission(ctx, "content.read");
  const s = (await db.select({ mode: site.experimentMode, warnDays: site.experimentWarnDays }).from(site).where(eq(site.id, ctx.siteId)).limit(1))[0];
  const warnDays = s?.warnDays ?? 30;
  const overdue = await db
    .select({ id: experiment.id })
    .from(experiment)
    .where(and(eq(experiment.siteId, ctx.siteId), eq(experiment.status, "running"), lte(experiment.startedAt, new Date(now.getTime() - warnDays * 86_400_000))));
  return { mode: (s?.mode as ExperimentMode) ?? "cookieless", warnDays, overdue: overdue.map((o) => o.id) };
}

export async function setExperimentSettings(db: Database, ctx: AccessContext, input: { mode?: ExperimentMode; warnDays?: number }): Promise<ExperimentSettings> {
  requirePermission(ctx, "site.manage");
  if (input.mode !== undefined && !(EXPERIMENT_MODES as readonly string[]).includes(input.mode)) throw Errors.validation(`mode: "cookieless" or "consent".`, ["mode"]);
  if (input.warnDays !== undefined && !(Number.isInteger(input.warnDays) && input.warnDays >= 1 && input.warnDays <= 365)) throw Errors.validation("warnDays: whole days, 1–365.", ["warnDays"]);
  await db
    .update(site)
    .set({ ...(input.mode ? { experimentMode: input.mode } : {}), ...(input.warnDays ? { experimentWarnDays: input.warnDays } : {}) })
    .where(eq(site.id, ctx.siteId));
  return getExperimentSettings(db, ctx);
}
