import { currentCode } from "@paperboy/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * H4 + M12: for a 2FA account the login is passwordless, so the TOTP code is the
 * SOLE factor. It must (M12) be single-use per time-step (no replay) and (H4) be
 * guarded by a per-account lockout like the password path — otherwise the only
 * factor protecting the account has no brute-force ceiling.
 */
describe("2FA login hardening: single-use TOTP + per-account lockout", () => {
  let s: Suite;
  let editor: Awaited<ReturnType<typeof login>>;
  let secret = "";
  const creds = { email: "editor@paperboy.test", password: "Editor!Passw0rd" };

  beforeAll(async () => {
    s = await setupApi();
    editor = await login(s.app, creds.email, creds.password);
    const setup = await s.app.inject({ method: "POST", url: "/api/v1/auth/2fa/setup", headers: authHeaders(editor) });
    secret = setup.json().secret as string;
    const enable = await s.app.inject({ method: "POST", url: "/api/v1/auth/2fa/enable", headers: authHeaders(editor), payload: { code: currentCode(secret) } });
    expect(enable.statusCode).toBe(200);
  });
  afterAll(async () => {
    await s.app.close();
  });

  const challenge = async () =>
    (await s.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: creds.email } })).json().mfaToken as string;
  const submit = (mfaToken: string, code: string) =>
    s.app.inject({ method: "POST", url: "/api/v1/auth/login/mfa", payload: { mfaToken, code } });

  it("M12: a TOTP code cannot be replayed within its validity window", async () => {
    const code = currentCode(secret);
    const first = await submit(await challenge(), code);
    expect(first.statusCode).toBe(200);
    // Same code, fresh challenge token: the time-step is already consumed.
    const replay = await submit(await challenge(), code);
    expect(replay.statusCode).toBe(401);
  });

  it("H4: repeated wrong codes lock the account (correct code then refused)", async () => {
    const token = await challenge();
    for (let i = 0; i < 5; i++) {
      expect((await submit(token, "000000")).statusCode).toBe(401);
    }
    // Locked: even a correct, never-used code is refused.
    expect((await submit(token, currentCode(secret))).statusCode).toBe(401);
  });
});
