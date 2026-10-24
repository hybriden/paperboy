import { createDb, deliveryGetByPath } from "@paperboy/db";
import { nanoid } from "nanoid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, TEST_DB, setupApi } from "./helpers.js";

/**
 * Delivery's round trips must not grow with the content. A page used to look
 * up every image, every shared block and every content type one query at a
 * time (68 queries for one real page, ~60 of them repeats); on a managed
 * database each is a network round trip, which is what made on-page editing
 * slow there. The lookups are now batched per level of the graph, so a page
 * with 25 images and 25 shared blocks costs the SAME number of queries as one
 * with 5 of each.
 */
describe("delivery query count does not grow with the number of images and shared blocks", () => {
  let s: Suite;
  let queries = 0;
  // Content type reads are left out: the per-process type cache re-reads a
  // definition when another test file (running in parallel) writes one.
  const counting = createDb(TEST_DB, { logger: { logQuery: (q) => void (/from "content_type"/.test(q) || queries++) } });

  const page = async (n: number): Promise<string> => {
    const sql = counting.sql;
    const slug = `qc-${n}-${nanoid(6).toLowerCase()}`;
    const assets = Array.from({ length: n }, () => nanoid(24));
    for (const a of assets) await sql`insert into asset (document_id, filename, mime, size, url) values (${a}, 'x.png', 'image/png', 1, ${`/uploads/${a}.png`})`;
    const cards: string[] = [];
    for (let i = 0; i < n; i++) {
      const id = nanoid(24);
      cards.push(id);
      await sql`insert into content_item (document_id, type, kind, parent_id, sort_index) values (${id}, 'CardBlock', 'block', null, 0)`;
      await sql`insert into content_version (document_id, locale, status, is_current_published, version_number, name, slug, data) values (${id}, 'en', 'published', true, 1, ${`Card ${i}`}, null, ${JSON.stringify({ title: `Card ${i}` })}::jsonb)`;
    }
    const pageId = nanoid(24);
    const mainArea = [
      ...assets.map((a, i) => ({ key: `h${i}`, blockType: "HeroBlock", display: "full", ref: null, inline: { title: `Hero ${i}`, heroImage: a } })),
      ...cards.map((c, i) => ({ key: `c${i}`, blockType: "CardBlock", display: "narrow", ref: c, inline: null })),
    ];
    await sql`insert into content_item (document_id, type, kind, parent_id, sort_index) values (${pageId}, 'LandingPage', 'page', null, 99)`;
    await sql`insert into content_version (document_id, locale, status, is_current_published, version_number, name, slug, data) values (${pageId}, 'en', 'published', true, 1, ${slug}, ${slug}, ${JSON.stringify({ heading: slug, mainArea })}::jsonb)`;
    return slug;
  };
  const count = async (fn: () => Promise<unknown>): Promise<number> => {
    queries = 0;
    await fn();
    return queries;
  };

  beforeAll(async () => {
    s = await setupApi();
  });
  afterAll(async () => {
    await counting.sql.end();
    await s.app.close();
  });

  it("a page with 25 images and 25 shared blocks costs what one with 5 does", async () => {
    const small = await page(5);
    const large = await page(25);
    const deliver = (slug: string) => deliveryGetByPath(counting.db, "published", "site_default", [slug], "en", 2);
    const delivered = (await deliver(large)) as { data: { mainArea: Array<{ data?: { heroImage?: { url?: string } }; content?: { data?: { title?: string } } }> } };
    expect(delivered.data.mainArea).toHaveLength(50);
    expect(delivered.data.mainArea[0]!.data!.heroImage!.url).toMatch(/\/uploads\//);
    expect(delivered.data.mainArea[25]!.content!.data!.title).toBe("Card 0");
    const qSmall = await count(() => deliver(small));
    const qLarge = await count(() => deliver(large));
    expect(qLarge).toBe(qSmall);
    // Headroom, not an exact pin: a handful of batched queries plus the path lookup.
    expect(qLarge).toBeLessThanOrEqual(20);
  });

});
