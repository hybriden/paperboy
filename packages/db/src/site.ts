import { and, eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { Errors } from "./errors.js";
import { type AccessContext, loadAuthorized, requirePermission } from "./scope.js";
import { contentItem, site, siteSetting } from "./schema.js";
import { decryptSecret, encryptSecret } from "./totp.js";

/**
 * Site settings. The preview origin + start page are PER-SITE (on the `site`
 * entity, migration 0013) — scoped to the active site (ctx.siteId / a passed
 * siteId). AI key/model + agentReview are instance-global (site_setting). Don't
 * add a per-site path that ignores the active site.
 */

const AI_API_KEY = "aiApiKey";
const AI_MODEL_KEY = "aiModel";

async function getSetting<T>(db: Database, key: string): Promise<T | null> {
  const rows = await db.select().from(siteSetting).where(eq(siteSetting.key, key)).limit(1);
  return rows[0] ? (rows[0].value as T) : null;
}

async function putSetting(db: Database, key: string, value: unknown): Promise<void> {
  await db
    .insert(siteSetting)
    .values({ key, value: value as object, updatedAt: new Date() })
    .onConflictDoUpdate({ target: siteSetting.key, set: { value: value as object, updatedAt: new Date() } });
}

/** The documentId of the page served at "/" for a site (or null if unset). */
export async function getStartPageId(db: Database, siteId: string): Promise<string | null> {
  const rows = await db.select({ id: site.startPageId }).from(site).where(eq(site.id, siteId)).limit(1);
  return rows[0]?.id ?? null;
}

/** Set (or clear, with null) the ACTIVE site's start page. Must be an in-site page. */
export async function setStartPage(db: Database, ctx: AccessContext, documentId: string | null): Promise<void> {
  requirePermission(ctx, "content.publish");
  if (documentId) {
    const item = await loadAuthorized(db, ctx, documentId); // confines to the active site + scope
    if (item.kind !== "page") throw Errors.badRequest("Only a page can be the start page");
  }
  await db.update(site).set({ startPageId: documentId }).where(eq(site.id, ctx.siteId));
}

/** The front-end origin used to build preview links for a site (or "" if unset). */
export async function getPreviewBaseUrl(db: Database, siteId: string): Promise<string> {
  const rows = await db.select({ url: site.previewBaseUrl }).from(site).where(eq(site.id, siteId)).limit(1);
  return rows[0]?.url ?? "";
}

/** Set (or clear, with "") the ACTIVE site's preview base URL. */
export async function setPreviewBaseUrl(db: Database, ctx: AccessContext, url: string): Promise<void> {
  requirePermission(ctx, "content.publish");
  const trimmed = url.trim().replace(/\/+$/, ""); // drop trailing slash
  if (trimmed && !/^https?:\/\/[^\s]+$/i.test(trimmed)) {
    throw Errors.badRequest("Preview URL must be a full http(s):// URL");
  }
  await db.update(site).set({ previewBaseUrl: trimmed || null }).where(eq(site.id, ctx.siteId));
}

/** Read-only site config surface for the admin (the ACTIVE site's start page + preview URL). */
export async function getSiteConfig(db: Database, ctx: AccessContext): Promise<{ startPageId: string | null; previewBaseUrl: string }> {
  requirePermission(ctx, "content.read");
  const previewBaseUrl = await getPreviewBaseUrl(db, ctx.siteId);
  // If the configured start page was trashed/deleted/moved out of the site, report
  // null so the UI/web fall back.
  const id = await getStartPageId(db, ctx.siteId);
  if (!id) return { startPageId: null, previewBaseUrl };
  const rows = await db
    .select({ id: contentItem.id })
    .from(contentItem)
    .where(and(eq(contentItem.documentId, id), eq(contentItem.siteId, ctx.siteId)))
    .limit(1);
  return { startPageId: rows[0] ? id : null, previewBaseUrl };
}

/* ------------------------------ agent review ------------------------------ */

const AGENT_REVIEW_KEY = "agentReview";

/** Whether agent (MCP) drafts must be human-approved before an AGENT may publish them. */
export async function getAgentReviewRequired(db: Database): Promise<boolean> {
  const v = await getSetting<{ required: boolean }>(db, AGENT_REVIEW_KEY);
  return v?.required ?? false;
}

/** Toggle the agent-review publish gate (Admin only; default off). */
export async function setAgentReviewRequired(db: Database, ctx: AccessContext, required: boolean): Promise<void> {
  requirePermission(ctx, "user.manage");
  await putSetting(db, AGENT_REVIEW_KEY, { required });
}

/* --------------------------------- AI key --------------------------------- */

/**
 * The AI provider key configured in the CMS, decrypted (or null if unset). AES-GCM
 * encrypted at rest — same scheme/key as TOTP secrets. Resolved at request time by
 * the AI route, which prefers this over the `ANTHROPIC_API_KEY` env fallback. A key
 * that can't be decrypted (e.g. SESSION_SECRET rotated) is treated as unset.
 */
export async function getStoredAiKey(db: Database): Promise<string | null> {
  const v = await getSetting<{ cipher: string }>(db, AI_API_KEY);
  if (!v?.cipher) return null;
  try {
    return decryptSecret(v.cipher);
  } catch {
    return null;
  }
}

/** The model override configured in the CMS (or null to fall back to env/default). */
export async function getStoredAiModel(db: Database): Promise<string | null> {
  const v = await getSetting<{ model: string }>(db, AI_MODEL_KEY);
  return v?.model ?? null;
}

/**
 * Set or clear the AI provider key/model (Admin only). The key is encrypted at
 * rest. For each field: `undefined` leaves it unchanged; null/"" clears it.
 */
export async function setAiConfig(
  db: Database,
  ctx: AccessContext,
  input: { apiKey?: string | null; model?: string | null },
): Promise<void> {
  requirePermission(ctx, "user.manage");
  if (input.apiKey !== undefined) {
    const key = input.apiKey?.trim();
    if (key) await putSetting(db, AI_API_KEY, { cipher: encryptSecret(key) });
    else await db.delete(siteSetting).where(eq(siteSetting.key, AI_API_KEY));
  }
  if (input.model !== undefined) {
    const model = input.model?.trim();
    if (model) await putSetting(db, AI_MODEL_KEY, { model });
    else await db.delete(siteSetting).where(eq(siteSetting.key, AI_MODEL_KEY));
  }
}
