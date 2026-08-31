import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * POST /manage/content silently DROPPED `data`: the request schema had no such
 * property, Zod stripped it, and the route answered 200 with an empty draft —
 * "valid data in → empty draft out" (agent-API rule #1). The MCP create_content
 * tool worked around it by calling updateContent after createContent; the REST
 * route must do the same, through the same coerce/validate chokepoint as PUT.
 */
describe("POST /manage/content with initial data", () => {
  let s: Suite;
  let ed: Awaited<ReturnType<typeof login>>;
  let admin: Awaited<ReturnType<typeof login>>;

  beforeAll(async () => {
    s = await setupApi();
    ed = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
  });

  const create = (payload: Record<string, unknown>) =>
    s.app.inject({ method: "POST", url: "/api/v1/manage/content", headers: authHeaders(ed), payload: { type: "ArticlePage", locale: "en", ...payload } });

  it("persists data (and slug) instead of returning an empty draft", async () => {
    const res = await create({ name: "Filled at birth", slug: "filled-at-birth", data: { heading: "Hello" } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.heading).toBe("Hello");
    expect(res.json().slug).toBe("filled-at-birth");

    const got = await s.app.inject({ method: "GET", url: `/api/v1/manage/content/${res.json().documentId}?locale=en`, headers: authHeaders(ed) });
    expect(got.statusCode).toBe(200);
    expect(got.json().data.heading).toBe("Hello");

    // ONE create, one audit row — the data is written in the same transaction as
    // the shell, not by a second update call (which left a second row and, on a
    // 422, an orphan shell).
    const audit = await s.app.inject({ method: "GET", url: `/api/v1/manage/audit?documentId=${res.json().documentId}`, headers: { cookie: admin.cookie } });
    const rows = audit.json() as Array<{ action: string; detail?: { withData?: boolean } }>;
    expect(rows.map((a) => a.action)).toEqual(["content.create"]);
    expect(rows[0]!.detail?.withData).toBe(true);
  });

  it("refuses invalid data exactly like PUT would (a URL in an image field → 422 naming the field)", async () => {
    const res = await create({ name: "Hotlinked", data: { ogImage: "https://images.unsplash.com/photo-1608742213509?fm=jpg" } });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().message).toContain("ogImage");
    expect(res.json().message).toContain("not a URL");
  });

  it("a 422 inserts NOTHING — no orphan shell is left in the tree", async () => {
    const res = await create({ name: "Orphan probe", data: { ogImage: "https://images.unsplash.com/photo-1608742213509?fm=jpg" } });
    expect(res.statusCode, res.body).toBe(422);
    const tree = await s.app.inject({ method: "GET", url: "/api/v1/manage/content/tree", headers: authHeaders(ed) });
    expect(tree.statusCode).toBe(200);
    expect(JSON.stringify(tree.json())).not.toContain("Orphan probe");
    const pages = (await s.app.inject({ method: "GET", url: "/api/v1/manage/pages", headers: authHeaders(ed) })).json() as Array<{ name: string }>;
    expect(pages.some((p) => p.name === "Orphan probe")).toBe(false);
  });

  it("an unknown field name gets the same verdict as PUT (one chokepoint, not two)", async () => {
    const shell = await create({ name: "Parity probe" });
    const put = await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${shell.json().documentId}?locale=en`,
      headers: authHeaders(ed),
      payload: { merge: true, data: { noSuchField: "x" } },
    });
    const post = await create({ name: "Parity probe 2", data: { noSuchField: "x" } });
    expect(post.statusCode, post.body).toBe(put.statusCode);
  });

  it("a plain create (no data) still returns the empty shell", async () => {
    const res = await create({ name: "Plain" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({});
  });
});
