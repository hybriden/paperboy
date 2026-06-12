import { describe, expect, it } from "vitest";
import {
  CREATIVE_WORK_TYPES,
  SCHEMA_FIELD_CATALOG,
  type FieldDef,
  isCreativeWorkType,
  normalizeSchemaFields,
  resolveSchemaSuggestions,
  schemaFieldGaps,
  seoRoleEligible,
} from "@paperboy/shared";

/**
 * The schema.org catalog behind delivery's per-@type emission and the type
 * editor's "add missing fields" helper. Pure: imports @paperboy/shared only.
 */

const f = (name: string, type: FieldDef["type"], extra: Partial<FieldDef> = {}) =>
  ({ name, type, seoRole: extra.seoRole, schemaProp: extra.schemaProp }) as Pick<
    FieldDef,
    "name" | "type" | "seoRole" | "schemaProp"
  >;

describe("isCreativeWorkType: the emission split", () => {
  it("classifies the dropdown types the way delivery emits them", () => {
    for (const t of ["WebPage", "Article", "BlogPosting", "NewsArticle", "CollectionPage", "AboutPage", "ContactPage", "FAQPage"]) {
      expect(isCreativeWorkType(t), t).toBe(true);
    }
    expect(isCreativeWorkType("Product")).toBe(false);
    expect(isCreativeWorkType("Event")).toBe(false);
    // Unknown custom types fall to the safe Thing subset on purpose.
    expect(isCreativeWorkType("JobPosting")).toBe(false);
    expect(isCreativeWorkType("LocalBusiness")).toBe(false);
  });
});

describe("schemaFieldGaps: coverage against a type's fields", () => {
  it("unknown @type → null (the AI suggestion path takes over)", () => {
    expect(schemaFieldGaps("JobPosting", [])).toBeNull();
    expect(schemaFieldGaps("", [])).toBeNull();
  });

  it("Event with no fields: every suggestion uncovered; startDate and location are required", () => {
    const gaps = schemaFieldGaps("Event", [])!;
    expect(gaps.every((g) => g.coveredBy === null && g.tagField === null)).toBe(true);
    const required = gaps.filter((g) => g.suggestion.required).map((g) => g.suggestion.prop);
    expect(required).toContain("startDate");
    expect(required).toContain("location");
  });

  it("an explicit schemaProp covers its suggestion regardless of the field's name", () => {
    const gaps = schemaFieldGaps("Event", [f("when", "datetime", { schemaProp: "startDate" })])!;
    expect(gaps.find((g) => g.suggestion.prop === "startDate")!.coveredBy).toBe("when");
  });

  it("a same-named untagged field becomes a TAG candidate, not a duplicate", () => {
    const gaps = schemaFieldGaps("Event", [f("startDate", "datetime")])!;
    const g = gaps.find((x) => x.suggestion.prop === "startDate")!;
    expect(g.coveredBy).toBeNull(); // untagged → delivery would NOT emit it
    expect(g.tagField).toBe("startDate"); // so the apply step tags it instead of adding
  });

  it("a type-mismatched same-named field is NOT a tag candidate", () => {
    // A text 'startDate' can't carry the datetime suggestion — adding a new
    // field (under a clashing name the editor will surface) beats mis-tagging.
    const gaps = schemaFieldGaps("Event", [f("startDate", "text")])!;
    expect(gaps.find((x) => x.suggestion.prop === "startDate")!.tagField).toBeNull();
  });

  it("seoRole suggestions are covered by delivery's name convention (heading ⇒ title)", () => {
    const gaps = schemaFieldGaps("WebPage", [f("heading", "text")])!;
    expect(gaps.find((g) => g.suggestion.prop === "name / headline")!.coveredBy).toBe("heading");
  });

  it("an explicit seoRole covers its suggestion regardless of the field's name", () => {
    const gaps = schemaFieldGaps("Article", [f("overskrift", "text", { seoRole: "title" })])!;
    expect(gaps.find((g) => g.suggestion.prop === "name / headline")!.coveredBy).toBe("overskrift");
  });

  it("Product requires offers.price + offers.priceCurrency (the Google rich-result gate)", () => {
    const required = schemaFieldGaps("Product", [])!
      .filter((g) => g.suggestion.required)
      .map((g) => g.suggestion.prop);
    expect(required).toContain("offers.price");
    expect(required).toContain("offers.priceCurrency");
  });
});

