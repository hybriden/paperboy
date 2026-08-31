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

/**
 * Grace period on the preview token. The frontend REJECTS an expired token and
 * falls back to rendering published content — with no bridge, no on-page
 * editing and no live updates, which is indistinguishable from a frontend that
 * never shipped the bridge at all. That produced a "No response from the
 * preview bridge" hint accusing a perfectly good frontend (reported
 * 2026-08-22), so the admin must never frame a page with a dead token: it
 * mints a fresh one instead, and treats a token this close to expiry as dead
 * (covers clock skew + the frame's own load time).
 */
export const PREVIEW_TOKEN_SKEW_MS = 60_000;

/** Is this token still safe to hand to the preview frame? */
export function previewTokenUsable(
  expiresAt: number | null | undefined,
  now: number = Date.now(),
  skewMs: number = PREVIEW_TOKEN_SKEW_MS,
): boolean {
  return typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt - skewMs > now;
}

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
 * Origin of the preview frontend — the ONLY origin the admin exchanges bridge
 * messages with. Used to address outbound posts (never "*", which would hand draft
 * content to whatever the iframe has navigated to) and to authenticate inbound
 * ones (see Editor's message handler). Strictly the site's CONFIGURED preview
 * URL: null while the site query hasn't resolved or nothing is set — never a
 * guessed host, which would send the live preview token to an unconfigured
 * origin and trust whatever answered. Callers fail closed on null.
 */
export function previewOrigin(site: { previewBaseUrl: string } | undefined): string | null {
  return originOf(site?.previewBaseUrl);
}

/** The sender identity a MessageEvent carries. */
export interface InboundMessage {
  origin: string | null | undefined;
  source: unknown;
}

/**
 * Is this message from the preview IFRAME itself — not merely from its origin?
 *
 * The preview origin is the customer's PUBLIC site, so the origin alone proves
 * little: an XSS on any public page can window.open() the admin and post from
 * that very origin. The window handle can't be forged, so identity is checked
 * on `source` (the bridge does the same for its parent). Fails closed while no
 * frame is mounted.
 */
export function isFromPreviewFrame(e: InboundMessage, previewUrl: string | null | undefined, frameWindow: Window | null | undefined): boolean {
  if (!frameWindow || e.source !== frameWindow) return false;
  return isPreviewOrigin(e.origin, previewUrl);
}

/**
 * Does this message prove the preview frame is ALIVE (loaded and rendering)?
 *
 * ANY valid `paperboy:*` message from the preview frame counts — not just
 * `paperboy:preview-ready` (a page whose bridge speaks an older protocol, or
 * only starts talking on interaction, was read as "silent" and triggered the
 * "refusing to be framed?" hint while the preview rendered fine). Used ONLY to
 * suppress that hint; the write-path handlers keep their stricter parsing.
 */
export function isPreviewActivity(e: InboundMessage, previewUrl: string | null | undefined, frameWindow: Window | null | undefined, data: unknown): boolean {
  if (!isFromPreviewFrame(e, previewUrl, frameWindow)) return false;
  const type = (data as { type?: unknown } | null | undefined)?.type;
  return typeof type === "string" && type.startsWith("paperboy:");
}
