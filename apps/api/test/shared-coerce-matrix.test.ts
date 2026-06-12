import { describe, expect, it } from "vitest";
import { type ContentTypeDef, type FieldDef, coerceData, coerceFieldValue } from "@paperboy/shared";

/**
 * The UNCOVERED edge matrix for `coerceFieldValue` / `coerceData`.
 *
 * The happy-path coercions (TipTap→markdown, single block→array, locale unwrap
 * for the requested locale) are already pinned end-to-end in
 * update-ergonomics.test.ts. This file pins the EDGES — nested wraps, unknown
 * locale keys, empty/null values, type-mismatched scalars, and (importantly)
 * the cases where tolerant coercion silently mangles garbage. Where a
 * clearly-destructive input is silently accepted, it is pinned with a `// NOTE:`
 * flag (current behavior is a regression lock, not an endorsement).
 *
 * Pure: imports @paperboy/shared only. No DB / Fastify.
 */

const f = (type: FieldDef["type"], extra: Partial<FieldDef> = {}): FieldDef => ({
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
  ...extra,
});

describe("coerceFieldValue: self-keyed wrap unwrap edges", () => {
  it("unwraps a self-keyed wrap {<fieldName>: v}", () => {
    expect(coerceFieldValue(f("text"), { fld: "hi" })).toBe("hi");
  });

  it("unwraps a NESTED self-keyed + locale wrap {<field>: {<locale>: v}}", () => {
    // self-key unwrap runs first → {en:"hi"}, then locale unwrap with locale=en → "hi"
    expect(coerceFieldValue(f("text"), { fld: { en: "hi" } }, "en")).toBe("hi");
  });

  it("does NOT unwrap a self-keyed wrap when there are sibling keys", () => {
    // more than one key → not a self-keyed wrap
    expect(coerceFieldValue(f("text"), { fld: "hi", other: "x" })).toEqual({ fld: "hi", other: "x" });
  });
});

describe("coerceFieldValue: text-carrier unwrap (the 2026-06-04 wrapper dance)", () => {
  // The three exact shapes a production agent invented for a text field,
  // rejected three times in a row before this coercion existed.
  it("unwraps {type:'text', text:'X'} for text fields", () => {
    expect(coerceFieldValue(f("text"), { type: "text", text: "X" })).toBe("X");
  });
  it("unwraps {text:'X'} for text fields", () => {
    expect(coerceFieldValue(f("text"), { text: "X" })).toBe("X");
  });
  it("unwraps {raw:'X'} for markdown fields", () => {
    expect(coerceFieldValue(f("markdown"), { raw: "X" })).toBe("X");
  });
  it("unwraps {value:'X'} / {content:'X'} / {markdown:'X'}", () => {
    expect(coerceFieldValue(f("text"), { value: "X" })).toBe("X");
    expect(coerceFieldValue(f("markdown"), { content: "X" })).toBe("X");
    expect(coerceFieldValue(f("markdown"), { markdown: "X" })).toBe("X");
  });
  it("does NOT unwrap when a sibling key makes it ambiguous", () => {
    const v = { text: "X", html: "<b>X</b>" };
    expect(coerceFieldValue(f("text"), v)).toBe(v);
  });
  it("does NOT unwrap a non-string carrier ({text: 1})", () => {
    const v = { text: 1 };
    expect(coerceFieldValue(f("text"), v)).toBe(v);
  });
  it("does NOT unwrap for richtext fields (a PM text node is not a doc)", () => {
    const v = { type: "text", text: "X" };
    expect(coerceFieldValue(f("richtext"), v)).toBe(v);
  });

  // The 2026-06-07 13:0x run: the agent annotated SCALAR values with their
  // field type — {type:'select', value:'article'}, {type:'datetime', value:
  // '…Z'}, {type:'image', value:'<assetId>'} — and looped 8× on the reject.
  it("unwraps {type:'select', value:'X'} for select fields", () => {
    expect(coerceFieldValue(f("select"), { type: "select", value: "article" })).toBe("article");
    expect(coerceFieldValue(f("select"), { value: "article" })).toBe("article");
  });
  it("unwraps {type:'datetime', value:'X'} for datetime fields", () => {
    expect(coerceFieldValue(f("datetime"), { type: "datetime", value: "2026-06-07T12:00:00.000Z" })).toBe(
      "2026-06-07T12:00:00.000Z",
    );
  });
  it("unwraps {type:'image', value:'<assetId>'} for image fields", () => {
    expect(coerceFieldValue(f("image"), { type: "image", value: "dKgpZAnRFGVEfmTjlWHwgV_X" })).toBe(
      "dKgpZAnRFGVEfmTjlWHwgV_X",
    );
  });
  it("still does NOT unwrap ambiguous objects on scalar fields", () => {
    const v = { value: "article", label: "Article" };
    expect(coerceFieldValue(f("select"), v)).toBe(v);
  });
  it("an empty object ({} — the client-mangled long string) stays an object → validation error", () => {
    const v = {};
    expect(coerceFieldValue(f("markdown"), v)).toBe(v);
  });
});

