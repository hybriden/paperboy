import { z } from "zod";

/**
 * Stock image providers (Unsplash first; pluggable for Pexels/Pixabay later).
 * Pure HTTP client code — no fs/db. The db layer orchestrates import (RBAC,
 * SSRF guard, size cap, sniff) and the API/MCP callers own the file write.
 *
 * Picking a stock image IMPORTS it into the regular asset pipeline (download,
 * not hotlink) so image fields keep their documentId model. Per Unsplash API
 * terms we (a) trigger the download-tracking endpoint on import and (b) keep
 * photographer attribution on the asset (source_meta) and in the picker UI.
 */

export const STOCK_PROVIDERS = ["unsplash"] as const;
export type StockProviderName = (typeof STOCK_PROVIDERS)[number];

/** Attribution kept on imported assets (asset.source_meta). */
export const AssetSourceMeta = z.object({
  provider: z.string(),
  providerId: z.string(),
  credit: z.string(), // photographer name
  creditUrl: z.string(), // photographer profile (UTM-tagged)
  sourceUrl: z.string(), // photo page (UTM-tagged)
  providerName: z.string(), // display name, e.g. "Unsplash"
});
export type AssetSourceMeta = z.infer<typeof AssetSourceMeta>;

/** One search hit, normalized across providers. */
export const StockSearchResult = z.object({
  id: z.string(),
  description: z.string(), // best-effort alt text from the provider
  thumbUrl: z.string(), // small preview for the picker grid
  width: z.number(),
  height: z.number(),
  credit: z.string(),
  creditUrl: z.string(),
  sourceUrl: z.string(),
});
export type StockSearchResult = z.infer<typeof StockSearchResult>;

/** A photo resolved for import: where to download it + the metadata to keep. */
export interface StockResolvedImage {
  downloadUrl: string;
  alt: string;
  sourceMeta: AssetSourceMeta;
}

export interface StockProvider {
  name: StockProviderName;
  displayName: string;
  search(query: string, opts: { apiKey: string; page?: number; perPage?: number }): Promise<StockSearchResult[]>;
  /** Resolve a photo for import. Also fires the provider's download-tracking (Unsplash requirement). */
  resolve(id: string, opts: { apiKey: string }): Promise<StockResolvedImage>;
  /** SSRF defense-in-depth: only download from the provider's own CDN hosts. */
  isDownloadHostAllowed(hostname: string): boolean;
}

const TIMEOUT_MS = 15_000;

/** fetch with an abort timeout, mirroring the AI client. */
async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------------------- Unsplash -------------------------------- */

// Unsplash attribution guideline: link photographer + photo page with UTM tags.
const UTM = "utm_source=paperboy&utm_medium=referral";

function unsplashError(action: string, status: number): Error {
  if (status === 401) return new Error(`Unsplash ${action} failed (401): the access key was rejected — check the key in Settings → Stock images (or UNSPLASH_ACCESS_KEY).`);
  if (status === 403) return new Error(`Unsplash ${action} failed (403): rate limit reached (demo keys allow 50 requests/hour) — wait for the window to reset or upgrade the Unsplash app to production.`);
  if (status === 404) return new Error(`Unsplash ${action} failed (404): photo not found — use an id returned by a stock image search.`);
  return new Error(`Unsplash ${action} failed (${status}) — try again; if it persists, check https://status.unsplash.com.`);
}

interface UnsplashPhoto {
  id: string;
  description?: string | null;
  alt_description?: string | null;
  width: number;
  height: number;
  urls: { regular: string; small: string };
  links: { html: string; download_location: string };
  user: { name: string; links: { html: string } };
}

function unsplashHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Client-ID ${apiKey}`, "Accept-Version": "v1" };
}

function photoMeta(p: UnsplashPhoto): AssetSourceMeta {
  return {
    provider: "unsplash",
    providerId: p.id,
    credit: p.user.name,
    creditUrl: `${p.user.links.html}?${UTM}`,
    sourceUrl: `${p.links.html}?${UTM}`,
    providerName: "Unsplash",
  };
}

const unsplash: StockProvider = {
  name: "unsplash",
  displayName: "Unsplash",

  async search(query, { apiKey, page = 1, perPage = 24 }) {
    const qs = new URLSearchParams({
      query,
      page: String(page),
      per_page: String(perPage),
      content_filter: "high",
    });
    const res = await fetchWithTimeout(`https://api.unsplash.com/search/photos?${qs}`, { headers: unsplashHeaders(apiKey) });
    if (!res.ok) throw unsplashError("search", res.status);
    const data = (await res.json()) as { results?: UnsplashPhoto[] };
    return (data.results ?? []).map((p) => {
      const meta = photoMeta(p);
      return {
        id: p.id,
        description: p.alt_description ?? p.description ?? "",
        thumbUrl: p.urls.small,
        width: p.width,
        height: p.height,
        credit: meta.credit,
        creditUrl: meta.creditUrl,
        sourceUrl: meta.sourceUrl,
      };
    });
  },

  async resolve(id, { apiKey }) {
    const res = await fetchWithTimeout(`https://api.unsplash.com/photos/${encodeURIComponent(id)}`, { headers: unsplashHeaders(apiKey) });
    if (!res.ok) throw unsplashError("photo lookup", res.status);
    const p = (await res.json()) as UnsplashPhoto;
    // Mandatory per Unsplash API terms: trigger download tracking on import.
    // Best-effort — a tracking hiccup must not fail the import itself.
    void fetchWithTimeout(p.links.download_location, { headers: unsplashHeaders(apiKey) }).catch(() => undefined);
    return {
      downloadUrl: p.urls.regular, // ~1080px — well under the 5 MB asset cap
      alt: p.alt_description ?? p.description ?? "",
      sourceMeta: photoMeta(p),
    };
  },

  isDownloadHostAllowed(hostname) {
    return hostname === "unsplash.com" || hostname.endsWith(".unsplash.com");
  },
};

const providers: Record<StockProviderName, StockProvider> = { unsplash };

export function getStockProvider(name: string): StockProvider | null {
  return (providers as Record<string, StockProvider>)[name] ?? null;
}

/* ----------------------------- upload sniffing ----------------------------- */

/**
 * Magic-byte sniff — trust the bytes, not the client-declared mimetype/extension
 * (nor a stock provider's content-type header). Returns the canonical extension
 * + mime, or null if the bytes are not an allowed type. Images (png/jpeg/gif/webp)
 * and PDF documents are supported.
 */
export function sniffUpload(buf: Buffer): { ext: string; mime: string } | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { ext: "png", mime: "image/png" };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: "jpg", mime: "image/jpeg" };
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return { ext: "gif", mime: "image/gif" };
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return { ext: "webp", mime: "image/webp" };
  if (buf.toString("ascii", 0, 5) === "%PDF-") return { ext: "pdf", mime: "application/pdf" };
  return null;
}
