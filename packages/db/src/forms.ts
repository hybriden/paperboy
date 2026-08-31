import {
  type FormSpec,
  type SharedBlockResolver,
  coerceSubmissionValues,
  fieldSnapshot,
  formSpecFrom,
  isFormFieldType,
  isFormType,
  submissionErrors,
  submissionSchemaFor,
} from "@paperboy/shared";
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Database } from "./client.js";
import { Errors } from "./errors.js";
import { type AccessContext, requirePermission } from "./scope.js";
import { resolveDefaultLocale } from "./content.js";
import { publishWindowOpen } from "./delivery.js";
import { contentItem, contentVersion, formSubmission, siteSetting } from "./schema.js";

/**
 * Form submissions: the WRITE chokepoint for public form posts, plus the
 * management reads, the GDPR paths and the retention sweep.
 *
 * Deliberately separate from delivery.ts. Delivery is the single READ
 * chokepoint and stays GET-only; this module is the single WRITE chokepoint for
 * anonymous public traffic, with its own rules:
 *
 *  - the form definition is re-read from the CURRENT PUBLISHED version on every
 *    submission, and validation is compiled from it (never from anything the
 *    client sent);
 *  - a submission is confined to the site whose delivery key was presented;
 *  - answers are stored with a snapshot of the fields as answered;
 *  - nothing here ever reads a session cookie or an AccessContext — the public
 *    path has no ambient authority to confuse it with.
 */

/** Instance-wide fallback when a form declares no retention. */
export const DEFAULT_RETENTION_SETTING_KEY = "submissionRetentionDays";

export interface FormSettings {
  retentionDays: number | null;
  captureMetadata: boolean;
  notifyWebhooks: boolean;
  notifyEmail: string;
}

export interface PublishedForm {
  formId: string;
  siteId: string;
  locale: string;
  cv: number;
  name: string;
  spec: FormSpec;
  settings: FormSettings;
}

const asNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const asStr = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * Load a published Form for a site, preferring the requested locale.
 *
 * Reads the raw stored data rather than delivery output on purpose: the form's
 * operational settings (retention, metadata capture, notification targets) are
 * `delivery: private` and are therefore absent from delivered JSON — they must
 * never leave the server, but the server needs them.
 */
/**
 * The site a live Form belongs to, or null. A browser's CORS preflight carries
 * no credential, so the submit route's OPTIONS handler can only learn the site —
 * and therefore which origins may post — from the form's own id.
 */
export async function formSiteId(db: Database, formId: string): Promise<string | null> {
  const rows = await db
    .select({ siteId: contentItem.siteId, type: contentItem.type, deletedAt: contentItem.deletedAt })
    .from(contentItem)
    .where(eq(contentItem.documentId, formId))
    .limit(1);
  const item = rows[0];
  return item && !item.deletedAt && isFormType(item.type) ? item.siteId : null;
}

