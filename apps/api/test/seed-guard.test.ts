import { createDb, databaseHoldsData, seed } from "@paperboy/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_DB } from "./helpers.js";

/**
 * M3: the destructive-reseed guard must treat a CONTENT-EMPTY but otherwise
 * configured instance (users with hashed passwords, delivery keys, sites) as
 * "holds data" — counting content_item alone would silently wipe a real
 * deployment whose pages happen to be empty.
 */
describe("seed guard — databaseHoldsData covers the TRUNCATE blast radius", () => {
  const { sql } = createDb(TEST_DB);
  beforeAll(async () => {
    await seed(TEST_DB);
  });
  afterAll(async () => {
    await sql.end();
  });

  it("a fully seeded DB holds data", async () => {
    expect(await databaseHoldsData(sql)).toBe(true);
  });

  it("a DB with NO content but real users/keys still holds data", async () => {
    await sql`TRUNCATE content_item, content_version RESTART IDENTITY CASCADE`;
    const contentCount = (await sql`SELECT count(*)::int AS n FROM content_item`)[0] as { n: number };
    expect(contentCount.n).toBe(0); // content is gone…
    expect(await databaseHoldsData(sql)).toBe(true); // …but users/keys remain
  });
});
