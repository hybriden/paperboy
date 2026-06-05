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

  it("strips empty text nodes from richtext (ProseMirror rejects them → blank editor)", async () => {
    // Regression: an AI/MCP write stored {type:"text", text:""} inside a doc;
    // TipTap then refused the WHOLE document and the admin editor rendered empty.
    const res = await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${pageId}?locale=en`,
      headers: authHeaders(ed),
      payload: {
        merge: true,
        data: {
          intro: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "Built with " },
                  { type: "text", text: "MCP", marks: [{ type: "bold" }] },
                  { type: "text", text: "" }, // ← invalid: PM forbids empty text nodes
                ],
              },
            ],
          },
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const got = (await s.app.inject({ method: "GET", url: `/api/v1/manage/content/${pageId}?locale=en`, headers: authHeaders(ed) })).json();
    const para = got.data.intro.content[0];
    expect(para.content).toHaveLength(2); // empty text node stripped
    expect(para.content.map((n: { text: string }) => n.text)).toEqual(["Built with ", "MCP"]);
  });

  it("normalizes richtext outside the editor schema (unknown nodes/marks → blank editor)", async () => {
    // Regression: an MCP write stored {type:"separator"} — a node type the admin
    // editor's TipTap schema doesn't know — and the editor blanked the whole doc.
    const res = await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${pageId}?locale=en`,
      headers: authHeaders(ed),
      payload: {
        merge: true,
        data: {
          intro: {
            type: "doc",
            content: [
              { type: "separator" }, // alias → horizontalRule
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "kept ", marks: [{ type: "strong" }] }, // alias → bold
                  { type: "text", text: "styled", marks: [{ type: "highlight" }] }, // unknown mark → dropped
                ],
              },
              { type: "bullet_list", content: [{ type: "list_item", content: [{ type: "paragraph", content: [{ type: "text", text: "item" }] }] }] }, // snake_case → camelCase
              { type: "callout", content: [{ type: "text", text: "salvaged" }] }, // unknown node → children hoisted into a paragraph
            ],
          },
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const intro = (await s.app.inject({ method: "GET", url: `/api/v1/manage/content/${pageId}?locale=en`, headers: authHeaders(ed) })).json().data.intro;
    expect(intro.content.map((n: { type: string }) => n.type)).toEqual(["horizontalRule", "paragraph", "bulletList", "paragraph"]);
    expect(intro.content[1].content[0].marks).toEqual([{ type: "bold" }]);
    expect(intro.content[1].content[1].marks).toEqual([]); // unknown mark stripped
    expect(intro.content[2].content[0].type).toBe("listItem");
    expect(intro.content[3].content[0].text).toBe("salvaged");
  });

  it("richtext images: kept at block level, hoisted out of paragraphs, srcless dropped", async () => {
    const res = await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${pageId}?locale=en`,
      headers: authHeaders(ed),
      payload: {
        merge: true,
        data: {
          intro: {
            type: "doc",
            content: [
              { type: "image", attrs: { src: "/uploads/a.png", alt: "A" } }, // valid block-level image
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "around " },
                  { type: "image", attrs: { src: "/uploads/b.png", alt: "B" } }, // inside a paragraph → hoisted out
                ],
              },
              { type: "img", attrs: { src: "/uploads/c.png" } }, // alias → image
              { type: "image", attrs: { alt: "no src" } }, // srcless → dropped (PM requires src)
            ],
          },
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const intro = (await s.app.inject({ method: "GET", url: `/api/v1/manage/content/${pageId}?locale=en`, headers: authHeaders(ed) })).json().data.intro;
    expect(intro.content.map((n: { type: string }) => n.type)).toEqual(["image", "paragraph", "image", "image"]);
    expect(intro.content[1].content.map((n: { type: string }) => n.type)).toEqual(["text"]); // image gone from the paragraph…
    expect(intro.content[2].attrs.src).toBe("/uploads/b.png"); // …and hoisted right after it
    expect(intro.content[3].attrs.src).toBe("/uploads/c.png");
  });

  it("delivery absolutizes richtext image srcs", async () => {
    const publish = await s.app.inject({
      method: "POST",
      url: `/api/v1/manage/content/${pageId}/publish?locale=en`,
      headers: authHeaders(ed),
    });
    expect(publish.statusCode).toBe(200);
    const res = await s.app.inject({
      method: "GET",
      url: `/api/v1/delivery/content/${pageId}?locale=en`,
      headers: { "x-api-key": "pk_live_test_public" },
    });
    expect(res.statusCode).toBe(200);
    const intro = res.json().data.intro;
    // MEDIA_PUBLIC_BASE is http://localhost:8091 in the test env.
    expect(intro.content[0].attrs.src).toBe("http://localhost:8091/uploads/a.png");
  });

  it("unwraps locale-map values ({en: ...}) — the exact mistake a real agent burned 12 attempts on", async () => {
    const res = await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${pageId}?locale=en`,
      headers: authHeaders(ed),
      payload: {
        merge: true,
        data: {
          heading: { en: "Locale-wrapped heading" }, // requested locale present
          intro: { nb: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Eneste nøkkel" }] }] } }, // single locale-shaped key
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const got = (await s.app.inject({ method: "GET", url: `/api/v1/manage/content/${pageId}?locale=en`, headers: authHeaders(ed) })).json();
    expect(got.data.heading).toBe("Locale-wrapped heading");
    expect(got.data.intro.type).toBe("doc"); // unwrapped, then kept as a doc
  });

  it("converts a TipTap doc sent to a MARKDOWN field into real Markdown (structure kept)", async () => {
    // Regression: a real agent sent {type:"doc",…} for BlogPost.body (markdown).
    // The old flattener concatenated text nodes with NO separators — destroyed
    // content + reported success → the agent looped re-sending the payload.
    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(ed),
      payload: { type: "BlogPost", locale: "en", name: "Md Coercion", parentId: s.ids.blogId },
    });
    const id = created.json().documentId;
    const res = await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${id}?locale=en`,
      headers: authHeaders(ed),
      payload: {
        merge: true,
        data: {
          title: "Md Coercion",
          body: {
            type: "doc",
            content: [
              { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "The Numbers That Matter" }] },
              { type: "paragraph", content: [{ type: "text", text: "Gartner's latest research says " }, { type: "text", text: "75%", marks: [{ type: "bold" }] }, { type: "text", text: " of new apps." }] },
              { type: "bulletList", content: [
                { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "First point" }] }] },
                { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Second point" }] }] },
              ] },
            ],
          },
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json().data.body as string;
    expect(typeof body).toBe("string");
    expect(body).toBe("## The Numbers That Matter\n\nGartner's latest research says **75%** of new apps.\n\n- First point\n- Second point");
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
