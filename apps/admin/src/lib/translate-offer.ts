/**
 * Which locale should the editor's "Translate from …" offer seed FROM?
 *
 * Returns the source locale code, or null when no offer applies (the current
 * locale already has content, or nothing exists to translate from).
 */
export interface TranslateOfferInput {
  /** The locale the editor is currently showing. */
  currentLocale: string;
  /** The site's default locale (Settings → Locales). */
  defaultLocale: string;
  /** Locale codes that HAVE at least one saved version, in site order. */
  localesWithContent: string[];
}

export function pickTranslateSource({ currentLocale, defaultLocale, localesWithContent }: TranslateOfferInput): string | null {
  if (localesWithContent.includes(currentLocale)) return null; // already translated
  // Directionless (2026-06-07: an nb-only article opened in en got NO offer —
  // the old logic only fired outside the default locale, seeding only FROM
  // it). Prefer the default locale as source; otherwise the first locale that
  // actually has content.
  const candidates = localesWithContent.filter((code) => code !== currentLocale);
  if (candidates.includes(defaultLocale)) return defaultLocale;
  return candidates[0] ?? null;
}
