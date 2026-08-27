import { compareKeys, sortByRule } from "@paperboy/shared";
import { describe, expect, it } from "vitest";

/**
 * compareKeys is the ONE comparator behind the admin tree's alphabetical order
 * and delivery's default list order. It compared strings with raw `<`/`>`, i.e.
 * by UTF-16 code point — so "Banana" sorted before "apple" (B=66 < a=97) and
 * æøå landed after z, on a project that handles æøå deliberately everywhere
 * else. It uses an Intl.Collator now.
 */
describe("compareKeys (locale-aware ordering)", () => {
  it("is case-insensitive for order: 'apple' before 'Banana' (was reversed under UTF-16)", () => {
    expect(compareKeys("apple", "Banana")).toBeLessThan(0);
    expect(compareKeys("Banana", "apple")).toBeGreaterThan(0);
  });

  it("orders numerically within strings: item2 before item10", () => {
    expect(compareKeys("item2", "item10")).toBeLessThan(0);
  });

  it("still compares numbers numerically and sorts missing values last", () => {
    expect(compareKeys(2, 10)).toBeLessThan(0);
    expect(compareKeys(null, "a")).toBeGreaterThan(0);
    expect(compareKeys("a", null)).toBeLessThan(0);
  });

  it("a mixed-case Norwegian list sorts sensibly, not by code point", () => {
    const names = ["Zebra", "apple", "Banana", "Ost", "ost"];
    const sorted = [...names].sort(compareKeys);
    // The load-bearing claim: lowercase 'apple' is NOT stranded after every
    // capitalised word (which is what UTF-16 did — B,O,Z all before a).
    expect(sorted.indexOf("apple")).toBeLessThan(sorted.indexOf("Banana"));
    expect(sorted.indexOf("Banana")).toBeLessThan(sorted.indexOf("Zebra"));
  });

  it("sortByRule still keeps nulls last and respects direction", () => {
    const items = [{ n: "b" }, { n: "a" }, {}] as Array<{ n?: string }>;
    const keyOf = (i: { n?: string }) => i.n;
    expect(sortByRule(items, "n", keyOf).map((i) => i.n)).toEqual(["a", "b", undefined]);
    expect(sortByRule(items, "-n", keyOf).map((i) => i.n)).toEqual(["b", "a", undefined]);
  });
});
