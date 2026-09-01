import type { ContentStatus } from "@paperboy/shared";

/** Status badge for a block placed as a reference. null = say nothing. */
export type ReferenceBadge = "draft" | null;

/**
 * Decide whether a placed REFERENCE (a shared block, or a page rendered as a
 * teaser) needs a draft badge.
 *
 * A reference's content lives in another document with its own publish state,
 * and delivery's published perspective DROPS a reference it cannot resolve —
 * silently, because keeping the shallow entry would hand a public key the id of
 * an unpublished document. So a draft target is a block the editor sees in the
 * area and in preview, and never on the live site.
 *
 * The rule is "no published version in ANY locale", not "not published in the
 * locale being edited", because delivery resolves a reference along the locale
 * FALLBACK chain (nb -> en): a target published only in `en` still reaches an
 * `nb` page. Badging on the current locale alone would call such a block missing
 * while it renders — and a status badge that lies is worse than none. Published
 * somewhere means it can appear, so the badge stays quiet.
 *
 * An unknown target (no `locales`) is not a draft target: a section-scoped
 * editor's page list omits pages they cannot read. Never badge on a guess.
 */
export function referenceBadge(
  target: { locales: Record<string, { status: ContentStatus }> } | undefined,
): ReferenceBadge {
  const states = Object.values(target?.locales ?? {});
  if (!states.length) return null;
  return states.some((s) => s.status === "published") ? null : "draft";
}
