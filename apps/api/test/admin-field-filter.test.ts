import { describe, expect, it } from "vitest";
import { fieldMatches, filterFields } from "../../admin/src/lib/field-filter.js";
import type { FieldDef } from "@paperboy/shared";

/**
 * The admin's property filter. Pure logic, so it lives beside the other unit
 * tests here rather than needing a browser.
 */

const f = (name: string, displayName: string, group = "Content"): FieldDef =>
  ({ name, displayName, group, type: "text", localized: false, required: false, delivery: "public" }) as FieldDef;

const TYPE: FieldDef[] = [
  f("heading", "Heading"),
  f("mainIntro", "Main intro"),
  f("mainArea", "Main content area"),
  f("metaTitle", "Meta title", "SEO"),
  f("metaDescription", "Meta description", "SEO"),
  f("ingress", "Ingress", "Content"),
];

describe("fieldMatches", () => {
  it("matches on what the editor sees", () => {
    expect(fieldMatches(f("mainIntro", "Main intro"), "intro")).toBe(true);
  });

  it("matches on the field's own name too", () => {
    // The editor knows "Main intro"; whoever built the type knows `mainIntro`.
    expect(fieldMatches(f("mainIntro", "Main intro"), "mainintro")).toBe(true);
  });

  it("ignores case and accents", () => {
    expect(fieldMatches(f("unique", "Ünique"), "unique")).toBe(true);
    expect(fieldMatches(f("heading", "Heading"), "HEAD")).toBe(true);
  });

  it("does not match unrelated fields", () => {
    expect(fieldMatches(f("heading", "Heading"), "intro")).toBe(false);
  });

  it("an empty query matches everything", () => {
    expect(fieldMatches(f("heading", "Heading"), "   ")).toBe(true);
  });
});

describe("filterFields", () => {
  it("returns nothing for an empty query, so the pane keeps its normal render", () => {
    expect(filterFields(TYPE, "")).toEqual([]);
    expect(filterFields(TYPE, "   ")).toEqual([]);
  });

  it("searches ACROSS groups — the whole point", () => {
    // "meta" lives in SEO; a filter that only searched the open tab would leave
    // the original problem (not knowing which group to look in) untouched.
    const out = filterFields(TYPE, "meta");
    expect(out.map((g) => g.group)).toEqual(["SEO"]);
    expect(out[0]!.fields.map((x) => x.name)).toEqual(["metaTitle", "metaDescription"]);
  });

  it("groups the matches and keeps the type's group order", () => {
    const out = filterFields(TYPE, "main");
    expect(out.map((g) => g.group)).toEqual(["Content"]);
    expect(out[0]!.fields.map((x) => x.name)).toEqual(["mainIntro", "mainArea"]);
  });

  it("spans several groups when the query does", () => {
    const out = filterFields(TYPE, "i");
    // Content before SEO, because that is the order the type declares them.
    expect(out.map((g) => g.group)).toEqual(["Content", "SEO"]);
  });

  it("returns an empty list when nothing matches", () => {
    expect(filterFields(TYPE, "zzzz")).toEqual([]);
  });

  it("treats a field with no group as Content", () => {
    const odd = [{ ...f("x", "Ex"), group: "" } as FieldDef];
    expect(filterFields(odd, "ex")[0]!.group).toBe("Content");
  });
});