export async function loadPublishedForm(
  db: Database,
  siteId: string,
  formId: string,
  locale: string,
): Promise<PublishedForm | null> {
  const items = await db
    .select()
    .from(contentItem)
    .where(and(eq(contentItem.documentId, formId), eq(contentItem.siteId, siteId)))
    .limit(1);
  const item = items[0];
  // Deny-by-default: unknown document, another site's document, a trashed one,
  // or a document that isn't a Form all look identical from outside.
  if (!item || item.deletedAt || !isFormType(item.type)) return null;

  // The publish window applies here as it does in delivery: a form whose
  // expire_at has passed is no longer served, so it no longer accepts either.
  const now = new Date();
  const rows = (
    await db
      .select()
      .from(contentVersion)
      .where(
        and(
          eq(contentVersion.documentId, formId),
          eq(contentVersion.status, "published"),
          eq(contentVersion.isCurrentPublished, true),
        ),
      )
  ).filter((r) => publishWindowOpen(r, now));
  if (rows.length === 0) return null; // an unpublished (or expired) form accepts nothing

  // An unrecognised locale must not select a variant by accident: a caller
  // sending a locale this form has never published in falls back to the site's
  // default, not to whichever row the database happened to return first.
  const known = rows.some((r) => r.locale === locale);
  if (!known) locale = await resolveDefaultLocale(db, siteId);

  // The LABELS come from the requested locale (that is what the visitor read).
  // Everything policy-shaped is resolved across ALL published variants below.
  const row = rows.find((r) => r.locale === locale) ?? rows[0]!;
  const data = (row.data ?? {}) as Record<string, unknown>;
  const variants = rows.map((r) => (r.data ?? {}) as Record<string, unknown>);
  // Prefer the requested variant's own value, then any sibling's.
  const ordered = [data, ...variants.filter((v) => v !== data)];

  /**
   * The operational settings are NOT localized — one value, shared across
   * language branches — but they are physically stored per locale-version, and
   * a translated branch starts empty (workingData returns {} for a new locale).
   * Reading only the requested row therefore let the CALLER pick which policy
   * to be judged by: posting `locale: "nb"` against a form whose Turnstile
   * challenge was configured in `en` skipped the challenge entirely, and a
   * branch missing `retentionDays` fell back to the instance default, keeping
   * personal data far longer than the editor asked.
   *
   * So: fill a missing value from a sibling variant (delivery already does this
   * for non-localized fields), and where branches genuinely disagree, resolve
   * the STRICT way — any variant demanding a challenge means a challenge, and
   * the shortest declared retention wins. A setting that protects visitors must
   * never be the laxest one an attacker can name.
   */
  const firstDefined = <T>(read: (v: Record<string, unknown>) => T | null | undefined): T | null => {
    for (const v of ordered) {
      const got = read(v);
      if (got !== null && got !== undefined) return got;
    }
    return null;
  };

  const retentionDays = variants
    .map((v) => asNum(v.retentionDays))
    .filter((n): n is number => n !== null)
    .reduce<number | null>((min, n) => (min === null || n < min ? n : min), null);
  const requiresTurnstile = variants.some((v) => asStr(v.spamProtection) === "heuristics+turnstile");

  const spec = formSpecFrom(data, { sharedBlock: await publishedFieldBlocks(db, siteId, data.fields, row.locale, now) });
  return {
    formId,
    siteId,
    locale: row.locale,
    cv: row.cv,
    name: row.name,
    spec: { ...spec, turnstile: spec.turnstile || requiresTurnstile },
    settings: {
      retentionDays,
      captureMetadata: firstDefined((v) => (typeof v.captureMetadata === "boolean" ? v.captureMetadata : null)) === true,
      notifyWebhooks: firstDefined((v) => (typeof v.notifyWebhooks === "boolean" ? v.notifyWebhooks : null)) === true,
      notifyEmail: firstDefined((v) => (typeof v.notifyEmail === "string" && v.notifyEmail ? v.notifyEmail : null)) ?? "",
    },
  };
}

/**
 * The form's SHARED field blocks, read the way the form itself is: the current
 * published version, this site, not trashed, inside its publish window, and a
 * form field part — so a shared consent box binds a submission exactly like an
 * inline one, and an unpublished one binds nothing.
 */
async function publishedFieldBlocks(
  db: Database,
  siteId: string,
  area: unknown,
  locale: string,
  now: Date,
): Promise<SharedBlockResolver> {
  const refs = [
    ...new Set(
      (Array.isArray(area) ? area : [])
        .map((b) => (b && typeof b === "object" ? (b as { ref?: unknown }).ref : undefined))
        .filter((r): r is string => typeof r === "string" && r !== ""),
    ),
  ];
  const blocks = new Map<string, { blockType: string; data: Record<string, unknown> }>();
  if (refs.length === 0) return (documentId) => blocks.get(documentId);

  const items = (
    await db
      .select({ documentId: contentItem.documentId, type: contentItem.type })
      .from(contentItem)
      .where(and(inArray(contentItem.documentId, refs), eq(contentItem.siteId, siteId), isNull(contentItem.deletedAt)))
  ).filter((i) => isFormFieldType(i.type));
  if (items.length === 0) return (documentId) => blocks.get(documentId);

  const rows = (
    await db
      .select()
      .from(contentVersion)
      .where(
        and(
          inArray(contentVersion.documentId, items.map((i) => i.documentId)),
          eq(contentVersion.status, "published"),
          eq(contentVersion.isCurrentPublished, true),
        ),
      )
  ).filter((r) => publishWindowOpen(r, now));
  for (const item of items) {
    const variants = rows.filter((r) => r.documentId === item.documentId);
    const own = variants.find((r) => r.locale === locale) ?? variants[0];
    if (!own) continue;
    // The form's locale wins; siblings fill what a translated branch left empty
    // (the key and the required flag are not localized, but are stored per
    // locale-version — the same gap loadPublishedForm closes for its settings).
    const data = Object.assign({}, ...variants.filter((v) => v !== own).map((v) => v.data ?? {}), own.data ?? {}) as Record<string, unknown>;
    blocks.set(item.documentId, { blockType: item.type, data });
  }
  return (documentId) => blocks.get(documentId);
}

