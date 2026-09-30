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

  // Which guess of a parallel burst gets the last attempt is a race, so these
  // assert what the fix guarantees regardless of order: with ONE attempt left,
  // exactly one guess is checked (and counted) and every other one is refused
  // unchecked. The old read-then-check gate checked — and counted — them all.
  const failedAttempts = async (where: { id?: string; email?: string }) =>
    ((where.id
      ? await raw.sql`SELECT failed_attempts FROM users WHERE id = ${where.id}`
      : await raw.sql`SELECT failed_attempts FROM users WHERE email = ${where.email!}`) as Array<{ failed_attempts: number }>)[0]!.failed_attempts;

  it("with one attempt left, a burst of wrong 2FA codes gets exactly one checked", async () => {
    await raw.sql`UPDATE users SET failed_attempts = 4, locked_until = NULL WHERE id = ${editorId}`;
    const results = await Promise.all(Array.from({ length: 6 }, () => verifySecondFactor(s.app.db, editorId, "000000")));
    expect(results.filter(Boolean)).toEqual([]);
    expect(await failedAttempts({ id: editorId })).toBe(5);
  });

  it("with one attempt left, a burst of wrong passwords gets exactly one checked", async () => {
    await raw.sql`UPDATE users SET failed_attempts = 4, locked_until = NULL WHERE email = ${pwEmail}`;
    const results = await Promise.all(
      Array.from({ length: 6 }, () => verifyLogin(s.app.db, pwEmail, "wrong-password").then(() => true, () => false)),
    );
    expect(results.filter(Boolean)).toEqual([]);
    expect(await failedAttempts({ email: pwEmail })).toBe(5);
  });

  it("once the burst has spent the last attempt, even the right password is refused", async () => {
    // Locked by the previous burst (failed_attempts = 5, locked_until set).
    await expect(verifyLogin(s.app.db, pwEmail, "Correct!Passw0rd")).rejects.toThrow();
  });

  it("a correct attempt still resets the counter", async () => {
    await raw.sql`UPDATE users SET failed_attempts = 2, locked_until = NULL WHERE email = ${pwEmail}`;
    await verifyLogin(s.app.db, pwEmail, "Correct!Passw0rd");
    const rows = (await raw.sql`SELECT failed_attempts, locked_until FROM users WHERE email = ${pwEmail}`) as Array<{ failed_attempts: number; locked_until: Date | null }>;
    expect(rows[0]).toMatchObject({ failed_attempts: 0, locked_until: null });
  });
});
