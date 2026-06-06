import { createClient } from "@paperboy/client";
import type { DeliveryContent } from "@paperboy/shared";

const API = process.env.PAPERBOY_API_URL ?? "http://localhost:8091";
const PUBLIC_KEY = process.env.PAPERBOY_PUBLIC_KEY ?? "pk_live_seed_public_key_value";
const PREVIEW_KEY = process.env.PAPERBOY_PREVIEW_KEY ?? "prv_seed_preview_key_value";

/**
 * Two-token model via @paperboy/client: the published site uses the PUBLIC
 * key; preview/draft mode uses the PREVIEW key (server-side only). Next.js
 * caches fetch aggressively — `no-store` keeps drafts and fresh publishes live.
 */
const published = createClient({ baseUrl: API, key: PUBLIC_KEY, fetchInit: { cache: "no-store" } });
const preview = createClient({ baseUrl: API, key: PREVIEW_KEY, fetchInit: { cache: "no-store" } });
const cms = (usePreview: boolean) => (usePreview ? preview : published);

export async function fetchBySlug(slug: string, locale: string, preview: boolean): Promise<DeliveryContent | null> {
  return cms(preview).getBySlug(slug, { locale, populate: 2 });
}

/** Resolve a hierarchical URL path (e.g. "/about/team") built from the page tree. */
export async function fetchByPath(path: string, locale: string, preview: boolean): Promise<DeliveryContent | null> {
  return cms(preview).getByPath(path, { locale, populate: 2 });
}

/** The configured start page (served at "/" and "/{locale}"). */
export async function fetchStart(locale: string, preview: boolean): Promise<DeliveryContent | null> {
  return cms(preview).startPage({ locale, populate: 2 });
}

/** List delivered content of a type and/or the children of a page (ListPage, teaser blocks). */
export async function fetchList(type: string | null, locale: string, preview: boolean, parentId?: string): Promise<DeliveryContent[]> {
  try {
    const { items } = await cms(preview).list(type, { locale, populate: 0, parentId });
    return items;
  } catch {
    return []; // listing is decorative on this reference frontend — degrade quietly
  }
}
