import { createDb, runAuditRetention, runWebhookDeliveryRetention } from "@paperboy/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_DB, type Suite, setupApi } from "./helpers.js";

/**
 * The two append-only log tables must be prunable — the review flagged both as
 * unbounded (audit_log grows per write, webhook_delivery per publish×hook), with
 * the only sweeper being submission retention. Now there are matching sweeps.
 */
describe("log retention (P5)", () => {
  let s: Suite;
  const raw = createDb(TEST_DB);
  const now = new Date("2026-08-01T00:00:00.000Z");
  const old = new Date("2026-01-01T00:00:00.000Z"); // ~212 days before `now`
  const recent = new Date("2026-07-30T00:00:00.000Z"); // 2 days before `now`

  beforeAll(async () => {
    s = await setupApi();
    await raw.sql`insert into audit_log (ts, action) values (${old.toISOString()}::timestamptz, 'test.old'), (${recent.toISOString()}::timestamptz, 'test.recent')`;
    await raw.sql`insert into webhook_delivery (webhook_id, event, ts) values (1, 'e', ${old.toISOString()}::timestamptz), (1, 'e', ${recent.toISOString()}::timestamptz)`;
  });
  afterAll(async () => {
    await raw.sql`delete from audit_log where action like 'test.%'`;
    await raw.sql`delete from webhook_delivery where webhook_id = 1`;
    await s.app.close();
    await raw.sql.end();
  });

  it("audit retention: days=0 keeps everything, a positive window prunes the old row", async () => {
    expect((await runAuditRetention(s.app.db, 0, now)).deleted).toBe(0);
    const cnt = async () => Number(((await raw.sql`select count(*)::int as c from audit_log where action like 'test.%'`) as Array<{ c: number }>)[0]!.c);
    expect(await cnt()).toBe(2);
    const { deleted } = await runAuditRetention(s.app.db, 90, now); // 90d < 212d, so the old row goes
    expect(deleted).toBe(1);
    expect(await cnt()).toBe(1); // the recent one survives
  });

  it("webhook-delivery retention prunes past the window and keeps recent", async () => {
    const { deleted } = await runWebhookDeliveryRetention(s.app.db, 90, now);
    expect(deleted).toBe(1);
    const rows = (await raw.sql`select count(*)::int as c from webhook_delivery where webhook_id = 1`) as Array<{ c: number }>;
    expect(rows[0]!.c).toBe(1);
  });
});
