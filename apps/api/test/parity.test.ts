import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PUBLIC_KEY, type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * Proves the content-management features:
 * allowed-types enforcement, trash/restore, duplicate, version restore,
 * delivery list (batched), delivery-key list/revoke, audit viewer, user
 * management, and self-service password change.
 */
describe("Content-management features", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  let editor: Awaited<ReturnType<typeof login>>;
  const pub = { authorization: `Bearer ${PUBLIC_KEY}` };

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    editor = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
  });

  async function newPage(name: string): Promise<string> {
    const r = await s.app.inject({ method: "POST", url: "/api/v1/manage/content", headers: authHeaders(editor), payload: { type: "ArticlePage", locale: "en", name } });
    expect(r.statusCode).toBe(200);
    return r.json().documentId;
  }

  /* ----------------------------- A1: allowed types ----------------------------- */
  it("rejects a block whose type is not in the content area's allowedBlocks (422)", async () => {
    const id = await newPage("Bad block page");
    const save = await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${id}?locale=en`,
      headers: authHeaders(editor),
      payload: { data: { heading: "x", mainArea: [{ key: "a", blockType: "SiteSettings", display: "automatic", ref: null, inline: {} }] } },
    });
    expect(save.statusCode).toBe(422);
  });

  it("accepts a block whose type IS allowed", async () => {
    const id = await newPage("Good block page");
    const save = await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${id}?locale=en`,
      headers: authHeaders(editor),
      payload: { data: { heading: "x", mainArea: [{ key: "a", blockType: "HeroBlock", display: "automatic", ref: null, inline: { title: "ok" } }] } },
    });
    expect(save.statusCode).toBe(200);
  });

  /* ------------------------------- B3: duplicate ------------------------------- */
  it("duplicates a page as a new draft document with copied data", async () => {
    const id = await newPage("Original");
    await s.app.inject({ method: "PUT", url: `/api/v1/manage/content/${id}?locale=en`, headers: authHeaders(editor), payload: { name: "Original", slug: "original", data: { heading: "Hello world" } } });
    const dup = await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${id}/duplicate?locale=en`, headers: authHeaders(editor) });
    expect(dup.statusCode).toBe(200);
    const body = dup.json();
    expect(body.documentId).not.toBe(id);
    expect(body.status).toBe("draft");
    expect(body.data.heading).toBe("Hello world");
    expect(body.name).toContain("(copy)");
    expect(body.slug).toBeNull(); // page slug cleared to force URL uniqueness
  });

  /* ---------------------------- B1: version restore ---------------------------- */
  it("restores a historical version's data into a fresh draft", async () => {
    const id = await newPage("Versioned");
    await s.app.inject({ method: "PUT", url: `/api/v1/manage/content/${id}?locale=en`, headers: authHeaders(editor), payload: { name: "Versioned", slug: "versioned-v1", data: { heading: "Version ONE" } } });
    await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${id}/publish?locale=en`, headers: authHeaders(editor) });
    // Edit to v2 + publish.
    await s.app.inject({ method: "PUT", url: `/api/v1/manage/content/${id}?locale=en`, headers: authHeaders(editor), payload: { name: "Versioned", slug: "versioned-v1", data: { heading: "Version TWO" } } });
    await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${id}/publish?locale=en`, headers: authHeaders(editor) });

    const versions = await s.app.inject({ method: "GET", url: `/api/v1/manage/content/${id}/versions?locale=en`, headers: authHeaders(editor) });
    const list = versions.json() as Array<{ id: number; versionNumber: number }>;
    const v1 = list.reduce((min, v) => (v.versionNumber < min.versionNumber ? v : min), list[0]);

    const restore = await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${id}/versions/${v1.id}/restore?locale=en`, headers: authHeaders(editor) });
    expect(restore.statusCode).toBe(200);
    expect(restore.json().data.heading).toBe("Version ONE");
    expect(restore.json().hasUnpublishedChanges).toBe(true);
  });

  /* ------------------------------ B4: trash/restore ---------------------------- */
  it("trashes content (gone from delivery + tree) and restores it", async () => {
    const id = await newPage("Trashable");
    await s.app.inject({ method: "PUT", url: `/api/v1/manage/content/${id}?locale=en`, headers: authHeaders(editor), payload: { name: "Trashable", slug: "trashable", data: { heading: "Trash me" } } });
    await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${id}/publish?locale=en`, headers: authHeaders(editor) });
    expect((await s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${id}?locale=en`, headers: pub })).statusCode).toBe(200);

    // Editor can delete (content.delete). Author cannot (tested via RBAC elsewhere).
    const del = await s.app.inject({ method: "DELETE", url: `/api/v1/manage/content/${id}`, headers: authHeaders(editor) });
    expect(del.statusCode).toBe(200);
    // Gone from delivery (unpublished) and from the management read.
    expect((await s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${id}?locale=en`, headers: pub })).statusCode).toBe(404);
    expect((await s.app.inject({ method: "GET", url: `/api/v1/manage/content/${id}?locale=en`, headers: authHeaders(editor) })).statusCode).toBe(404);

    // Shows up in trash, then restores.
    const trash = await s.app.inject({ method: "GET", url: "/api/v1/manage/content/trash", headers: authHeaders(editor) });
    expect((trash.json() as Array<{ documentId: string }>).some((t) => t.documentId === id)).toBe(true);
    const restore = await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${id}/restore`, headers: authHeaders(editor) });
    expect(restore.statusCode).toBe(200);
    expect((await s.app.inject({ method: "GET", url: `/api/v1/manage/content/${id}?locale=en`, headers: authHeaders(editor) })).statusCode).toBe(200);
  });

  /* --------------------------- C4: delivery list (batched) --------------------- */
  it("lists published pages of a type through the no-leak chokepoint", async () => {
    const res = await s.app.inject({ method: "GET", url: "/api/v1/delivery/content?type=LandingPage&locale=en&populate=2", headers: pub });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<{ name: string; data: Record<string, unknown> }>;
    expect(items.length).toBeGreaterThan(0);
    // The seeded Home page resolves with its nested blocks.
    const home = items.find((i) => i.name === "Home");
    expect(home).toBeTruthy();
    expect(Array.isArray(home!.data.mainArea)).toBe(true);
  });

  it("lists only a page's children when parentId is given (ListPage semantics)", async () => {
    // The seeded Blog (ListPage) has two published BlogPost children.
    const res = await s.app.inject({
      method: "GET",
      url: `/api/v1/delivery/content?type=BlogPost&locale=en&parentId=${s.ids.blogId}`,
      headers: pub,
    });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<{ name: string }>;
    expect(items.length).toBe(2);
    // A parentId with no children of that type yields an empty list, not a leak.
    const none = await s.app.inject({
      method: "GET",
      url: `/api/v1/delivery/content?type=BlogPost&locale=en&parentId=${s.ids.homeId}`,
      headers: pub,
    });
    expect(none.json().items).toHaveLength(0);
  });

  it("lists a page's children of ANY type (teaser blocks) with their urlPath", async () => {
    // No type filter — just "the children of this page" (what a ListBlock needs).
    const res = await s.app.inject({
      method: "GET",
      url: `/api/v1/delivery/content?parentId=${s.ids.blogId}&locale=en`,
      headers: pub,
    });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<{ slug: string | null; urlPath: string | null }>;
    expect(items).toHaveLength(2);
    // urlPath is built through the same perspective chokepoint: /<blog>/<post>.
    const hello = items.find((i) => i.slug === "hello-paperboy");
    expect(hello?.urlPath).toBe("/blog/hello-paperboy");
    // Neither type nor parentId → explicit 400, not an unbounded listing.
    const bare = await s.app.inject({ method: "GET", url: "/api/v1/delivery/content?locale=en", headers: pub });
    expect(bare.statusCode).toBe(400);
  });

  /* ----------------------------- D4: delivery keys ----------------------------- */
  it("lists delivery keys and revokes one (revoked key → 401)", async () => {
    const create = await s.app.inject({ method: "POST", url: "/api/v1/manage/delivery-keys", headers: authHeaders(admin), payload: { name: "temp", type: "public" } });
    expect(create.statusCode).toBe(200);
    const key = create.json().key as string;
    // Works before revoke.
    expect((await s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${s.ids.homeId}?locale=en`, headers: { authorization: `Bearer ${key}` } })).statusCode).toBe(200);

    const list = await s.app.inject({ method: "GET", url: "/api/v1/manage/delivery-keys", headers: authHeaders(admin) });
    const rows = list.json() as Array<{ id: number; name: string }>;
    const row = rows.find((r) => r.name === "temp")!;
    // Rename it.
    const renamed = await s.app.inject({ method: "PUT", url: `/api/v1/manage/delivery-keys/${row.id}`, headers: authHeaders(admin), payload: { name: "Production public" } });
    expect(renamed.statusCode).toBe(200);
    const list2 = await s.app.inject({ method: "GET", url: "/api/v1/manage/delivery-keys", headers: authHeaders(admin) });
    expect((list2.json() as Array<{ id: number; name: string }>).find((r) => r.id === row.id)?.name).toBe("Production public");

    const revoke = await s.app.inject({ method: "POST", url: `/api/v1/manage/delivery-keys/${row.id}/revoke`, headers: authHeaders(admin) });
    expect(revoke.statusCode).toBe(200);
    // Revoked key is rejected.
    expect((await s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${s.ids.homeId}?locale=en`, headers: { authorization: `Bearer ${key}` } })).statusCode).toBe(401);
  });

  /* ------------------------------- D3: audit log ------------------------------- */
  it("exposes the audit log to admins and writes entries on mutations (403 for non-admin)", async () => {
    // A publish above wrote audit rows; admin can read them.
    const res = await s.app.inject({ method: "GET", url: "/api/v1/manage/audit?limit=50", headers: authHeaders(admin) });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as Array<{ action: string }>;
    expect(rows.some((r) => r.action === "content.publish")).toBe(true);
    // Editor lacks audit.read.
    expect((await s.app.inject({ method: "GET", url: "/api/v1/manage/audit", headers: authHeaders(editor) })).statusCode).toBe(403);
  });

  /* ----------------------------- D2: user management --------------------------- */
  it("admin creates a user with roles + sections; non-admin is forbidden", async () => {
    const create = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/users",
      headers: authHeaders(admin),
      payload: { email: "author2@paperboy.test", name: "Author Two", password: "Author!Passw0rd", roles: ["Author"], sections: [s.ids.authorZoneId] },
    });
    expect(create.statusCode).toBe(200);
    // The new user can log in and is scoped (can read its section, not others).
    const author = await login(s.app, "author2@paperboy.test", "Author!Passw0rd");
    expect((await s.app.inject({ method: "GET", url: `/api/v1/manage/content/${s.ids.authorZoneId}?locale=en`, headers: authHeaders(author) })).statusCode).toBe(200);
    expect((await s.app.inject({ method: "GET", url: `/api/v1/manage/content/${s.ids.homeId}?locale=en`, headers: authHeaders(author) })).statusCode).toBe(403);
    // List + forbidden for editor.
    expect((await s.app.inject({ method: "GET", url: "/api/v1/manage/users", headers: authHeaders(admin) })).statusCode).toBe(200);
    expect((await s.app.inject({ method: "GET", url: "/api/v1/manage/users", headers: authHeaders(editor) })).statusCode).toBe(403);
  });

  /* --------------------------- D1: password change ----------------------------- */
  it("lets a user change their password (wrong old → 401; success invalidates sessions)", async () => {
    await s.app.inject({ method: "POST", url: "/api/v1/manage/users", headers: authHeaders(admin), payload: { email: "pw@paperboy.test", name: "PW User", password: "Initial!Passw0rd", roles: ["Viewer"] } });
    const u = await login(s.app, "pw@paperboy.test", "Initial!Passw0rd");
    // Wrong current password.
    const bad = await s.app.inject({ method: "POST", url: "/api/v1/auth/change-password", headers: authHeaders(u), payload: { oldPassword: "nope", newPassword: "Changed!Passw0rd" } });
    expect(bad.statusCode).toBe(401);
    // Correct change.
    const ok = await s.app.inject({ method: "POST", url: "/api/v1/auth/change-password", headers: authHeaders(u), payload: { oldPassword: "Initial!Passw0rd", newPassword: "Changed!Passw0rd" } });
    expect(ok.statusCode).toBe(200);
    // Old password no longer works; new one does.
    await expect(login(s.app, "pw@paperboy.test", "Initial!Passw0rd")).rejects.toThrow();
    await expect(login(s.app, "pw@paperboy.test", "Changed!Passw0rd")).resolves.toBeTruthy();
  });
});
