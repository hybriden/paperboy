import { currentCode } from "@paperboy/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * /2fa/enable had no re-auth gate, while /2fa/disable did (`verifyReauth`).
 *
 * That asymmetry turns a stolen session into a permanent account takeover:
 *  1. the attacker calls /2fa/setup + /2fa/enable, enrolling THEIR authenticator;
 *  2. the same call runs evictOtherSessions(keep = the attacker's session), so the
 *     legitimate owner is signed out and the attacker stays in;
 *  3. because 2FA login is PASSWORDLESS (email → code), the owner's password no
 *     longer reaches any login path at all, and /2fa/disable needs a session they
 *     can't get. Recovery requires a second Admin.
 *
 * Enabling 2FA is a credential-posture change, so it needs the same password gate
 * as disabling it.
 */
describe("/2fa/enable requires the account password (re-auth)", () => {
  let s: Suite;
  let ctx: Awaited<ReturnType<typeof login>>;
  const password = "Editor!Passw0rd";

  beforeAll(async () => {
    s = await setupApi();
    ctx = await login(s.app, "editor@paperboy.test", password);
  });
  afterAll(async () => {
    await s.app.close();
  });

  /** Begin enrolment and return a valid current code for the issued secret. */
  async function beginSetup(): Promise<string> {
    const setup = await s.app.inject({ method: "POST", url: "/api/v1/auth/2fa/setup", headers: authHeaders(ctx) });
    expect(setup.statusCode, setup.body).toBe(200);
    return currentCode(setup.json().secret as string);
  }

  it("refuses to enable without a password (a stolen session is not enough)", async () => {
    const code = await beginSetup();
    const res = await s.app.inject({
      method: "POST",
      url: "/api/v1/auth/2fa/enable",
      headers: authHeaders(ctx),
      payload: { code },
    });
    // 422 from the route schema (password is now required) — any refusal is fine,
    // what must not happen is a 200 with backup codes.
    expect(res.statusCode, res.body).not.toBe(200);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("refuses to enable with a WRONG password even when the code is valid", async () => {
    const code = await beginSetup();
    const res = await s.app.inject({
      method: "POST",
      url: "/api/v1/auth/2fa/enable",
      headers: authHeaders(ctx),
      payload: { code, password: "not-the-right-password" },
    });
    expect([400, 401]).toContain(res.statusCode);

    const status = await s.app.inject({ method: "GET", url: "/api/v1/auth/2fa/status", headers: authHeaders(ctx) });
    expect(status.json().enabled, "2FA must NOT be enabled by a failed attempt").toBe(false);
  });

  it("enables 2FA when both the password and the code are correct", async () => {
    const code = await beginSetup();
    const res = await s.app.inject({
      method: "POST",
      url: "/api/v1/auth/2fa/enable",
      headers: authHeaders(ctx),
      payload: { code, password },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(Array.isArray(res.json().backupCodes)).toBe(true);

    const status = await s.app.inject({ method: "GET", url: "/api/v1/auth/2fa/status", headers: authHeaders(ctx) });
    expect(status.json().enabled).toBe(true);
  });
});
