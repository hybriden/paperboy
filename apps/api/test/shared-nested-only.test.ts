import { describe, expect, it } from "vitest";
import { BUILTIN_TYPE_TEMPLATES, ContentTypeDef, generalBlockTypes, isFormFieldType } from "@paperboy/shared";

/**
 * AVAILABILITY: a type that is only ever a PART of another one.
 *
 * `allowedBlocks` states the rule from the container's side and defaults to
 * "any block", so there was no way to say a type has no standalone meaning —
 * and every content area without an allow-list offered a Form's ten field
 * blocks alongside real page blocks. `nestedOnly` is that missing half.
 */

describe("nestedOnly", () => {
  it("defaults to false, so every existing stored definition is unaffected", () => {
    // Definitions written before the flag existed have no such key. They must
    // keep parsing, and keep behaving as ordinary blocks.
    const parsed = ContentTypeDef.parse({
      name: "HeroBlock",
      displayName: "Hero block",
      kind: "block",
      fields: [{ name: "title", displayName: "Title", type: "text" }],
    });
    expect(parsed.nestedOnly).toBe(false);
  });

  it("round-trips when set", () => {
    const parsed = ContentTypeDef.parse({
      name: "FormDateField",
      displayName: "Date field",
      kind: "block",
      nestedOnly: true,
      fields: [{ name: "name", displayName: "Field key", type: "text" }],
    });
    expect(parsed.nestedOnly).toBe(true);
  });
});

describe("generalBlockTypes", () => {
  const t = (name: string, kind: string, nestedOnly = false) => ({ name, kind, nestedOnly });

  it("is what an area with no allow-list may offer", () => {
    const types = [
      t("HeroBlock", "block"),
      t("FormDateField", "block", true),
      t("ArticlePage", "page"),
      t("SiteSettings", "global"),
    ];
    expect(generalBlockTypes(types).map((x) => x.name)).toEqual(["HeroBlock"]);
  });

  it("treats a definition with no flag as a general block", () => {
    // Same reason as above: pre-flag definitions must not vanish from palettes.
    expect(generalBlockTypes([{ name: "OldBlock", kind: "block" }]).map((x) => x.name)).toEqual(["OldBlock"]);
  });
});

describe("the built-in form field blocks are parts", () => {
  const fieldTemplates = BUILTIN_TYPE_TEMPLATES.filter((t) => isFormFieldType(t.name));

  it("covers all ten field types", () => {
    expect(fieldTemplates).toHaveLength(10);
  });

  it("marks every one nestedOnly", () => {
    for (const t of fieldTemplates) {
      expect(t.nestedOnly, `${t.name} must be a part`).toBe(true);
    }
  });

  it("leaves the Form itself a normal block — it IS page composition", () => {
    const form = BUILTIN_TYPE_TEMPLATES.find((t) => t.name === "Form");
    expect(form?.nestedOnly ?? false).toBe(false);
  });

  it("keeps every other built-in block generally available", () => {
    // A regression here would quietly empty the palette of a real page block,
    // so the full set of parts is pinned by name rather than by a rule.
    const parts = BUILTIN_TYPE_TEMPLATES.filter((t) => t.nestedOnly).map((t) => t.name);
    expect(parts.sort()).toEqual([...fieldTemplates.map((t) => t.name), ...COMPOSITION_PARTS].sort());
  });

  it("is still reachable: the Form's fields area names each part explicitly", () => {
    // Being a part means "not offered where ANY block goes" — a container opts
    // in through allowedBlocks, so the parts must actually be listed there.
    const form = BUILTIN_TYPE_TEMPLATES.find((t) => t.name === "Form");
    const area = form?.fields.find((f) => f.name === "fields");
    expect(area?.type).toBe("contentArea");
    expect([...(area?.allowedBlocks ?? [])].sort()).toEqual(fieldTemplates.map((t) => t.name).sort());
  });
});

/**
 * The parts that are not form fields.
 *
 * Each is a piece of ANOTHER block and renders as nothing on its own: an
 * accordion item outside its list, a question outside its topic, a link item
 * outside a link list or a menu. Each container already names them in its
 * `allowedBlocks` — that is the rule stated from the container's side, and
 * `nestedOnly` is the other half. Without it, a content area with no allow-list
 * offered all three beside real page blocks (spotted in the block palette,
 * fixed by migration 0025 for instances that already installed them).
 */
const COMPOSITION_PARTS = ["AccordionItemBlock", "QuestionBlock", "LinkItemBlock"];

describe("the built-in composition parts", () => {
  it.each(COMPOSITION_PARTS)("%s is a part", (name) => {
    expect(BUILTIN_TYPE_TEMPLATES.find((t) => t.name === name)?.nestedOnly).toBe(true);
  });

  it("is still reachable: some container names each one in allowedBlocks", () => {
    // Being a part means "never offered where ANY block goes", so a part nobody
    // opts into is a type an editor can no longer place at all.
    for (const part of COMPOSITION_PARTS) {
      const containers = BUILTIN_TYPE_TEMPLATES.filter((t) =>
        t.fields.some((f) => f.type === "contentArea" && (f.allowedBlocks ?? []).includes(part)),
      );
      expect(containers.map((c) => c.name), `${part} must be allowed somewhere`).not.toHaveLength(0);
    }
  });

  it("leaves their containers generally available", () => {
    // The list is page composition even though its items are not.
    for (const container of ["AccordionBlock", "FaqTopicBlock", "LinkListBlock"]) {
      const t = BUILTIN_TYPE_TEMPLATES.find((x) => x.name === container);
      if (!t) continue;
      expect(t.nestedOnly ?? false, `${container} must stay a normal block`).toBe(false);
    }
  });
});