async function instanceRetentionDays(db: Database): Promise<number | null> {
  const rows = await db
    .select()
    .from(siteSetting)
    .where(eq(siteSetting.key, DEFAULT_RETENTION_SETTING_KEY))
    .limit(1);
  const v = rows[0]?.value as unknown;
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  if (v && typeof v === "object" && "days" in v) {
    const d = (v as { days?: unknown }).days;
    if (typeof d === "number" && Number.isFinite(d) && d > 0) return d;
  }
  return null;
}

export interface SubmitInput {
  siteId: string;
  formId: string;
  locale: string;
  values: Record<string, unknown>;
  /** Technical metadata, stored ONLY if the form opted in. */
  meta?: { ip?: string; userAgent?: string; referer?: string };
  idempotencyKey?: string;
  /**
   * Instance-wide fallback retention, supplied by the caller because the
   * environment belongs to the API process, not to this layer. Precedence:
   * the form's own setting, then the stored instance setting, then this.
   */
  defaultRetentionDays?: number;
}

/**
 * Validation failure is a RESULT, not an exception: the route has to answer with
 * one message per field so a frontend can render it beside the input it belongs
 * to (WCAG 3.3.1 identifies errors per field). A flat error string can't carry that.
 */
export type SubmitResult =
  | { ok: true; submissionId: string; form: PublishedForm; replayed: boolean; values: Record<string, unknown> }
  | { ok: false; fields: Record<string, string> };

/**
 * Store one submission.
 *
 * Spam heuristics and Turnstile run in the route BEFORE this (a bot's payload
 * should cost a database round-trip only if it looks human). Validation runs
 * HERE, against the live definition, so no caller can skip it.
 */
export async function submitForm(db: Database, input: SubmitInput): Promise<SubmitResult> {
  const form = await loadPublishedForm(db, input.siteId, input.formId, input.locale);
  if (!form) throw Errors.notFound("Form not found, not published, or not available for this site.");

  const coerced = coerceSubmissionValues(form.spec, input.values);
  const parsed = submissionSchemaFor(form.spec).safeParse(coerced);
  if (!parsed.success) return { ok: false, fields: submissionErrors(parsed.error) };

  // A repeated key is a retry, not a second answer.
  if (input.idempotencyKey) {
    const existing = await db
      .select()
      .from(formSubmission)
      .where(and(eq(formSubmission.formId, input.formId), eq(formSubmission.idempotencyKey, input.idempotencyKey)))
      .limit(1);
    if (existing[0]) return { ok: true, submissionId: existing[0].submissionId, form, replayed: true, values: (existing[0].values ?? {}) as Record<string, unknown> };
  }

  const retentionDays =
    form.settings.retentionDays ?? (await instanceRetentionDays(db)) ?? input.defaultRetentionDays ?? null;
  const expiresAt = retentionDays ? new Date(Date.now() + retentionDays * 86_400_000) : null;
  const submissionId = `sub_${nanoid(18)}`;
  // Data minimisation: an IP address is personal data, so it is stored only
  // when the editor explicitly asked for it on this form.
  const meta = form.settings.captureMetadata ? (input.meta ?? {}) : {};

  try {
    await db.insert(formSubmission).values({
      submissionId,
      siteId: input.siteId,
      formId: input.formId,
      formCv: form.cv,
      locale: form.locale,
      values: parsed.data,
      fieldSnapshot: fieldSnapshot(form.spec),
      meta,
      idempotencyKey: input.idempotencyKey ?? null,
      expiresAt,
    });
  } catch (err) {
    // Concurrent duplicate of the same key: the unique index won the race, so
    // return the row that landed instead of failing a legitimate retry.
    if (input.idempotencyKey) {
      const raced = await db
        .select()
        .from(formSubmission)
        .where(and(eq(formSubmission.formId, input.formId), eq(formSubmission.idempotencyKey, input.idempotencyKey)))
        .limit(1);
      if (raced[0]) return { ok: true, submissionId: raced[0].submissionId, form, replayed: true, values: (raced[0].values ?? {}) as Record<string, unknown> };
    }
    throw err;
  }
  return { ok: true, submissionId, form, replayed: false, values: parsed.data };
}

