import { currentCode } from "@paperboy/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, authHeaders, login, setupApi } from "./helpers.js";

/** Full TOTP 2FA: enroll (setup→verify→backup), challenge at login, backup-code
 *  login (one-time), and disable. */
describe("Two-factor authentication (TOTP)", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  let secret = "";
  let backupCodes: string[] = [];
  const creds = { email: "admin@paperboy.test", password: "Admin!Passw0rd" };

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, creds.email, creds.password); // 2FA still off here
  });
  afterAll(async () => {
    await s.app.close();
  });

  const rawLogin = () => s.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: creds });

  it("starts disabled; plain login returns a session (no challenge)", async () => {
    const status = await s.app.inject({ method: "GET", url: "/api/v1/auth/2fa/status", headers: { cookie: admin.cookie } });
    expect(status.json().enabled).toBe(false);
    expect(rawLogin && (await rawLogin()).json().user.email).toBe(creds.email); // session, not a challenge
  });

  it("email-first: a non-2FA account is asked for a password (then logs in)", async () => {
    const ask = await s.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "editor@paperboy.test" } });
    expect(ask.statusCode).toBe(200);
    expect(ask.json().passwordRequired).toBe(true);
    expect(ask.json().user).toBeUndefined();
    const ok = await s.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "editor@paperboy.test", password: "Editor!Passw0rd" } });
    expect(ok.json().user.email).toBe("editor@paperboy.test");
  });

  it("enrolls: setup → verify code → returns 10 backup codes; status becomes enabled", async () => {
    const setup = await s.app.inject({ method: "POST", url: "/api/v1/auth/2fa/setup", headers: authHeaders(admin) });
    expect(setup.statusCode).toBe(200);
    secret = setup.json().secret;
    expect(setup.json().uri).toContain("otpauth://totp/");

    // Wrong code is rejected.
    expect((await s.app.inject({ method: "POST", url: "/api/v1/auth/2fa/enable", headers: authHeaders(admin), payload: { code: "000000" } })).statusCode).toBe(401);

    const enable = await s.app.inject({ method: "POST", url: "/api/v1/auth/2fa/enable", headers: authHeaders(admin), payload: { code: currentCode(secret) } });
    expect(enable.statusCode).toBe(200);
    backupCodes = enable.json().backupCodes;
    expect(backupCodes).toHaveLength(10);

    const status = await s.app.inject({ method: "GET", url: "/api/v1/auth/2fa/status", headers: { cookie: admin.cookie } });
    expect(status.json()).toMatchObject({ enabled: true, backupCodesRemaining: 10 });
  });

  it("login now requires a 2FA code (password alone returns a challenge, not a session)", async () => {
    const res = await rawLogin();
    expect(res.statusCode).toBe(200);
    expect(res.json().mfaRequired).toBe(true);
    expect(res.json().user).toBeUndefined();
    const mfaToken = res.json().mfaToken as string;

    // Wrong code → 401.
    expect((await s.app.inject({ method: "POST", url: "/api/v1/auth/login/mfa", payload: { mfaToken, code: "000000" } })).statusCode).toBe(401);

    // Correct code → full session.
    const ok = await s.app.inject({ method: "POST", url: "/api/v1/auth/login/mfa", payload: { mfaToken, code: currentCode(secret) } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().user.email).toBe(creds.email);
    expect(ok.json().user.mfaEnabled).toBe(true);
    expect(ok.cookies.find((c) => c.name.includes("paperboy_sid"))).toBeTruthy();
  });

  it("PASSWORDLESS: a 2FA account logs in with email + code, no password sent", async () => {
    // Email only — no password field at all.
    const res = await s.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: creds.email } });
    expect(res.statusCode).toBe(200);
    expect(res.json().mfaRequired).toBe(true);
    expect(res.json().passwordRequired).toBeUndefined();
    const mfaToken = res.json().mfaToken as string;
    const ok = await s.app.inject({ method: "POST", url: "/api/v1/auth/login/mfa", payload: { mfaToken, code: currentCode(secret) } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().user.email).toBe(creds.email);
    expect(ok.cookies.find((c) => c.name.includes("paperboy_sid"))).toBeTruthy();
  });

  it("a backup code logs in once, then is consumed", async () => {
    const mfaToken = (await rawLogin()).json().mfaToken as string;
    const first = await s.app.inject({ method: "POST", url: "/api/v1/auth/login/mfa", payload: { mfaToken, code: backupCodes[0] } });
    expect(first.statusCode).toBe(200);

    // Reusing the same backup code fails (one-time).
    const token2 = (await rawLogin()).json().mfaToken as string;
    expect((await s.app.inject({ method: "POST", url: "/api/v1/auth/login/mfa", payload: { mfaToken: token2, code: backupCodes[0] } })).statusCode).toBe(401);
  });

  it("disable requires the password and turns 2FA off", async () => {
    expect((await s.app.inject({ method: "POST", url: "/api/v1/auth/2fa/disable", headers: authHeaders(admin), payload: { password: "wrong" } })).statusCode).toBe(401);
    const ok = await s.app.inject({ method: "POST", url: "/api/v1/auth/2fa/disable", headers: authHeaders(admin), payload: { password: creds.password } });
    expect(ok.statusCode).toBe(200);
    // Login is back to a direct session.
    expect((await rawLogin()).json().user.email).toBe(creds.email);
  });
});