describe("normalizeSchemaFields: the AI schema_fields reply contract", () => {
  const valid = JSON.stringify([
    { prop: "datePosted", required: true, field: { name: "datePosted", displayName: "Date posted", type: "datetime", schemaProp: "datePosted" } },
  ]);

  it("accepts a clean JSON array and round-trips it validated", () => {
    const out = JSON.parse(normalizeSchemaFields(valid));
    expect(out[0].field.schemaProp).toBe("datePosted");
    expect(out[0].required).toBe(true);
  });

  it("strips code fences and surrounding prose (models add them despite instructions)", () => {
    expect(JSON.parse(normalizeSchemaFields("```json\n" + valid + "\n```"))).toHaveLength(1);
    expect(JSON.parse(normalizeSchemaFields("Here you go:\n" + valid))).toHaveLength(1);
  });

  it("THROWS on garbage instead of letting it reach the editor (rule #1)", () => {
    expect(() => normalizeSchemaFields("I cannot help with that.")).toThrow();
    expect(() => normalizeSchemaFields("[]")).toThrow(); // empty list is not a usable suggestion
    // shape violations: bad field name, bad type, dotted-too-deep schemaProp
    expect(() => normalizeSchemaFields(JSON.stringify([{ prop: "x", field: { name: "1bad", displayName: "X", type: "text" } }]))).toThrow();
    expect(() => normalizeSchemaFields(JSON.stringify([{ prop: "x", field: { name: "ok", displayName: "X", type: "nope" } }]))).toThrow();
    expect(() => normalizeSchemaFields(JSON.stringify([{ prop: "x", field: { name: "ok", displayName: "X", type: "text", schemaProp: "a.b.c" } }]))).toThrow();
  });

  it("validated AI suggestions resolve through the same gap machinery as the catalog", () => {
    const suggestions = JSON.parse(normalizeSchemaFields(valid));
    const gaps = resolveSchemaSuggestions(suggestions, [f("datePosted", "datetime")]);
    expect(gaps[0]!.coveredBy).toBeNull();
    expect(gaps[0]!.tagField).toBe("datePosted"); // tags the existing field instead of duplicating
  });
});

describe("catalog hygiene", () => {
  it("every suggested field parses as a valid FieldDef fragment (name/type sane, schemaProp shape valid)", () => {
    for (const [type, suggestions] of Object.entries(SCHEMA_FIELD_CATALOG)) {
      for (const s of suggestions) {
        expect(s.field.name, `${type}/${s.prop}`).toMatch(/^[a-zA-Z][a-zA-Z0-9_]*$/);
        if (s.field.schemaProp) expect(s.field.schemaProp, `${type}/${s.prop}`).toMatch(/^[a-zA-Z][a-zA-Z0-9]*(\.[a-zA-Z][a-zA-Z0-9]*)?$/);
        if (s.field.seoRole) expect(seoRoleEligible(s.field.seoRole, s.field.type), `${type}/${s.prop}`).toBe(true);
      }
    }
  });

  it("every cataloged CreativeWork @type is in CREATIVE_WORK_TYPES (and Product/Event are not)", () => {
    for (const t of Object.keys(SCHEMA_FIELD_CATALOG)) {
      if (t === "Product" || t === "Event") expect(CREATIVE_WORK_TYPES.has(t), t).toBe(false);
      else expect(CREATIVE_WORK_TYPES.has(t), t).toBe(true);
    }
  });
});