describe("coerceFieldValue: locale-map unwrap edges", () => {
  it("picks the requested locale from a multi-locale map", () => {
    expect(coerceFieldValue(f("text"), { en: "a", nb: "b" }, "en")).toBe("a");
  });

  it("leaves a multi-locale map untouched when NO locale param is given (ambiguous)", () => {
    // Conservative: with >1 locale-shaped key and no locale to pick, it does not guess.
    expect(coerceFieldValue(f("text"), { en: "a", nb: "b" })).toEqual({ en: "a", nb: "b" });
  });

  it("unwraps a single locale-shaped key even when it is NOT the requested locale", () => {
    // single locale-shaped key → unwrapped regardless of which locale it is.
    expect(coerceFieldValue(f("text"), { nb: "norsk" }, "en")).toBe("norsk");
  });

  it("unwraps a single UNKNOWN-but-locale-shaped key (no locale param)", () => {
    expect(coerceFieldValue(f("text"), { xx: "a" })).toBe("a");
  });

  it("does NOT treat a 4+ char single key as a locale (left untouched)", () => {
    // LOCALE_KEY = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/ — 'href' is 4 chars, not locale-shaped.
    expect(coerceFieldValue(f("text"), { href: "x" })).toEqual({ href: "x" });
  });

  it("NOTE garbage-in: a 3-char-keyed junk object {foo:1} is locale-unwrapped to its inner value", () => {
    // NOTE: `foo` matches the locale regex (3 lowercase letters), so {foo:1} is
    // treated as a locale map and unwrapped to the number 1. For a text field
    // this 1 then fails downstream string validation (→ helpful 422), so it is
    // not silently persisted — but the coercion itself is lossy. Pinned as-is.
    expect(coerceFieldValue(f("text"), { foo: 1 })).toBe(1);
  });

  it("unwraps a locale-region key like {en-US: v} (single key)", () => {
    expect(coerceFieldValue(f("text"), { "en-US": "hi" })).toBe("hi");
  });
});

describe("coerceFieldValue: null / undefined / empty per field type", () => {
  for (const t of ["text", "markdown", "richtext", "number", "boolean", "image", "reference", "contentArea"] as const) {
    it(`returns null unchanged for ${t}`, () => {
      expect(coerceFieldValue(f(t), null)).toBeNull();
    });
    it(`returns undefined unchanged for ${t}`, () => {
      expect(coerceFieldValue(f(t), undefined)).toBeUndefined();
    });
  }

  it("empty string passes through a text field unchanged", () => {
    expect(coerceFieldValue(f("text"), "")).toBe("");
  });

  it("empty string passes through a markdown field unchanged", () => {
    expect(coerceFieldValue(f("markdown"), "")).toBe("");
  });

  it("empty string sent to a richtext field is wrapped into a doc with an empty paragraph", () => {
    expect(coerceFieldValue(f("richtext"), "")).toEqual({ type: "doc", content: [{ type: "paragraph", content: [] }] });
  });
});

