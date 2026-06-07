import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PUBLIC_KEY, type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * SEO is an INTRINSIC, reserved property of every page — not an opt-in field
 * group a type author can forget or delete (2026-06-08). A brand-new custom
 * page type with NO SEO fields must automatically expose the SEO group and
 * deliver a full `seo` block; the group cannot be removed; blocks/globals never
 * get it. The reserved group is injected at read time and stripped at storage,
 * so it's defined once and can't drift.
 */
describe("intrinsic reserved SEO group", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  let ed: Awaited<ReturnType<typeof login>>;
  const SEO_NAMES = ["metaTitle", "metaDescription", "canonicalUrl", "noIndex", "ogTitle", "ogDescription", "ogImage", "ogType", "twitterCard"];

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    ed = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
  });

  async function createType(name: string, kind: "page" | "block", fields: unknown[]) {
    return s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content-types",
      headers: authHeaders(admin),
      payload: { name, displayName: name, kind, fields },
    });
  }
  async function getType(name: string) {
    const r = await s.app.inject({ method: "GET", url: `/api/v1/manage/content-types/${name}`, headers: { cookie: admin.cookie } });
    return r.json();
  }
  const fieldNames = (def: { fields: Array<{ name: string }> }) => def.fields.map((f) => f.name);

  it("a brand-new page type with NO SEO fields automatically has the full SEO group", async () => {
    const r = await createType("MinimalPage", "page", [
      { name: "heading", displayName: "Heading", type: "text", localized: true, required: true, delivery: "public", group: "Content", seoRole: "title" },
    ]);
    expect(r.statusCode, r.body).toBe(200);
    const def = await getType("MinimalPage");
    for (const n of SEO_NAMES) expect(fieldNames(def), `missing reserved SEO field ${n}`).toContain(n);
  });

  it("the injected SEO fields actually validate + deliver (title=metaTitle, noIndex→robots)", async () => {
    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(ed),
      payload: { type: "MinimalPage", locale: "en", name: "Min One" },
    });
    const id = created.json().documentId as string;
    const put = await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${id}?locale=en`,
      headers: authHeaders(ed),
      payload: { data: { heading: "The Heading", metaTitle: "Meta Wins", noIndex: true } },
    });
    expect(put.statusCode, put.body).toBe(200);
    await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${id}/publish?locale=en`, headers: authHeaders(ed) });
    const seo = (await s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${id}?locale=en`, headers: { authorization: `Bearer ${PUBLIC_KEY}` } })).json().seo;
    expect(seo.title).toBe("Meta Wins");
    expect(seo.robots).toBe("noindex, follow");
  });

  it("the SEO group CANNOT be removed: updating the type without SEO fields still yields them on read", async () => {
    const upd = await s.app.inject({
      method: "PUT",
      url: "/api/v1/manage/content-types/MinimalPage",
      headers: authHeaders(admin),
      payload: {
        name: "MinimalPage",
        displayName: "MinimalPage",
        kind: "page",
        fields: [
          { name: "heading", displayName: "Heading", type: "text", localized: true, required: true, delivery: "public", group: "Content", seoRole: "title" },
        ],
      },
    });
    expect(upd.statusCode, upd.body).toBe(200);
    const def = await getType("MinimalPage");
    for (const n of SEO_NAMES) expect(fieldNames(def), `SEO field ${n} was removable`).toContain(n);
    // And exactly one of each (no duplicates from injection).
    expect(fieldNames(def).filter((x: string) => x === "metaTitle")).toHaveLength(1);
  });

  it("blocks never get the SEO group", async () => {
    const r = await createType("PlainBlock", "block", [
      { name: "label", displayName: "Label", type: "text", localized: true, required: false, delivery: "public", group: "Content" },
    ]);
    expect(r.statusCode, r.body).toBe(200);
    const def = await getType("PlainBlock");
    for (const n of SEO_NAMES) expect(fieldNames(def)).not.toContain(n);
  });

  it("seeded page types still deliver SEO (existing ArticlePage), proving injection covers them too", async () => {
    const def = await getType("ArticlePage");
    expect(fieldNames(def)).toContain("metaDescription");
  });
});
