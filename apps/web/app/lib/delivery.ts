import type { DeliveryContent } from "@paperboy/shared";

const API = process.env.PAPERBOY_API_URL ?? "http://localhost:8091";
const PUBLIC_KEY = process.env.PAPERBOY_PUBLIC_KEY ?? "pk_live_seed_public_key_value";
const PREVIEW_KEY = process.env.PAPERBOY_PREVIEW_KEY ?? "prv_seed_preview_key_value";

/**
 * Two-token model: the published site uses the PUBLIC key; preview/draft mode
 * uses the PREVIEW key. The preview key is only ever used server-side here.
 */
async function fetchKeyed(url: string, preview: boolean): Promise<DeliveryContent | null> {
  const key = preview ? PREVIEW_KEY : PUBLIC_KEY;
  const res = await fetch(url, { headers: { authorization: `Bearer ${key}` }, cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Delivery API ${res.status}`);
  return (await res.json()) as DeliveryContent;
}

export async function fetchBySlug(slug: string, locale: string, preview: boolean): Promise<DeliveryContent | null> {
  return fetchKeyed(
    `${API}/api/v1/delivery/content/by-slug?slug=${encodeURIComponent(slug)}&locale=${encodeURIComponent(locale)}&populate=2`,
    preview,
  );
}

/** Resolve a hierarchical URL path (e.g. "/about/team") built from the page tree. */
export async function fetchByPath(path: string, locale: string, preview: boolean): Promise<DeliveryContent | null> {
  return fetchKeyed(
    `${API}/api/v1/delivery/content/by-path?path=${encodeURIComponent(path)}&locale=${encodeURIComponent(locale)}&populate=2`,
    preview,
  );
}

/** The configured start page (served at "/" and "/{locale}"). */
export async function fetchStart(locale: string, preview: boolean): Promise<DeliveryContent | null> {
  return fetchKeyed(
    `${API}/api/v1/delivery/start?locale=${encodeURIComponent(locale)}&populate=2`,
    preview,
  );
}

/** List delivered content of a type and/or the children of a page (ListPage, teaser blocks). */
export async function fetchList(type: string | null, locale: string, preview: boolean, parentId?: string): Promise<DeliveryContent[]> {
  const key = preview ? PREVIEW_KEY : PUBLIC_KEY;
  const params = new URLSearchParams({ locale, populate: "0" });
  if (type) params.set("type", type);
  if (parentId) params.set("parentId", parentId);
  const res = await fetch(`${API}/api/v1/delivery/content?${params}`, {
    headers: { authorization: `Bearer ${key}` },
    cache: "no-store",
  });
  if (!res.ok) return [];
  const body = (await res.json()) as { items?: DeliveryContent[] } | DeliveryContent[];
  return Array.isArray(body) ? body : (body.items ?? []);
}
