import { describe, expect, it } from "vitest";
import { referenceBadge } from "./reference-badge.js";

// A block placed as a REFERENCE (a shared block, or a page rendered as a teaser)
// lives in another document with its own publish state. Delivery's published
// perspective drops a reference whose target it cannot see, so a draft target is
// a block the editor sees in the CMS and in preview but never on the live site.
describe("referenceBadge", () => {
  it("badges a target that has no published version anywhere (the reported bug)", () => {
    expect(referenceBadge({ locales: { en: { status: "draft" } } })).toBe("draft");
    expect(referenceBadge({ locales: { en: { status: "draft" }, nb: { status: "draft" } } })).toBe("draft");
  });

  it("stays silent when the target is published", () => {
    expect(referenceBadge({ locales: { en: { status: "published" } } })).toBeNull();
  });

  // The badge must not claim a block is invisible when a locale fallback would
  // still serve it: delivery walks the chain (nb -> en), so a target published in
  // ANY locale can reach the page. Silence is the honest answer here.
  it("stays silent when the target is published in another locale only", () => {
    expect(referenceBadge({ locales: { en: { status: "published" }, nb: { status: "draft" } } })).toBeNull();
  });

  // A section-scoped editor does not see every page in /manage/pages, and a row
  // can outlive its target. Unknown is not draft — never badge on a guess.
  it("stays silent for a target it cannot see", () => {
    expect(referenceBadge(undefined)).toBeNull();
    expect(referenceBadge({ locales: {} })).toBeNull();
  });
});