/* --------------------------- management reads ----------------------------- */

export interface SubmissionRow {
  submissionId: string;
  formId: string;
  formName?: string;
  locale: string;
  values: Record<string, unknown>;
  fieldSnapshot: { name: string; label: string; kind: string }[];
  meta: Record<string, unknown>;
  createdAt: string;
  expiresAt: string | null;
}

const toRow = (r: typeof formSubmission.$inferSelect): SubmissionRow => ({
  submissionId: r.submissionId,
  formId: r.formId,
  locale: r.locale,
  values: (r.values ?? {}) as Record<string, unknown>,
  fieldSnapshot: (r.fieldSnapshot ?? []) as SubmissionRow["fieldSnapshot"],
  meta: (r.meta ?? {}) as Record<string, unknown>,
  createdAt: r.createdAt.toISOString(),
  expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
});

/** Forms in the active site that have a published or draft version, with counts. */
export async function listForms(
  db: Database,
  ctx: AccessContext,
): Promise<{ formId: string; name: string; submissions: number; lastAt: string | null }[]> {
  requirePermission(ctx, "submission.read");
  const items = await db
    .select({ documentId: contentItem.documentId, type: contentItem.type })
    .from(contentItem)
    .where(and(eq(contentItem.siteId, ctx.siteId), eq(contentItem.type, "Form")));
  const live = items.filter((i) => isFormType(i.type)).map((i) => i.documentId);
  if (live.length === 0) return [];

  const names = await db
    .select({ documentId: contentVersion.documentId, name: contentVersion.name })
    .from(contentVersion)
    .where(inArray(contentVersion.documentId, live));
  const counts = await db
    .select({
      formId: formSubmission.formId,
      n: count(formSubmission.id),
      lastAt: sql<Date | null>`max(${formSubmission.createdAt})`,
    })
    .from(formSubmission)
    .where(and(eq(formSubmission.siteId, ctx.siteId), inArray(formSubmission.formId, live)))
    .groupBy(formSubmission.formId);

  return live.map((formId) => {
    const c = counts.find((x) => x.formId === formId);
    return {
      formId,
      name: names.find((n) => n.documentId === formId)?.name ?? formId,
      submissions: Number(c?.n ?? 0),
      lastAt: c?.lastAt ? new Date(c.lastAt).toISOString() : null,
    };
  });
}

export async function listSubmissions(
  db: Database,
  ctx: AccessContext,
  opts: { formId?: string; limit?: number; offset?: number } = {},
): Promise<{ items: SubmissionRow[]; total: number }> {
  requirePermission(ctx, "submission.read");
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  // Site scope is structural, exactly as it is for content: another site's
  // submissions are invisible, not merely filtered out of the default view.
  const where = opts.formId
    ? and(eq(formSubmission.siteId, ctx.siteId), eq(formSubmission.formId, opts.formId))
    : eq(formSubmission.siteId, ctx.siteId);

  const rows = await db
    .select()
    .from(formSubmission)
    .where(where)
    .orderBy(desc(formSubmission.createdAt))
    .limit(limit)
    .offset(offset);
  const totals = await db.select({ n: count(formSubmission.id) }).from(formSubmission).where(where);
  return { items: rows.map(toRow), total: Number(totals[0]?.n ?? 0) };
}

export async function getSubmission(
  db: Database,
  ctx: AccessContext,
  submissionId: string,
): Promise<SubmissionRow | null> {
  requirePermission(ctx, "submission.read");
  const rows = await db
    .select()
    .from(formSubmission)
    .where(and(eq(formSubmission.submissionId, submissionId), eq(formSubmission.siteId, ctx.siteId)))
    .limit(1);
  return rows[0] ? toRow(rows[0]) : null;
}

