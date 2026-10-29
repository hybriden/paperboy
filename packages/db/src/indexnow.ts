import { eq } from "drizzle-orm";
import { LocalePrefix, normalizePath, parseSeoFilesConfig, sitePath } from "@paperboy/shared";
import type { Database } from "./client.js";
import { deliveryPages } from "./delivery.js";
import { site } from "./schema.js";

/**
 * IndexNow (indexnow.org): tell Bing, Yandex, Seznam, Naver and Yep which public
 * URLs changed, so they recrawl in minutes instead of whenever. Opt-in per site
 * (Settings → Site → Public files mints the key; the frontend proxies
 * GET /delivery/indexnow.txt as its /indexnow.txt) and needs the canonical base URL.
 *
 * Paths are queued by trackUrlChanges (publish, scheduled publish, move,
 * unpublish, trash) and sent per site in one batch a few seconds later, so
 * publishing a subtree is one request. Fire-and-forget: failures are logged.
 * shortcut: the queue is in-process, so a restart drops what is waiting; the
 * sitemap still carries those pages. Fine while the API runs as one replica.
 */
export const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";
const FLUSH_AFTER_MS = 10_000;
const MAX_URLS_PER_REQUEST = 10_000; // the protocol's limit

const pending = new Map<string, Set<string>>(); // siteId → served paths
let scheduled = false;

/** Queue served site paths ("/nb/om-oss") for the next IndexNow batch. */
export function queueIndexNow(db: Database, siteId: string, paths: Iterable<string>): void {
  const set = pending.get(siteId) ?? new Set<string>();
  for (const p of paths) set.add(p);
  if (set.size === 0) return;
  pending.set(siteId, set);
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => void flushIndexNow(db), FLUSH_AFTER_MS).unref();
}

/** Send everything queued now (the timer calls this; tests call it directly). */
export async function flushIndexNow(db: Database): Promise<void> {
  scheduled = false; // a timer still pending after a manual flush finds an empty queue
  const batch = [...pending];
  pending.clear();
  for (const [siteId, paths] of batch) {
    try {
      await submitSite(db, siteId, paths);
    } catch (err) {
      console.error(`[paperboy] IndexNow submission failed for site ${siteId}:`, err);
    }
  }
}

async function submitSite(db: Database, siteId: string, paths: Set<string>): Promise<void> {
  const row = (await db.select().from(site).where(eq(site.id, siteId)).limit(1))[0];
  const key = parseSeoFilesConfig(row?.seoFiles).indexNowKey;
  if (!row?.canonicalBaseUrl || !key) return; // switched off, or no public origin to name
  // A page that asks not to be indexed is not announced (a removed URL still is).
  const scheme = { localePrefix: LocalePrefix.catch("always").parse(row.localePrefix), defaultLocale: row.defaultLocale };
  const { pages } = await deliveryPages(db, "published", siteId);
  const noIndex = new Set(pages.filter((p) => p.noIndex).map((p) => normalizePath(sitePath(p.urlPath, p.locale, scheme))));
  const base = row.canonicalBaseUrl.replace(/\/+$/, "");
  const urls = [...paths].filter((p) => !noIndex.has(normalizePath(p))).map((p) => new URL(`${base}${p}`).href); // percent-encoded, as RFC 3986 asks
  const host = new URL(base).host;
  for (let i = 0; i < urls.length; i += MAX_URLS_PER_REQUEST) {
    const res = await fetch(INDEXNOW_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ host, key, keyLocation: `${base}/indexnow.txt`, urlList: urls.slice(i, i + MAX_URLS_PER_REQUEST) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) console.error(`[paperboy] IndexNow answered ${res.status} for site ${siteId}: ${(await res.text()).slice(0, 200)}`);
  }
}