describe("coerceFieldValue: scalar type mismatches are NOT coerced (no number/boolean parsing)", () => {
  it("does NOT parse a numeric string for a number field (left as a string)", () => {
    // The coercion layer does no string→number parsing; downstream Zod rejects it.
    expect(coerceFieldValue(f("number"), "42")).toBe("42");
  });

  it("leaves an actual number unchanged for a number field", () => {
    expect(coerceFieldValue(f("number"), 42)).toBe(42);
  });

  it('does NOT parse "true"/"false" strings for a boolean field', () => {
    expect(coerceFieldValue(f("boolean"), "true")).toBe("true");
    expect(coerceFieldValue(f("boolean"), "false")).toBe("false");
  });

  it("leaves an actual boolean unchanged", () => {
    expect(coerceFieldValue(f("boolean"), true)).toBe(true);
    expect(coerceFieldValue(f("boolean"), false)).toBe(false);
  });

  it("leaves a datetime string unchanged", () => {
    expect(coerceFieldValue(f("datetime"), "2026-01-15T09:00:00.000Z")).toBe("2026-01-15T09:00:00.000Z");
  });
});

describe("coerceFieldValue: arrays / objects sent to scalar fields", () => {
  it("an array sent to a text field passes through unchanged (rejected later by Zod)", () => {
    expect(coerceFieldValue(f("text"), [1, 2, 3])).toEqual([1, 2, 3]);
  });

  it("a non-tiptap, non-locale object sent to a text field with multiple keys passes through", () => {
    // {a:1,b:2} → both keys locale-shaped (2 chars) but >1 key and no locale → untouched.
    expect(coerceFieldValue(f("text"), { a1: 1, b2: 2 })).toEqual({ a1: 1, b2: 2 });
  });

  it("NOTE garbage-in: a plain object whose only key is locale-shaped collapses to its value on a text field", () => {
    // NOTE: {ab:"junk"} → "junk". A real non-locale object that happens to have a
    // single 2-3 char key is indistinguishable from a locale map here. The value
    // it collapses to must still satisfy the field's Zod schema downstream.
    expect(coerceFieldValue(f("text"), { ab: "junk" })).toBe("junk");
  });
});

describe("coerceFieldValue: markdown field receiving a deeply-nested TipTap doc", () => {
  it("converts nested lists + marks to structured Markdown (no word-gluing)", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "outer", marks: [{ type: "bold" }] }] },
                {
                  type: "bulletList",
                  content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "inner" }] }] }],
                },
              ],
            },
          ],
        },
      ],
    };
    const md = coerceFieldValue(f("markdown"), doc) as string;
    expect(typeof md).toBe("string");
    // nested list rendered with a 2-space indent under its parent item.
    expect(md).toBe("- **outer**\n  - inner");
  });
});

describe("coerceFieldValue: image / media field shapes", () => {
  it("extracts documentId from a resolved asset object {documentId, url, alt}", () => {
    expect(coerceFieldValue(f("image"), { documentId: "asset_1", url: "/u.png", alt: "A" })).toBe("asset_1");
  });

  it("leaves a bare documentId string unchanged", () => {
    expect(coerceFieldValue(f("image"), "asset_1")).toBe("asset_1");
  });

  it("media field: same documentId extraction as image", () => {
    expect(coerceFieldValue(f("media"), { documentId: "m_1", url: "/m.png" })).toBe("m_1");
  });

  it("REJECTS {url:'/u.png'} WITHOUT documentId on an image field (object passes through, fails validation)", () => {
    // 'url' matches the locale regex (3 chars) but sits in NOT_LOCALE_KEYS, so
    // the locale-unwrap stage no longer collapses it to a bare string. The image
    // branch finds no documentId and returns the object unchanged → downstream
    // z.string() rejects with the format hint instead of persisting '/u.png' as
    // a bogus documentId (the garbage-in-success-out this suite originally found).
    expect(coerceFieldValue(f("image"), { url: "/u.png" })).toEqual({ url: "/u.png" });
  });

  it("an image object with documentId='' (empty) and a url falls back to the raw value", () => {
    // documentId is empty → not used; but {documentId:'',url:'x'} has 2 keys so no
    // locale unwrap → the image branch returns the original object unchanged.
    expect(coerceFieldValue(f("image"), { documentId: "", url: "/u.png" })).toEqual({ documentId: "", url: "/u.png" });
  });

  it("normalizes an empty string to null for image / media (a cleared value, never an empty pseudo-id)", () => {
    // Harmonix 2026-06-12: a template-resolution failure sent image:"" through
    // create_content and it persisted as an empty pseudo-id with a success
    // response. "" carries no reference — normalize to null ("no image"), which
    // is also what the admin's legacy media text input emits when emptied.
    expect(coerceFieldValue(f("image"), "")).toBeNull();
    expect(coerceFieldValue(f("media"), "")).toBeNull();
  });
});

