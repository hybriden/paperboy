import type { FieldDef } from "@paperboy/shared";

/**
 * How wide a field's control should be.
 *
 * Width is a hint about how much to type, so a form that stretches every input
 * to the column tells the editor the wrong thing everywhere: a datetime and a
 * page heading both arrived 720px wide (measured 2026-08-23). These caps come
 * from what the type DECLARES — the field's kind and its own maxLength — so
 * nobody building a content type has to think about layout.
 *
 * THREE steps, not five values. The principle above is right, but the caps were
 * 130 / 210 / 340 / 440 / 520px, which put fifteen controls on four different
 * right edges in one panel (measured 2026-08-25) — and whitespace only reads as
 * deliberate when the edges bounding it are. A scale of three says the same
 * thing about expected input length while giving the eye three edges to learn
 * instead of five to measure.
 *
 * Multi-line fields (markdown, richtext), content areas and composites (link,
 * image) get no cap: there the width IS the point.
 *
 * One home, because a block's fields must read the same as a page's.
 */

/** Enough for a date, a number, a code — anything you read at a glance. */
const SHORT = "max-w-[13rem]";
/** Enough for a title, a name, a select — one line of real language. */
const MEDIUM = "max-w-[26rem]";
/** No cap: the width carries meaning. */
const FULL = "";

export function fieldWidthClass(field: FieldDef): string {
  switch (field.type) {
    case "datetime":
    case "number":
      return SHORT;
    case "select":
      return field.multiple ? FULL : MEDIUM;
    case "reference":
      return MEDIUM;
    case "text": {
      // A short declared maxLength is the type telling us this is a label, not
      // a sentence — so it gets the short box rather than the medium one.
      const max = field.validation?.maxLength;
      if (max && max <= 40) return SHORT;
      return MEDIUM;
    }
    default:
      return FULL;
  }
}
