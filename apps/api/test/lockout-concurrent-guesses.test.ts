import { createDb, createUser, currentCode, verifyLogin, verifySecondFactor } from "@paperboy/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_DB, type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * Audit 2026-09-30: the lockout counted concurrent failures atomically, but the
 * GATE still read `locked_until` with a plain SELECT, checked the guess, and
 * only then recorded the failure. Every request already in flight was checked,
 * so a parallel burst from many IPs got far more than MAX_FAILED guesses at
 * the 6-digit code — which, for a 2FA account, is the only login factor. The
 * attempt must be reserved (counted, lock-checked) BEFORE the guess is checked.
 */
describe("the lockout caps CONCURRENT guesses, not only the counter", () => {
  let s: Suite;
  const raw = createDb(TEST_DB);
  let secret = "";
  let editorId = "";
  const pwEmail = "lockout-burst@paperboy.test";

  beforeAll(async () => {
    s = await setupApi();
    const editor = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
    const setup = await s.app.inject({ method: "POST", url: "/api/v1/auth/2fa/setup", headers: authHeaders(editor) });
    secret = setup.json().secret as string;
    const enable = await s.app.inject({ method: "POST", url: "/api/v1/auth/2fa/enable", headers: authHeaders(editor), payload: { code: currentCode(secret), password: "Editor!Passw0rd" } });
    expect(enable.statusCode).toBe(200);
    editorId = ((await raw.sql`SELECT id FROM users WHERE email = 'editor@paperboy.test'`) as Array<{ id: string }>)[0]!.id;
    await createUser(s.app.db, { email: pwEmail, name: "Burst", password: "Correct!Passw0rd", roles: ["Viewer"], sections: [] });
  });
  afterAll(async () => {
    await s.app.close();
    await raw.sql.end();
  });

  it("with one attempt left, a burst of wrong 2FA codes cannot be followed by a correct one in the same burst", async () => {
    // Clear the step the enrolment consumed so the current code is acceptable.
    await raw.sql`UPDATE users SET failed_attempts = 4, locked_until = NULL, last_totp_step = NULL WHERE id = ${editorId}`;
    const guesses = [...Array.from({ length: 5 }, () => "000000"), currentCode(secret)];
    const results = await Promise.all(guesses.map((code) => verifySecondFactor(s.app.db, editorId, code)));
    // Only ONE attempt was left: the correct code arrived after it was spent.
    expect(results.filter(Boolean)).toEqual([]);
  });

  it("with one attempt left, a burst of wrong passwords cannot be followed by the right one", async () => {
    await raw.sql`UPDATE users SET failed_attempts = 4, locked_until = NULL WHERE email = ${pwEmail}`;
    const guesses = [...Array.from({ length: 5 }, () => "wrong-password"), "Correct!Passw0rd"];
    const results = await Promise.all(
      guesses.map((pw) => verifyLogin(s.app.db, pwEmail, pw).then(() => true, () => false)),
    );
    expect(results.filter(Boolean)).toEqual([]);
  });

  it("a correct attempt still resets the counter", async () => {
    await raw.sql`UPDATE users SET failed_attempts = 2, locked_until = NULL WHERE email = ${pwEmail}`;
    await verifyLogin(s.app.db, pwEmail, "Correct!Passw0rd");
    const rows = (await raw.sql`SELECT failed_attempts, locked_until FROM users WHERE email = ${pwEmail}`) as Array<{ failed_attempts: number; locked_until: Date | null }>;
    expect(rows[0]).toMatchObject({ failed_attempts: 0, locked_until: null });
  });
});
