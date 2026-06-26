import { currentCode } from "@paperboy/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * S2-L1: enabling/disabling 2FA changes the account's auth posture but evicted no
 * sessions, so a held (possibly hijacked) session outlived the change. Enabling 2FA
 * now drops the user's OTHER sessions while keeping the acting session alive.
 */
describe("toggling 2FA evicts the user's other sessions", () => {
  let s: Suite;
  beforeAll(async () => {
    s = await setupApi();
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("enabling 2FA invalidates a previously-issued session but not the acting one", async () => {
    // Two independent sessions for the same user.
    const stale = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
    const acting = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");

    // The stale session works before the posture change.
    expect((await s.app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie: stale.cookie } })).statusCode).toBe(200);

    // Enrol + enable 2FA using the ACTING session.
    const setup = await s.app.inject({ method: "POST", url: "/api/v1/auth/2fa/setup", headers: authHeaders(acting) });
    const secret = setup.json().secret as string;
    const enable = await s.app.inject({ method: "POST", url: "/api/v1/auth/2fa/enable", headers: authHeaders(acting), payload: { code: currentCode(secret) } });
    expect(enable.statusCode).toBe(200);

    // The OTHER session is now rejected…
    expect((await s.app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie: stale.cookie } })).statusCode).toBe(401);
    // …but the acting session still works.
    expect((await s.app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie: acting.cookie } })).statusCode).toBe(200);
  });
});
