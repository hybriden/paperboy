import { eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { Errors } from "./errors.js";
import { type AccessContext, loadAuthorized, requirePermission } from "./scope.js";
import { contentItem, siteSetting } from "./schema.js";
import { decryptSecret, encryptSecret } from "./totp.js";

/** Site settings. First setting: the START PAGE served at "/". */

const START_PAGE_KEY = "startPage";
const PREVIEW_URL_KEY = "previewBaseUrl";
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

/** The documentId of the page served at "/" (or null if unset/cleared). */
export async function getStartPageId(db: Database): Promise<string | null> {
  const v = await getSetting<{ documentId: string | null }>(db, START_PAGE_KEY);
  return v?.documentId ?? null;
}

/** Set (or clear, with null) the start page. Must be an existing, in-scope page. */
export async function setStartPage(db: Database, ctx: AccessContext, documentId: string | null): Promise<void> {
  requirePermission(ctx, "content.publish");
  if (documentId) {
    const item = await loadAuthorized(db, ctx, documentId); // scope-checks + ensures it exists
    if (item.kind !== "page") throw Errors.badRequest("Only a page can be the start page");
  }
  await putSetting(db, START_PAGE_KEY, { documentId });
}

/** The base URL of the front end used to build preview links (or "" if unset). */
export async function getPreviewBaseUrl(db: Database): Promise<string> {
  const v = await getSetting<{ url: string }>(db, PREVIEW_URL_KEY);
  return v?.url ?? "";
}

/** Set (or clear, with "") the preview base URL (the front-end origin). */
export async function setPreviewBaseUrl(db: Database, ctx: AccessContext, url: string): Promise<void> {
  requirePermission(ctx, "content.publish");
  const trimmed = url.trim().replace(/\/+$/, ""); // drop trailing slash
  if (trimmed && !/^https?:\/\/[^\s]+$/i.test(trimmed)) {
    throw Errors.badRequest("Preview URL must be a full http(s):// URL");
  }
  await putSetting(db, PREVIEW_URL_KEY, { url: trimmed });
}

/** Read-only site config surface for the admin (start page id + preview URL). */
export async function getSiteConfig(db: Database, ctx: AccessContext): Promise<{ startPageId: string | null; previewBaseUrl: string }> {
  requirePermission(ctx, "content.read");
  const previewBaseUrl = await getPreviewBaseUrl(db);
  // If the configured start page was trashed/deleted, report null so the UI/web fall back.
  const id = await getStartPageId(db);
  if (!id) return { startPageId: null, previewBaseUrl };
  const rows = await db.select({ id: contentItem.id }).from(contentItem).where(eq(contentItem.documentId, id)).limit(1);
  return { startPageId: rows[0] ? id : null, previewBaseUrl };
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
