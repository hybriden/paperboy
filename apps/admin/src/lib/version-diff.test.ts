import { describe, expect, it } from "vitest";
import type { ContentTypeDef } from "@paperboy/shared";
import type { VersionDetail } from "./api.js";
import { DIFF_CELL_CAP, type DiffSegment, diffFields, docToText, wordDiff } from "./version-diff.js";

/** The A side is every eq+del token, the B side every eq+ins token — a diff
 *  that does not reproduce both inputs is wrong whatever it highlights. */
function sides(segments: DiffSegment[]): { a: string; b: string } {
  return {
    a: segments.filter((s) => s.t !== "ins").map((s) => s.s).join(""),
    b: segments.filter((s) => s.t !== "del").map((s) => s.s).join(""),
  };
}
const words = (segments: DiffSegment[]) => segments.filter((s) => s.s.trim()).map((s) => `${s.t}:${s.s}`);

describe("wordDiff", () => {
  it("equal text is all eq", () => {
    const d = wordDiff("same text here", "same text here")!;
    expect(d.every((s) => s.t === "eq")).toBe(true);
    expect(sides(d)).toEqual({ a: "same text here", b: "same text here" });
  });

  it("marks an inserted word", () => {
    const d = wordDiff("a b", "a c b")!;
    expect(words(d)).toEqual(["eq:a", "ins:c", "eq:b"]);
    expect(sides(d)).toEqual({ a: "a b", b: "a c b" });
  });

  it("marks a deleted word", () => {
    const d = wordDiff("a c b", "a b")!;
    expect(words(d)).toEqual(["eq:a", "del:c", "eq:b"]);
    expect(sides(d)).toEqual({ a: "a c b", b: "a b" });
  });

  it("handles an empty side", () => {
    expect(words(wordDiff("", "new")!)).toEqual(["ins:new"]);
    expect(words(wordDiff("old", "")!)).toEqual(["del:old"]);
  });

  it("diffs paragraph by paragraph: an untouched paragraph stays eq, a changed one diffs inside", () => {
    const d = wordDiff("one\ntwo\nthree", "one\ntwo changed\nthree")!;
    expect(words(d)).toEqual(["eq:one", "eq:two", "ins:changed", "eq:three"]);
    expect(sides(d)).toEqual({ a: "one\ntwo\nthree", b: "one\ntwo changed\nthree" });
  });

  it("an inserted paragraph is one ins, not a word-by-word shuffle of its neighbours", () => {
    const d = wordDiff("one\nthree", "one\ntwo\nthree")!;
    expect(words(d)).toEqual(["eq:one", "ins:two", "eq:three"]);
    expect(sides(d)).toEqual({ a: "one\nthree", b: "one\ntwo\nthree" });
  });

  it("gives up (null) instead of allocating a 6000×6000 matrix for one huge paragraph", () => {
    const a = Array.from({ length: 6000 }, (_, i) => `w${i}`).join(" ");
    const b = Array.from({ length: 6000 }, (_, i) => `x${i}`).join(" ");
    expect(6000 * 6000).toBeGreaterThan(DIFF_CELL_CAP);
    const t0 = performance.now();
    expect(wordDiff(a, b)).toBeNull();
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it("still diffs 6000 tokens when they are paragraph-structured", () => {
    const para = (p: number, prefix: string) => Array.from({ length: 60 }, (_, i) => `${prefix}${p}_${i}`).join(" ");
    const a = Array.from({ length: 100 }, (_, p) => para(p, "w")).join("\n");
    const b = Array.from({ length: 100 }, (_, p) => para(p, p % 2 ? "w" : "x")).join("\n");
    const t0 = performance.now();
    const d = wordDiff(a, b);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(d).not.toBeNull();
    expect(sides(d!)).toEqual({ a, b });
  });
});

describe("docToText", () => {
  it("joins block nodes with newlines and inline text without separators; marks are ignored", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Hello " }, { type: "text", text: "world", marks: [{ type: "bold" }] }] },
        { type: "paragraph" },
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Next" }] },
        { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "item" }] }] }] },
      ],
    };
    expect(docToText(doc)).toBe("Hello world\nNext\nitem");
  });

  it("is empty for nothing", () => {
    expect(docToText(null)).toBe("");
    expect(docToText({ type: "doc", content: [{ type: "paragraph" }] })).toBe("");
  });
});

describe("diffFields", () => {
  const type = {
    fields: [
      { name: "body", displayName: "Body", type: "richtext" },
      { name: "tags", displayName: "Tags", type: "select", multiple: true },
    ],
  } as unknown as ContentTypeDef;
  const version = (name: string, data: Record<string, unknown>): VersionDetail =>
    ({ id: 1, versionNumber: 1, status: "draft", isCurrentPublished: false, name, slug: "s", displayInNav: true, data, createdAt: "", createdBy: null });

  it("flattens every field to comparable text and flags what changed", () => {
    const a = version("Title", { body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Old" }] }] }, tags: ["x"] });
    const b = version("Title", { body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "New" }] }] }, tags: ["x"] });
    const out = diffFields(type, a, b);
    expect(out.map((f) => [f.key, f.changed])).toEqual([["__name", false], ["__slug", false], ["__nav", false], ["body", true], ["tags", false]]);
    expect(out.find((f) => f.key === "body")).toMatchObject({ aText: "Old", bText: "New" });
    expect(out.find((f) => f.key === "tags")).toMatchObject({ aText: "x", bText: "x" });
  });
});
