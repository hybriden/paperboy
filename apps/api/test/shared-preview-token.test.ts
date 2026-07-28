import { describe, expect, it } from "vitest";
import {
  PREVIEW_TOKEN_TTL_MS,
  mintPreviewToken,
  signPreviewToken,
  verifyPreviewToken,
} from "@paperboy/shared/preview-token";

/**
 * Preview tokens replace shipping the long-lived PREVIEW_SECRET to the browser.
 * Verified live before the fix: the rotated secret appeared verbatim in the
 * unauthenticated admin bundle (GET /assets/index-*.js → 200), so anyone who loaded
 * the admin's JS could read every draft via ?pb=<secret>, permanently.
 *
 * A token is only useful for minutes, and only the API (which holds the secret) can
 * mint one.
 */
const SECRET = "a-real-rotated-preview-secret";

describe("preview tokens", () => {
  it("round-trips a freshly minted token", () => {
    const { token } = mintPreviewToken(SECRET);
    expect(verifyPreviewToken(SECRET, token)).toBe(true);
  });

  it("expires — a token past its expiry is refused", () => {
    const now = 1_800_000_000_000;
    const { token } = mintPreviewToken(SECRET, now);
    expect(verifyPreviewToken(SECRET, token, now + PREVIEW_TOKEN_TTL_MS - 1)).toBe(true);
    expect(verifyPreviewToken(SECRET, token, now + PREVIEW_TOKEN_TTL_MS + 1)).toBe(false);
  });

  it("refuses a token signed with a different secret", () => {
    const { token } = mintPreviewToken("some-other-secret");
    expect(verifyPreviewToken(SECRET, token)).toBe(false);
  });

  it("refuses a tampered expiry (the signature covers it)", () => {
    const now = 1_800_000_000_000;
    const { token } = mintPreviewToken(SECRET, now);
    const sig = token.slice(token.indexOf(".") + 1);
    const forged = `${now + 10 * 365 * 24 * 3600 * 1000}.${sig}`;
    expect(verifyPreviewToken(SECRET, forged, now)).toBe(false);
  });

  it("refuses a tampered signature", () => {
    const { token } = mintPreviewToken(SECRET);
    const [exp, sig] = token.split(".");
    const flipped = `${sig!.slice(0, -1)}${sig!.endsWith("a") ? "b" : "a"}`;
    expect(verifyPreviewToken(SECRET, `${exp}.${flipped}`)).toBe(false);
  });

  it("fails closed on malformed input", () => {
    for (const bad of ["", ".", "abc", "abc.def", "123", "123.", ".deadbeef", "12x.deadbeef", null, undefined]) {
      expect(verifyPreviewToken(SECRET, bad as string | null | undefined)).toBe(false);
    }
  });

  it("fails closed when no secret is configured", () => {
    const { token } = mintPreviewToken(SECRET);
    expect(verifyPreviewToken("", token)).toBe(false);
  });

  it("does not leak the secret into the token", () => {
    const { token } = mintPreviewToken(SECRET);
    expect(token).not.toContain(SECRET);
  });

  it("signPreviewToken is deterministic for a given expiry", () => {
    expect(signPreviewToken(SECRET, 1234567)).toBe(signPreviewToken(SECRET, 1234567));
  });
});
