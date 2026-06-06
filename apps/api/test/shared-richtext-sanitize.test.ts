import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type FieldDef, coerceFieldValue } from "@paperboy/shared";

/**
 * Pure unit + property tests for the richtext (TipTap) sanitizer in
 * packages/shared/src/content-types.ts.
 *
 * The sanitizer (`sanitizeRichTextDoc` / `sanitizeRichTextNodes`) is NOT
 * exported — it is reached through the exported `coerceFieldValue` with a
 * `richtext` field, which calls `sanitizeRichTextDoc(doc)` for any value that
 * looksLikeTiptapDoc. That is the production entry point too (API + MCP + admin
 * all coerce through coerceFieldValue), so this is the right surface to pin.
 *
 * No DB, no Fastify, no setupApi — these import @paperboy/shared only.
 */

const RT: FieldDef = {
  name: "body",
  displayName: "Body",
  type: "richtext",
  localized: false,
  required: false,
  delivery: "private",
  allowedBlocks: [],
  allowedTypes: [],
  options: [],
  multiple: false,
  group: "Content",
};

/** Sanitize a doc through the production coercion chokepoint. */
const san = (doc: unknown): { type: string; content: Array<Record<string, unknown>> } =>
  coerceFieldValue(RT, doc) as { type: string; content: Array<Record<string, unknown>> };

const types = (nodes: Array<{ type?: string }>): string[] => nodes.map((n) => n.type ?? "");

describe("richtext sanitizer: unknown node types are husked, not blanked", () => {
  it("hoists an unknown wrapper's block children into its position (drops the husk)", () => {
    const out = san({
      type: "doc",
      content: [{ type: "callout", content: [{ type: "paragraph", content: [{ type: "text", text: "in" }] }] }],
    });
    // The whole doc is NOT blanked: the salvaged paragraph survives.
    expect(types(out.content)).toEqual(["paragraph"]);
    expect((out.content[0]!.content as Array<{ text: string }>)[0]!.text).toBe("in");
  });

  it("wraps an unknown wrapper whose children are inline-only into a paragraph", () => {
    const out = san({ type: "doc", content: [{ type: "callout", content: [{ type: "text", text: "bare" }] }] });
    expect(types(out.content)).toEqual(["paragraph"]);
    expect((out.content[0]!.content as Array<{ text: string }>)[0]!.text).toBe("bare");
  });

  it("an unknown node carrying a `text` prop becomes a text node (then grouped into a paragraph)", () => {
    const out = san({ type: "doc", content: [{ type: "weird", text: "direct" }] });
    expect(types(out.content)).toEqual(["paragraph"]);
    expect((out.content[0]!.content as Array<{ text: string }>)[0]!.text).toBe("direct");
  });

  it("a single unknown node does not blank the rest of the document", () => {
    const out = san({
      type: "doc",
      content: [
        { type: "separator" }, // alias → horizontalRule
        { type: "callout", content: [{ type: "text", text: "salvaged" }] }, // unknown → husked
        { type: "paragraph", content: [{ type: "text", text: "after" }] },
      ],
    });
    expect(types(out.content)).toEqual(["horizontalRule", "paragraph", "paragraph"]);
    expect((out.content[2]!.content as Array<{ text: string }>)[0]!.text).toBe("after");
  });
});

describe("richtext sanitizer: text nodes", () => {
  it("drops empty text nodes, keeps text nodes with content", () => {
    const out = san({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "" }, { type: "text", text: "keep" }] }],
    });
    const para = out.content[0]!.content as Array<{ type: string; text: string }>;
    expect(para).toHaveLength(1);
    expect(para[0]!.text).toBe("keep");
  });

  it("drops a text node whose `text` is not a string", () => {
    const out = san({
      type: "doc",
      // a non-string text is invalid for PM and is dropped
      content: [{ type: "paragraph", content: [{ type: "text", text: 123 }, { type: "text", text: "ok" }] }],
    });
    const para = out.content[0]!.content as Array<{ type: string; text: string }>;
    expect(para).toHaveLength(1);
    expect(para[0]!.text).toBe("ok");
  });

  it("strips the `content` array off a text node (PM text nodes are leaves)", () => {
    const out = san({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "x", content: [{ type: "text", text: "nested" }] }] }],
    });
    const node = (out.content[0]!.content as Array<Record<string, unknown>>)[0]!;
    expect(node.text).toBe("x");
    expect(node.content).toBeUndefined();
  });
});

