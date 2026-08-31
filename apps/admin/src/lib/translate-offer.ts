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
  // Prefer the default locale as source; otherwise the first locale that has content.
  const candidates = localesWithContent.filter((code) => code !== currentLocale);
  if (candidates.includes(defaultLocale)) return defaultLocale;
  return candidates[0] ?? null;
}
