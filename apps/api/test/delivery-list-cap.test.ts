import { MAX_LIST_ITEMS, createDb } from "@paperboy/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PUBLIC_KEY, type Suite, TEST_DB, setupApi } from "./helpers.js";

/**
 * An unpaginated list resolves EVERY item of a type — populate graph and SEO
 * block each — so with no `limit` one public request could pull thousands of
 * documents through the chokepoint. There is deliberately no default page size
 * (that would silently truncate deployed frontends); instead a hard cap refuses
 * the request with the recipe, and pagination reports the total on every page.
 */
describe("delivery list cap", () => {
  let s: Suite;
  const raw = createDb(TEST_DB);
  const pub = { authorization: `Bearer ${PUBLIC_KEY}` };
  const N = MAX_LIST_ITEMS + 1;

  beforeAll(async () => {
    s = await setupApi();
    // Straight SQL: N published ArticlePages in the default site, no per-item API cost.
    await raw.sql`
      INSERT INTO content_item (document_id, type, kind, parent_id, sort_index, section_id, site_id)
      SELECT 'cap' || i, 'ArticlePage', 'page', NULL, i, 'cap' || i, 'site_default' FROM generate_series(1, ${N}) AS i`;
    await raw.sql`
      INSERT INTO content_version (document_id, locale, status, is_current_published, version_number, name, slug, data)
      SELECT 'cap' || i, 'en', 'published', true, 1, 'Cap ' || i, 'cap-' || i, '{"heading":"Cap"}'::jsonb FROM generate_series(1, ${N}) AS i`;
  });
  afterAll(async () => {
    await s.app.close();
    await raw.sql.end();
  });

  it(`refuses an unpaginated list of more than ${MAX_LIST_ITEMS} items with the pagination recipe`, async () => {
    const res = await s.app.inject({ method: "GET", url: "/api/v1/delivery/content?type=ArticlePage", headers: pub });
    expect(res.statusCode, res.body.slice(0, 300)).toBe(400);
    expect(res.json().message).toMatch(/limit/);
  });

  it("the same list paginates fine and still reports the full total", async () => {
    const res = await s.app.inject({ method: "GET", url: "/api/v1/delivery/content?type=ArticlePage&limit=5&offset=0", headers: pub });
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
    expect(res.json().items).toHaveLength(5);
    expect(res.json().total).toBeGreaterThanOrEqual(N);
    expect(res.headers["x-total-count"]).toBe(String(res.json().total));
  });
});