describe("richtext sanitizer: snake_case / aliased node names normalized", () => {
  it("bullet_list / list_item → bulletList / listItem", () => {
    const out = san({
      type: "doc",
      content: [
        { type: "bullet_list", content: [{ type: "list_item", content: [{ type: "paragraph", content: [{ type: "text", text: "i" }] }] }] },
      ],
    });
    expect(types(out.content)).toEqual(["bulletList"]);
    const li = out.content[0]!.content as Array<{ type: string }>;
    expect(li[0]!.type).toBe("listItem");
  });

  it("ordered_list / code_block / horizontal_rule / hard_break aliases", () => {
    const out = san({
      type: "doc",
      content: [
        { type: "ordered_list", content: [{ type: "list_item", content: [{ type: "paragraph", content: [{ type: "text", text: "1" }] }] }] },
        { type: "horizontal_rule" },
      ],
    });
    expect(out.content[0]!.type).toBe("orderedList");
    expect(out.content[1]!.type).toBe("horizontalRule");
  });

  it("img / picture → image", () => {
    const out = san({
      type: "doc",
      content: [{ type: "img", attrs: { src: "/a.png" } }, { type: "picture", attrs: { src: "/b.png" } }],
    });
    expect(types(out.content)).toEqual(["image", "image"]);
    expect((out.content[0]!.attrs as { src: string }).src).toBe("/a.png");
    expect((out.content[1]!.attrs as { src: string }).src).toBe("/b.png");
  });
});

describe("richtext sanitizer: images", () => {
  it("drops srcless images (PM requires the src attr)", () => {
    const out = san({ type: "doc", content: [{ type: "image", attrs: { alt: "no src" } }] });
    // doc would be empty → fallback empty paragraph
    expect(types(out.content)).toEqual(["paragraph"]);
  });

  it("drops an image whose src is an empty string", () => {
    const out = san({ type: "doc", content: [{ type: "image", attrs: { src: "" } }] });
    expect(types(out.content)).toEqual(["paragraph"]);
  });

  it("keeps a block-level image with a valid src", () => {
    const out = san({ type: "doc", content: [{ type: "image", attrs: { src: "/uploads/a.png", alt: "A" } }] });
    expect(types(out.content)).toEqual(["image"]);
    expect(out.content[0]!.content).toBeUndefined(); // void node — no content
  });

  it("hoists an image out of a paragraph to a block-level sibling right after it", () => {
    const out = san({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "around " }, { type: "image", attrs: { src: "/uploads/b.png" } }] }],
    });
    expect(types(out.content)).toEqual(["paragraph", "image"]);
    // the image is gone from inside the paragraph (inline-only content model)
    expect(types(out.content[0]!.content as Array<{ type: string }>)).toEqual(["text"]);
    expect((out.content[1]!.attrs as { src: string }).src).toBe("/uploads/b.png");
  });
});

describe("richtext sanitizer: marks", () => {
  it("filters marks to the allowed set (unknown marks dropped, array kept)", () => {
    const out = san({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "a", marks: [{ type: "highlight" }] }] }],
    });
    const node = (out.content[0]!.content as Array<{ marks: unknown[] }>)[0]!;
    expect(node.marks).toEqual([]);
  });

  it("normalizes aliased mark names (strong→bold, em→italic, u→underline)", () => {
    const out = san({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "a", marks: [{ type: "strong" }, { type: "em" }, { type: "u" }] }] }],
    });
    const node = (out.content[0]!.content as Array<{ marks: Array<{ type: string }> }>)[0]!;
    expect(node.marks.map((m) => m.type)).toEqual(["bold", "italic", "underline"]);
  });

  it("keeps the allowed marks (bold/italic/strike/code/underline/link)", () => {
    const out = san({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "a",
              marks: [{ type: "bold" }, { type: "italic" }, { type: "strike" }, { type: "code" }, { type: "underline" }, { type: "link", attrs: { href: "x" } }],
            },
          ],
        },
      ],
    });
    const node = (out.content[0]!.content as Array<{ marks: Array<{ type: string }> }>)[0]!;
    expect(node.marks.map((m) => m.type)).toEqual(["bold", "italic", "strike", "code", "underline", "link"]);
  });
});

