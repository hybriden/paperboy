import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "../src/env.js";
import { type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * The preview-token route must not become a scope-escalation hatch.
 *
 * The token replaced shipping the long-lived PREVIEW_SECRET to the browser — good —
 * but it carries NO identity, section, site or document binding: it signs only an
 * expiry. And the perspective it unlocks on the frontend is KEY-scoped (the preview
 * delivery key), never section-scoped.
 *
 * So a section-scoped Author, whose management reads correctly 403 outside their
 * sections, could mint a token, lift `?pbt=` out of the preview iframe's URL, and
 * read every unpublished draft in the site. That is precisely the escalation
 * `needDelivery` blocks for the MCP `delivery_*` tools (apps/mcp/src/server.ts) —
 * the same rule has to hold on the HTTP surface.
 */
describe("GET /manage/preview-token — scope", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  let author: Awaited<ReturnType<typeof login>>;
  let viewer: Awaited<ReturnType<typeof login>>;

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    author = await login(s.app, "author@paperboy.test", "Author!Passw0rd");
    viewer = await login(s.app, "viewer@paperboy.test", "Viewer!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
  });

  const mint = (ctx: Awaited<ReturnType<typeof login>>) =>
    s.app.inject({ method: "GET", url: "/api/v1/manage/preview-token", headers: authHeaders(ctx) });

  it("refuses a section-scoped Author (the token is not section-scoped)", async () => {
    const res = await mint(author);
    expect(res.statusCode, res.body).toBe(403);
  });

  it("says WHY, and what to do instead (self-teaching, rule #2)", async () => {
    const res = await mint(author);
    expect(res.json().message).toMatch(/section/i);
  });

  it("allows a site-wide role", async () => {
    // PREVIEW_SECRET is unset in the test env, so a permitted caller gets the
    // self-teaching 503 rather than 403 — the point is that scope no longer blocks.
    for (const ctx of [admin, viewer]) {
      const res = await mint(ctx);
      expect(res.statusCode, res.body).not.toBe(403);
      if (res.statusCode === 503) expect(res.json().message).toMatch(/PREVIEW_SECRET/);
    }
  });

  // NOTE: the successful-mint audit row can't be asserted here — this suite runs
  // without PREVIEW_SECRET, so no mint ever succeeds. The audit call sits directly
  // before the return in the handler (routes/manage.ts) and is covered by review,
  // not by this file. Asserting a shape that proves nothing would be worse.
});

// PREVIEW_SECRET became a signing key when tokens replaced the raw secret, so it
// belongs in the same production placeholder guard as SESSION_SECRET/CSRF_SECRET.
describe("loadEnv production guard on PREVIEW_SECRET", () => {
  const base = {
    DATABASE_URL: "postgresql://paperboy:paperboy@localhost:5433/paperboy",
    NODE_ENV: "production" as const,
    COOKIE_SECURE: "true" as const,
    SESSION_SECRET: "a-genuinely-strong-session-secret-value",
    CSRF_SECRET: "a-genuinely-strong-csrf-secret-value-x",
  };

  it("refuses the committed dev default", () => {
    expect(() => loadEnv({ ...base, PREVIEW_SECRET: "dev-preview-secret-change-me" })).toThrow(/PREVIEW_SECRET/);
  });

  it("refuses a please-override placeholder", () => {
    expect(() => loadEnv({ ...base, PREVIEW_SECRET: "prod-preview-secret-please-override" })).toThrow(
      /PREVIEW_SECRET/,
    );
  });

  it("accepts a generated value", () => {
    expect(() => loadEnv({ ...base, PREVIEW_SECRET: "9f2c1b7ae4d6083b5c1e7f2a9d4b6c8e" })).not.toThrow();
  });

  it("treats empty as unset (compose ships `PREVIEW_SECRET: ${PREVIEW_SECRET:-}`)", () => {
    expect(() => loadEnv({ ...base, PREVIEW_SECRET: "" })).not.toThrow();
  });
});
