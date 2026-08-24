/**
 * Verification for Paperboy's short-lived preview tokens.
 *
 * A frontend that renders drafts needs to answer one question before it does:
 * is this caller allowed to see unpublished content? This is that check, and it
 * is the security boundary of the whole app — which is exactly why it lives here
 * rather than being copy-pasted into every frontend. It used to be duplicated by
 * hand in each one, and a hand-copied MAC comparison is how draft content ends
 * up on a public site.
 *
 * How the flow works: the admin never sends its `PREVIEW_SECRET` to the browser.
 * It asks its own API for a signed, minutes-long token
 * (`GET /manage/preview-token`, session-authenticated) and passes it to the
 * frontend as `?pbt=`. The secret stays server-side on both ends — the API signs,
 * you verify. The browser only ever holds a credential that expires.
 *
 * Token format is `<expiryEpochMs>.<hmac-sha256-hex>`, the MAC taken over the
 * expiry string.
 *
 * SERVER-SIDE ONLY. Deliberately NOT re-exported from the package index: it is
 * reached via `@paperboycms/client/preview-token`, so a browser bundle can never
 * pull it in by accident. Its first argument is your `PREVIEW_SECRET`, and code
 * that ships to a browser has no business holding that.
 *
 * WebCrypto rather than `node:crypto`, so the same module runs unchanged on Node,
 * Cloudflare Workers, Deno and Bun. That is also why verification is async:
 * Workers has no synchronous HMAC.
 *
 * @example
 * ```ts
 * import { verifyPreviewToken } from "@paperboycms/client/preview-token";
 *
 * const preview = await verifyPreviewToken(env.PREVIEW_SECRET, url.searchParams.get("pbt"));
 * ```
 */

const encoder = new TextEncoder();

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Length-guarded constant-time compare, for secrets and MACs.
 *
 * Use this for the `?pb=<secret>` path if you support it — a plain `===` returns
 * as soon as two strings differ, which leaks how much of a guess was right and
 * makes the value recoverable byte by byte from response timing.
 *
 * Best-effort at the JS level (the engine gives no timing guarantees), which is
 * the accepted trade for running in every runtime. Comparing lengths first is
 * safe here: both a hex MAC and a configured secret have a public length.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Is `token` a valid, unexpired preview token for `secret`?
 *
 * Fails closed on everything malformed, and on an empty secret — a deploy that
 * forgot to set `PREVIEW_SECRET` must authorise nothing rather than everything.
 *
 * The expiry is checked only AFTER the MAC verifies. That order matters: it means
 * an unsigned guess cannot be used to probe whether a chosen expiry is in range,
 * which would otherwise be a free oracle on the token format.
 *
 * @param secret your instance's `PREVIEW_SECRET` — the same value the API signs with
 * @param token the raw `?pbt=` value; `null` / `undefined` are safe to pass
 * @param now epoch ms to judge expiry against; override only in tests
 */
export async function verifyPreviewToken(
  secret: string,
  token: string | null | undefined,
  now: number = Date.now(),
): Promise<boolean> {
  if (!secret || !token) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const exp = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^\d+$/.test(exp) || !/^[0-9a-f]+$/.test(sig)) return false;

  if (!constantTimeEqual(await hmacHex(secret, exp), sig)) return false;
  return Number(exp) > now;
}
