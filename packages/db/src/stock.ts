import {
  type AssetSourceMeta,
  type StockProvider,
  type StockProviderName,
  STOCK_PROVIDERS,
  type StockSearchResult,
  getStockProvider,
  sniffUpload,
} from "@paperboy/shared";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { type AssetRecord, findAssetBySource, insertAsset } from "./assets.js";
import type { Database } from "./client.js";
import { AppError, Errors } from "./errors.js";
import { type AccessContext, requirePermission } from "./scope.js";
import { siteSetting } from "./schema.js";
import { decryptSecret, encryptSecret } from "./totp.js";

/**
 * Stock image provider (Settings → Stock images). The provider HTTP clients
 * live in @paperboy/shared; this layer owns config storage (key encrypted at
 * rest like the AI key), RBAC, and the import pipeline (SSRF guard, size cap,
 * magic-byte sniff). Imports land in the regular asset table, so image fields,
 * delivery, and RBAC are untouched. Callers audit-log like other writes.
 */

const STOCK_KEY = "stockImageProvider";
const MAX_IMPORT_BYTES = 5 * 1024 * 1024; // matches the upload route's 5 MB cap

interface StoredStockConfig {
  provider: StockProviderName;
  apiKey?: { cipher: string };
}

/**
 * The stock provider config stored in the CMS, with the key decrypted (or null
 * if unset). A key that can't be decrypted (e.g. SESSION_SECRET rotated) is
 * treated as unset — same behavior as the AI key.
 */
export async function getStoredStockConfig(db: Database): Promise<{ provider: StockProviderName; apiKey: string | null } | null> {
  const rows = await db.select().from(siteSetting).where(eq(siteSetting.key, STOCK_KEY)).limit(1);
  const v = rows[0]?.value as StoredStockConfig | undefined;
  if (!v) return null;
  let apiKey: string | null = null;
  if (v.apiKey?.cipher) {
    try {
      apiKey = decryptSecret(v.apiKey.cipher);
    } catch {
      apiKey = null;
    }
  }
  return { provider: v.provider, apiKey };
}

/**
 * Set or clear the stock provider config (Admin only). The key is encrypted at
 * rest. `apiKey: undefined` leaves it unchanged; null/"" clears it.
 */
export async function setStockConfig(
  db: Database,
  ctx: AccessContext,
  input: { provider?: string; apiKey?: string | null },
): Promise<void> {
  requirePermission(ctx, "user.manage");
  const current = (await getStoredStockConfigRaw(db)) ?? { provider: "unsplash" as StockProviderName };
  if (input.provider !== undefined) {
    if (!STOCK_PROVIDERS.includes(input.provider as StockProviderName)) {
      throw Errors.badRequest(`Unknown stock provider "${input.provider}" — supported: ${STOCK_PROVIDERS.join(", ")}`);
    }
    current.provider = input.provider as StockProviderName;
  }
  if (input.apiKey !== undefined) {
    const key = input.apiKey?.trim();
    if (key) current.apiKey = { cipher: encryptSecret(key) };
    else delete current.apiKey;
  }
  if (!current.apiKey) {
    // No key stored → drop the row entirely (falls back to env or "none").
    await db.delete(siteSetting).where(eq(siteSetting.key, STOCK_KEY));
    return;
  }
  await db
    .insert(siteSetting)
    .values({ key: STOCK_KEY, value: current, updatedAt: new Date() })
    .onConflictDoUpdate({ target: siteSetting.key, set: { value: current, updatedAt: new Date() } });
}

async function getStoredStockConfigRaw(db: Database): Promise<StoredStockConfig | null> {
  const rows = await db.select().from(siteSetting).where(eq(siteSetting.key, STOCK_KEY)).limit(1);
  return (rows[0]?.value as StoredStockConfig | undefined) ?? null;
}

/**
 * Resolve the active provider + key: CMS-stored config first, env fallback
 * (env key implies Unsplash), or null when unconfigured.
 */
export async function resolveStockProvider(
  db: Database,
  envKey?: string,
): Promise<{ provider: StockProvider; apiKey: string; source: "db" | "env" } | null> {
  const stored = await getStoredStockConfig(db);
  if (stored?.apiKey) {
    const provider = getStockProvider(stored.provider);
    if (provider) return { provider, apiKey: stored.apiKey, source: "db" };
  }
  if (envKey) return { provider: getStockProvider("unsplash")!, apiKey: envKey, source: "env" };
  return null;
}

const UNCONFIGURED = "No stock image provider is configured. Add an Unsplash access key in Settings → Stock images (or set UNSPLASH_ACCESS_KEY).";

/** Provider errors are self-teaching — keep the message instead of an opaque 500. */
async function fromProvider<T>(call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(502, "stock_provider_error", err instanceof Error ? err.message : String(err));
  }
}

/** Search the configured stock provider. */
export async function searchStockImages(
  db: Database,
  ctx: AccessContext,
  query: string,
  envKey?: string,
): Promise<StockSearchResult[]> {
  requirePermission(ctx, "content.read");
  const active = await resolveStockProvider(db, envKey);
  if (!active) throw Errors.badRequest(UNCONFIGURED);
  return fromProvider(active.provider.search(query, { apiKey: active.apiKey }));
}

