import { describe, expect, it } from "vitest";
import type { ContentTypeDef, FieldDef } from "@paperboy/shared";
import { allowedBlockTypesFor } from "./area-add.js";

// One home for "which block types can this area accept" — the sidebar
// ContentArea palette and the on-page add-block overlay must agree, or the
// preview offers a block the write chokepoint then rejects.

const t = (name: string, over: Partial<ContentTypeDef> = {}): ContentTypeDef =>
  ({ name, displayName: name, kind: "block", fields: [], ...over }) as ContentTypeDef;

const area = (allowedBlocks: string[]): FieldDef =>
  ({ name: "mainArea", type: "contentArea", allowedBlocks }) as FieldDef;

const TYPES = [
  t("ZHero"),
  t("TextBlock"),
  t("FormTextField", { nestedOnly: true }),
  t("ArticlePage", { kind: "page" }),
];

describe("allowedBlockTypesFor", () => {
  it("follows the DECLARED allow-list order, not alphabetical", () => {
    expect(allowedBlockTypesFor(area(["ZHero", "TextBlock"]), TYPES).map((x) => x.name)).toEqual(["ZHero", "TextBlock"]);
  });

  it("silently skips allow-list names that no longer exist", () => {
    expect(allowedBlockTypesFor(area(["Gone", "TextBlock"]), TYPES).map((x) => x.name)).toEqual(["TextBlock"]);
  });

  it("no allow-list = any general block — parts (nestedOnly) and pages excluded", () => {
    const names = allowedBlockTypesFor(area([]), TYPES).map((x) => x.name);
    expect(names).toContain("ZHero");
    expect(names).toContain("TextBlock");
    expect(names).not.toContain("FormTextField");
    expect(names).not.toContain("ArticlePage");
  });

  it("an allow-list may opt a part IN (that is how containers use parts)", () => {
    expect(allowedBlockTypesFor(area(["FormTextField"]), TYPES).map((x) => x.name)).toEqual(["FormTextField"]);
  });
});
