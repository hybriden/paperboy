import { createDb } from "@paperboy/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AuthCtx, type Suite, TEST_DB, authHeaders, login, setupApi } from "./helpers.js";

/**
 * The last every-site Admin can't be demoted or deleted: without one, nobody can
 * manage users, sites or content types. The guard counted Admins BEFORE the
 * write's transaction, so two Admins demoting each other at the same moment both
 * saw two and both committed, leaving none.
 */
describe("the last-Admin guard holds under concurrent requests", () => {
  let s: Suite;
  const raw = createDb(TEST_DB, { max: 2 });
  let a: AuthCtx;
  let b: AuthCtx;
  let aId: string;
  let bId: string;
  const PW = "SecondAdmin!Passw0rd";

  const everySiteAdmins = async () => ((await raw.sql`SELECT count(*)::int AS n FROM user_role WHERE role = 'Admin' AND site_id IS NULL`) as Array<{ n: number }>)[0]!.n;
  const demote = (who: AuthCtx, id: string) => s.app.inject({ method: "PUT", url: `/api/v1/manage/users/${id}`, headers: authHeaders(who), payload: { roles: ["Editor"] } });

  beforeAll(async () => {
    s = await setupApi();
    a = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    aId = ((await raw.sql`SELECT id FROM users WHERE email = 'admin@paperboy.test'`) as Array<{ id: string }>)[0]!.id;
    const made = await s.app.inject({ method: "POST", url: "/api/v1/manage/users", headers: authHeaders(a), payload: { email: "admin2@paperboy.test", name: "Second Admin", password: PW, roles: ["Admin"] } });
    expect(made.statusCode, made.body).toBe(200);
    bId = made.json().id as string;
    b = await login(s.app, "admin2@paperboy.test", PW);
  });
  afterAll(async () => {
    await s.app.close();
    await raw.sql.end();
  });

  it("two Admins demoting each other at once leave one Admin", async () => {
    for (let round = 0; round < 5; round++) {
      // Both Admin again before each round.
      await raw.sql`INSERT INTO user_role (user_id, role) VALUES (${aId}, 'Admin'), (${bId}, 'Admin') ON CONFLICT DO NOTHING`;
      await raw.sql`DELETE FROM user_role WHERE site_id IS NULL AND role = 'Editor' AND user_id IN (${aId}, ${bId})`;
      expect(await everySiteAdmins()).toBe(2);
      const codes = (await Promise.all([demote(a, bId), demote(b, aId)])).map((r) => r.statusCode).sort((x, y) => x - y);
      expect(await everySiteAdmins(), `round ${round}: ${codes.join(",")}`).toBe(1);
      expect(codes).toEqual([200, 409]);
    }
  });

  it("demoting the only Admin is still refused", async () => {
    expect(await everySiteAdmins()).toBe(1);
    const [survivorId, survivor] = (await raw.sql`SELECT 1 FROM user_role WHERE user_id = ${aId} AND role = 'Admin' AND site_id IS NULL`).length ? [aId, a] : [bId, b];
    const res = await demote(survivor, survivorId);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().message).toMatch(/last administrator/);
  });
});
