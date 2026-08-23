import { describe, expect, it } from "vitest";
import { duplicateFieldKeys, fieldKeyFromLabel, formSpecFrom, isFormFieldType } from "@paperboy/shared";

/**
 * The AUTHORING side of the forms contract (pure — no DB).
 *
 * A form's field key is an identifier the answer is stored under, and it is the
 * first control an editor meets on every field. Two things follow, both pinned
 * here: the key can be derived from the label the editor already typed, and a
 * key used twice must be reportable — because `formSpecFrom` keeps only the
 * first, so the second field silently vanishes from the form.
 */

const field = (blockType: string, inline: Record<string, unknown>) => ({
  key: `k_${blockType}_${typeof inline.name === "string" ? inline.name : ""}`,
  blockType,
  display: "automatic",
  inline,
  ref: null,
});

describe("fieldKeyFromLabel", () => {
  it("derives a camelCase identifier from a label", () => {
    expect(fieldKeyFromLabel("Company name")).toBe("companyName");
    expect(fieldKeyFromLabel("Email")).toBe("email");
    expect(fieldKeyFromLabel("Your phone number")).toBe("yourPhoneNumber");
  });

  it("keeps Norwegian labels legible instead of dropping the letter", () => {
    // "Ønsket dato" must not become "nsketDato".
    expect(fieldKeyFromLabel("Ønsket dato")).toBe("oensketDato");
    expect(fieldKeyFromLabel("Årsak")).toBe("aarsak");
    expect(fieldKeyFromLabel("Spørsmål")).toBe("spoersmaal");
  });

  it("always produces something the field-key pattern accepts", () => {
    const pattern = /^[a-zA-Z][a-zA-Z0-9_]*$/;
    for (const label of [
      "1st choice", "  spaced  out  ", "Hva? (valgfritt)", "e-mail address",
      "ÆØÅ", "résumé", "100%", "a".repeat(200),
    ]) {
      const key = fieldKeyFromLabel(label);
      if (key) expect(key, `label: ${label}`).toMatch(pattern);
      expect(key.length).toBeLessThanOrEqual(60);
    }
  });

  it("returns nothing usable rather than a broken key", () => {
    // The caller leaves the field alone; it must never write "" over a key.
    expect(fieldKeyFromLabel("")).toBe("");
    expect(fieldKeyFromLabel("???")).toBe("");
  });
});

describe("duplicateFieldKeys", () => {
  it("reports a key used by two fields", () => {
    const area = [
      field("FormTextField", { name: "name", label: "Name" }),
      field("FormEmailField", { name: "email", label: "Email" }),
      field("FormTextField", { name: "name", label: "Company name" }),
    ];
    expect([...duplicateFieldKeys(area)]).toEqual(["name"]);
  });

  it("is the warning for a field formSpecFrom drops", () => {
    // The reason this matters: the third field never reaches the visitor.
    const area = [
      field("FormTextField", { name: "name", label: "Name" }),
      field("FormEmailField", { name: "email", label: "Email" }),
      field("FormTextField", { name: "name", label: "Company name" }),
    ];
    const spec = formSpecFrom({ fields: area });
    expect(spec.fields.map((f) => f.label)).toEqual(["Name", "Email"]);
    expect(duplicateFieldKeys(area).has("name")).toBe(true);
  });

  it("stays quiet on a clean form, on static text, and on blank keys", () => {
    expect(duplicateFieldKeys([]).size).toBe(0);
    expect(
      duplicateFieldKeys([
        field("FormTextField", { name: "name", label: "Name" }),
        field("FormEmailField", { name: "email", label: "Email" }),
      ]).size,
    ).toBe(0);
    // Static text collects no answer, so two of them share no key.
    expect(
      duplicateFieldKeys([
        field("FormStaticText", { heading: "About you" }),
        field("FormStaticText", { heading: "About the project" }),
      ]).size,
    ).toBe(0);
    // An empty key is caught by the type's own required-field validation.
    expect(
      duplicateFieldKeys([
        field("FormTextField", { name: "", label: "One" }),
        field("FormTextField", { name: "  ", label: "Two" }),
      ]).size,
    ).toBe(0);
  });

  it("ignores blocks that are not form fields", () => {
    expect(
      duplicateFieldKeys([
        field("HeroBlock", { name: "hero" }),
        field("HeroBlock", { name: "hero" }),
      ]).size,
    ).toBe(0);
  });

  it("reads the delivered shape as well as the stored one", () => {
    // delivery serializes an inline block as { blockType, data }.
    const area = [
      { blockType: "FormTextField", data: { name: "name", label: "Name" } },
      { blockType: "FormTextField", data: { name: "name", label: "Also name" } },
    ];
    expect(duplicateFieldKeys(area).has("name")).toBe(true);
  });
});

describe("isFormFieldType", () => {
  it("knows the ten field blocks from everything else", () => {
    expect(isFormFieldType("FormTextField")).toBe(true);
    expect(isFormFieldType("FormStaticText")).toBe(true);
    expect(isFormFieldType("Form")).toBe(false);
    expect(isFormFieldType("HeroBlock")).toBe(false);
  });
});
