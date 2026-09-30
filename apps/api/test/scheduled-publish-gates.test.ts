import {
  cloneContent,
  createDb,
  getAccessContext,
  restoreVersion,
  runScheduledPublish,
  schedulePublish,
  setAgentReviewRequired,
  updateContent,
} from "@paperboy/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PUBLIC_KEY, type Suite, TEST_DB, authHeaders, login, setupApi } from "./helpers.js";

/**
 * Audit 2026-09-30: the publish gates (content.publish permission, agent
 * review, strict pre-publish checks) lived only in publishContent. A scheduled
 * publish is owned by the DRAFT ROW, so whatever the draft held when the ticker
 * fired went live — an Author's rewrite of an Editor-scheduled page, an agent's
 * unreviewed edit — and the ticker skipped assertDraftPublishable. The MCP
 * `publish {expireAt}` path (schedulePublish with publishAt=now) skipped the
 * review gate outright, and clone/restore wrote drafts without the flag.
 */
describe("scheduled publish honours the same gates as publish", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  let ed: Awaited<ReturnType<typeof login>>;
  let author: Awaited<ReturnType<typeof login>>;
  let editorId: string;
  let adminId: string;

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    ed = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
    author = await login(s.app, "author@paperboy.test", "Author!Passw0rd");
    const users = (await s.app.inject({ method: "GET", url: "/api/v1/manage/users", headers: authHeaders(admin) })).json() as Array<{ id: string; email: string }>;
    editorId = users.find((u) => u.email === "editor@paperboy.test")!.id;
    adminId = users.find((u) => u.email === "admin@paperboy.test")!.id;
  });
  afterAll(async () => {
    await setAgentReviewRequired(s.app.db, await getAccessContext(s.app.db, adminId), false);
    await s.app.close();
  });

  const pub = { authorization: `Bearer ${PUBLIC_KEY}` };
  const later = () => new Date(Date.now() + 2 * 60 * 60 * 1000);
  const mcpCtx = async () => ({ ...(await getAccessContext(s.app.db, editorId)), via: "mcp" as const });

  async function page(name: string, parentId?: string): Promise<string> {
    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(ed),
      payload: { type: "ArticlePage", locale: "en", name, parentId, data: { heading: name } },
    });
    expect(created.statusCode).toBe(200);
    return created.json().documentId as string;
  }
  async function schedule(id: string, as = ed): Promise<void> {
    const res = await s.app.inject({
      method: "POST",
      url: `/api/v1/manage/content/${id}/schedule?locale=en`,
      headers: authHeaders(as),
      payload: { publishAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(), expireAt: null },
    });
    expect(res.statusCode).toBe(200);
  }
  const delivered = (id: string) => s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${id}?locale=en`, headers: pub });

  it("an Author's edit to an Editor-scheduled draft does not ride the schedule to production", async () => {
    const id = await page("Author Rewrite Target", s.ids.authorZoneId);
    await schedule(id);
    const put = await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${id}?locale=en`,
      headers: authHeaders(author),
      payload: { data: { heading: "Unapproved author rewrite" }, merge: true },
    });
    expect(put.statusCode).toBe(200);
    // The Author cannot publish, so their edit must cancel the pending go-live.
    expect(put.json().publishAt).toBeNull();
    await runScheduledPublish(s.app.db, later());
    expect((await delivered(id)).statusCode).toBe(404);
  });

  it("an agent's edit to a human-scheduled draft is held for review, not published by the ticker", async () => {
    await setAgentReviewRequired(s.app.db, await getAccessContext(s.app.db, adminId), true);
    const id = await page("Agent Edits Scheduled");
    await schedule(id);
    await updateContent(s.app.db, await mcpCtx(), id, "en", { data: { heading: "Agent text" }, merge: true });
    await runScheduledPublish(s.app.db, later());
    expect((await delivered(id)).statusCode).toBe(404);
  });

  it("MCP publish with expireAt (immediate publish) honours the agent-review gate", async () => {
    await setAgentReviewRequired(s.app.db, await getAccessContext(s.app.db, adminId), true);
    const id = await page("Immediate Via Schedule");
    const ctx = await mcpCtx();
    await updateContent(s.app.db, ctx, id, "en", { data: { heading: "Agent text" }, merge: true });
    await expect(
      schedulePublish(s.app.db, ctx, id, "en", { publishAt: new Date(), expireAt: later() }),
    ).rejects.toThrow(/human review/);
    expect((await delivered(id)).statusCode).toBe(404);
  });

  it("an agent's duplicate keeps the source's review flag", async () => {
    await setAgentReviewRequired(s.app.db, await getAccessContext(s.app.db, adminId), true);
    const id = await page("Clone Source");
    const ctx = await mcpCtx();
    await updateContent(s.app.db, ctx, id, "en", { data: { heading: "Agent text" }, merge: true });
    const copy = await cloneContent(s.app.db, ctx, id, "en");
    expect(copy.needsReview).toBe(true);
  });

  it("an agent's restore_version flags the restored draft for review", async () => {
    await setAgentReviewRequired(s.app.db, await getAccessContext(s.app.db, adminId), true);
    const id = await page("Restore Target");
    const versions = (await s.app.inject({ method: "GET", url: `/api/v1/manage/content/${id}/versions?locale=en`, headers: authHeaders(ed) })).json() as Array<{ id: number }>;
    const restored = await restoreVersion(s.app.db, await mcpCtx(), id, "en", versions[versions.length - 1]!.id);
    expect(restored.needsReview).toBe(true);
  });

  it("the ticker runs the strict pre-publish checks (placeholder name) and drops the schedule", async () => {
    const id = await page("Renamed Later");
    await schedule(id);
    // A publisher keeps the schedule across edits — but the ticker must still
    // refuse what publish would refuse.
    const put = await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${id}?locale=en`,
      headers: authHeaders(ed),
      payload: { name: "Untitled", merge: true, data: {} },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().publishAt).toBeTruthy();
    const res = await runScheduledPublish(s.app.db, later());
    expect(res.failed).toBeGreaterThanOrEqual(1);
    expect((await delivered(id)).statusCode).toBe(404);
  });

  it("a schedule cancelled while the ticker is mid-promotion does not go live", async () => {
    const id = await page("Cancelled Mid Tick");
    await schedule(id);
    // Hold the draft row locked from another connection so the ticker blocks on
    // its promote UPDATE, cancel the schedule in that transaction, then let go.
    const { sql } = createDb(TEST_DB, { max: 1 });
    try {
      let tick: Promise<unknown> | undefined;
      await sql.begin(async (tx) => {
        await tx`SELECT id FROM content_version WHERE document_id = ${id} AND status = 'draft' FOR UPDATE`;
        tick = runScheduledPublish(s.app.db, later());
        await new Promise((r) => setTimeout(r, 500));
        await tx`UPDATE content_version SET publish_at = NULL WHERE document_id = ${id} AND status = 'draft'`;
      });
      await tick;
    } finally {
      await sql.end();
    }
    expect((await delivered(id)).statusCode).toBe(404);
  });
});
