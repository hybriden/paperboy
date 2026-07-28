import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Short-lived preview tokens.
 *
 * The admin's preview iframe needs draft mode, and it uses a QUERY PARAM rather
 * than the Next Draft-Mode cookie on purpose: the iframe is cross-origin, so a
 * cookie is unreliable (third-party cookie blocking) and would need HTTPS.
 *
 * It used to pass the long-lived `PREVIEW_SECRET` itself, inlined into the admin
 * bundle at build time by Vite (`VITE_PREVIEW_SECRET`). That bundle is served
 * without authentication, so the secret was effectively published: anyone who
 * fetched the admin's JS could read every draft, forever, and the value also landed
 * in access logs, browser history and outbound `Referer` headers.
 *
 * Now the API mints a signed token that expires in minutes. The secret stays
 * server-side on both ends (the API signs, the frontend verifies); the browser only
 * ever holds a short-lived credential.
 *
 * SERVER-ONLY (node:crypto). Deliberately NOT re-exported from the package index —
 * it is reached via `@paperboy/shared/preview-token`, so the browser bundle can
 * never pull it in.
 */

/** How long a freshly minted token stays valid. */
export const PREVIEW_TOKEN_TTL_MS = 15 * 60 * 1000;

const hmac = (secret: string, message: string): string =>
  createHmac("sha256", secret).update(message).digest("hex");

/** `<expiryEpochMs>.<hmac>` — opaque to the client, verifiable without state. */
export function signPreviewToken(secret: string, expiresAtMs: number): string {
  const exp = String(Math.floor(expiresAtMs));
  return `${exp}.${hmac(secret, exp)}`;
}

/** Mint a token valid for PREVIEW_TOKEN_TTL_MS from `now`. */
export function mintPreviewToken(secret: string, now: number = Date.now()): { token: string; expiresAt: number } {
  const expiresAt = now + PREVIEW_TOKEN_TTL_MS;
  return { token: signPreviewToken(secret, expiresAt), expiresAt };
}

/**
 * Is `token` a valid, unexpired token for `secret`? Fails closed on anything
 * malformed, and compares the signature in constant time so the MAC can't be
 * recovered byte-by-byte through timing.
 */
export function verifyPreviewToken(secret: string, token: string | null | undefined, now: number = Date.now()): boolean {
  if (!secret || !token) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const exp = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^\d+$/.test(exp) || !/^[0-9a-f]+$/.test(sig)) return false;

  const expected = Buffer.from(hmac(secret, exp));
  const got = Buffer.from(sig);
  if (expected.length !== got.length) return false;
  if (!timingSafeEqual(expected, got)) return false;

  // Signature valid → only now does the expiry matter. Checked AFTER the MAC so an
  // unsigned guess can't be used to probe clock/expiry behaviour.
  return Number(exp) > now;
}
