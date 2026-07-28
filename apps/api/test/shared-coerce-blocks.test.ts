import { describe, expect, it } from "vitest";
import { type ContentTypeDef, type FieldDef, coerceData } from "@paperboy/shared";

/** A coerced richtext value is a TipTap doc node, never a raw string. */
const isRichTextDoc = (v: unknown): boolean =>
  !!v && typeof v === "object" && (v as { type?: unknown }).type === "doc" && Array.isArray((v as { content?: unknown }).content);

/**
 * The coercion chokepoint stopped at the TOP LEVEL: `coerceData` iterated
 * `type.fields` and never descended into a contentArea's INLINE block data. So
 * every incident-derived guarantee held for a page field and silently vanished one
 * level down, inside a block — which is the CMS's headline feature.
 *
 * Concretely (agent-API rule #1, garbage-in-success-out): writing raw Markdown into
 * a block's `richtext` field returned 200 OK and PERSISTED the string. Delivery then
 * advertised `fieldTypes.body: "richtext"` with a string value, so renderRichText
 * returned "" and the block rendered BLANK, while TipTap opened an empty editor. The
 * identical write to a top-level richtext field was correctly parsed into a doc.
 *
 * Rule #3 says all tolerant coercion lives in ONE chokepoint — so the chokepoint has
 * to reach the whole document, not just its first level.
 */
const f = (name: string, type: FieldDef["type"], extra: Partial<FieldDef> = {}): FieldDef => ({
  name,
  displayName: name,
  type,
  localized: false,
  required: false,
  delivery: "public",
  allowedBlocks: [],
  allowedTypes: [],
  options: [],
  multiple: false,
  group: "Content",
  ...extra,
});

const CARD: ContentTypeDef = {
  name: "CardBlock",
  displayName: "Card",
  kind: "block",
  fields: [f("title", "text"), f("body", "richtext"), f("hero", "image")],
};

const PAGE: ContentTypeDef = {
  name: "LandingPage",
  displayName: "Landing",
  kind: "page",
  fields: [f("heading", "text"), f("mainArea", "contentArea", { allowedBlocks: ["CardBlock"] })],
};

/** Nests itself, to prove the recursion terminates. */
const SELF: ContentTypeDef = {
  name: "SelfBlock",
  displayName: "Self",
  kind: "block",
  fields: [f("body", "richtext"), f("inner", "contentArea", { allowedBlocks: ["SelfBlock"] })],
};

const resolve = (name: string): ContentTypeDef | undefined =>
  ({ CardBlock: CARD, SelfBlock: SELF })[name];

const block = (blockType: string, inline: Record<string, unknown>) => ({
  key: "k1",
  blockType,
  display: "automatic",
  shared: false,
  ref: null,
  inline,
});

describe("coerceData recurses into content-area inline block data", () => {
  it("converts a Markdown STRING in a block's richtext field into a real doc", () => {
    const out = coerceData(
      PAGE,
      { heading: "Hi", mainArea: [block("CardBlock", { title: "Card", body: "## Heading\n\n**bold**" })] },
      "en",
      resolve,
    );
    const inline = (out.mainArea as Array<{ inline: Record<string, unknown> }>)[0]!.inline;
    expect(isRichTextDoc(inline.body), `body stayed a raw string: ${JSON.stringify(inline.body)}`).toBe(true);
  });

  it("normalizes a resolved asset OBJECT back to a documentId in a block image field", () => {
    const out = coerceData(
      PAGE,
      {
        mainArea: [
          block("CardBlock", { hero: { documentId: "asset123", url: "/api/v1/media/x.png", alt: "x" } }),
        ],
      },
      "en",
      resolve,
    );
    const inline = (out.mainArea as Array<{ inline: Record<string, unknown> }>)[0]!.inline;
    expect(inline.hero).toBe("asset123");
  });

  it("normalizes an empty-string asset to null inside a block (not a pseudo-id)", () => {
    const out = coerceData(PAGE, { mainArea: [block("CardBlock", { hero: "" })] }, "en", resolve);
    const inline = (out.mainArea as Array<{ inline: Record<string, unknown> }>)[0]!.inline;
    expect(inline.hero).toBeNull();
  });

  it("unwraps a self-keyed wrap inside a block ({title: {title: v}})", () => {
    const out = coerceData(PAGE, { mainArea: [block("CardBlock", { title: { title: "Real" } })] }, "en", resolve);
    const inline = (out.mainArea as Array<{ inline: Record<string, unknown> }>)[0]!.inline;
    expect(inline.title).toBe("Real");
  });

  it("leaves the block envelope (key/blockType/display/shared/ref) untouched", () => {
    const out = coerceData(PAGE, { mainArea: [block("CardBlock", { title: "T" })] }, "en", resolve);
    const b = (out.mainArea as Array<Record<string, unknown>>)[0]!;
    expect(b).toMatchObject({ key: "k1", blockType: "CardBlock", display: "automatic", shared: false, ref: null });
  });

  it("passes through a SHARED block (no inline data to coerce)", () => {
    const shared = { key: "k2", blockType: "CardBlock", display: "automatic", shared: true, ref: "doc9", inline: null };
    const out = coerceData(PAGE, { mainArea: [shared] }, "en", resolve);
    expect((out.mainArea as unknown[])[0]).toEqual(shared);
  });

  it("leaves an unknown blockType's inline data alone rather than guessing", () => {
    const out = coerceData(PAGE, { mainArea: [block("NopeBlock", { body: "## md" })] }, "en", resolve);
    const inline = (out.mainArea as Array<{ inline: Record<string, unknown> }>)[0]!.inline;
    expect(inline.body).toBe("## md");
  });

  it("recurses into NESTED content areas inside blocks", () => {
    const out = coerceData(
      { name: "P", displayName: "P", kind: "page", fields: [f("area", "contentArea")] } as ContentTypeDef,
      { area: [block("SelfBlock", { body: "# outer", inner: [block("SelfBlock", { body: "# inner" })] })] },
      "en",
      resolve,
    );
    const outer = (out.area as Array<{ inline: Record<string, unknown> }>)[0]!.inline;
    expect(isRichTextDoc(outer.body)).toBe(true);
    const inner = (outer.inner as Array<{ inline: Record<string, unknown> }>)[0]!.inline;
    expect(isRichTextDoc(inner.body)).toBe(true);
  });

  it("terminates on a deeply self-nesting area instead of recursing forever", () => {
    // Build a chain deeper than any sane depth guard.
    let node: Record<string, unknown> = block("SelfBlock", { body: "# deep" });
    for (let i = 0; i < 30; i++) node = block("SelfBlock", { body: "# d", inner: [node] });
    expect(() =>
      coerceData(
        { name: "P", displayName: "P", kind: "page", fields: [f("area", "contentArea")] } as ContentTypeDef,
        { area: [node] },
        "en",
        resolve,
      ),
    ).not.toThrow();
  });

  it("without a resolver, behaves exactly as before (back-compat)", () => {
    const data = { mainArea: [block("CardBlock", { body: "## md" })] };
    const out = coerceData(PAGE, data, "en");
    const inline = (out.mainArea as Array<{ inline: Record<string, unknown> }>)[0]!.inline;
    expect(inline.body).toBe("## md");
  });
});