describe("richtext sanitizer: codeBlock children flattened to plain text without marks", () => {
  it("strips marks inside a code block and keeps only text", () => {
    const out = san({
      type: "doc",
      content: [{ type: "codeBlock", content: [{ type: "text", text: "const x = 1", marks: [{ type: "bold" }] }] }],
    });
    expect(out.content[0]!.type).toBe("codeBlock");
    const inner = out.content[0]!.content as Array<Record<string, unknown>>;
    expect(inner).toEqual([{ type: "text", text: "const x = 1" }]);
    expect(inner[0]!.marks).toBeUndefined();
  });

  it("flattens nested block descendants inside a code block to their text", () => {
    const out = san({
      type: "doc",
      content: [{ type: "codeBlock", content: [{ type: "paragraph", content: [{ type: "text", text: "deep" }] }] }],
    });
    const inner = out.content[0]!.content as Array<Record<string, unknown>>;
    expect(inner).toEqual([{ type: "text", text: "deep" }]);
  });
});

describe("richtext sanitizer: listItem shaping (loose inline runs wrapped)", () => {
  it("wraps a loose inline run inside a list into a listItem>paragraph", () => {
    const out = san({ type: "doc", content: [{ type: "bulletList", content: [{ type: "text", text: "loose" }] }] });
    expect(out.content[0]!.type).toBe("bulletList");
    const li = (out.content[0]!.content as Array<Record<string, unknown>>)[0]!;
    expect(li.type).toBe("listItem");
    const para = (li.content as Array<Record<string, unknown>>)[0]!;
    expect(para.type).toBe("paragraph");
    expect((para.content as Array<{ text: string }>)[0]!.text).toBe("loose");
  });

  it("wraps a loose block child inside a list into a listItem", () => {
    const out = san({
      type: "doc",
      content: [{ type: "bulletList", content: [{ type: "paragraph", content: [{ type: "text", text: "p" }] }] }],
    });
    const li = (out.content[0]!.content as Array<Record<string, unknown>>)[0]!;
    expect(li.type).toBe("listItem");
    expect((li.content as Array<{ type: string }>)[0]!.type).toBe("paragraph");
  });

  it("leaves an already-correct listItem untouched (shape-wise)", () => {
    const out = san({
      type: "doc",
      content: [{ type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "ok" }] }] }] }],
    });
    const li = (out.content[0]!.content as Array<Record<string, unknown>>)[0]!;
    expect(li.type).toBe("listItem");
    expect((li.content as Array<{ type: string }>)[0]!.type).toBe("paragraph");
  });
});

describe("richtext sanitizer: content-model structural fixes", () => {
  it("flattens a paragraph nested inside a paragraph (inline-only content model)", () => {
    const out = san({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "paragraph", content: [{ type: "text", text: "nested" }] }] }],
    });
    expect(types(out.content)).toEqual(["paragraph"]);
    expect(types(out.content[0]!.content as Array<{ type: string }>)).toEqual(["text"]);
    expect((out.content[0]!.content as Array<{ text: string }>)[0]!.text).toBe("nested");
  });

  it("empty doc → a single empty paragraph (PM requires block+)", () => {
    const out = san({ type: "doc", content: [] });
    expect(out.content).toEqual([{ type: "paragraph", content: [] }]);
  });

  it("a doc with no content key → a single empty paragraph", () => {
    const out = san({ type: "doc" });
    expect(out.content).toEqual([{ type: "paragraph", content: [] }]);
  });

  it("a node whose content is not an array → treated as empty", () => {
    const out = san({ type: "doc", content: [{ type: "paragraph", content: "notarray" }] });
    expect(types(out.content)).toEqual(["paragraph"]);
    expect(out.content[0]!.content).toEqual([]);
  });

  it("preserves unrelated top-level doc keys", () => {
    const out = san({ type: "doc", content: [], foo: "bar" }) as unknown as { foo: string };
    expect(out.foo).toBe("bar");
  });
});

