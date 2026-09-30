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

/**
 * Audit 2026-09-30: databaseHoldsData caught EVERY error and answered "fresh
 * database", after which the CLI TRUNCATEs everything. On a populated database
 * a statement/lock timeout or a permission error during the count therefore led
 * straight to a full wipe. Only "table does not exist" (42P01) means fresh.
 */
describe("seed guard — only a missing table means 'fresh'", () => {
  const failing = (code: string) =>
    (async () => {
      throw Object.assign(new Error(`simulated ${code}`), { code });
    }) as unknown as Parameters<typeof databaseHoldsData>[0];

  it("a statement timeout is an error, never 'safe to wipe'", async () => {
    await expect(databaseHoldsData(failing("57014"))).rejects.toThrow(/57014/);
  });

  it("a permission error is an error, never 'safe to wipe'", async () => {
    await expect(databaseHoldsData(failing("42501"))).rejects.toThrow(/42501/);
  });

  it("an absent table still means a fresh database", async () => {
    await expect(databaseHoldsData(failing("42P01"))).resolves.toBe(false);
  });
});
