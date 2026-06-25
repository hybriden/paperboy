import { type AccessContext, createContent, getAccessContext, loadAuthorized, moveContent } from "@paperboy/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, login, setupApi } from "./helpers.js";

/**
 * S2-M10: the reparent acyclicity walk ran OUTSIDE the mutating transaction with no
 * lock, so two opposing concurrent reparents ("move X under Y" + "move Y under X")
 * could both pass the check and commit a parent cycle. The check now runs inside the
 * tx under a per-site advisory lock, so exactly one wins and no cycle forms.
 */
describe("moveContent — concurrent opposing reparents cannot form a cycle", () => {
  let s: Suite;
  let ctx: AccessContext;

  beforeAll(async () => {
    s = await setupApi();
    const admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    const users = (await s.app.inject({ method: "GET", url: "/api/v1/manage/users", headers: { cookie: admin.cookie } })).json() as Array<{ id: string; email: string }>;
    ctx = await getAccessContext(s.app.db, users.find((u) => u.email === "admin@paperboy.test")!.id);
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("two opposing reparents settle with no parent cycle (exactly one wins)", async () => {
    const x = (await createContent(s.app.db, ctx, { type: "LandingPage", locale: "en", name: "X root", parentId: null })).documentId;
    const y = (await createContent(s.app.db, ctx, { type: "LandingPage", locale: "en", name: "Y root", parentId: null })).documentId;

    const results = await Promise.allSettled([
      moveContent(s.app.db, ctx, x, { parentId: y }),
      moveContent(s.app.db, ctx, y, { parentId: x }),
    ]);

    const px = (await loadAuthorized(s.app.db, ctx, x)).parentId;
    const py = (await loadAuthorized(s.app.db, ctx, y)).parentId;

    expect(px === y && py === x).toBe(false); // no 2-node cycle
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1); // one move rejected
  });
});
