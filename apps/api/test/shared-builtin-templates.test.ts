import { describe, expect, it } from "vitest";
import {
  BUILTIN_TYPE_TEMPLATES,
  BUILTIN_TYPE_TEMPLATE_NAMES,
  ContentTypeDef,
  SEO_FIELD_NAMES,
} from "@paperboy/shared";

/**
 * Pins the invariants of the BUILT-IN type-template library (pure data in
 * packages/shared — no DB). The library ships on every instance, so a broken
 * entry is a product defect, not a content problem: these assertions make the
 * quality bar executable.
 */
describe("Built-in type-template library", () => {
  it("ships the essential editorial set", () => {
    // Removing a template from the library is a breaking change for every
    // instance — this list is the deliberate surface.
    const names = BUILTIN_TYPE_TEMPLATES.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "AccordionBlock", "AccordionItemBlock", "ArticleListPage", "ArticlePage", "BannerBlock",
        "FaqPage", "FaqTopicBlock", "FooterSettings", "HeaderSettings", "HeroBlock", "ImageBlock",
        "LinkItemBlock", "LinkListBlock", "PageTeaserBlock", "PersonBlock", "PersonPage",
        "QuestionBlock", "QuoteBlock", "SectionPage", "StartPage", "TeaserListBlock", "TextBlock",
        "VideoBlock",
      ].sort(),
    );
  });

  it("every template is a valid ContentTypeDef with unique names", () => {
    for (const t of BUILTIN_TYPE_TEMPLATES) expect(() => ContentTypeDef.parse(t)).not.toThrow();
    expect(new Set(BUILTIN_TYPE_TEMPLATES.map((t) => t.name)).size).toBe(BUILTIN_TYPE_TEMPLATES.length);
    expect(BUILTIN_TYPE_TEMPLATE_NAMES.has("ArticlePage")).toBe(true);
  });

  it("every contentArea allowedBlocks entry resolves to a built-in BLOCK template", () => {
    // withBlocks relies on this: an instantiated page must be able to pull in
    // every block its areas reference. An empty list means "any block".
    const byName = new Map(BUILTIN_TYPE_TEMPLATES.map((t) => [t.name, t]));
    for (const t of BUILTIN_TYPE_TEMPLATES) {
      for (const f of t.fields.filter((f) => f.type === "contentArea")) {
        for (const b of f.allowedBlocks) {
          const target = byName.get(b);
          expect(target, `${t.name}.${f.name} references '${b}'`).toBeDefined();
          expect(target!.kind, `${t.name}.${f.name} references non-block '${b}'`).toBe("block");
        }
      }
    }
  });

  it("carries the editorial quality bar: descriptions, help texts, public delivery", () => {
    for (const t of BUILTIN_TYPE_TEMPLATES) {
      expect(t.description, `${t.name} needs a description`).not.toBe("");
      expect(t.icon.startsWith("ph:"), `${t.name} icon should be a phosphor name`).toBe(true);
      for (const f of t.fields) {
        expect(f.helpText, `${t.name}.${f.name} needs helpText`).toBeTruthy();
        // The library models rendered content — every field is meant for the
        // frontend, so private (the fail-closed default) would be a mistake.
        expect(f.delivery, `${t.name}.${f.name} should be public`).toBe("public");
      }
    }
  });

  it("pages carry the SEO contract: schemaType + a seoRole:title field, and never reserved SEO names", () => {
    for (const t of BUILTIN_TYPE_TEMPLATES.filter((t) => t.kind === "page")) {
      expect(t.schemaType, `${t.name} needs a schemaType`).toBeTruthy();
      for (const f of t.fields) {
        expect(SEO_FIELD_NAMES.has(f.name), `${t.name}.${f.name} collides with the reserved SEO group`).toBe(false);
      }
    }
    // Every page except the person profile has an explicit title-role heading
    // (PersonPage composes its title from first/last name in the frontend).
    for (const t of BUILTIN_TYPE_TEMPLATES.filter((t) => t.kind === "page" && t.name !== "PersonPage")) {
      expect(t.fields.some((f) => f.seoRole === "title"), `${t.name} needs a seoRole:title field`).toBe(true);
    }
  });

  it("the teaser/promote pattern is consistent across listed page types", () => {
    const teaserPages = BUILTIN_TYPE_TEMPLATES.filter((t) => t.fields.some((f) => f.group === "Teaser"));
    expect(teaserPages.map((t) => t.name).sort()).toEqual(["ArticleListPage", "ArticlePage", "FaqPage", "SectionPage"]);
    for (const t of teaserPages) {
      const teaser = t.fields.filter((f) => f.group === "Teaser").map((f) => f.name).sort();
      expect(teaser, `${t.name} teaser group`).toEqual(["teaserImage", "teaserText", "teaserTitle"]);
    }
  });
});
