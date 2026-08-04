/**
 * Trust boundary for the admin↔preview postMessage bridge.
 *
 * The admin's message handler acts on `paperboy:drop` by appending a block to the
 * open document, which autosaves — so an unvalidated handler is a write primitive
 * driven by the editor's own session, bypassing CSRF entirely. Any page that does
 * `window.open("https://cms.example/…")` holds a handle to the admin window and can
 * postMessage into it; CSP frame-ancestors does not apply to that path.
 *
 * So: inbound messages are only honoured when they come from the preview iframe's
 * own origin, and outbound messages are addressed to that origin rather than "*"
 * (which would leak draft content to whatever the iframe has navigated to — an
 * editor clicking an external link inside the preview is enough).
 */

/** Origin of an absolute URL, or null when it isn't parseable. */
export function originOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Is `eventOrigin` (from a MessageEvent) the origin of `previewUrl`?
 *
 * Fails CLOSED: an unparseable preview URL or a missing event origin is never
 * trusted. "null" — what a sandboxed/opaque origin reports — is rejected outright
 * so an opaque-origin frame can't slip through by matching a null preview URL.
 */
export function isPreviewOrigin(eventOrigin: string | null | undefined, previewUrl: string | null | undefined): boolean {
  if (!eventOrigin || eventOrigin === "null") return false;
  const expected = originOf(previewUrl);
  if (!expected) return false;
  return eventOrigin === expected;
}

/**
 * Does this message prove the preview frame is ALIVE (loaded and rendering)?
 *
 * ANY valid `paperboy:*` message from the preview origin counts — not just
 * `paperboy:preview-ready` (a page whose bridge speaks an older protocol, or
 * only starts talking on interaction, was read as "silent" and triggered the
 * "refusing to be framed?" hint while the preview rendered fine). Used ONLY to
 * suppress that hint; the write-path handlers keep their stricter parsing.
 */
export function isPreviewActivity(eventOrigin: string | null | undefined, previewUrl: string | null | undefined, data: unknown): boolean {
  if (!isPreviewOrigin(eventOrigin, previewUrl)) return false;
  const type = (data as { type?: unknown } | null | undefined)?.type;
  return typeof type === "string" && type.startsWith("paperboy:");
}