describe("richtext sanitizer: property — never throws, fixpoint (idempotent)", () => {
  // Build a recursive arbitrary of arbitrary junk "doc-like" JSON: random type
  // strings (mix of real, aliased, and garbage), optional text/marks/attrs/content,
  // depth bounded so fast-check terminates.
  const knownType = fc.constantFrom(
    "doc",
    "paragraph",
    "text",
    "heading",
    "bulletList",
    "orderedList",
    "listItem",
    "codeBlock",
    "blockquote",
    "horizontalRule",
    "hardBreak",
    "image",
    "bullet_list",
    "list_item",
    "img",
    "picture",
    "separator",
    "callout",
  );
  const typeArb = fc.oneof({ weight: 4, arbitrary: knownType }, { weight: 1, arbitrary: fc.string() });

  const markArb = fc.record({
    type: fc.oneof(fc.constantFrom("bold", "strong", "italic", "em", "code", "strike", "underline", "link", "highlight"), fc.string()),
    attrs: fc.option(fc.record({ href: fc.option(fc.webUrl(), { nil: undefined }) }, { requiredKeys: [] }), { nil: undefined }),
  });

  const nodeArb: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
    node: fc.record(
      {
        type: typeArb,
        text: fc.option(fc.string(), { nil: undefined }),
        attrs: fc.option(
          fc.record(
            {
              src: fc.option(fc.oneof(fc.webUrl(), fc.constant("")), { nil: undefined }),
              alt: fc.option(fc.string(), { nil: undefined }),
              level: fc.option(fc.integer({ min: 1, max: 8 }), { nil: undefined }),
            },
            { requiredKeys: [] },
          ),
          { nil: undefined },
        ),
        marks: fc.option(fc.array(markArb, { maxLength: 3 }), { nil: undefined }),
        content: fc.option(fc.array(tie("node"), { maxLength: 3 }), { nil: undefined }),
      },
      { requiredKeys: ["type"] },
    ),
  })).node;

  // depth ≤ 4 via fast-check's natural size control + maxLength caps above.
  const docArb = fc.oneof(
    fc.record({ type: fc.constant("doc"), content: fc.array(nodeArb, { maxLength: 4 }) }),
    nodeArb, // also feed bare node-shaped junk (coerce wraps via looksLikeTiptapDoc)
  );

  it("(a) never throws on arbitrary doc-like junk", () => {
    fc.assert(
      fc.property(docArb, (doc) => {
        expect(() => san(doc)).not.toThrow();
      }),
      { numRuns: 350 },
    );
  });

  it("(b) sanitizing is a SINGLE-PASS fixpoint: sanitize(sanitize(x)) deep-equals sanitize(x)", () => {
    // The editor applies the sanitizer ONCE — so one pass must already be a
    // fixpoint, or a doc that "needs two passes" reaches ProseMirror invalid
    // and blanks the editor. This strict form caught two real bugs: a loose
    // listItem under doc surviving pass 1, and the empty-doc fallback paragraph
    // missing its content array.
    fc.assert(
      fc.property(docArb, (doc) => {
        const once = san(doc);
        const twice = san(once);
        expect(twice).toEqual(once);
      }),
      { numRuns: 350 },
    );
  });

  it("regression: the fixpoint counterexamples found by fast-check", () => {
    // Loose listItem under doc wrapping a list holding an empty blockquote —
    // previously survived pass 1 as a PM-invalid bare listItem.
    const out = san({ type: "doc", content: [{ type: "listItem", content: [{ type: "bullet_list", content: [{ type: "blockquote" }] }] }] }) as { content: Array<{ type: string }> };
    expect(san(out)).toEqual(out);
    // Everything inside was empty → the whole thing collapses to the fallback.
    expect(out.content).toEqual([{ type: "paragraph", content: [] }]);

    // A loose listItem WITH real content gets wrapped in a bulletList.
    const wrapped = san({ type: "doc", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }] }] }) as { content: Array<{ type: string }> };
    expect(wrapped.content[0]!.type).toBe("bulletList");
    expect(san(wrapped)).toEqual(wrapped);
  });
});
