import { type AccessContext, createContent, getAccessContext } from "@paperboy/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, login, setupApi } from "./helpers.js";

/**
 * S2-M9: sibling URL-segment uniqueness was an app-level check-then-act (autoSlug
 * scans committed siblings, then inserts) with no lock — concurrent creates of the
 * same name all saw the slug free and committed colliding segments, leaving one
 * sibling unreachable. The create now runs in a tx behind a per-(site,parent,locale)
 * advisory lock, so concurrent creates allocate distinct slugs (about, about-2, …).
 */
describe("createContent — concurrent same-name siblings get distinct slugs", () => {
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

  it("6 concurrent root creates of the same name yield 6 distinct slugs", async () => {
    const N = 6;
    const created = await Promise.all(
      Array.from({ length: N }, () => createContent(s.app.db, ctx, { type: "LandingPage", locale: "en", name: "Race Page", parentId: null })),
    );
    const slugs = created.map((c) => c.slug);
    expect(new Set(slugs).size).toBe(N); // all distinct — no collision
  });
});
