import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PUBLIC_KEY, type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * Declared child ordering (childSort) on container pages.
 *
 * Motivating state (found live 2026-08-04): a blog container with 58 automated
 * posts where nothing ever assigned sortIndex — every child sat at 0, so the
 * admin tree listed them by insertion id, oldest first (newest post #58 of 58),
 * while both frontends overrode the order client-side. Nobody owned the order.
 *
 * The rule lives on the container as data ("manual" | "name" | "createdAt" |
 * "data.<field>", "-" prefix = descending): the tree follows it, delivery's
 * default order follows it (explicit ?sort= still wins), and new children
 * APPEND (sortIndex = max+1) so a curated manual order isn't undermined by the
 * next create.
 */

describe("Container childSort: tree + delivery follow the declared rule", () => {
  let s: Suite;
  let ed: Awaited<ReturnType<typeof login>>;

  beforeAll(async () => {
    s = await setupApi();
    ed = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
  });

  /** Create a page (ArticlePage unless given) and return its documentId. */
  async function createPage(name: string, parentId: string | null, type = "ArticlePage"): Promise<string> {
    const res = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(ed),
      payload: { type, locale: "en", name, parentId },
    });
    expect(res.statusCode).toBe(200);
    return res.json().documentId as string;
  }

  const setRule = (documentId: string, childSort: string, auth: Awaited<ReturnType<typeof login>> = ed) =>
    s.app.inject({ method: "POST", url: `/api/v1/manage/content/${documentId}/child-sort`, headers: authHeaders(auth), payload: { childSort } });

  /** Child names under a parent, in tree order. */
  async function treeOrder(parentId: string): Promise<string[]> {
    const res = await s.app.inject({ method: "GET", url: `/api/v1/manage/content/tree?parentId=${parentId}`, headers: { cookie: ed.cookie } });
    expect(res.statusCode).toBe(200);
    return (res.json() as Array<{ name: string }>).map((n) => n.name);
  }

  it("new children APPEND: creation order is the tree order, sortIndex strictly increases", async () => {
    const parent = await createPage("Append Container", null);
    await createPage("First", parent);
    await createPage("Second", parent);
    await createPage("Third", parent);
    expect(await treeOrder(parent)).toEqual(["First", "Second", "Third"]);

    const detail = async (name: string) => {
      const tree = await s.app.inject({ method: "GET", url: `/api/v1/manage/content/tree?parentId=${parent}`, headers: { cookie: ed.cookie } });
      return (tree.json() as Array<{ name: string; sortIndex: number }>).find((n) => n.name === name)!.sortIndex;
    };
    const [a, b, c] = [await detail("First"), await detail("Second"), await detail("Third")];
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
  });

  it("the tree follows the declared rule, and 'manual' restores tree order", async () => {
    const parent = await createPage("Sorted Container", null);
    await createPage("Banana", parent);
    await createPage("Apple", parent);
    await createPage("Cherry", parent);

    expect((await setRule(parent, "name")).statusCode).toBe(200);
    expect(await treeOrder(parent)).toEqual(["Apple", "Banana", "Cherry"]);

    expect((await setRule(parent, "-name")).statusCode).toBe(200);
    expect(await treeOrder(parent)).toEqual(["Cherry", "Banana", "Apple"]);

    expect((await setRule(parent, "-createdAt")).statusCode).toBe(200);
    expect(await treeOrder(parent)).toEqual(["Cherry", "Apple", "Banana"]);

    expect((await setRule(parent, "manual")).statusCode).toBe(200);
    expect(await treeOrder(parent)).toEqual(["Banana", "Apple", "Cherry"]);
  });

  it("the tree exposes each node's childSort (seeded Blog declares -data.publishDate)", async () => {
    const res = await s.app.inject({ method: "GET", url: "/api/v1/manage/content/tree", headers: { cookie: ed.cookie } });
    const blog = (res.json() as Array<{ documentId: string; childSort: string }>).find((n) => n.documentId === s.ids.blogId);
    expect(blog?.childSort).toBe("-data.publishDate");
  });

  it("delivery default order follows the container rule; explicit ?sort= still wins", async () => {
    // Seeded blog: hello-paperboy (2026-01-15) and modelling-listings (2026-02-02),
    // tree order oldest-first — the declared -data.publishDate must flip it.
    const pub = { authorization: `Bearer ${PUBLIC_KEY}` };
    const byRule = await s.app.inject({ method: "GET", url: `/api/v1/delivery/content?parentId=${s.ids.blogId}&locale=en`, headers: pub });
    expect(byRule.statusCode).toBe(200);
    expect((byRule.json().items as Array<{ slug: string }>).map((i) => i.slug)).toEqual(["modelling-listings", "hello-paperboy"]);

    const explicit = await s.app.inject({ method: "GET", url: `/api/v1/delivery/content?parentId=${s.ids.blogId}&locale=en&sort=data.publishDate`, headers: pub });
    expect((explicit.json().items as Array<{ slug: string }>).map((i) => i.slug)).toEqual(["hello-paperboy", "modelling-listings"]);
  });

  it("a rule naming a non-public field is IGNORED in delivery (no inference oracle) — tree order applies", async () => {
    const parent = await createPage("Oracle Container", null);
    const first = await createPage("O-First", parent);
    const second = await createPage("O-Second", parent);
    for (const id of [first, second]) {
      await s.app.inject({ method: "PUT", url: `/api/v1/manage/content/${id}?locale=en`, headers: authHeaders(ed), payload: { data: { heading: "h" } } });
      await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${id}/publish?locale=en`, headers: authHeaders(ed) });
    }
    expect((await setRule(parent, "-data.doesNotExist")).statusCode).toBe(200);
    const res = await s.app.inject({ method: "GET", url: `/api/v1/delivery/content?parentId=${parent}&locale=en`, headers: { authorization: `Bearer ${PUBLIC_KEY}` } });
    expect((res.json().items as Array<{ name: string }>).map((i) => i.name)).toEqual(["O-First", "O-Second"]);
  });

  it("an invalid rule is rejected with a self-teaching validation error", async () => {
    const parent = await createPage("Invalid Rule Container", null);
    const res = await setRule(parent, "price descending");
    expect(res.statusCode).toBe(422);
    expect(res.body).toMatch(/data\.<field>/);
    expect(res.body).toMatch(/-data\.publishDate/); // a copyable example (rule 2)
  });

  it("requires content.update (Viewer denied)", async () => {
    const viewer = await login(s.app, "viewer@paperboy.test", "Viewer!Passw0rd");
    const res = await setRule(s.ids.blogId, "name", viewer);
    expect(res.statusCode).toBe(403);
  });
});