describe("coerceFieldValue: reference field shapes", () => {
  it("leaves a {documentId} object unchanged (already the write shape)", () => {
    // 'documentId' is a single 10-char key → not locale-shaped → untouched, and
    // reference has no special coercion branch.
    expect(coerceFieldValue(f("reference"), { documentId: "p1" })).toEqual({ documentId: "p1" });
  });

  it("leaves a {documentId, type} object unchanged", () => {
    expect(coerceFieldValue(f("reference"), { documentId: "p1", type: "ArticlePage" })).toEqual({ documentId: "p1", type: "ArticlePage" });
  });

  it("leaves a bare documentId string unchanged for a reference field (rejected later by Zod)", () => {
    expect(coerceFieldValue(f("reference"), "p1")).toBe("p1");
  });
});

describe("coerceFieldValue: contentArea shapes", () => {
  it("wraps a single block object (has blockType) into an array", () => {
    const block = { key: "b1", blockType: "HeroBlock", display: "full", ref: null, inline: { title: "Hi" } };
    expect(coerceFieldValue(f("contentArea"), block)).toEqual([block]);
  });

  it("leaves an already-array content area unchanged", () => {
    const arr = [{ key: "b1", blockType: "HeroBlock" }];
    expect(coerceFieldValue(f("contentArea"), arr)).toEqual(arr);
  });

  it("NOTE garbage-in: a non-block object with a single locale-shaped key collapses to its inner value", () => {
    // NOTE: {foo:1} → 1 (locale-unwrap). It is NOT a block (no blockType) so it is
    // not array-wrapped. The scalar 1 then fails the ContentArea array schema → 422.
    expect(coerceFieldValue(f("contentArea"), { foo: 1 })).toBe(1);
  });

  it("does NOT wrap a plain object lacking blockType (multi-key, no locale collapse)", () => {
    // {title:'x',body:'y'} → 5/4-char keys, not locale-shaped, >1 key → untouched,
    // and no blockType so not array-wrapped → passes through to fail Zod.
    expect(coerceFieldValue(f("contentArea"), { title: "x", body: "y" })).toEqual({ title: "x", body: "y" });
  });
});

