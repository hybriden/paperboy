import { type ContentTypeDef, parseStoredContentTypeDef } from "@paperboy/shared";
import { asc, inArray, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { contentType } from "./schema.js";

/**
 * Every content type, parsed, shared by the requests of this process. Each call
 * still asks the database what is current, but only for each row's name, kind
 * and xmin (a few bytes, where the definitions are ~160 kB of JSON to parse and
 * validate); a definition is re-read only when its xmin moved (any write
 * changes it, from this process or another, e.g. the MCP server). A row gone
 * from the table is gone from the result. Cached definitions are frozen, so
 * nothing can change one for the next caller.
 */
const parsed = new WeakMap<Database, Map<string, { xmin: string; def: ContentTypeDef }>>();

export interface CurrentType {
  name: string;
  kind: string;
  /** null = shared by every site. */
  siteId: string | null;
  def: ContentTypeDef;
}

/** The types a site can use: the shared ones plus its own. */
export function visibleIn<T extends { siteId: string | null }>(types: T[], siteId: string): T[] {
  return types.filter((t) => t.siteId === null || t.siteId === siteId);
}

/** All content types in name order (the database's collation, as before). */
export async function currentContentTypes(db: Database): Promise<CurrentType[]> {
  let cache = parsed.get(db);
  if (!cache) parsed.set(db, (cache = new Map()));
  const rows = await db
    .select({ name: contentType.name, kind: contentType.kind, siteId: contentType.siteId, xmin: sql<string>`xmin::text` })
    .from(contentType)
    .orderBy(asc(contentType.name));
  const stale = rows.filter((r) => cache.get(r.name)?.xmin !== r.xmin);
  if (stale.length) {
    const defs = await db
      .select({ name: contentType.name, definition: contentType.definition })
      .from(contentType)
      .where(inArray(contentType.name, stale.map((r) => r.name)));
    const xminOf = new Map(stale.map((r) => [r.name, r.xmin]));
    // Same normalization everywhere (the reserved SEO group injected for page
    // kinds), so a def read here validates, coerces and delivers alike.
    for (const d of defs) cache.set(d.name, { xmin: xminOf.get(d.name)!, def: deepFreeze(parseStoredContentTypeDef(d.definition)) });
  }
  const out: CurrentType[] = [];
  for (const r of rows) {
    const hit = cache.get(r.name);
    if (hit) out.push({ name: r.name, kind: r.kind, siteId: r.siteId, def: hit.def });
  }
  return out;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}
