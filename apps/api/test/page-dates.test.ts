import { readFileSync } from "node:fs";
import { createDb } from "@paperboy/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PUBLIC_KEY, type Suite, TEST_DB, authHeaders, login, setupApi } from "./helpers.js";

/**
 * A page has three dates, and "newest first" has to say which one (pageDates in
 * @paperboy/shared): created in the CMS, published (first went live, or the
 * type's datePublished field) and modified (last went live with a change).
 *
 * Reported: a list of articles only came out right when sorted by their
 * publishDate field; "Newest first (created)" didn't, and worse, the admin tree
 * and the delivered list ordered it by different dates (the document's creation
 * vs the live version's draft start), so republishing an old page moved it to
 * the top of the site but not of the tree. Publishing recorded no time at all.
 */
describe("created, published and modified: one definition for the tree, delivery and JSON-LD", () => {
  let s: Suite;
  let ed: Awaited<ReturnType<typeof login>>;
  let admin: Awaited<ReturnType<typeof login>>;
  const raw = createDb(TEST_DB, { max: 1 });
  const tick = () => new Promise((r) => setTimeout(r, 15)); // distinct timestamps
  const pub = { authorization: `Bearer ${PUBLIC_KEY}` };

  beforeAll(async () => {
    s = await setupApi();
    ed = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    const text = { name: "body", displayName: "Body", type: "text", delivery: "public" };
    for (const def of [
      { name: "PlainPost", displayName: "Plain post", kind: "page", schemaType: "Article", fields: [text] },
      { name: "DatedPost", displayName: "Dated post", kind: "page", fields: [text, { name: "publishDate", displayName: "Publish date", type: "datetime", delivery: "public" }] },
    ]) {
      const res = await s.app.inject({ method: "POST", url: "/api/v1/manage/content-types", headers: authHeaders(admin), payload: def });
      expect(res.statusCode, res.body).toBe(200);
    }
  });
  afterAll(async () => {
    await raw.sql.end();
    await s.app.close();
  });

  const create = async (name: string, parentId: string | null, type: string, data: Record<string, unknown> = {}) => {
    const res = await s.app.inject({ method: "POST", url: "/api/v1/manage/content", headers: authHeaders(ed), payload: { type, locale: "en", name, parentId } });
    expect(res.statusCode, res.body).toBe(200);
    const id = res.json().documentId as string;
    if (Object.keys(data).length) await edit(id, data);
    await tick();
    return id;
  };
  const edit = async (id: string, data: Record<string, unknown>) => {
    const res = await s.app.inject({ method: "PUT", url: `/api/v1/manage/content/${id}?locale=en`, headers: authHeaders(ed), payload: { data } });
    expect(res.statusCode, res.body).toBe(200);
  };
  const publish = async (id: string) => {
    const res = await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${id}/publish?locale=en`, headers: authHeaders(ed) });
    expect(res.statusCode, res.body).toBe(200);
    await tick();
  };
  const setRule = async (id: string, childSort: string) => {
    const res = await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${id}/child-sort`, headers: authHeaders(ed), payload: { childSort } });
    expect(res.statusCode, res.body).toBe(200);
  };
  const tree = async (parentId: string) =>
    ((await s.app.inject({ url: `/api/v1/manage/content/tree?parentId=${parentId}`, headers: { cookie: ed.cookie } })).json() as Array<{ name: string }>).map((n) => n.name);
  const delivered = async (parentId: string) => {
    const res = await s.app.inject({ url: `/api/v1/delivery/content?parentId=${parentId}&locale=en`, headers: pub });
    expect(res.statusCode, res.body).toBe(200);
    return (res.json().items as Array<{ name: string }>).map((i) => i.name);
  };
  /** The tree and the public list, which must always agree. */
  const both = async (parentId: string) => {
    const [t, d] = await Promise.all([tree(parentId), delivered(parentId)]);
    expect(d, "delivery must order like the tree").toEqual(t);
    return t;
  };

  let parent: string;
  const ids: Record<string, string> = {};

  it("created, published and modified each give their own order, in the tree and on the site", async () => {
    parent = await create("Dates", null, "PlainPost");
    await publish(parent);
    for (const n of ["A", "B", "C"]) ids[n] = await create(n, parent, "PlainPost"); // created A, B, C
    for (const n of ["C", "A", "B"]) await publish(ids[n]!); // first published C, A, B
    await edit(ids.A!, { body: "fixed a typo" });
    await publish(ids.A!); // A changes last

    await setRule(parent, "-createdAt");
    expect(await both(parent)).toEqual(["C", "B", "A"]);
    await setRule(parent, "-publishedAt");
    expect(await both(parent)).toEqual(["B", "A", "C"]); // republishing A didn't move it
    await setRule(parent, "-modifiedAt");
    expect(await both(parent)).toEqual(["A", "B", "C"]);
    await setRule(parent, "publishedAt");
    expect(await both(parent)).toEqual(["C", "A", "B"]);
  });

  it("an explicit ?sort= accepts the same keys", async () => {
    const res = await s.app.inject({ url: `/api/v1/delivery/content?parentId=${parent}&locale=en&sort=-modifiedAt`, headers: pub });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json().items as Array<{ name: string }>).map((i) => i.name)).toEqual(["A", "B", "C"]);
  });

  it("a publish-date field stands in for 'published' (an imported article predates the CMS)", async () => {
    const list = await create("Imported", null, "PlainPost");
    await publish(list);
    const old = await create("Old", list, "DatedPost", { publishDate: "2019-05-01T10:00:00Z" });
    const newer = await create("Newer", list, "DatedPost", { publishDate: "2023-02-01" });
    const undated = await create("Undated", list, "DatedPost");
    for (const id of [newer, old, undated]) await publish(id);
    await setRule(list, "-publishedAt");
    // Undated falls back to when it went live: today, newest of all.
    expect(await both(list)).toEqual(["Undated", "Newer", "Old"]);
  });

  it("JSON-LD and sitemap use the same dates: datePublished = first published, dateModified = last", async () => {
    const res = await s.app.inject({ url: `/api/v1/delivery/content/${ids.A}?locale=en`, headers: pub });
    expect(res.statusCode, res.body).toBe(200);
    const ld = res.json().seo.jsonLd as { datePublished?: string; dateModified?: string };
    const [row] = (await raw.sql`SELECT first_published_at, published_at FROM content_version WHERE document_id = ${ids.A!} AND is_current_published`) as Array<{ first_published_at: string; published_at: string }>;
    const firstAt = new Date(row!.first_published_at);
    const lastAt = new Date(row!.published_at);
    expect(ld.datePublished).toBe(firstAt.toISOString());
    expect(ld.dateModified).toBe(lastAt.toISOString());
    expect(firstAt.getTime()).toBeLessThan(lastAt.getTime());

    const { pages } = (await s.app.inject({ url: "/api/v1/delivery/pages", headers: pub })).json() as { pages: Array<{ documentId: string; lastmod: string }> };
    const entry = pages.find((p) => p.documentId === ids.A);
    expect(entry?.lastmod).toBe(lastAt.toISOString());
  });

  it("migration 0037's backfill: the audit trail's publish times where they exist, else the version's date", async () => {
    const sqlFile = readFileSync(new URL("../../../packages/db/migrations/0037_version_published_at.sql", import.meta.url), "utf8");
    const backfill = sqlFile.slice(sqlFile.indexOf("UPDATE"));
    // A page as an older install left it: live, no recorded times, two manual publishes in the audit log.
    const doc = ids.B!;
    await raw.sql`UPDATE content_version SET published_at = NULL, first_published_at = NULL WHERE document_id = ${doc}`;
    const [live] = (await raw.sql`SELECT created_at FROM content_version WHERE document_id = ${doc} AND is_current_published`) as Array<{ created_at: string }>;
    const made = new Date(live!.created_at).getTime();
    const first = new Date(made + 1000);
    const last = new Date(made + 5000);
    await raw.sql`DELETE FROM audit_log WHERE document_id = ${doc}`;
    await raw.sql`INSERT INTO audit_log (action, document_id, locale, ts) VALUES ('content.publish', ${doc}, 'en', ${first.toISOString()}), ('content.publish', ${doc}, 'en', ${last.toISOString()})`;
    await raw.sql.unsafe(backfill);
    const [after] = (await raw.sql`SELECT first_published_at, published_at FROM content_version WHERE document_id = ${doc} AND is_current_published`) as Array<{ first_published_at: string; published_at: string }>;
    expect(new Date(after!.first_published_at).toISOString()).toBe(first.toISOString());
    expect(new Date(after!.published_at).toISOString()).toBe(last.toISOString());

    // No audit trail (seeded, imported, scheduled): the version's own date.
    const lone = ids.C!;
    await raw.sql`UPDATE content_version SET published_at = NULL, first_published_at = NULL WHERE document_id = ${lone}`;
    await raw.sql`DELETE FROM audit_log WHERE document_id = ${lone}`;
    await raw.sql.unsafe(backfill);
    const [c] = (await raw.sql`SELECT created_at, first_published_at, published_at FROM content_version WHERE document_id = ${lone} AND is_current_published`) as Array<{ created_at: string; first_published_at: string; published_at: string }>;
    expect(new Date(c!.published_at).getTime()).toBe(new Date(c!.created_at).getTime());
    expect(new Date(c!.first_published_at).getTime()).toBe(new Date(c!.created_at).getTime());
  });
});
