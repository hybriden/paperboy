import { describe, expect, it } from "vitest";
import { verifyPreviewToken as verifyInFrontend } from "@paperboycms/client/preview-token";
import {
  PREVIEW_TOKEN_TTL_MS,
  mintPreviewToken,
  signPreviewToken,
  verifyPreviewToken as verifyInApi,
} from "@paperboy/shared/preview-token";

/**
 * The preview handshake spans two implementations of one format, on purpose:
 *
 *   packages/shared/src/preview-token.ts   node:crypto  — the API SIGNS with this
 *   packages/client/src/preview-token.ts   WebCrypto    — a FRONTEND verifies with this
 *
 * The frontend half is WebCrypto so it runs on Workers/Deno/Bun as well as Node,
 * and it ships to npm as `@paperboycms/client/preview-token` so no frontend has to
 * hand-copy a MAC comparison. Two implementations means they can drift — and the
 * failure mode is silent in the direction that matters: either editors lose preview
 * everywhere, or an unsigned token starts verifying and drafts leak.
 *
 * So this locks them together at the seam, using the API's REAL minting function
 * rather than a re-implementation of it.
 */

const SECRET = "cross-impl-preview-secret";

describe("preview token: API signer ↔ client verifier", () => {
  it("a token minted by the API verifies in a frontend", async () => {
    const { token, expiresAt } = mintPreviewToken(SECRET);
    expect(await verifyInFrontend(SECRET, token)).toBe(true);
    // And the expiry the API advertises is the one the frontend enforces.
    expect(await verifyInFrontend(SECRET, token, expiresAt - 1)).toBe(true);
    expect(await verifyInFrontend(SECRET, token, expiresAt)).toBe(false);
  });

  it("agrees on the TTL boundary to the millisecond", async () => {
    const now = 1_700_000_000_000;
    const { token } = mintPreviewToken(SECRET, now);
    const lastValid = now + PREVIEW_TOKEN_TTL_MS - 1;
    expect(verifyInApi(SECRET, token, lastValid)).toBe(true);
    expect(await verifyInFrontend(SECRET, token, lastValid)).toBe(true);
    expect(verifyInApi(SECRET, token, lastValid + 1)).toBe(false);
    expect(await verifyInFrontend(SECRET, token, lastValid + 1)).toBe(false);
  });

  it("computes the same MAC, so neither side accepts what the other rejects", async () => {
    // Same expiry, both implementations: byte-identical token or the handshake is broken.
    const exp = 1_800_000_000_000;
    const fromApi = signPreviewToken(SECRET, exp);
    expect(await verifyInFrontend(SECRET, fromApi, exp - 1)).toBe(true);
    expect(await verifyInFrontend("almost-the-same-secret", fromApi, exp - 1)).toBe(false);
  });

  it("fails closed identically on every malformed input", async () => {
    const exp = String(Date.now() + 60_000);
    const junk = [
      "",
      ".",
      `${exp}.`,
      exp,
      `.${"0".repeat(64)}`,
      `${exp}.${"0".repeat(64)}`, // right shape, unsigned
      `${exp}.${"0".repeat(63)}`, // one nibble short
      `${exp}.NOTHEX${"0".repeat(58)}`,
      `${exp}.${"0".repeat(64).toUpperCase()}`, // uppercase hex is not our format
      "abc.def",
      "-1.aabb",
      `1e3.${"0".repeat(64)}`,
      ` ${exp}.${"0".repeat(64)}`,
      null,
      undefined,
    ];
    for (const bad of junk) {
      const api = verifyInApi(SECRET, bad);
      const frontend = await verifyInFrontend(SECRET, bad);
      expect(api, `api accepted ${JSON.stringify(bad)}`).toBe(false);
      expect(frontend, `frontend disagreed on ${JSON.stringify(bad)}`).toBe(api);
    }
  });

  it("both refuse to authorise anything when PREVIEW_SECRET is unset", async () => {
    const token = signPreviewToken("", Date.now() + 60_000);
    expect(verifyInApi("", token)).toBe(false);
    expect(await verifyInFrontend("", token)).toBe(false);
  });
});
