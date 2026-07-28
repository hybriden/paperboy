import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, setupApi } from "./helpers.js";

/**
 * Rate limiting must apply to REJECTED delivery requests too.
 *
 * The delivery plugin resolved the credential in an instance-level `onRequest`
 * hook, and Fastify runs instance hooks before the per-route hooks that
 * @fastify/rate-limit installs. So a 401 short-circuited the limiter entirely:
 * unauthenticated callers got unmetered request volume — free delivery-key
 * guessing and unmetered load on the credential lookup (which is a DB query),
 * with nothing in the metrics to show it.
 *
 * Verified before the fix: 700 requests with invalid keys → 700x 401, zero 429s.
 *
 * The fix moves credential resolution to `preHandler`, which still runs before
 * any handler — so "fails before any content read" is preserved — but after the
 * limiter.
 */
describe("invalid delivery credentials are rate limited", () => {
  let s: Suite;

  beforeAll(async () => {
    s = await setupApi();
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("starts returning 429 instead of unbounded 401s", async () => {
    const codes: Record<number, number> = {};
    // The route's limit is 600/min; 700 crosses it with margin.
    for (let i = 0; i < 700; i++) {
      const res = await s.app.inject({
        method: "GET",
        url: "/api/v1/delivery/content?type=ArticlePage&limit=1",
        headers: { authorization: `Bearer pk_guess_${i}` },
      });
      codes[res.statusCode] = (codes[res.statusCode] ?? 0) + 1;
    }
    expect(codes[401], "invalid keys must still be rejected").toBeGreaterThan(0);
    expect(codes[429] ?? 0, `no 429 seen — the limiter never engaged: ${JSON.stringify(codes)}`).toBeGreaterThan(0);
  });

  it("a valid request still works (the limiter is per-key, not a global block)", async () => {
    // A fresh app instance: the previous test exhausted the window for its IP.
    const fresh = await setupApi();
    try {
      const res = await fresh.app.inject({
        method: "GET",
        url: "/api/v1/delivery/content?type=ArticlePage&limit=1",
        headers: { authorization: "Bearer pk_live_test_public" },
      });
      expect(res.statusCode, res.body).toBe(200);
    } finally {
      await fresh.app.close();
    }
  });
});