export async function deleteSubmission(db: Database, ctx: AccessContext, submissionId: string): Promise<boolean> {
  requirePermission(ctx, "submission.manage");
  const res = await db
    .delete(formSubmission)
    .where(and(eq(formSubmission.submissionId, submissionId), eq(formSubmission.siteId, ctx.siteId)))
    .returning({ id: formSubmission.id });
  return res.length > 0;
}

/**
 * Erase every submission in the active site whose answers contain this address
 * — the data-subject-erasure path. One action, so a request can be answered
 * completely and provably instead of hunting per form.
 *
 * Matching is a case-insensitive CONTAINS across all answer VALUES rather than
 * an exact match on a named "email" field: the address may have been given in
 * any field the editor built, including in passing inside a message.
 */
export async function eraseSubmissionsByEmail(
  db: Database,
  ctx: AccessContext,
  email: string,
): Promise<{ deleted: number }> {
  requirePermission(ctx, "submission.manage");
  const needle = email.trim().toLowerCase();
  if (!needle) throw Errors.validation("An email address is required to erase submissions.", ["email"]);
  const res = await db
    .delete(formSubmission)
    .where(
      and(
        eq(formSubmission.siteId, ctx.siteId),
        sql`exists (
          select 1 from jsonb_each_text(${formSubmission.values}) kv
          where position(${needle} in lower(kv.value)) > 0
        )`,
      ),
    )
    .returning({ id: formSubmission.id });
  return { deleted: res.length };
}

/** CSV of the given submissions. Pure, so it is unit-testable without a DB. */
export function submissionsToCsv(rows: SubmissionRow[]): string {
  // Union of every field ever answered, in first-seen order, so a column that
  // only exists in older submissions still appears.
  const columns: { name: string; label: string }[] = [];
  for (const r of rows) {
    for (const f of r.fieldSnapshot) {
      if (!columns.some((c) => c.name === f.name)) columns.push({ name: f.name, label: f.label || f.name });
    }
    for (const k of Object.keys(r.values)) {
      if (!columns.some((c) => c.name === k)) columns.push({ name: k, label: k });
    }
  }
  const esc = (v: unknown): string => {
    // Narrowed rather than String(v): a stored answer is a JSON scalar or a
    // structure, and stringifying an object through the default toString would
    // export "[object Object]" instead of the data.
    const s =
      v == null
        ? ""
        : typeof v === "string"
          ? v
          : typeof v === "number" || typeof v === "boolean" || typeof v === "bigint"
            ? v.toString()
            : JSON.stringify(v);
    // A leading =, +, - or @ makes a spreadsheet treat the cell as a formula,
    // which turns an exported answer into code someone's Excel will run.
    const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return `"${guarded.replace(/"/g, '""')}"`;
  };
  const header = ["Submitted at", "Submission ID", "Locale", ...columns.map((c) => c.label)];
  const lines = [header.map(esc).join(",")];
  for (const r of rows) {
    lines.push(
      [r.createdAt, r.submissionId, r.locale, ...columns.map((c) => r.values[c.name])].map(esc).join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

export async function exportSubmissions(
  db: Database,
  ctx: AccessContext,
  formId?: string,
): Promise<{ csv: string; rows: number }> {
  requirePermission(ctx, "submission.read");
  const where = formId
    ? and(eq(formSubmission.siteId, ctx.siteId), eq(formSubmission.formId, formId))
    : eq(formSubmission.siteId, ctx.siteId);
  const rows = await db.select().from(formSubmission).where(where).orderBy(asc(formSubmission.createdAt));
  const mapped = rows.map(toRow);
  return { csv: submissionsToCsv(mapped), rows: mapped.length };
}

/* ------------------------------- retention -------------------------------- */

/**
 * Delete submissions whose retention window has passed.
 *
 * Called from the API's existing ticker, in-process and on by default. Umbraco
 * Forms ships the same per-form policy but it silently does nothing until a
 * separate scheduled task is switched on in configuration — a compliance
 * setting that lies is worse than none, so this one cannot be left off.
 */
export async function runSubmissionRetention(db: Database, now: Date = new Date()): Promise<{ deleted: number }> {
  const res = await db
    .delete(formSubmission)
    .where(and(isNotNull(formSubmission.expiresAt), lte(formSubmission.expiresAt, now)))
    .returning({ id: formSubmission.id });
  return { deleted: res.length };
}
