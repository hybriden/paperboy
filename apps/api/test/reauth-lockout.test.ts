import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * S3-L3: the password-reauth paths (/change-password, /2fa/disable) verified the
 * password with no per-account lockout, so a session holder could brute-force it.
 * They now share the same failedAttempts/lockedUntil lockout as login.
 */
describe("password reauth paths enforce the account lockout", () => {
  let s: Suite;
  let editor: Awaited<ReturnType<typeof login>>;
  beforeAll(async () => {
    s = await setupApi();
    editor = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("/change-password locks the account after repeated wrong current passwords", async () => {
    const attempt = (oldPassword: string) =>
      s.app.inject({ method: "POST", url: "/api/v1/auth/change-password", headers: authHeaders(editor), payload: { oldPassword, newPassword: "BrandNewPassw0rd" } });

    for (let i = 0; i < 5; i++) expect((await attempt("wrong-password")).statusCode).toBe(401);
    // Locked: even the CORRECT current password is now refused.
    expect((await attempt("Editor!Passw0rd")).statusCode).toBe(401);
  });
});
