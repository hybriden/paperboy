/** Content-Security-Policy for the reference frontend: the frame-ancestors decision
 *  (who may embed the preview iframe, and WHEN) plus safe baseline hardening (S3-L1).
 *  A real script-src needs Next nonces; object-src/base-uri are safe drop-ins. Kept
 *  free of node:crypto so it's importable from the Edge-runtime middleware. */
export function buildContentSecurityPolicy(frameAncestors: string): string {
  return [`frame-ancestors ${frameAncestors}`, "object-src 'none'", "base-uri 'self'"].join("; ");
}

/**
 * Which origins may embed THIS response — decided per request, not per site.
 *
 * A frontend that permanently advertises `frame-ancestors … https://cms.example`
 * is framable by the CMS origin on every public page, forever. That relaxation
 * only needs to exist while the response is actually being used as the CMS
 * preview, so an ordinary visitor gets a flat `'none'`.
 *
 * The discriminator is `Sec-Fetch-Dest`: a browser-controlled forbidden header
 * (a page cannot forge it) that reports what the response will be used AS.
 * Crucially it keeps working after an in-iframe navigation, where the `?pbt=`
 * preview token is gone but framing must not break — keying this on the token
 * alone blanks the pane as soon as an editor clicks a link in the preview.
 *
 * Emitting the allowlist for a framed request grants nothing by itself: the
 * browser still checks the REAL ancestor chain against the list, so a hostile
 * site framing us gets refused exactly as before.
 */
export function frameAncestorsFor(input: {
  /** `Sec-Fetch-Dest` request header, or null if the client didn't send one. */
  secFetchDest: string | null;
  /** Does the request carry a preview credential (`?pbt=`/`?pb=`, or draft mode)? */
  hasPreviewCredential: boolean;
  /** Request hostname, without port. */
  hostname: string;
  /** Extra admin origins from ADMIN_ORIGINS. */
  adminOrigins: string[];
  /** Production? Then the localhost dev origins are omitted (see below). */
  isProduction?: boolean;
}): string {
  // "frame" covers the legacy <frame>; absent header → fall back to the preview
  // credential so pre-Sec-Fetch-Dest browsers can still preview.
  const framed =
    input.secFetchDest === "iframe" ||
    input.secFetchDest === "frame" ||
    (input.secFetchDest === null && input.hasPreviewCredential);
  if (!framed) return "'none'";

  // Host-agnostic: the admin shares our hostname on :8090 in the default compose
  // topology, so localhost / a LAN IP / a domain all work with no configuration.
  // localhost:8090/8093 are the DEV admin/MCP origins. Shipping them in a
  // production policy means any process listening on those ports on a visitor's
  // own machine may frame the customer's HTTPS site, which is a real (if niche)
  // clickjacking vector and pure dead weight in production. A production deploy
  // names its admin via ADMIN_ORIGINS.
  const devOrigins = input.isProduction ? [] : ["http://localhost:8090", "http://localhost:8093"];
  return [
    "'self'",
    input.hostname ? `http://${input.hostname}:8090` : "",
    input.hostname ? `https://${input.hostname}:8090` : "",
    ...devOrigins,
    ...input.adminOrigins,
  ]
    .filter(Boolean)
    .join(" ");
}
