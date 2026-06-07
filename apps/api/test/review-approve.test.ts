import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAccessContext, publishContent, updateContent } from "@paperboy/db";
import { type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * Regression for the dead Approve button (2026-06-07, prod doc
 * QvpNjy3ahsjxPu9cASbBy-gF): an agent wrote AND published a version via MCP
 * (needs_review stays true through publish, and publishing leaves NO draft
 * row). The editor then showed "🤖 Needs review" on the published working
 * version — but POST /content/:id/review only cleared the flag on `draft`
 * rows, so Approve matched zero rows, audit-logged, returned 200, and changed
 * nothing. The user pressed it twice; the badge never went away.
 *
 * Contract: Approve clears the review flag on the WORKING version — the draft
 * when one exists, else the current published row.
 */
describe("agent review: Approve works on a published (draft-less) flagged version", () => {
  let s: Suite;
  let ed: Awaited<ReturnType<typeof login>>;
  let editorUserId: string;

  beforeAll(async () => {
    s = await setupApi();
    ed = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
    const admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    const users = await s.app.inject({ method: "GET", url: "/api/v1/manage/users", headers: authHeaders(admin) });
    editorUserId = (users.json() as Array<{ id: string; email: string }>).find(
      (u) => u.email === "editor@paperboy.test",
    )!.id;
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("clears needsReview on the current published version when no draft exists", async () => {
    // A human creates the page…
    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(ed),
      payload: { type: "ArticlePage", locale: "en", name: "Agent-published page" },
    });
    const documentId = created.json().documentId as string;

    // …then an agent writes and publishes it — the exact MCP path (apps/mcp
    // builds its ctx the same way and calls these same functions).
    const mcpCtx = { ...(await getAccessContext(s.app.db, editorUserId)), via: "mcp" as const };
    await updateContent(s.app.db, mcpCtx, documentId, "en", {
      data: { heading: "Agent wrote this" },
      merge: true,
    });
    const published = await publishContent(s.app.db, mcpCtx, documentId, "en");
    // The incident state: live, flagged, and no draft row left behind.
    expect(published.status).toBe("published");
    expect(published.hasUnpublishedChanges).toBe(false);
    expect(published.needsReview).toBe(true);

    // The human presses Approve.
    const approved = await s.app.inject({
      method: "POST",
      url: `/api/v1/manage/content/${documentId}/review?locale=en`,
      headers: authHeaders(ed),
    });
    expect(approved.statusCode).toBe(200);
    // The flag must actually clear — this is what silently no-opped.
    expect(approved.json().needsReview).toBe(false);

    // And it stays cleared on a fresh read.
    const reread = await s.app.inject({
      method: "GET",
      url: `/api/v1/manage/content/${documentId}?locale=en`,
      headers: authHeaders(ed),
    });
    expect(reread.json().needsReview).toBe(false);
  });

  it("still clears the draft's flag when a draft exists (unchanged behavior)", async () => {
    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(ed),
      payload: { type: "ArticlePage", locale: "en", name: "Agent-drafted page" },
    });
    const documentId = created.json().documentId as string;
    const mcpCtx = { ...(await getAccessContext(s.app.db, editorUserId)), via: "mcp" as const };
    await updateContent(s.app.db, mcpCtx, documentId, "en", {
      data: { heading: "Agent draft" },
      merge: true,
    });

    const approved = await s.app.inject({
      method: "POST",
      url: `/api/v1/manage/content/${documentId}/review?locale=en`,
      headers: authHeaders(ed),
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().needsReview).toBe(false);
  });
});
