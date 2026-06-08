import { describe, expect, it } from "vitest";
import { applyRichTextStrings, collectRichTextStrings } from "./richtext-strings.js";

const doc = () => ({
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Tittel" }] },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Hei " },
        { type: "text", text: "verden", marks: [{ type: "bold" }] },
      ],
    },
    {
      type: "bulletList",
      content: [
        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Punkt" }] }] },
      ],
    },
  ],
});

describe("collectRichTextStrings", () => {
  it("returns every text node in document order", () => {
    expect(collectRichTextStrings(doc())).toEqual(["Tittel", "Hei ", "verden", "Punkt"]);
  });

  it("returns [] for an empty/structure-only doc", () => {
    expect(collectRichTextStrings({ type: "doc", content: [{ type: "paragraph", content: [] }] })).toEqual([]);
  });
});

describe("applyRichTextStrings", () => {
  it("swaps text in order while preserving structure and marks", () => {
    const out = applyRichTextStrings(doc(), ["Title", "Hello ", "world", "Item"]) as ReturnType<typeof doc>;
    expect(collectRichTextStrings(out)).toEqual(["Title", "Hello ", "world", "Item"]);
    // structure + marks untouched
    expect(out.content[0]!.type).toBe("heading");
    expect(out.content[0]!.attrs!.level).toBe(2);
    const bold = (out.content[1]!.content as Array<{ marks?: unknown[] }>)[1]!.marks;
    expect(bold).toEqual([{ type: "bold" }]);
    expect(out.content[2]!.type).toBe("bulletList");
  });

  it("does not mutate the source document", () => {
    const src = doc();
    applyRichTextStrings(src, ["X", "Y", "Z", "W"]);
    expect(collectRichTextStrings(src)).toEqual(["Tittel", "Hei ", "verden", "Punkt"]);
  });

  it("keeps the original text where a replacement is missing (short/failed batch)", () => {
    const out = applyRichTextStrings(doc(), ["Title"]); // only first provided
    expect(collectRichTextStrings(out)).toEqual(["Title", "Hei ", "verden", "Punkt"]);
  });

  it("round-trips: collect → apply(same) is identity", () => {
    const d = doc();
    const out = applyRichTextStrings(d, collectRichTextStrings(d));
    expect(out).toEqual(d);
  });
});
