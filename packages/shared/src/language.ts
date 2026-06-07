/**
 * Conservative language detection for the agent-publish language/branch guard
 * (2026-06-07 incident: an agent wrote a Norwegian article and published it
 * into the 'en' branch — a Norwegian post went live on the English blog).
 *
 * Deliberately minimal: it only distinguishes Norwegian from English, and only
 * when the signal is strong — everything else is "unknown" (the guard never
 * fires on "unknown"). False negatives are fine (the guard is defence in
 * depth); false positives would block legitimate publishes, so thresholds are
 * strict and short texts are never classified.
 */

const NB_STOPWORDS = new Set([
  "og", "ikke", "det", "som", "på", "til", "av", "er", "en", "et", "med",
  "for", "den", "jeg", "vi", "du", "har", "kan", "skal", "fra", "om", "seg",
  "å", "de", "i", "var", "blir", "ble", "også", "eller", "men", "etter",
]);
const EN_STOPWORDS = new Set([
  "the", "and", "of", "to", "in", "is", "that", "it", "for", "with", "as",
  "are", "was", "this", "have", "from", "not", "they", "you", "be", "we",
  "has", "had", "but", "their", "its", "about", "which", "will", "would",
]);

export type DetectedLanguage = "en" | "nb" | "unknown";

/** Classify a text as English, Norwegian, or unknown (strict thresholds). */
export function detectContentLanguage(text: string): DetectedLanguage {
  const words = text
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, " ") // code blocks are language-neutral
    .split(/[^a-zæøåäöü]+/)
    .filter(Boolean);
  if (words.length < 30) return "unknown"; // too short to classify safely

  const aeoeaa = (text.match(/[æøå]/gi) ?? []).length;
  let nbHits = 0;
  let enHits = 0;
  for (const w of words) {
    if (NB_STOPWORDS.has(w)) nbHits++;
    if (EN_STOPWORDS.has(w)) enHits++;
  }
  const nbRatio = nbHits / words.length;
  const enRatio = enHits / words.length;

  // Norwegian: dense nb stopwords AND the æ/ø/å fingerprint (English never
  // has it; Norwegian prose of any length always does).
  if (aeoeaa >= 3 && nbRatio >= 0.12 && nbRatio > enRatio) return "nb";
  // English: dense en stopwords, clear margin, and NO æ/ø/å at all.
  if (aeoeaa === 0 && enRatio >= 0.15 && enRatio > nbRatio * 1.5) return "en";
  return "unknown";
}

/**
 * The language a locale code implies, for codes the detector understands.
 * en / en-US → "en"; nb / nb-NO / no → "nb"; anything else → null (no guard).
 */
export function expectedLanguageForLocale(localeCode: string): DetectedLanguage | null {
  const base = localeCode.toLowerCase().split("-")[0];
  if (base === "en") return "en";
  if (base === "nb" || base === "no" || base === "nn") return "nb";
  return null;
}
