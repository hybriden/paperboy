import { NOT_FOUND_CAP, createDb } from "@paperboy/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PUBLIC_KEY, type Suite, TEST_DB, setupApi } from "./helpers.js";

/**
 * The 404 log is capped per site, but the cap was applied only by the hourly
 * sweep. Between sweeps a holder of the public key could add 100 new paths per
 * request, 600 requests a minute, and the sweep then read every path into
 * memory before trimming. New paths stop at the cap; known ones keep counting.
 */
describe("the 404 log stays under its cap between sweeps", () => {
  let s: Suite;
  const { sql } = createDb(TEST_DB);

  beforeAll(async () => {
    s = await setupApi();
  });
  afterAll(async () => {
    await s.app.close();
    await sql.end();
  });

  const report = (paths: string[]) =>
    s.app.inject({ method: "POST", url: "/api/v1/delivery/traffic", headers: { authorization: `Bearer ${PUBLIC_KEY}` }, payload: { notFound: paths } });
  const stored = async () => ((await sql`select count(*)::int as n from not_found_path where site_id = 'site_default'`) as Array<{ n: number }>)[0]!.n;

  it("refuses new paths at the cap and keeps counting known ones", async () => {
    const batches = Math.ceil(NOT_FOUND_CAP / 100) + 2;
    for (let b = 0; b < batches; b++) {
      const res = await report(Array.from({ length: 100 }, (_, i) => `/missing/${b}/${i}`));
      expect(res.statusCode, res.body).toBe(202);
    }
    expect(await stored()).toBeLessThanOrEqual(NOT_FOUND_CAP);

    const [before] = (await sql`select hits from not_found_path where site_id = 'site_default' and path = '/missing/0/0'`) as Array<{ hits: number }>;
    await report(["/missing/0/0"]);
    const [after] = (await sql`select hits from not_found_path where site_id = 'site_default' and path = '/missing/0/0'`) as Array<{ hits: number }>;
    expect(after!.hits).toBe(before!.hits + 1);
  });
});
