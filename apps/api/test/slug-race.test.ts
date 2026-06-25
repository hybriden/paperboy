import { type AccessContext, createContent, createDb, getAccessContext } from "@paperboy/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, TEST_DB, setupApi } from "./helpers.js";

/**
 * S2-M9: sibling URL-segment uniqueness was an app-level check-then-act (autoSlug
 * scans committed siblings, then inserts) with no lock — concurrent creates of the
 * same name all saw the slug free and committed colliding segments, leaving one
 * sibling unreachable. The create now runs in a tx behind a per-(site,parent,locale)
 * advisory lock, so concurrent creates allocate distinct slugs (about, about-2, …).
 */
describe("createContent — concurrent same-name siblings get distinct slugs", () => {
  let s: Suite;
  const raw = createDb(TEST_DB);
  let ctx: AccessContext;

  beforeAll(async () => {
    s = await setupApi();
    const rows = (await raw.sql`SELECT id FROM users WHERE email='admin@paperboy.test' LIMIT 1`) as Array<{ id: string }>;
    ctx = await getAccessContext(s.app.db, rows[0]!.id);
  });
  afterAll(async () => {
    await s.app.close();
    await raw.sql.end();
  });

  it("6 concurrent root creates of the same name yield 6 distinct slugs", async () => {
    const N = 6;
    const created = await Promise.all(
      Array.from({ length: N }, () => createContent(s.app.db, ctx, { type: "LandingPage", locale: "en", name: "Race Page", parentId: null })),
    );
    const slugs: Array<string | null> = [];
    for (const c of created) {
      const row = (await raw.sql`SELECT slug FROM content_version WHERE document_id=${c.documentId} AND locale='en' LIMIT 1`) as Array<{ slug: string | null }>;
      slugs.push(row[0]?.slug ?? null);
    }
    expect(new Set(slugs).size).toBe(N); // all distinct — no collision
  });
});
