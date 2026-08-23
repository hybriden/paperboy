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
 * Multi-line fields (markdown, richtext), content areas and composites (link,
 * image) get no cap: there the width IS the point.
 *
 * One home, because a block's fields must read the same as a page's.
 */
export function fieldWidthClass(field: FieldDef): string {
  switch (field.type) {
    case "datetime":
      return "max-w-[210px]";
    case "number":
      return "max-w-[130px]";
    case "select":
      return field.multiple ? "" : "max-w-[340px]";
    case "reference":
      return "max-w-[440px]";
    case "text": {
      // A single line never needs more than ~60 characters of box.
      const max = field.validation?.maxLength;
      if (max && max <= 40) return "max-w-[340px]";
      return "max-w-[520px]";
    }
    default:
      return "";
  }
}
