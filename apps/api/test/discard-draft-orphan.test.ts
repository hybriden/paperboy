import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * Discarding the draft of a NEVER-PUBLISHED page used to destroy the document's
 * only version, leaving the `content_item` row behind with zero versions: a
 * ghost that still sat in the page tree (labelled with its raw documentId,
 * because there was no version left to read a name from) and opened a broken
 * editor.
 *
 * Live incident (2026-07-27, cms.neoteric.no): three MCP-created BlogPosts under
 * /blog were tidied up with "Discard draft" and all three stayed in the tree as
 * un-nameable, un-editable rows — jmDaRpO-NBPcOx05ql1HUKb9,
 * RUQFzGtz8X0Ooyi8TcAaQ9ru, xikFNz3QzV85yyhy98kTJ9RS.
 *
 * `deleteVariant` already refuses the equivalent move ("move the whole page to
 * trash instead"); discard-draft now refuses on the same grounds.
 */
describe("discard-draft cannot orphan a never-published page", () => {
  let s: Suite;
  let ed: Awaited<ReturnType<typeof login>>;
  beforeAll(async () => {
    s = await setupApi();
    ed = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("refuses the discard and leaves the page listed under its real name", async () => {
    // A page created but never published — exactly what the MCP agent left behind.
    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(ed),
      payload: { type: "ArticlePage", locale: "en", name: "Never published" },
    });
    const id = created.json().documentId as string;

    const discard = await s.app.inject({
      method: "POST",
      url: `/api/v1/manage/content/${id}/discard-draft?locale=en`,
      headers: authHeaders(ed),
    });
    expect(discard.statusCode).toBe(400);
    // Self-teaching: name the way out (rule 2).
    expect(discard.json().message).toMatch(/trash/i);

    // The document still has its version, so the tree shows a real name — not
    // the raw documentId that betrayed the ghost rows on the live site.
    const tree = await s.app.inject({
      method: "GET",
      url: "/api/v1/manage/content/tree",
      headers: authHeaders(ed),
    });
    const node = tree.json().find((n: { documentId: string }) => n.documentId === id);
    expect(node).toBeDefined();
    expect(node.name).toBe("Never published");
    expect(node.documentId).not.toBe(node.name);

    // And it is still editable.
    const read = await s.app.inject({
      method: "GET",
      url: `/api/v1/manage/content/${id}?locale=en`,
      headers: authHeaders(ed),
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().versionNumber).toBeGreaterThan(0);
  });

  it("no tree node is ever a version-less ghost", async () => {
    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(ed),
      payload: { type: "ArticlePage", locale: "en", name: "Ghost candidate" },
    });
    const id = created.json().documentId as string;
    await s.app.inject({
      method: "POST",
      url: `/api/v1/manage/content/${id}/discard-draft?locale=en`,
      headers: authHeaders(ed),
    });

    const tree = await s.app.inject({
      method: "GET",
      url: "/api/v1/manage/content/tree",
      headers: authHeaders(ed),
    });
    // The live symptom: a node whose name is its own documentId and whose
    // per-locale status map is empty, because no version remains.
    for (const node of tree.json() as Array<{ documentId: string; name: string; locales: object }>) {
      expect(node.name).not.toBe(node.documentId);
      expect(Object.keys(node.locales).length).toBeGreaterThan(0);
    }
  });

  it("still discards normally when a published version remains", async () => {
    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(ed),
      payload: { type: "ArticlePage", locale: "en", name: "Published then edited" },
    });
    const id = created.json().documentId as string;
    await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${id}?locale=en`,
      headers: authHeaders(ed),
      payload: { data: { heading: "Live copy" } },
    });
    await s.app.inject({
      method: "POST",
      url: `/api/v1/manage/content/${id}/publish?locale=en`,
      headers: authHeaders(ed),
    });
    // A new draft on top of the published version.
    await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${id}?locale=en`,
      headers: authHeaders(ed),
      payload: { data: { heading: "Unwanted edit" } },
    });

    const discard = await s.app.inject({
      method: "POST",
      url: `/api/v1/manage/content/${id}/discard-draft?locale=en`,
      headers: authHeaders(ed),
    });
    expect(discard.statusCode).toBe(200);

    // Reverted to the published copy, document intact.
    const read = await s.app.inject({
      method: "GET",
      url: `/api/v1/manage/content/${id}?locale=en`,
      headers: authHeaders(ed),
    });
    expect(read.json().data.heading).toBe("Live copy");
  });
});
