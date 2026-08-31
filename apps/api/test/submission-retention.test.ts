import { createDb, runSubmissionRetention } from "@paperboy/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_DB, type Suite, setupApi } from "./helpers.js";

/**
 * The hourly submission sweep. It is wired from app.ts and disabled under test,
 * so nothing exercised it: a retention setting that silently does nothing is
 * the Umbraco failure the forms design explicitly refuses to repeat.
 */
describe("submission retention", () => {
  let s: Suite;
  const raw = createDb(TEST_DB);
  const now = new Date("2026-08-01T00:00:00.000Z");
  const past = new Date("2026-07-31T00:00:00.000Z");
  const future = new Date("2026-08-02T00:00:00.000Z");

  beforeAll(async () => {
    s = await setupApi();
    await raw.sql`insert into form_submission (submission_id, site_id, form_id, locale, values, expires_at) values
      ('sub_ret_expired', 'site_default', 'form_ret', 'en', '{}'::jsonb, ${past.toISOString()}::timestamptz),
      ('sub_ret_live', 'site_default', 'form_ret', 'en', '{}'::jsonb, ${future.toISOString()}::timestamptz),
      ('sub_ret_forever', 'site_default', 'form_ret', 'en', '{}'::jsonb, null)`;
  });
  afterAll(async () => {
    await raw.sql`delete from form_submission where form_id = 'form_ret'`;
    await s.app.close();
    await raw.sql.end();
  });

  it("deletes only the rows whose expires_at has passed; a NULL expiry is kept forever", async () => {
    const { deleted } = await runSubmissionRetention(s.app.db, now);
    expect(deleted).toBe(1);
    const left = (await raw.sql`select submission_id from form_submission where form_id = 'form_ret' order by submission_id`) as Array<{ submission_id: string }>;
    expect(left.map((r) => r.submission_id)).toEqual(["sub_ret_forever", "sub_ret_live"]);
  });

  it("is idempotent — a second sweep at the same instant deletes nothing", async () => {
    expect((await runSubmissionRetention(s.app.db, now)).deleted).toBe(0);
  });
});
