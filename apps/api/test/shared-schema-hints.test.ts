import { describe, expect, it } from "vitest";
import { type ContentTypeDef, type FieldDef, type FieldType, dataSchemaFor, fieldFormatHint } from "@paperboy/shared";

/**
 * `dataSchemaFor` (draft vs strict-publish validation) and `fieldFormatHint`
 * (the valueFormat/valueExample contract surfaced to agents).
 *
 * The hint shape mirrors `withFieldFormats` in apps/mcp/src/server.ts:
 *   const { format, example } = fieldFormatHint(f);
 *   return { ...f, valueFormat: format, valueExample: example };
 * i.e. get_content_type returns each field with `valueFormat` + `valueExample`.
 *
 * Pure: imports @paperboy/shared only.
 */

const f = (type: FieldType, extra: Partial<FieldDef> = {}): FieldDef => ({
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

const ct = (fields: FieldDef[]): ContentTypeDef => ({
  name: "T",
  displayName: "T",
  kind: "page",
  description: "",
  icon: "file",
  fields,
});

const accepts = (type: ContentTypeDef, strict: boolean, data: unknown) =>
  dataSchemaFor(type, strict).safeParse(data).success;

describe("fieldFormatHint: each field type names its expected shape + a copyable example", () => {
  it("text", () => {
    const h = fieldFormatHint(f("text"));
    expect(h.format).toContain("string");
    expect(typeof h.example).toBe("string");
  });

  it("markdown names Markdown and gives a Markdown example string", () => {
    const h = fieldFormatHint(f("markdown"));
    expect(h.format).toContain("Markdown");
    expect(typeof h.example).toBe("string");
    expect(h.example as string).toContain("#");
  });

  it("richtext names a TipTap document and the example is a real doc object", () => {
    const h = fieldFormatHint(f("richtext"));
    expect(h.format).toContain("TipTap");
    expect(h.format).toContain("not a string");
    expect((h.example as { type: string }).type).toBe("doc");
  });

  it("boolean / number / datetime", () => {
    expect(fieldFormatHint(f("boolean")).format).toContain("boolean");
    expect(fieldFormatHint(f("boolean")).example).toBe(true);
    expect(fieldFormatHint(f("number")).format).toContain("number");
    expect(typeof fieldFormatHint(f("number")).example).toBe("number");
    expect(fieldFormatHint(f("datetime")).format).toContain("ISO-8601");
    expect(typeof fieldFormatHint(f("datetime")).example).toBe("string");
  });

  it("select single uses the first option value as the example", () => {
    const h = fieldFormatHint(f("select", { options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] }));
    expect(h.format).toContain("one option-value string");
    expect(h.example).toBe("a");
  });

  it("select single with no options falls back to a placeholder example", () => {
    const h = fieldFormatHint(f("select"));
    expect(h.example).toBe("option-value");
  });

  it("select multiple says 'array' and the example is an array of option values", () => {
    const h = fieldFormatHint(f("select", { multiple: true, options: [{ value: "a", label: "A" }] }));
    expect(h.format).toContain("array");
    expect(h.example).toEqual(["a"]);
  });

  it("link names the object shape with href", () => {
    const h = fieldFormatHint(f("link"));
    expect(h.format).toContain("href");
    expect((h.example as { href: string }).href).toContain("http");
  });

  it("image / media both name an asset documentId string", () => {
    expect(fieldFormatHint(f("image")).format).toContain("documentId");
    expect(typeof fieldFormatHint(f("image")).example).toBe("string");
    expect(fieldFormatHint(f("media")).format).toContain("documentId");
  });

  it("reference names a { documentId, type? } object", () => {
    const h = fieldFormatHint(f("reference"));
    expect(h.format).toContain("documentId");
    expect((h.example as { documentId: string }).documentId).toBeTruthy();
  });

  it("contentArea names an ARRAY of block instances; the example is a real array of blocks", () => {
    const h = fieldFormatHint(f("contentArea"));
    expect(h.format).toContain("ARRAY");
    expect(Array.isArray(h.example)).toBe(true);
    expect((h.example as Array<{ blockType: string }>)[0]!.blockType).toBeTruthy();
  });

  it("every field type produces a non-empty format and a defined example (the agent contract)", () => {
    const allTypes: FieldType[] = [
      "text",
      "markdown",
      "richtext",
      "boolean",
      "number",
      "datetime",
      "select",
      "link",
      "image",
      "media",
      "reference",
      "contentArea",
    ];
    for (const t of allTypes) {
      const h = fieldFormatHint(f(t));
      expect(h.format.length, `format for ${t}`).toBeGreaterThan(0);
      expect(h.example, `example for ${t}`).toBeDefined();
    }
  });
});

describe("dataSchemaFor: required fields enforced only on publish (strict)", () => {
  const type = ct([f("text", { name: "title", required: true })]);

  it("draft: a missing required field is accepted", () => {
    expect(accepts(type, false, {})).toBe(true);
  });

  it("publish: a missing required field is rejected", () => {
    expect(accepts(type, true, {})).toBe(false);
  });

  it("publish: a present required field is accepted", () => {
    expect(accepts(type, true, { title: "hi" })).toBe(true);
  });

  it("publish: an explicit null in a required field is rejected", () => {
    expect(accepts(type, true, { title: null })).toBe(false);
  });

  it("draft: an explicit null in an optional field is accepted (optional+nullable)", () => {
    const optType = ct([f("text", { name: "title" })]);
    expect(accepts(optType, false, { title: null })).toBe(true);
  });
});

describe("dataSchemaFor: per-field validation rules apply only in strict mode", () => {
  it("text minLength: violated in strict (reject), ignored in draft (accept)", () => {
    const type = ct([f("text", { name: "a", validation: { minLength: 5 } })]);
    expect(accepts(type, true, { a: "hi" })).toBe(false);
    expect(accepts(type, false, { a: "hi" })).toBe(true);
  });

  it("text maxLength: violated in strict (reject)", () => {
    const type = ct([f("text", { name: "a", validation: { maxLength: 3 } })]);
    expect(accepts(type, true, { a: "toolong" })).toBe(false);
    expect(accepts(type, true, { a: "ok" })).toBe(true);
  });

  it("text pattern (regex): violated in strict (reject), satisfied (accept)", () => {
    const type = ct([f("text", { name: "a", validation: { pattern: "^[0-9]+$" } })]);
    expect(accepts(type, true, { a: "abc" })).toBe(false);
    expect(accepts(type, true, { a: "123" })).toBe(true);
  });

  it("an INVALID stored regex pattern does not crash validation (value accepted)", () => {
    const type = ct([f("text", { name: "a", validation: { pattern: "(" } })]);
    // The bad pattern is swallowed; validation falls back to a plain string check.
    expect(accepts(type, true, { a: "anything" })).toBe(true);
  });

  it("number min/max: violated in strict (reject), within range (accept)", () => {
    const type = ct([f("number", { name: "a", validation: { min: 1, max: 10 } })]);
    expect(accepts(type, true, { a: 0 })).toBe(false);
    expect(accepts(type, true, { a: 99 })).toBe(false);
    expect(accepts(type, true, { a: 5 })).toBe(true);
  });

  it("number range is NOT enforced in draft mode", () => {
    const type = ct([f("number", { name: "a", validation: { min: 1, max: 10 } })]);
    expect(accepts(type, false, { a: 99 })).toBe(true);
  });
});

describe("dataSchemaFor: representative valid/invalid per field type", () => {
  const single = (field: FieldDef, value: unknown, strict = true) => accepts(ct([{ ...field, name: "v" }]), strict, { v: value });

  it("text accepts a string, rejects a number", () => {
    expect(single(f("text"), "hi")).toBe(true);
    expect(single(f("text"), 5)).toBe(false);
  });

  it("markdown accepts a string, rejects an object", () => {
    expect(single(f("markdown"), "## md")).toBe(true);
    expect(single(f("markdown"), { type: "doc" })).toBe(false);
  });

  it("richtext accepts an object (record), rejects a plain string", () => {
    expect(single(f("richtext"), { type: "doc", content: [] })).toBe(true);
    expect(single(f("richtext"), "not a doc")).toBe(false);
  });

  it("boolean accepts true/false, rejects the strings 'true'/'false'", () => {
    expect(single(f("boolean"), true)).toBe(true);
    expect(single(f("boolean"), false)).toBe(true);
    expect(single(f("boolean"), "true")).toBe(false);
  });

  it("number accepts a number, rejects a numeric string", () => {
    expect(single(f("number"), 42)).toBe(true);
    expect(single(f("number"), "42")).toBe(false);
  });

  it("datetime accepts any string (ISO not regex-enforced here)", () => {
    expect(single(f("datetime"), "2026-01-15T09:00:00.000Z")).toBe(true);
    expect(single(f("datetime"), 1736931600000)).toBe(false);
  });

  it("select single: strict rejects an out-of-list value, draft accepts it", () => {
    const sel = f("select", { options: [{ value: "x", label: "X" }] });
    expect(single(sel, "y", true)).toBe(false);
    expect(single(sel, "y", false)).toBe(true);
    expect(single(sel, "x", true)).toBe(true);
  });

  it("select multiple: accepts an array of values", () => {
    const sel = f("select", { multiple: true, options: [{ value: "x", label: "X" }] });
    expect(single(sel, ["x"], true)).toBe(true);
    expect(single(sel, "x", true)).toBe(false); // not an array
  });

  it("select single with NO options: strict accepts any string (no option list to enforce)", () => {
    const sel = f("select", { options: [] });
    expect(single(sel, "anything", true)).toBe(true);
  });

  it("link accepts {href}, rejects a bare string", () => {
    expect(single(f("link"), { href: "https://x" })).toBe(true);
    expect(single(f("link"), "https://x")).toBe(false);
  });

  it("image / media accept a documentId string, reject an object", () => {
    expect(single(f("image"), "asset_1")).toBe(true);
    expect(single(f("image"), { documentId: "asset_1" })).toBe(false);
    expect(single(f("media"), "asset_1")).toBe(true);
  });

  it("reference accepts {documentId}, accepts {documentId,type}, rejects a bare string", () => {
    expect(single(f("reference"), { documentId: "p1" })).toBe(true);
    expect(single(f("reference"), { documentId: "p1", type: "ArticlePage" })).toBe(true);
    expect(single(f("reference"), "p1")).toBe(false);
  });

  it("contentArea accepts an array of valid block instances, rejects a single block object", () => {
    expect(single(f("contentArea"), [{ key: "b1", blockType: "Hero", display: "full", ref: null, inline: { x: 1 } }])).toBe(true);
    // a block must be inline XOR ref — both null is invalid
    expect(single(f("contentArea"), [{ key: "b1", blockType: "Hero", ref: null, inline: null }])).toBe(false);
    // a bare object is not an array
    expect(single(f("contentArea"), { key: "b1", blockType: "Hero" })).toBe(false);
  });
});

describe("dataSchemaFor: object-level behavior", () => {
  it("passes through unknown keys (passthrough schema)", () => {
    const type = ct([f("text", { name: "a" })]);
    const parsed = dataSchemaFor(type, true).safeParse({ a: "x", unknownExtra: 1 });
    expect(parsed.success).toBe(true);
    expect((parsed as { data: Record<string, unknown> }).data.unknownExtra).toBe(1);
  });

  it("multiple required fields: strict rejects unless all are present", () => {
    const type = ct([f("text", { name: "a", required: true }), f("number", { name: "b", required: true })]);
    expect(accepts(type, true, { a: "x" })).toBe(false);
    expect(accepts(type, true, { a: "x", b: 1 })).toBe(true);
  });
});
