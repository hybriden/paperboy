import { describe, expect, it } from "vitest";
import { localeIndicator } from "./locale-indicator.js";

/** A node.locales map fixture: the codes the node has a version in. */
const L = (...codes: string[]) =>
  Object.fromEntries(codes.map((c) => [c, { status: "draft", hasUnpublishedChanges: false }]));

describe("localeIndicator", () => {
  it("flags translated (no chip) when the active locale has a version", () => {
    const r = localeIndicator(L("en", "nb"), "nb", ["en", "nb"]);
    expect(r.translated).toBe(true);
    expect(r.fallbackCode).toBeNull();
  });

  it("surfaces the default locale's code when the active locale is missing", () => {
    // 'en' is default (first in order); node exists in en+de, viewing nb.
    const r = localeIndicator(L("en", "de"), "nb", ["en", "de"]);
    expect(r.translated).toBe(false);
    expect(r.fallbackCode).toBe("en");
    expect(r.availableCodes).toEqual(["en", "de"]);
  });

  it("orders available codes by display order regardless of object key order", () => {
    const r = localeIndicator(L("de", "en"), "nb", ["en", "de"]);
    expect(r.availableCodes).toEqual(["en", "de"]);
    expect(r.fallbackCode).toBe("en");
  });

  it("falls back to alphabetical order when no display order is given", () => {
    const r = localeIndicator(L("nb", "de"), "en");
    expect(r.availableCodes).toEqual(["de", "nb"]);
    expect(r.fallbackCode).toBe("de");
  });

  it("handles a node with no locales at all", () => {
    const r = localeIndicator({}, "en", ["en"]);
    expect(r.translated).toBe(false);
    expect(r.fallbackCode).toBeNull();
    expect(r.availableCodes).toEqual([]);
  });
});