describe("coerceFieldValue: richtext from plain string + out-of-schema normalization", () => {
  it("wraps a multi-paragraph plain string into a doc, splitting on blank lines", () => {
    expect(coerceFieldValue(f("richtext"), "Para one\n\nPara two")).toEqual({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Para one" }] },
        { type: "paragraph", content: [{ type: "text", text: "Para two" }] },
      ],
    });
  });

  it("normalizes an out-of-schema richtext doc (unknown node husked, alias applied)", () => {
    const out = coerceFieldValue(f("richtext"), {
      type: "doc",
      content: [{ type: "separator" }, { type: "callout", content: [{ type: "text", text: "x" }] }],
    }) as { content: Array<{ type: string }> };
    expect(out.content.map((n) => n.type)).toEqual(["horizontalRule", "paragraph"]);
  });

  it("a non-doc, non-string value for richtext is returned unchanged (not forced into a doc)", () => {
    // looksLikeTiptapDoc is false for a number → returned as-is (Zod rejects later).
    expect(coerceFieldValue(f("richtext"), 5)).toBe(5);
  });

  // Agents send MARKDOWN to richtext fields (set_field is a string). Wrapping
  // it as literal plaintext rendered "#", "**", "-" verbatim (2026-06-07).
  // The coercion now PARSES the markdown into structured TipTap nodes.
  it("parses markdown structure (headings, bold, lists) into TipTap nodes", () => {
    const md = "## Title\n\nA **bold** word.\n\n- one\n- two";
    const doc = coerceFieldValue(f("richtext"), md) as {
      content: Array<{ type: string; attrs?: { level?: number }; content?: unknown[] }>;
    };
    const types = doc.content.map((n) => n.type);
    expect(types).toEqual(["heading", "paragraph", "bulletList"]);

    const heading = doc.content[0]!;
    expect(heading.attrs?.level).toBe(2);
    expect((heading.content as Array<{ text: string }>)[0]!.text).toBe("Title");

    // The bold word carries a bold mark — not literal asterisks.
    const para = JSON.stringify(doc.content[1]);
    expect(para).toContain('"bold"');
    expect(para).toContain('"bold"');
    expect(para).not.toContain("**");

    const list = doc.content[2]!;
    expect((list.content as unknown[]).length).toBe(2); // two listItems
  });

  it("maps a markdown link to a link mark with href", () => {
    const doc = coerceFieldValue(f("richtext"), "See [the docs](https://example.com/x).") as {
      content: Array<{ content?: Array<{ text?: string; marks?: Array<{ type: string; attrs?: { href?: string } }> }> }>;
    };
    const linkNode = doc.content[0]!.content!.find((n) => n.marks?.some((m) => m.type === "link"));
    expect(linkNode?.text).toBe("the docs");
    expect(linkNode?.marks?.find((m) => m.type === "link")?.attrs?.href).toBe("https://example.com/x");
  });

  it("clamps heading level to the editor schema (2–3): a single # becomes level 2", () => {
    const doc = coerceFieldValue(f("richtext"), "# Top") as { content: Array<{ attrs?: { level?: number } }> };
    expect(doc.content[0]!.attrs?.level).toBe(2);
  });
});

describe("coerceData: applies per-field coercion across a content type, only to present fields", () => {
  const ct: ContentTypeDef = {
    name: "LandingPage",
    displayName: "Landing Page",
    kind: "page",
    description: "",
    icon: "file",
    fields: [
      f("text", { name: "heading" }),
      f("markdown", { name: "body" }),
      f("contentArea", { name: "mainArea" }),
      f("image", { name: "hero" }),
    ],
  };

  it("coerces each present field by its type and leaves absent fields out", () => {
    const out = coerceData(
      ct,
      {
        heading: { en: "Hi" }, // locale unwrap
        body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "p" }] }] }, // tiptap→md
        mainArea: { key: "b", blockType: "X", inline: {}, ref: null }, // single block→array
        hero: { documentId: "a1", url: "/x" }, // asset→documentId
      },
      "en",
    );
    expect(out.heading).toBe("Hi");
    expect(out.body).toBe("p");
    expect(Array.isArray(out.mainArea)).toBe(true);
    expect(out.hero).toBe("a1");
  });

  it("does not touch keys that are not declared fields of the type", () => {
    const out = coerceData(ct, { heading: "H", notAField: { en: "leftAlone" } }, "en");
    expect(out.heading).toBe("H");
    // notAField is not a declared field → coerceData skips it entirely.
    expect(out.notAField).toEqual({ en: "leftAlone" });
  });

  it("returns a new object (does not mutate the input)", () => {
    const input = { heading: "H" };
    const out = coerceData(ct, input, "en");
    expect(out).not.toBe(input);
    expect(input).toEqual({ heading: "H" });
  });
});
