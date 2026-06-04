import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * Regression for the MCP "stuck-in-a-loop" report: updating a LandingPage-style
 * page (text + richtext + contentArea) failed because the caller sent the wrong
 * JSON shapes and the error didn't say how to fix it. These cover the two fixes:
 * self-teaching validation errors, and merge (partial-patch) mode.
 */
describe("update_content ergonomics: helpful errors + merge mode", () => {
  let s: Suite;
  let ed: Awaited<ReturnType<typeof login>>;
  let pageId: string;

  beforeAll(async () => {
    s = await setupApi();
    ed = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
    // LandingPage: heading(text), intro(richtext), mainArea(contentArea).
    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(ed),
      payload: { type: "LandingPage", locale: "en", name: "Ergo Page" },
    });
    pageId = created.json().documentId;
    // Seed a clean draft with correct shapes.
    await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${pageId}?locale=en`,
      headers: authHeaders(ed),
      payload: {
        name: "Ergo Page",
        slug: "ergo-page",
        data: { heading: "Original heading", intro: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Intro" }] }] }, mainArea: [] },
      },
    });
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("uncoercible shapes → an error that names the expected format + example", async () => {
    const res = await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${pageId}?locale=en`,
      headers: authHeaders(ed),
      // Objects that are NOT a TipTap doc / NOT a block can't be coerced — so
      // they surface the helpful, format-naming validation error.
      payload: { name: "Ergo Page", data: { heading: { foo: 1 }, mainArea: { foo: 1 } } },
    });
    expect(res.statusCode).toBe(422);
    const msg = res.json().message as string;
    expect(msg).toContain("'heading' is a text field");
    expect(msg).toContain("send a plain string");
    expect(msg).toContain("'mainArea' is a contentArea field");
    expect(msg).toContain("ARRAY of block instances");
  });

  it("tolerantly coerces the field-shape mistakes agents make", async () => {
    const res = await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${pageId}?locale=en`,
      headers: authHeaders(ed),
      payload: {
        merge: true,
        data: {
          // text given a TipTap doc → flattened to plain text
          heading: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Coerced heading" }] }] },
          // contentArea given a single block object → wrapped in an array
          mainArea: { key: "b1", blockType: "HeroBlock", display: "full", ref: null, inline: { title: "Hi" } },
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const got = (await s.app.inject({ method: "GET", url: `/api/v1/manage/content/${pageId}?locale=en`, headers: authHeaders(ed) })).json();
    expect(got.data.heading).toBe("Coerced heading"); // flattened to string
    expect(Array.isArray(got.data.mainArea)).toBe(true); // wrapped
    expect(got.data.mainArea[0].blockType).toBe("HeroBlock");
  });

  it("merge mode patches one field and leaves the rest intact", async () => {
    const res = await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${pageId}?locale=en`,
      headers: authHeaders(ed),
      payload: { merge: true, data: { heading: "Patched heading" } }, // only heading
    });
    expect(res.statusCode).toBe(200);
    const got = await s.app.inject({ method: "GET", url: `/api/v1/manage/content/${pageId}?locale=en`, headers: authHeaders(ed) });
    const data = got.json().data;
    expect(data.heading).toBe("Patched heading"); // changed
    expect(data.intro?.type).toBe("doc"); // untouched
    expect(Array.isArray(data.mainArea)).toBe(true); // untouched
  });
});
