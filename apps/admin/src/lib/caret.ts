/**
 * Click-to-caret plumbing for on-page editing. The preview iframe reports WHERE
 * inside a field the editor clicked (a snippet of the clicked DOM text node +
 * the offset within it); the matching field editor places its caret there.
 *
 * A mailbox (rather than props) because the target editor may not exist yet
 * when the message arrives: the OPE overlay mounts after setOpe, and the
 * TipTap editor is a lazy chunk. Mounted editors react to the event; editors
 * that mount later pick the caret up with takeCaret().
 */

export interface PbCaret {
  snippet: string; // text around the click, from a single DOM text node
  offset: number; // caret position within the snippet
}

const pending = new Map<string, PbCaret>();

/** Announce a caret for a field editor (id = the field input id, `f-<name>`). */
export function postCaret(id: string, caret: PbCaret): void {
  pending.set(id, caret);
  window.dispatchEvent(new CustomEvent("pb:caret", { detail: { id } }));
  // A caret only makes sense for the click that produced it.
  setTimeout(() => pending.delete(id), 4000);
}

/** Claim (and clear) the pending caret for a field editor. */
export function takeCaret(id: string): PbCaret | null {
  const c = pending.get(id) ?? null;
  pending.delete(id);
  return c;
}
