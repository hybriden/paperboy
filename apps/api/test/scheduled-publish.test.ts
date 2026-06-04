import { runScheduledPublish } from "@paperboy/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PREVIEW_KEY, PUBLIC_KEY, type Suite, TEST_DB, authHeaders, login, setupApi } from "./helpers.js";

describe("Scheduled publish (timed go-live + expiry)", () => {
  let s: Suite;
  let ed: Awaited<ReturnType<typeof login>>;
  beforeAll(async () => {
    s = await setupApi();
    ed = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
  });

  const pub = { authorization: `Bearer ${PUBLIC_KEY}` };
  const prev = { authorization: `Bearer ${PREVIEW_KEY}` };

  /** Create a ArticlePage with a valid (publishable) draft. */
  async function makeDraft(name: string, data: Record<string, unknown> = { heading: name }): Promise<string> {
    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(ed),
      payload: { type: "ArticlePage", locale: "en", name },
    });
    const id = created.json().documentId as string;
    await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${id}?locale=en`,
      headers: authHeaders(ed),
      payload: { slug: name.toLowerCase().replace(/\s+/g, "-"), data },
    });
    return id;
  }

  it("future publishAt stays hidden until the publisher runs, then goes live", async () => {
    const id = await makeDraft("Scheduled Page");
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const sched = await s.app.inject({
      method: "POST",
      url: `/api/v1/manage/content/${id}/schedule?locale=en`,
      headers: authHeaders(ed),
      payload: { publishAt: future, expireAt: null },
    });
    expect(sched.statusCode).toBe(200);
    expect(sched.json().status).toBe("draft");
    expect(sched.json().publishAt).toBeTruthy();

    // Not in the published Delivery API yet.
    const before = await s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${id}?locale=en`, headers: pub });
    expect(before.statusCode).toBe(404);

    // Simulate the publisher running after the scheduled time.
    const res = await runScheduledPublish(s.app.db, new Date(Date.now() + 2 * 60 * 60 * 1000));
    expect(res.published).toBeGreaterThanOrEqual(1);

    const after = await s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${id}?locale=en`, headers: pub });
    expect(after.statusCode).toBe(200);
    // The schedule is cleared once promoted.
    const detail = await s.app.inject({ method: "GET", url: `/api/v1/manage/content/${id}?locale=en`, headers: authHeaders(ed) });
    expect(detail.json().status).toBe("published");
    expect(detail.json().publishAt).toBeNull();
  });

  it("past expiry hides published content at read time — before the ticker even runs", async () => {
    const id = await makeDraft("Expiring Page");
    await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${id}/publish?locale=en`, headers: authHeaders(ed) });
    expect((await s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${id}?locale=en`, headers: pub })).statusCode).toBe(200);

    const past = new Date(Date.now() - 60 * 1000).toISOString();
    const sched = await s.app.inject({
      method: "POST",
      url: `/api/v1/manage/content/${id}/schedule?locale=en`,
      headers: authHeaders(ed),
      payload: { publishAt: null, expireAt: past },
    });
    expect(sched.statusCode).toBe(200);

    // Read-time delivery guard hides it immediately (no publisher run needed).
    expect((await s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${id}?locale=en`, headers: pub })).statusCode).toBe(404);
    // Preview (privileged) still sees it.
    expect((await s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${id}?locale=en`, headers: prev })).statusCode).toBe(200);

    // The publisher demotes the expired row (fires the unpublish webhook).
    const res = await runScheduledPublish(s.app.db, new Date());
    expect(res.expired).toBeGreaterThanOrEqual(1);
  });

  it("re-validation failure at fire time leaves the item a draft (never publishes invalid content)", async () => {
    // ArticlePage requires `heading` at publish; this draft omits it.
    const id = await makeDraft("Invalid Scheduled", { intro: { type: "doc", content: [] } });
    // Force a due publish_at directly, bypassing schedule's strict validation.
    const { createDb } = await import("@paperboy/db");
    const { sql } = createDb(TEST_DB);
    await sql`UPDATE content_version SET publish_at = now() - interval '1 minute' WHERE document_id = ${id} AND status = 'draft'`;
    await sql.end();

    const res = await runScheduledPublish(s.app.db, new Date());
    expect(res.failed).toBeGreaterThanOrEqual(1);

    // Still not public, still a draft, schedule cleared.
    expect((await s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${id}?locale=en`, headers: pub })).statusCode).toBe(404);
    const detail = await s.app.inject({ method: "GET", url: `/api/v1/manage/content/${id}?locale=en`, headers: authHeaders(ed) });
    expect(detail.json().status).toBe("draft");
    expect(detail.json().publishAt).toBeNull();
  });

  it("scheduling requires content.publish (Author is denied)", async () => {
    const author = await login(s.app, "author@paperboy.test", "Author!Passw0rd");
    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(author),
      payload: { type: "ArticlePage", locale: "en", parentId: s.ids.authorZoneId, name: "Author Child" },
    });
    expect(created.statusCode).toBe(200);
    const id = created.json().documentId;
    const sched = await s.app.inject({
      method: "POST",
      url: `/api/v1/manage/content/${id}/schedule?locale=en`,
      headers: authHeaders(author),
      payload: { publishAt: new Date(Date.now() + 3_600_000).toISOString(), expireAt: null },
    });
    expect(sched.statusCode).toBe(403);
  });
});
