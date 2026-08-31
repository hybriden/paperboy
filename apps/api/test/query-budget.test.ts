import { type AccessContext, createContent, createDb, getAccessContext, updateContent } from "@paperboy/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, TEST_DB, setupApi } from "./helpers.js";

/**
 * Query budgets for the write path. Each case pins a cost that must not grow
 * with the data: sibling-slug allocation used to run one query PER SIBLING per
 * candidate (a 30-child parent cost ~60 round-trips per create), and one save
 * read the content_type table four times over.
 */
describe("write-path query budgets", () => {
  let s: Suite;
  let ctx: AccessContext;
  const queries: string[] = [];
  const counted = createDb(TEST_DB, { logger: { logQuery: (q) => void queries.push(q) } });

  beforeAll(async () => {
    s = await setupApi();
    const users = (await counted.sql`SELECT id FROM users WHERE email = 'admin@paperboy.test'`) as unknown as { id: string }[];
    ctx = await getAccessContext(counted.db, users[0]!.id);
  });
  afterAll(async () => {
    await s.app.close();
    await counted.sql.end();
  });

  async function countQueries(fn: () => Promise<unknown>): Promise<string[]> {
    queries.length = 0;
    await fn();
    return [...queries];
  }

  const page = (name: string, parentId: string | null) => createContent(counted.db, ctx, { type: "ArticlePage", parentId, locale: "en", name });

  it("autoSlug costs the same under 1 sibling as under 30 (one sibling read, not one per sibling)", async () => {
    const small = await page("Budget Small", null);
    await page("Child 1", small.documentId);
    const big = await page("Budget Big", null);
    for (let i = 1; i <= 30; i++) await page(`Child ${i}`, big.documentId);

    // Both collide with an existing "child-1" and settle on "child-1-2".
    const underOne = await countQueries(() => page("Child 1", small.documentId));
    const underThirty = await countQueries(() => page("Child 1", big.documentId));
    expect(underThirty.length, `1 sibling: ${underOne.length} queries, 30 siblings: ${underThirty.length}`).toBe(underOne.length);
  });

  it("one save reads content_type once", async () => {
    const doc = await page("Budget Save", null);
    const q = await countQueries(() => updateContent(counted.db, ctx, doc.documentId, "en", { data: { heading: "x" }, merge: true }));
    const typeReads = q.filter((sql) => sql.includes('"content_type"'));
    expect(typeReads, typeReads.join("\n")).toHaveLength(1);
  });

  it("one create with data reads content_type once", async () => {
    const q = await countQueries(() => createContent(counted.db, ctx, { type: "ArticlePage", parentId: null, locale: "en", name: "Budget Create", data: { heading: "x" } }));
    const typeReads = q.filter((sql) => sql.includes('"content_type"'));
    expect(typeReads, typeReads.join("\n")).toHaveLength(1);
  });
});
