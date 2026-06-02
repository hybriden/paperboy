import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, authHeaders, login, setupApi } from "./helpers.js";

describe("RBAC + object-level authorization (IDOR defense)", () => {
  let s: Suite;
  beforeAll(async () => {
    s = await setupApi();
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("blocks the entire Management API for anonymous callers (401)", async () => {
    const res = await s.app.inject({ method: "GET", url: "/api/v1/manage/content/tree" });
    expect(res.statusCode).toBe(401);
  });

  it("Viewer can read but cannot create content (verb RBAC)", async () => {
    const v = await login(s.app, "viewer@paperboy.test", "Viewer!Passw0rd");
    const tree = await s.app.inject({ method: "GET", url: "/api/v1/manage/content/tree", headers: { cookie: v.cookie } });
    expect(tree.statusCode).toBe(200);

    const create = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(v),
      payload: { type: "StandardPage", locale: "en", name: "Nope" },
    });
    expect(create.statusCode).toBe(403);
  });

  it("rejects authenticated mutations missing a CSRF token (403)", async () => {
    const ed = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
    const res = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: { cookie: ed.cookie, origin: "http://localhost:8090" }, // no x-csrf-token
      payload: { type: "StandardPage", locale: "en", name: "x" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("csrf_failed");
  });

  it("Author scoped to Author Zone CANNOT access Home (IDOR / out-of-scope) — 403 not 404", async () => {
    const a = await login(s.app, "author@paperboy.test", "Author!Passw0rd");
    // In scope: author zone is readable.
    const inScope = await s.app.inject({
      method: "GET",
      url: `/api/v1/manage/content/${s.ids.authorZoneId}?locale=en`,
      headers: { cookie: a.cookie },
    });
    expect(inScope.statusCode).toBe(200);

    // Out of scope: Home belongs to a different section -> denied.
    const outOfScope = await s.app.inject({
      method: "GET",
      url: `/api/v1/manage/content/${s.ids.homeId}?locale=en`,
      headers: { cookie: a.cookie },
    });
    expect(outOfScope.statusCode).toBe(403);

    // And the Home node is filtered out of the Author's tree entirely.
    const tree = await s.app.inject({ method: "GET", url: "/api/v1/manage/content/tree", headers: { cookie: a.cookie } });
    const docIds = (tree.json() as Array<{ documentId: string }>).map((n) => n.documentId);
    expect(docIds).toContain(s.ids.authorZoneId);
    expect(docIds).not.toContain(s.ids.homeId);
  });

  it("Author cannot publish (lacks content.publish) even within scope", async () => {
    const a = await login(s.app, "author@paperboy.test", "Author!Passw0rd");
    const res = await s.app.inject({
      method: "POST",
      url: `/api/v1/manage/content/${s.ids.authorZoneId}/publish?locale=en`,
      headers: authHeaders(a),
    });
    expect(res.statusCode).toBe(403);
  });

  it("Editor can create, save and publish (full editorial verbs)", async () => {
    const ed = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(ed),
      payload: { type: "StandardPage", locale: "en", name: "Editor Page" },
    });
    expect(created.statusCode).toBe(200);
    const id = created.json().documentId;
    const saved = await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${id}?locale=en`,
      headers: authHeaders(ed),
      payload: { slug: "editor-page", data: { heading: "Made by editor" } },
    });
    expect(saved.statusCode).toBe(200);
    const published = await s.app.inject({
      method: "POST",
      url: `/api/v1/manage/content/${id}/publish?locale=en`,
      headers: authHeaders(ed),
    });
    expect(published.statusCode).toBe(200);
    expect(published.json().status).toBe("published");
  });
});
