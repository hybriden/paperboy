import { describe, expect, it } from "vitest";
import { detectContentLanguage, expectedLanguageForLocale } from "@paperboy/shared";

/**
 * Pure unit tests of the language detector behind the agent-publish
 * language/branch guard (J9). The contract is CONSERVATIVE: only classify on
 * a strong signal; everything borderline is "unknown" and never blocks.
 */
describe("detectContentLanguage", () => {
  const NORSK = `Japansk interiørdesign har fascinert verden i generasjoner. Med sin dypt
rotfestede filosofi om enkelhet, naturlighet og harmoni representerer japansk design noe
unikt – ikke bare estetiske valg, men en hel livsfilosofi manifestert i rom og gjenstander.
For å forstå japansk interiør må vi først forstå wabi-sabi, en japansk verdensoppfatning som
anerkjenner skjønnhet i det ufullkomne, det midlertidige og det enkle. Den oppstod fra
zen-buddhismen og lærte at skjønnhet finnes i naturmaterialenes råhet og i patinaen som
tiden legger på alt vi omgir oss med hjemme i stua.`;

  const ENGLISH = `Graphics card prices are up since New Year, driven by the DRAM shortage
and surging demand for AI accelerators. The hyperscalers are buying everything they can get
from the market, and consumer cards are deprioritised in production for the rest of the
year. If you can hold off upgrading, prices will likely normalise in the third quarter, and
used cards from the previous generation are now a real alternative for most of the people
that we have talked with about this story.`;

  it("classifies dense Norwegian prose as nb", () => {
    expect(detectContentLanguage(NORSK)).toBe("nb");
  });

  it("classifies dense English prose as en", () => {
    expect(detectContentLanguage(ENGLISH)).toBe("en");
  });

  it("refuses to classify short texts (never blocks on thin evidence)", () => {
    expect(detectContentLanguage("Japansk interiør – En reise gjennom tid og estetikk")).toBe("unknown");
    expect(detectContentLanguage("A short English heading")).toBe("unknown");
  });

  it("English prose with a sprinkle of æøå (quotes, names) stays NOT-Norwegian", () => {
    const mixed = `${ENGLISH}\n\nRemember: special characters like æ, ø and å must survive end to end.`;
    expect(detectContentLanguage(mixed)).not.toBe("nb");
  });

  it("ignores code blocks (language-neutral content)", () => {
    const codeHeavy = `\`\`\`python\n# måling av æøå og tokens\nfor i in range(10): print(i)\n\`\`\`\n\nShort caption.`;
    expect(detectContentLanguage(codeHeavy)).toBe("unknown");
  });
});

describe("expectedLanguageForLocale", () => {
  it("maps en/en-US → en and nb/nb-NO/no/nn → nb", () => {
    expect(expectedLanguageForLocale("en")).toBe("en");
    expect(expectedLanguageForLocale("en-US")).toBe("en");
    expect(expectedLanguageForLocale("nb")).toBe("nb");
    expect(expectedLanguageForLocale("nb-NO")).toBe("nb");
    expect(expectedLanguageForLocale("no")).toBe("nb");
    expect(expectedLanguageForLocale("nn")).toBe("nb");
  });
  it("returns null (no guard) for languages outside the detector's vocabulary", () => {
    expect(expectedLanguageForLocale("de")).toBeNull();
    expect(expectedLanguageForLocale("sv-SE")).toBeNull();
  });
});
