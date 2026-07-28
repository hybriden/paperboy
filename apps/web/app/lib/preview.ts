import { timingSafeEqual } from "node:crypto";
import { verifyPreviewToken } from "@paperboy/shared/preview-token";

/** The committed dev default — must never grant access in production (S2-M2). */
const DEV_PREVIEW_SECRET = "dev-preview-secret-change-me";

/** Constant-time string compare (length-guarded), to avoid a timing oracle on the
 *  long-lived preview secret. */
function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Does `provided` match the configured preview secret? Constant-time (S2-M11), and
 * the committed dev default never matches in production (S2-M2), so a deploy that
 * forgot to rotate PREVIEW_SECRET silently exposes nothing rather than serving
 * drafts to anyone who knows the public default.
 */
export function matchesPreviewSecret(provided: string | null | undefined): boolean {
  if (!provided) return false;
  const secret = process.env.PREVIEW_SECRET ?? DEV_PREVIEW_SECRET;
  if (process.env.NODE_ENV === "production" && secret === DEV_PREVIEW_SECRET) return false;
  return constantTimeEqual(provided, secret);
}

/**
 * Does `provided` match a SHORT-LIVED preview token minted by the API
 * (GET /manage/preview-token, session-authenticated)?
 *
 * This is how the in-editor preview iframe authenticates now. `?pb=<secret>` still
 * works for server-side/CLI callers that legitimately hold the secret, but the
 * BROWSER must never hold it: the admin used to inline PREVIEW_SECRET into its
 * public JS bundle, so fetching that bundle granted permanent access to every
 * draft. A token expires in minutes and only a signed-in editor can get one.
 *
 * Same production guard as above — the committed dev default never verifies
 * anything in production.
 */
export function matchesPreviewToken(provided: string | null | undefined): boolean {
  if (!provided) return false;
  const secret = process.env.PREVIEW_SECRET ?? DEV_PREVIEW_SECRET;
  if (process.env.NODE_ENV === "production" && secret === DEV_PREVIEW_SECRET) return false;
  return verifyPreviewToken(secret, provided);
}

/**
 * Make an internal redirect target safe to emit as a RELATIVE Location (S2-M12):
 * collapse leading slashes so a crafted segment (e.g. an attacker-controlled
 * locale) can't turn it into a protocol-relative `//evil.com` redirect. The
 * browser resolves a relative Location against the origin it actually connected
 * to, so we never trust the spoofable Host header.
 */
export function safeRedirectLocation(target: string): string {
  return `/${target.replace(/^\/+/, "")}`;
}
