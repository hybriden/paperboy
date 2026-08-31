import { type AccessContext, createContent, getAccessContext } from "@paperboy/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, authHeaders, login, setupApi } from "./helpers.js";

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

/**
 * The same TOCTOU on every OTHER path that writes a page's URL segment: save,
 * restore, publish and move all checked sibling uniqueness and then wrote without
 * the per-(site, parent, locale) lock create takes, so two concurrent writers both
 * saw the segment free and both committed it — one page unreachable, no 409.
 */
describe("sibling slug uniqueness holds under concurrent saves and moves", () => {
  let s: Suite;
  let ed: Awaited<ReturnType<typeof login>>;

  beforeAll(async () => {
    s = await setupApi();
    ed = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
  });

  async function createPage(name: string, parentId: string | null, slug?: string): Promise<string> {
    const res = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(ed),
      payload: { type: "LandingPage", locale: "en", name, parentId, ...(slug ? { slug } : {}) },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().documentId as string;
  }

  it("6 concurrent saves of sibling pages to the same slug leave exactly one winner (the rest 409)", async () => {
    const N = 6;
    const ids = await Promise.all(Array.from({ length: N }, (_, i) => createPage(`Save Race ${i}`, null)));
    const codes = (
      await Promise.all(
        ids.map((id) =>
          s.app.inject({ method: "PUT", url: `/api/v1/manage/content/${id}?locale=en`, headers: authHeaders(ed), payload: { slug: "save-race-shared", data: {} } }),
        ),
      )
    ).map((r) => r.statusCode);
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(N - 1);
  });

  it("4 concurrent moves of same-slug pages under one parent leave exactly one there (the rest 409)", async () => {
    const N = 4;
    const target = await createPage("Move Race Target", null);
    const movers = await Promise.all(
      Array.from({ length: N }, async (_, i) => createPage("Dup", await createPage(`Move Race Parent ${i}`, null), "dup")),
    );
    const codes = (
      await Promise.all(
        movers.map((id) => s.app.inject({ method: "POST", url: `/api/v1/manage/content/${id}/move`, headers: authHeaders(ed), payload: { parentId: target } })),
      )
    ).map((r) => r.statusCode);
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(N - 1);
    const tree = await s.app.inject({ method: "GET", url: `/api/v1/manage/content/tree?parentId=${target}`, headers: { cookie: ed.cookie } });
    expect((tree.json() as Array<{ documentId: string }>).map((n) => n.documentId)).toHaveLength(1);
  });
});
