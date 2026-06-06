import { describe, expect, it } from "vitest";
import { type FieldDef, coerceFieldValue } from "@paperboy/shared";

/**
 * The TipTap → Markdown and TipTap → plain-text converters in
 * packages/shared/src/content-types.ts (`tiptapToMarkdown` / `tiptapToPlainText`).
 *
 * Both are module-PRIVATE. They are reached through the exported
 * `coerceFieldValue`:
 *   - a `markdown` field that receives a TipTap doc → tiptapToMarkdown
 *   - a `text` field that receives a TipTap doc      → tiptapToPlainText
 * That is exactly how production reaches them, so this is the surface to pin.
 *
 * The critical invariant (a real incident): the converter must NOT glue words
 * together. The old flattener concatenated text nodes with no separators,
 * destroying content while reporting success → an agent looped 9×.
 *
 * Pure: imports @paperboy/shared only.
 */

const md = (doc: unknown): string =>
  coerceFieldValue(field("markdown"), doc) as string;
const txt = (doc: unknown): string =>
  coerceFieldValue(field("text"), doc) as string;

function field(type: FieldDef["type"]): FieldDef {
  return {
    name: "fld",
    displayName: "Fld",
    type,
    localized: false,
    required: false,
    delivery: "private",
    allowedBlocks: [],
    allowedTypes: [],
    options: [],
    multiple: false,
    group: "Content",
  };
}

const doc = (...content: unknown[]) => ({ type: "doc", content });
const para = (...content: unknown[]) => ({ type: "paragraph", content });
const text = (t: string, marks?: Array<{ type: string; attrs?: Record<string, unknown> }>) => ({ type: "text", text: t, ...(marks ? { marks } : {}) });

describe("tiptap → Markdown", () => {
  it("headings render with the right number of #, clamped to 1..6", () => {
    expect(md(doc({ type: "heading", attrs: { level: 1 }, content: [text("H1")] }))).toBe("# H1");
    expect(md(doc({ type: "heading", attrs: { level: 3 }, content: [text("H3")] }))).toBe("### H3");
    // level defaults to 2 when absent
    expect(md(doc({ type: "heading", content: [text("Hdef")] }))).toBe("## Hdef");
    // out-of-range levels clamp to 1 and 6
    expect(md(doc({ type: "heading", attrs: { level: 0 }, content: [text("Low")] }))).toBe("# Low");
    expect(md(doc({ type: "heading", attrs: { level: 99 }, content: [text("High")] }))).toBe("###### High");
  });

  it("bullet list renders with '- ' markers", () => {
    const out = md(
      doc({
        type: "bulletList",
        content: [
          { type: "listItem", content: [para(text("one"))] },
          { type: "listItem", content: [para(text("two"))] },
        ],
      }),
    );
    expect(out).toBe("- one\n- two");
  });

  it("ordered list renders with '1. 2. ...' numbering", () => {
    const out = md(
      doc({
        type: "orderedList",
        content: [
          { type: "listItem", content: [para(text("first"))] },
          { type: "listItem", content: [para(text("second"))] },
        ],
      }),
    );
    expect(out).toBe("1. first\n2. second");
  });

  it("nested lists indent the inner list by two spaces", () => {
    const out = md(
      doc({
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              para(text("outer")),
              {
                type: "bulletList",
                content: [{ type: "listItem", content: [para(text("inner"))] }],
              },
            ],
          },
        ],
      }),
    );
    expect(out).toBe("- outer\n  - inner");
  });

  it("inline marks → bold/italic/code/strike Markdown syntax", () => {
    expect(md(doc(para(text("b", [{ type: "bold" }]))))).toBe("**b**");
    expect(md(doc(para(text("s", [{ type: "strong" }]))))).toBe("**s**"); // alias
    expect(md(doc(para(text("i", [{ type: "italic" }]))))).toBe("*i*");
    expect(md(doc(para(text("e", [{ type: "em" }]))))).toBe("*e*"); // alias
    expect(md(doc(para(text("c", [{ type: "code" }]))))).toBe("`c`");
    expect(md(doc(para(text("d", [{ type: "strike" }]))))).toBe("~~d~~");
  });

  it("links render with [text](href) Markdown syntax", () => {
    expect(md(doc(para(text("click", [{ type: "link", attrs: { href: "https://x.test" } }]))))).toBe("[click](https://x.test)");
  });

  it("a link with no href falls back to (#)", () => {
    expect(md(doc(para(text("nolink", [{ type: "link" }]))))).toBe("[nolink](#)");
  });

  it("blockquote prefixes each line with '> '", () => {
    expect(md(doc({ type: "blockquote", content: [para(text("quoted"))] }))).toBe("> quoted");
  });

  it("code block fences with triple backticks and does NOT apply marks inside", () => {
    expect(md(doc({ type: "codeBlock", content: [text("const x = 1", [{ type: "bold" }])] }))).toBe("```\nconst x = 1\n```");
  });

  it("horizontal rule renders as ---", () => {
    expect(md(doc({ type: "horizontalRule" }))).toBe("---");
  });

  it("hard break renders as a Markdown line break (two spaces + newline)", () => {
    expect(md(doc(para(text("a"), { type: "hardBreak" }, text("b"))))).toBe("a  \nb");
  });

  it("block-level image renders ![alt](src)", () => {
    expect(md(doc({ type: "image", attrs: { src: "/x.png", alt: "Alt" } }))).toBe("![Alt](/x.png)");
  });

  it("an image with no alt renders ![](src)", () => {
    expect(md(doc({ type: "image", attrs: { src: "/x.png" } }))).toBe("![](/x.png)");
  });

  it("inline image inside a paragraph renders ![alt](src) inline", () => {
    expect(md(doc(para(text("see "), { type: "image", attrs: { src: "/i.png", alt: "I" } })))).toBe("see ![I](/i.png)");
  });

  it("multiple paragraphs are separated by a blank line", () => {
    expect(md(doc(para(text("P1")), para(text("P2"))))).toBe("P1\n\nP2");
  });

  it("combined document keeps full structure (heading + bold + list)", () => {
    const out = md(
      doc(
        { type: "heading", attrs: { level: 2 }, content: [text("The Numbers That Matter")] },
        para(text("Gartner says "), text("75%", [{ type: "bold" }]), text(" of new apps.")),
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [para(text("First point"))] },
            { type: "listItem", content: [para(text("Second point"))] },
          ],
        },
      ),
    );
    expect(out).toBe("## The Numbers That Matter\n\nGartner says **75%** of new apps.\n\n- First point\n- Second point");
  });

  it("empty / whitespace-only blocks are filtered out", () => {
    expect(md(doc(para(text("kept")), para(), para(text("   "))))).toBe("kept");
  });
});

