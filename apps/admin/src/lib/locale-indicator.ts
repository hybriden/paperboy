/**
 * Decide how a content-tree node should present its translation state relative
 * to the locale the editor is currently viewing — mirroring Optimizely's tree,
 * where a page not translated to the active language is shown in italics with
 * the language code it DOES exist in (e.g. "Some Page  en").
 *
 * Pure: takes the node's per-locale map + the active locale + the preferred
 * display order of locales (the site default first). No DOM, no network, so it
 * is unit-tested directly (see locale-indicator.test.ts).
 */
export interface LocaleIndicator {
  /** The node has a version in the active locale → render it normally. */
  translated: boolean;
  /** When untranslated, the single locale code to surface as a chip: the
   *  primary available locale (the site default if present, else the first in
   *  display order). null when the node is translated or has no locales. */
  fallbackCode: string | null;
  /** Every locale the node exists in, in display order (for the chip tooltip). */
  availableCodes: string[];
}

export function localeIndicator(
  nodeLocales: Record<string, unknown>,
  activeLocale: string,
  localeOrder: readonly string[] = [],
): LocaleIndicator {
  // Rank by the caller's display order (default first); unknown codes sort last,
  // then alphabetically so the result is stable regardless of object key order.
  const rank = (code: string) => {
    const i = localeOrder.indexOf(code);
    return i === -1 ? localeOrder.length : i;
  };
  const availableCodes = Object.keys(nodeLocales).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const translated = activeLocale in nodeLocales;
  return {
    translated,
    fallbackCode: translated ? null : (availableCodes[0] ?? null),
    availableCodes,
  };
}
