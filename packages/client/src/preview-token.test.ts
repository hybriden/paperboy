import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { constantTimeEqual, verifyPreviewToken } from "./preview-token";

/**
 * This function is the security boundary of any frontend that renders drafts: a
 * caller who gets past it reads unpublished content. So the tokens here are signed
 * with `node:crypto` — an INDEPENDENT implementation of the same format the API
 * uses (`<expiryEpochMs>.<hmac-sha256-hex>` over the expiry string). If this
 * module's WebCrypto path ever drifts from that format, these fail rather than a
 * customer's drafts appearing on their public site.
 *
 * `apps/api/test/client-preview-token.test.ts` closes the loop the other way,
 * running the API's REAL minting function against this verifier.
 */

const SECRET = "test-preview-secret";
const sign = (secret: string, exp: number) =>
  `${exp}.${createHmac("sha256", secret).update(String(exp)).digest("hex")}`;

describe("verifyPreviewToken", () => {
  it("accepts a token signed with the secret that has not expired", async () => {
    expect(await verifyPreviewToken(SECRET, sign(SECRET, Date.now() + 60_000))).toBe(true);
  });

  it("rejects an expired token even though its signature is valid", async () => {
    expect(await verifyPreviewToken(SECRET, sign(SECRET, Date.now() - 1))).toBe(false);
  });

  it("judges expiry against `now`, so a caller can pin the clock", async () => {
    const exp = 1_700_000_000_000;
    const token = sign(SECRET, exp);
    expect(await verifyPreviewToken(SECRET, token, exp - 1)).toBe(true);
    expect(await verifyPreviewToken(SECRET, token, exp)).toBe(false);
  });

  it("rejects a token signed with a different secret", async () => {
    expect(await verifyPreviewToken(SECRET, sign("some-other-secret", Date.now() + 60_000))).toBe(false);
  });

  it("rejects a tampered signature", async () => {
    const token = sign(SECRET, Date.now() + 60_000);
    expect(await verifyPreviewToken(SECRET, `${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}`)).toBe(false);
  });

  it("rejects a far-future expiry with no signature — the obvious forgery", async () => {
    const exp = Date.now() + 86_400_000;
    expect(await verifyPreviewToken(SECRET, `${exp}.`)).toBe(false);
    expect(await verifyPreviewToken(SECRET, String(exp))).toBe(false);
    expect(await verifyPreviewToken(SECRET, `${exp}.${"0".repeat(64)}`)).toBe(false);
  });

  it("fails closed on malformed input", async () => {
    for (const bad of ["", ".", ".abc", "abc.def", "12x3.aabb", "-1.aabb", "12.AABB", null, undefined]) {
      expect(await verifyPreviewToken(SECRET, bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("authorises nothing when the secret is unset", async () => {
    // A deploy that forgot PREVIEW_SECRET must serve no drafts, rather than
    // accepting tokens anyone can mint against the empty string.
    expect(await verifyPreviewToken("", sign("", Date.now() + 60_000))).toBe(false);
  });
});

describe("constantTimeEqual", () => {
  it("matches identical strings and rejects any difference", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    // First-character difference must not short-circuit differently from a last.
    expect(constantTimeEqual("abc", "zbc")).toBe(false);
  });

  it("rejects a length mismatch without reading past the end", () => {
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "a")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });
});
