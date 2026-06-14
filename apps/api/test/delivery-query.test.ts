import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PREVIEW_KEY, PUBLIC_KEY, type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * Delivery query layer: pagination, sorting, data-field filters and full-text
 * search — all resolved through the no-leak chokepoint (draft text must never
 * be findable under the public key, even as a match signal).
 */

describe("Delivery: list pagination/sorting/filters + full-text search", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  let blogId: string;
  const posts: string[] = [];

  async function createPost(name: string, data: Record<string, unknown>, publish = true): Promise<string> {
    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(admin),
      payload: { type: "BlogPost", parentId: blogId, locale: "en", name },
    });
    expect(created.statusCode).toBe(200);
    const id = created.json().documentId as string;
    await s.app.inject({ method: "PUT", url: `/api/v1/manage/content/${id}?locale=en`, headers: authHeaders(admin), payload: { data } });
    if (publish) {
      const pub = await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${id}/publish?locale=en`, headers: authHeaders(admin) });
      expect(pub.statusCode).toBe(200);
    }
    return id;
  }

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    blogId = s.ids.blogId;
    // Distinct, sortable, filterable corpus (on top of the 2 seeded posts).
    posts.push(await createPost("Alpha", { title: "Alpha", author: "Jane", publishDate: "2026-01-03T00:00:00Z", body: "the zebrasearchtoken lives here" }));
    posts.push(await createPost("Bravo", { title: "Bravo", author: "Jane", publishDate: "2026-01-01T00:00:00Z", body: "nothing special" }));
    posts.push(await createPost("Charlie", { title: "Charlie", author: "Ola", publishDate: "2026-01-02T00:00:00Z", body: "nothing special" }));
  });
  afterAll(async () => {
    await s.app.close();
  });

  const pub = { authorization: `Bearer ${PUBLIC_KEY}` };
  const prev = { authorization: `Bearer ${PREVIEW_KEY}` };

  it("paginates with limit/offset, reports total in body and X-Total-Count", async () => {
    const all = await s.app.inject({ method: "GET", url: "/api/v1/delivery/content?type=BlogPost", headers: pub });
    expect(all.statusCode).toBe(200);
    const total = all.json().total as number;
    expect(total).toBeGreaterThanOrEqual(5); // 2 seeded + 3 created
    expect(all.json().items.length).toBe(total); // no limit = back-compat full list

    const page = await s.app.inject({ method: "GET", url: "/api/v1/delivery/content?type=BlogPost&limit=2&offset=1", headers: pub });
    expect(page.json().items.length).toBe(2);
    expect(page.json().total).toBe(total); // total ignores pagination
    expect(page.headers["x-total-count"]).toBe(String(total));
  });

  it("sorts by data.<field> descending and by name ascending", async () => {
    const byDate = await s.app.inject({ method: "GET", url: "/api/v1/delivery/content?type=BlogPost&sort=-data.publishDate&limit=3", headers: pub });
    const dates = (byDate.json().items as Array<{ data: { publishDate?: string } }>).map((i) => i.data.publishDate).filter(Boolean);
    expect(dates).toEqual([...dates].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).reverse());

    const byName = await s.app.inject({ method: "GET", url: "/api/v1/delivery/content?type=BlogPost&sort=name", headers: pub });
    const names = (byName.json().items as Array<{ name: string }>).map((i) => i.name);
    expect(names).toEqual([...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });

  it("rejects an invalid sort key (422)", async () => {
    const res = await s.app.inject({ method: "GET", url: "/api/v1/delivery/content?type=BlogPost&sort=data.x;DROP", headers: pub });
    expect(res.statusCode).toBe(422);
  });

  it("filters by data field equality (data.author=Jane)", async () => {
    const res = await s.app.inject({ method: "GET", url: "/api/v1/delivery/content?type=BlogPost&data.author=Jane", headers: pub });
    const items = res.json().items as Array<{ data: { author?: string } }>;
    expect(items.length).toBe(2);
    expect(items.every((i) => i.data.author === "Jane")).toBe(true);
    expect(res.json().total).toBe(2);
  });

  it("full-text search finds published content by body text", async () => {
    const res = await s.app.inject({ method: "GET", url: "/api/v1/delivery/search?q=zebrasearchtoken", headers: pub });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<{ documentId: string }>;
    expect(items.some((i) => i.documentId === posts[0])).toBe(true);
  });

  it("NO-LEAK: draft-only text is not searchable under the public key, but is under preview", async () => {
    // Add a draft on top of the published Bravo post with a unique token.
    await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${posts[1]}?locale=en`,
      headers: authHeaders(admin),
      payload: { data: { body: "contains the quaggadrafttoken now" } },
    });
    const pubSearch = await s.app.inject({ method: "GET", url: "/api/v1/delivery/search?q=quaggadrafttoken", headers: pub });
    expect((pubSearch.json().items as unknown[]).length).toBe(0);

    const prevSearch = await s.app.inject({ method: "GET", url: "/api/v1/delivery/search?q=quaggadrafttoken", headers: prev });
    expect((prevSearch.json().items as Array<{ documentId: string }>).some((i) => i.documentId === posts[1])).toBe(true);
  });

  it("search restricts by type and respects limit", async () => {
    const res = await s.app.inject({ method: "GET", url: "/api/v1/delivery/search?q=nothing+special&type=BlogPost&limit=1", headers: pub });
    expect(res.statusCode).toBe(200);
    expect((res.json().items as unknown[]).length).toBeLessThanOrEqual(1);
  });

  it("search requires an API key", async () => {
    const res = await s.app.inject({ method: "GET", url: "/api/v1/delivery/search?q=anything" });
    expect(res.statusCode).toBe(401);
  });
});
