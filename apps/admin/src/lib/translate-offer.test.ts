import { describe, expect, it } from "vitest";
import { pickTranslateSource } from "./translate-offer";

/** Regression (2026-06-07): an nb-only article opened in en got no "Translate from …" offer — the contract is directionless. */
describe("pickTranslateSource", () => {
  it("canonical direction: en→nb (default has content, viewing empty nb)", () => {
    expect(
      pickTranslateSource({ currentLocale: "nb", defaultLocale: "en", localesWithContent: ["en"] }),
    ).toBe("en");
  });

  it("REVERSE direction (the incident): nb-only doc viewed in en offers nb as source", () => {
    expect(
      pickTranslateSource({ currentLocale: "en", defaultLocale: "en", localesWithContent: ["nb"] }),
    ).toBe("nb");
  });

  it("prefers the default locale when several locales have content", () => {
    expect(
      pickTranslateSource({ currentLocale: "sv", defaultLocale: "en", localesWithContent: ["nb", "en"] }),
    ).toBe("en");
  });

  it("falls back to the first content-bearing locale when the default is empty", () => {
    expect(
      pickTranslateSource({ currentLocale: "sv", defaultLocale: "en", localesWithContent: ["nb"] }),
    ).toBe("nb");
  });

  it("no offer when the current locale already has content", () => {
    expect(
      pickTranslateSource({ currentLocale: "nb", defaultLocale: "en", localesWithContent: ["en", "nb"] }),
    ).toBeNull();
  });

  it("no offer when nothing exists to translate from", () => {
    expect(
      pickTranslateSource({ currentLocale: "nb", defaultLocale: "en", localesWithContent: [] }),
    ).toBeNull();
  });

  it("never offers the current locale as its own source", () => {
    expect(
      pickTranslateSource({ currentLocale: "en", defaultLocale: "en", localesWithContent: ["en"] }),
    ).toBeNull();
  });
});
