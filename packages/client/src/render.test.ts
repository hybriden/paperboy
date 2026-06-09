import { describe, expect, it } from "vitest";
import { blockData, contentAreas, isRichTextDoc, renderRichText } from "./index.js";

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

  it("contentAreas: non-empty detected by shape (any name); empty only when …Area", () => {
    const data = {
      mainArea: [],
      tags: [],
      stuff: [{ blockType: "CardBlock", shared: false, data: {} }],
      heading: "x",
    };
    expect(contentAreas(data).map((a) => `${a.field}(${a.blocks.length})`)).toEqual(["mainArea(0)", "stuff(1)"]);
  });
});
