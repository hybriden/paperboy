import { describe, expect, it } from "vitest";
import { blockData, contentAreas, isRichTextDoc, pbAreaAttrs, renderKind, renderRichText } from "./index.js";

// XSS regression guard for renderRichText — its output is injected via
// innerHTML/set:html, and CMS content (incl. agent-written via MCP) is untrusted.
describe("renderRichText — XSS-safe", () => {
  it("escapes script-y text and neutralises javascript: hrefs", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "<script>alert(1)</script>" }] },
        { type: "paragraph", content: [{ type: "text", text: "click", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }] },
      ],
    };
    const html = renderRichText(doc);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("javascript:");
  });

  it("drops a javascript: image src", () => {
    expect(renderRichText({ type: "doc", content: [{ type: "image", attrs: { src: "javascript:alert(1)", alt: "x" } }] })).not.toContain("javascript:");
  });

  it("renders basic structure (p / strong / ul-li)", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "hi", marks: [{ type: "bold" }] }] },
        { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }] }] },
      ],
    };
    const html = renderRichText(doc);
    expect(html).toContain("<p><strong>hi</strong></p>");
    expect(html).toContain("<ul><li><p>a</p></li></ul>");
  });

  it("isRichTextDoc distinguishes docs from strings/null", () => {
    expect(isRichTextDoc({ type: "doc", content: [] })).toBe(true);
    expect(isRichTextDoc("# markdown")).toBe(false);
    expect(isRichTextDoc(null)).toBe(false);
  });
});

describe("blockData / contentAreas", () => {
  it("blockData reads inline vs shared fields", () => {
    expect(blockData({ blockType: "X", shared: false, data: { a: 1 } })).toEqual({ a: 1 });
    expect(blockData({ blockType: "X", shared: true, content: { data: { b: 2 } } })).toEqual({ b: 2 });
    expect(blockData({ blockType: "X" })).toEqual({});
  });

  // fieldTypes is the SCHEMA — it exists precisely so frontends stop guessing from
  // values. Passing it makes area detection exact regardless of the field's name.
  // Without it the old /area$/i heuristic found an EMPTY area only when the field
  // happened to be called "…Area", so a customer whose area is named `sections`
  // got no data-pb-area marker on a fresh page: nothing rendered, and on-page
  // drag-and-drop onto that page was impossible.
  it("contentAreas: fieldTypes identifies areas by schema, whatever they are named", () => {
    const data = {
      sections: [], // an EMPTY area not named "…Area" — the case that used to be missed
      tags: [],
      stuff: [{ blockType: "CardBlock", shared: false, data: {} }],
      heading: "x",
    };
    const fieldTypes = {
      sections: "contentArea",
      tags: "text",
      stuff: "contentArea",
      heading: "text",
    } as const;
    expect(contentAreas(data, fieldTypes).map((a) => `${a.field}(${a.blocks.length})`)).toEqual([
      "sections(0)",
      "stuff(1)",
    ]);
  });

  it("contentAreas: fieldTypes EXCLUDES a non-area field even when it holds block-shaped values", () => {
    const data = { related: [{ blockType: "CardBlock", shared: false, data: {} }] };
    expect(contentAreas(data, { related: "reference" }).map((a) => a.field)).toEqual([]);
  });

  it("contentAreas: without fieldTypes, falls back to the shape heuristic (back-compat)", () => {
    const data = {
      mainArea: [],
      tags: [],
      stuff: [{ blockType: "CardBlock", shared: false, data: {} }],
      heading: "x",
    };
    expect(contentAreas(data).map((a) => `${a.field}(${a.blocks.length})`)).toEqual(["mainArea(0)", "stuff(1)"]);
  });

  // The drop-zone contract: data-pb-area's VALUE is the FIELD NAME the bridge
  // posts back as paperboy:drop {field}. A boolean-ish marker breaks every drop.
  it("pbAreaAttrs emits data-pb-area=<field name> in preview, nothing on public pages", () => {
    expect(pbAreaAttrs("mainArea", true)).toEqual({ "data-pb-area": "mainArea" });
    expect(pbAreaAttrs("mainArea", false)).toEqual({});
  });

  // Render decision must come from the DECLARED type (fieldTypes[name]), not a
  // value sniff — a richtext doc and an empty string both look stringy.
  it("renderKind maps declared field types to a render strategy", () => {
    expect(renderKind("richtext")).toBe("richtext");
    expect(renderKind("markdown")).toBe("markdown");
    expect(renderKind("text")).toBe("text");
    expect(renderKind("image")).toBe("other");
    expect(renderKind("contentArea")).toBe("other");
    expect(renderKind(undefined)).toBe("other");
  });
});
