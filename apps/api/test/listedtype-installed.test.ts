import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * Regression for the "Projects lists a content type that doesn't exist"
 * incident (2026-06-07): the live Projects ListPage had listedType =
 * "ArticlePage" while no ArticlePage content type was installed. Nothing could
 * ever appear on the list, and an agent told to create the listed type hit a
 * dead end (the type can't be made), then forced through invisible BlogPosts.
 *
 * The listedType select must reflect REALITY, not a hardcoded option list:
 * saving a ListPage whose listedType is not an installed content type is
 * refused with a self-teaching error that lists the installed page types.
 */
describe("ListPage.listedType must reference an installed content type", () => {
  let s: Suite;
  let ed: Awaited<ReturnType<typeof login>>;
  let pageId: string;

  beforeAll(async () => {
    s = await setupApi();
    ed = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(ed),
      payload: { type: "ListPage", locale: "en", name: "Projects-ish" },
    });
    expect(created.statusCode).toBe(200);
    pageId = created.json().documentId;
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("rejects a listedType that is not an installed content type, naming the real ones", async () => {
    const res = await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${pageId}?locale=en`,
      headers: authHeaders(ed),
      payload: { data: { heading: "Projects", listedType: "GhostType" } },
    });
    expect(res.statusCode).toBe(422);
    const msg = res.json().message as string;
    expect(msg).toContain("listedType");
    expect(msg).toContain("GhostType");
    // Self-teaching: names installed types the editor/agent can actually pick.
    expect(msg).toContain("BlogPost");
  });

  it("accepts a listedType that IS an installed content type", async () => {
    const res = await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${pageId}?locale=en`,
      headers: authHeaders(ed),
      payload: { data: { heading: "Projects", listedType: "BlogPost" } },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.listedType).toBe("BlogPost");
  });

  it("blocks publish too (defence in depth) if a ghost listedType slips into a draft", async () => {
    // Reach in via a fresh page; set a valid value first (draft saves), then a
    // publish with a ghost value must be refused at the strict gate as well.
    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(ed),
      payload: { type: "ListPage", locale: "en", name: "Publish guard list" },
    });
    const id = created.json().documentId;
    const bad = await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${id}?locale=en`,
      headers: authHeaders(ed),
      payload: { data: { heading: "X", listedType: "AlsoGhost" } },
    });
    expect(bad.statusCode).toBe(422);
  });
});