describe("tiptap → plain text (no word-gluing — the real incident)", () => {
  it("separates blocks with newlines, never glues words together", () => {
    const out = txt(
      doc(
        { type: "heading", attrs: { level: 2 }, content: [text("Heading")] },
        para(text("Body text")),
      ),
    );
    // The OLD bug produced "HeadingBody text"; the fix keeps them on separate lines.
    expect(out).toBe("Heading\nBody text");
    expect(out).not.toContain("HeadingBody");
  });

  it("plain-text mode drops Markdown syntax (no #, no **, no backticks)", () => {
    const out = txt(
      doc(
        { type: "heading", attrs: { level: 1 }, content: [text("Title")] },
        para(text("bold", [{ type: "bold" }]), text(" and "), text("code", [{ type: "code" }])),
      ),
    );
    expect(out).toBe("Title\nbold and code");
    expect(out).not.toContain("#");
    expect(out).not.toContain("**");
    expect(out).not.toContain("`");
  });

  it("plain-text lists use a bullet glyph for unordered and numbers for ordered", () => {
    const bullet = txt(
      doc({
        type: "bulletList",
        content: [
          { type: "listItem", content: [para(text("a"))] },
          { type: "listItem", content: [para(text("b"))] },
        ],
      }),
    );
    expect(bullet).toBe("• a\n• b");
    const ordered = txt(
      doc({
        type: "orderedList",
        content: [
          { type: "listItem", content: [para(text("a"))] },
          { type: "listItem", content: [para(text("b"))] },
        ],
      }),
    );
    expect(ordered).toBe("1. a\n2. b");
  });

  it("plain-text image renders just its alt text", () => {
    expect(txt(doc({ type: "image", attrs: { src: "/x.png", alt: "Just alt" } }))).toBe("Just alt");
  });

  it("plain-text hard break is a newline", () => {
    expect(txt(doc(para(text("a"), { type: "hardBreak" }, text("b"))))).toBe("a\nb");
  });

  it("multi-paragraph plain text is newline-separated (each word preserved)", () => {
    const out = txt(doc(para(text("First paragraph.")), para(text("Second paragraph."))));
    expect(out).toBe("First paragraph.\nSecond paragraph.");
  });

  it("link in plain-text keeps the link text only (no url, no brackets)", () => {
    expect(txt(doc(para(text("click here", [{ type: "link", attrs: { href: "https://x" } }]))))).toBe("click here");
  });
});

describe("tiptap converters: tolerant input shapes", () => {
  it("a bare node (no doc wrapper) is treated as a single block", () => {
    // coerceFieldValue → looksLikeTiptapDoc true (has content array) → converted.
    expect(md({ content: [para(text("loose"))] })).toBe("loose");
  });

  it("an unknown wrapper node's children are descended into (salvaged as their own blocks)", () => {
    const out = md(doc({ type: "section", content: [para(text("inside section"))] }));
    expect(out).toBe("inside section");
  });

  it("a bare text node directly under an unknown wrapper becomes its own block", () => {
    const out = md(doc({ type: "weird", text: "loose text" }));
    expect(out).toBe("loose text");
  });
});
