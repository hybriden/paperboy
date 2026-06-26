import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, setupApi } from "./helpers.js";

/**
 * S3-M2: the API set no global security headers (only the media routes set nosniff).
 * A baseline (nosniff, Referrer-Policy, X-Frame-Options; HSTS when COOKIE_SECURE) is
 * now applied to every response via an onSend hook — no new dependency.
 */
describe("global baseline security headers", () => {
  let s: Suite;
  beforeAll(async () => {
    s = await setupApi();
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("are present on API responses (even a 401)", async () => {
    const res = await s.app.inject({ method: "GET", url: "/api/v1/auth/me" });
    expect(res.statusCode).toBe(401);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBeTruthy();
    expect(res.headers["x-frame-options"]).toBe("DENY");
  });
});
