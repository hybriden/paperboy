import type { FieldDef } from "@paperboy/shared";

/**
 * How wide a field's control should be: a hint about how much to type, derived
 * from what the type DECLARES (its kind and maxLength) on a three-step scale, so
 * a panel's controls share a few right edges instead of many. Multi-line fields,
 * content areas and composites (link, image) get no cap — there the width IS the
 * point. One home, because a block's fields must read the same as a page's.
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
