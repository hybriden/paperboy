import { and, eq } from "drizzle-orm";
import { type AiConfig, type AiProvider, DEFAULT_AI_MODELS, DEFAULT_OPENAI_BASE_URL } from "@paperboy/shared";
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
const AI_PROVIDER_KEY = "aiProvider";
const AI_BASE_URL_KEY = "aiBaseUrl";

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

/* ------------------------------- AI provider ------------------------------- */

/** The stored AI configuration, decrypted. `keyProvider` is the provider the key
 *  was SAVED under — a key is bound to its provider (see resolveAiRuntimeConfig). */
export interface StoredAiConfig {
  provider: AiProvider | null;
  apiKey: string | null;
  keyProvider: AiProvider | null;
  model: string | null;
  baseUrl: string | null;
}

/**
 * The AI config stored in the CMS. The key is AES-GCM encrypted at rest — same
 * scheme/key as TOTP secrets; a key that can't be decrypted (e.g. secret
 * rotated) is treated as unset.
 */
export async function getStoredAiConfig(db: Database): Promise<StoredAiConfig> {
  const keyRow = await getSetting<{ cipher: string; provider?: AiProvider }>(db, AI_API_KEY);
  let apiKey: string | null = null;
  if (keyRow?.cipher) {
    try {
      apiKey = decryptSecret(keyRow.cipher);
    } catch {
      apiKey = null;
    }
  }
  const provider = (await getSetting<{ provider: AiProvider }>(db, AI_PROVIDER_KEY))?.provider ?? null;
  const model = (await getSetting<{ model: string }>(db, AI_MODEL_KEY))?.model ?? null;
  const baseUrl = (await getSetting<{ url: string }>(db, AI_BASE_URL_KEY))?.url ?? null;
  // Keys stored before providers existed are Anthropic keys by definition.
  return { provider, apiKey, keyProvider: apiKey ? (keyRow?.provider ?? "anthropic") : null, model, baseUrl };
}

/**
 * Set or clear the AI provider config (Admin only). For each field: `undefined`
 * leaves it unchanged; null/"" clears it. The key is encrypted at rest and
 * SAVED BOUND to the active provider; switching provider therefore CLEARS a
 * key bound to the old one — a key must never be sent to a different vendor's
 * endpoint than it was entered for (an admin-set baseUrl would otherwise be a
 * key-exfiltration channel for the previous provider's key).
 */
export async function setAiConfig(
  db: Database,
  ctx: AccessContext,
  input: { provider?: AiProvider; apiKey?: string | null; model?: string | null; baseUrl?: string | null },
): Promise<void> {
  requirePermission(ctx, "user.manage");
  const stored = await getStoredAiConfig(db);
  const provider = input.provider ?? stored.provider ?? "anthropic";
  if (input.provider !== undefined) {
    await putSetting(db, AI_PROVIDER_KEY, { provider: input.provider });
    if (stored.apiKey && stored.keyProvider !== input.provider && input.apiKey === undefined) {
      await db.delete(siteSetting).where(eq(siteSetting.key, AI_API_KEY));
    }
  }
  if (input.apiKey !== undefined) {
    const key = input.apiKey?.trim();
    if (key) await putSetting(db, AI_API_KEY, { cipher: encryptSecret(key), provider });
    else await db.delete(siteSetting).where(eq(siteSetting.key, AI_API_KEY));
  }
  if (input.model !== undefined) {
    const model = input.model?.trim();
    if (model) await putSetting(db, AI_MODEL_KEY, { model });
    else await db.delete(siteSetting).where(eq(siteSetting.key, AI_MODEL_KEY));
  }
  if (input.baseUrl !== undefined) {
    const url = input.baseUrl?.trim().replace(/\/+$/, "");
    if (url && !/^https?:\/\/[^\s]+$/i.test(url)) {
      throw Errors.badRequest('AI base URL must be a full http(s):// URL, e.g. "https://api.openai.com/v1" or "http://localhost:11434/v1"');
    }
    if (url) await putSetting(db, AI_BASE_URL_KEY, { url });
    else await db.delete(siteSetting).where(eq(siteSetting.key, AI_BASE_URL_KEY));
  }
}

/** The env-side AI settings (process.env shaped — both the API and the MCP server pass theirs). */
export interface AiEnv {
  AI_PROVIDER?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  AI_MODEL?: string;
}

/** The resolved runtime config plus where the key came from (for the status UI). */
export interface ResolvedAiConfig extends AiConfig {
  source: "db" | "env" | "none";
}

/**
 * Resolve the effective AI config — the ONE place the DB settings and the env
 * fallbacks combine, shared by the API routes and the MCP server.
 *
 * Safety rule: key, provider and baseUrl resolve AS A UNIT from one source. A
 * stored (DB) key wins, and is only used under the provider it was saved for;
 * otherwise the env unit applies, where each vendor's env key is bound to its
 * own provider (ANTHROPIC_API_KEY → anthropic, OPENAI_API_KEY → openai) and the
 * base URL comes only from OPENAI_BASE_URL. Units never mix: a DB-set provider
 * or baseUrl can never cause an env key to be sent somewhere its owner didn't
 * configure. Only the model may cross sources (it is not a secret).
 */
export async function resolveAiRuntimeConfig(db: Database, env: AiEnv): Promise<ResolvedAiConfig> {
  const stored = await getStoredAiConfig(db);
  const envProvider: AiProvider | null =
    env.AI_PROVIDER === "openai" || env.AI_PROVIDER === "anthropic"
      ? env.AI_PROVIDER
      : env.ANTHROPIC_API_KEY
        ? "anthropic"
        : env.OPENAI_API_KEY
          ? "openai"
          : null;

  if (stored.apiKey && stored.keyProvider) {
    const provider = stored.keyProvider;
    return {
      provider,
      apiKey: stored.apiKey,
      baseUrl: provider === "openai" ? (stored.baseUrl ?? DEFAULT_OPENAI_BASE_URL) : undefined,
      // "" counts as unset (compose passes AI_MODEL through even when empty).
      model: stored.model || env.AI_MODEL?.trim() || DEFAULT_AI_MODELS[provider],
      source: "db",
    };
  }
  const provider = stored.provider ?? envProvider ?? "anthropic";
  const envKey = provider === "openai" ? env.OPENAI_API_KEY : env.ANTHROPIC_API_KEY;
  return {
    provider,
    apiKey: envKey || undefined,
    baseUrl: provider === "openai" ? (env.OPENAI_BASE_URL?.trim().replace(/\/+$/, "") || DEFAULT_OPENAI_BASE_URL) : undefined,
    model: stored.model || env.AI_MODEL?.trim() || DEFAULT_AI_MODELS[provider],
    source: envKey ? "env" : "none",
  };
}