/**
 * Import a stock photo into the asset library: resolve it at the provider
 * (fires download-tracking), download, validate (host allowlist, 5 MB cap,
 * magic-byte sniff — reject, never persist garbage), then hand the bytes to
 * the caller's `save` (the API/MCP owns the uploads dir) and insert the asset
 * row with alt + attribution. Returns the asset ready to set on an image field.
 */
export async function importStockImage(
  db: Database,
  ctx: AccessContext,
  input: { providerId: string; alt?: string },
  io: { save: (fileName: string, buf: Buffer) => Promise<{ relativePath: string }>; envKey?: string },
): Promise<AssetRecord> {
  requirePermission(ctx, "content.create");
  const active = await resolveStockProvider(db, io.envKey);
  if (!active) throw Errors.badRequest(UNCONFIGURED);

  const resolved = await fromProvider(active.provider.resolve(input.providerId, { apiKey: active.apiKey }));

  // Idempotent import: if this exact provider photo is already in the active
  // site's library, return it instead of downloading + inserting a byte-identical
  // copy. Agents re-running the same "find a photo of X" task would otherwise pile
  // up duplicates (every duplicate in production arrived this way via MCP).
  const existing = await findAssetBySource(db, ctx, resolved.sourceMeta.provider, resolved.sourceMeta.providerId);
  if (existing) return existing;

  // SSRF defense-in-depth: only ever download from the provider's own hosts.
  // (The URL came from the provider API, never from the user/agent.)
  const host = new URL(resolved.downloadUrl).hostname;
  if (!active.provider.isDownloadHostAllowed(host)) {
    throw Errors.badRequest(`Stock image download blocked: unexpected host "${host}" for provider ${active.provider.displayName}`);
  }

  const buf = await downloadBytes(resolved.downloadUrl, active.provider.displayName, (h) => active.provider.isDownloadHostAllowed(h));
  const sniff = sniffUpload(buf);
  if (!sniff || !sniff.mime.startsWith("image/")) {
    throw new AppError(415, "unsupported_media", `${active.provider.displayName} returned a file that is not a supported image (PNG, JPEG, GIF, WEBP) — try a different photo.`);
  }

  const documentId = nanoid(24);
  const { relativePath } = await io.save(`${documentId}.${sniff.ext}`, buf);
  return insertAsset(db, ctx, {
    documentId,
    filename: `${sourceSlug(resolved.sourceMeta)}.${sniff.ext}`,
    mime: sniff.mime,
    size: buf.length,
    relativePath,
    alt: (input.alt ?? resolved.alt).slice(0, 300),
    sourceMeta: resolved.sourceMeta,
  });
}

/** Human-readable filename for the media library, e.g. "unsplash-aBc123Xy". */
function sourceSlug(meta: AssetSourceMeta): string {
  return `${meta.provider}-${meta.providerId}`.replace(/[^a-zA-Z0-9._-]/g, "");
}

/**
 * Download image bytes, following redirects MANUALLY so each hop's host is
 * re-checked against the provider allowlist (S3-M8). undici follows 3xx by default,
 * which would let an allowlisted host redirect the server to an internal target —
 * the pre-fetch host check then guards nothing. Exported for the redirect test.
 */
export async function downloadBytes(
  url: string,
  providerName: string,
  isHostAllowed: (hostname: string) => boolean,
): Promise<Buffer> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15_000);
  try {
    let current = url;
    for (let hop = 0; hop < 5; hop++) {
      if (!isHostAllowed(new URL(current).hostname)) {
        throw Errors.badRequest(`${providerName} image download blocked: untrusted redirect host "${new URL(current).hostname}".`);
      }
      const res = await fetch(current, { signal: ac.signal, redirect: "manual" });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) throw Errors.badRequest(`${providerName} image download failed (redirect without a location).`);
        current = new URL(loc, current).toString(); // re-checked at the top of the next hop
        continue;
      }
      if (!res.ok) throw Errors.badRequest(`${providerName} image download failed (${res.status}) — try again or pick a different photo.`);
      const tooLarge = () => new AppError(413, "too_large", `${providerName} image is larger than the 5 MB asset limit — pick a different photo.`);
      // Reject early on a declared oversize, before reading a single byte.
      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > MAX_IMPORT_BYTES) throw tooLarge();
      // Stream + enforce the cap as bytes arrive, so a missing/lying Content-Length
      // can't make us buffer an unbounded body into memory (S3-L7).
      const reader = res.body?.getReader();
      if (!reader) return Buffer.alloc(0);
      const chunks: Buffer[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_IMPORT_BYTES) {
          ac.abort(); // stop pulling more bytes
          throw tooLarge();
        }
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks);
    }
    throw Errors.badRequest(`${providerName} image download failed (too many redirects).`);
  } finally {
    clearTimeout(timer);
  }
}
