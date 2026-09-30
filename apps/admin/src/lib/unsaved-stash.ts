/**
 * Unsaved editor edits kept in THIS tab's sessionStorage while the editor is
 * torn down mid-save — the case that matters is a sign-out in another tab: the
 * next autosave gets a 401, the app swaps the editor for the Login screen, and
 * the text on screen had nowhere to go. Keyed by user too, so a different
 * account signing in on this tab is never offered someone else's edits.
 *
 * Storage can be unavailable (private mode, blocked site data): every access is
 * best-effort and a failure just means nothing is offered back.
 */
export interface UnsavedEdits {
  name: string;
  slug: string | null;
  displayInNav: boolean;
  data: Record<string, unknown>;
}

const key = (userId: string, documentId: string, locale: string) => `paperboy.unsaved:${userId}:${documentId}:${locale}`;

export function stashUnsaved(userId: string, documentId: string, locale: string, edits: UnsavedEdits): void {
  try {
    sessionStorage.setItem(key(userId, documentId, locale), JSON.stringify(edits));
  } catch {
    /* storage unavailable: nothing to offer back later */
  }
}

export function readUnsaved(userId: string, documentId: string, locale: string): UnsavedEdits | null {
  try {
    const raw = sessionStorage.getItem(key(userId, documentId, locale));
    return raw ? (JSON.parse(raw) as UnsavedEdits) : null;
  } catch {
    return null;
  }
}

export function clearUnsaved(userId: string, documentId: string, locale: string): void {
  try {
    sessionStorage.removeItem(key(userId, documentId, locale));
  } catch {
    /* nothing to clear */
  }
}
