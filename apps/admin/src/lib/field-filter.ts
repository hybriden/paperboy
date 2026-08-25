import type { FieldDef } from "@paperboy/shared";

/**
 * Finding a field in a type that has thirty of them.
 *
 * The pane shows one property group at a time, which is fine until you cannot
 * remember which group a field is in — then it is a tab-by-tab hunt. A filter
 * answers that better than any amount of tidying: type three letters and the
 * field is on screen.
 *
 * The filter searches ACROSS groups deliberately. Narrowing only the current tab
 * would leave the original problem untouched — you would still have to know
 * where to look before looking.
 */

/** Fold case and accents, so "Ingress" finds "ingress" and "Ünique" finds "unique". */
function fold(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "");
}

/**
 * Does this field match? Both the DISPLAY name and the field's own `name` are
 * searched: an editor knows it as "Main intro", whoever built the type knows it
 * as `mainIntro`, and either should find it.
 */
export function fieldMatches(field: FieldDef, query: string): boolean {
  const q = fold(query.trim());
  if (!q) return true;
  return fold(field.displayName ?? "").includes(q) || fold(field.name).includes(q);
}

export interface FilteredGroup {
  group: string;
  fields: FieldDef[];
}

/**
 * Fields matching `query`, grouped, in the type's own group order.
 *
 * An empty query returns nothing — the caller keeps its normal single-group
 * render in that case, so the filter is purely additive and the pane behaves
 * exactly as before until someone types.
 */
export function filterFields(fields: FieldDef[], query: string): FilteredGroup[] {
  if (!query.trim()) return [];

  const byGroup = new Map<string, FieldDef[]>();
  for (const f of fields) {
    if (!fieldMatches(f, query)) continue;
    const key = f.group || "Content";
    const bucket = byGroup.get(key);
    if (bucket) bucket.push(f);
    else byGroup.set(key, [f]);
  }
  // Map preserves insertion order, which is the type's field order — so the
  // groups come out in the order the type declares them, not alphabetically.
  return [...byGroup].map(([group, matched]) => ({ group, fields: matched }));
}
