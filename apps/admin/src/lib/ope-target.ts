/**
 * What an on-page click should DO.
 *
 * The bridge reports which field (and, inside a rendered block, which block
 * index) the visitor clicked. Turning that into an action used to be a hundred
 * lines of nested conditions inside one effect, with the consequential branch —
 * "drop the whole editor into side-by-side" — as its fall-through. So a click on
 * anything not editable in place teleported the editor out of the mode it had
 * deliberately entered. Clicking page background is exactly that click: it
 * bubbles to the nearest `[data-pb-field]`, which is normally the content area
 * wrapping the blocks (reported 2026-08-23, "clunky to say the least").
 *
 * The rule now: ON-PAGE IS A MODE THE EDITOR CHOSE, AND AN INCOMING CLICK NEVER
 * CHANGES IT. Editable in place → the anchored overlay. Anything else → stay
 * put, silently for a stray background click and with a hint for a deliberate
 * click on a block the form owns.
 */

export type OpeMode = "edit" | "inspect";

export interface OpeClick {
  mode: OpeMode;
  /** The bridge sends the element box; without one there is nothing to anchor. */
  hasRect: boolean;
  /** Set when the click landed inside a rendered block. */
  blockIndex: number | null;
  fieldName: string | null;
  /** Field type on the PAGE's own type, when the click named one of its fields. */
  pageFieldType?: string;
  /** Field type on the BLOCK's type, when the click was inside an inline block. */
  blockFieldType?: string;
}

export type OpeAction =
  /** Open the anchored editor on the page. */
  | { kind: "overlay"; target: "page" | "block" | "name" }
  /** Do nothing to the view. `hint` asks for one line of explanation. */
  | { kind: "stay"; hint?: "form-only" }
  /** Inspect mode: focus and flash the field in the sidebar form. */
  | { kind: "sidebar" };

/**
 * Field types the anchored on-page editor can host. The one definition — the
 * Editor's message handler and this rule must never disagree about what is
 * editable in place.
 */
export const OPE_FIELD_TYPES: ReadonlySet<string> = new Set([
  "text",
  "markdown",
  "richtext",
  "boolean",
  "number",
  "datetime",
  "select",
  "link",
  "image",
]);

export function opeAction(click: OpeClick): OpeAction {
  // Inspect mode's whole purpose is to drive the sidebar.
  if (click.mode !== "edit") return { kind: "sidebar" };
  if (!click.hasRect) return { kind: "stay" };

  if (click.blockIndex == null) {
    // The page NAME is on-page-editable but is not a data field, so it is
    // checked before the type's own fields (a block field called "name" is a
    // different case, handled by the blockIndex branch).
    if (click.fieldName === "name") return { kind: "overlay", target: "name" };
    if (click.pageFieldType && OPE_FIELD_TYPES.has(click.pageFieldType)) {
      return { kind: "overlay", target: "page" };
    }
    // Content areas, references, an unknown marker: not editable in place, and
    // this is where a stray background click lands. Silence is correct — the
    // editor did not ask for anything.
    return { kind: "stay" };
  }

  if (click.blockFieldType && OPE_FIELD_TYPES.has(click.blockFieldType)) {
    return { kind: "overlay", target: "block" };
  }
  // A deliberate click on a block whose field only the form can edit (a nested
  // content area), or on a shared block, whose fields live on its own page.
  // Worth one line of explanation, unlike the stray click above.
  return { kind: "stay", hint: "form-only" };
}
