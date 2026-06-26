/** Content-Security-Policy for the reference frontend: the dynamic frame-ancestors
 *  (who may embed the preview iframe) plus safe baseline hardening (S3-L1). A real
 *  script-src needs Next nonces; object-src/base-uri are safe drop-ins. Kept free of
 *  node:crypto so it's importable from the Edge-runtime middleware. */
export function buildContentSecurityPolicy(frameAncestors: string): string {
  return [`frame-ancestors ${frameAncestors}`, "object-src 'none'", "base-uri 'self'"].join("; ");
}
