import { createDb, createUser, verifyLogin } from "@paperboy/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_DB, type Suite, setupApi } from "./helpers.js";

/**
 * The failed-attempt counter must bound CONCURRENT guessing, not just serial.
 *
 * All three gates (verifyLogin, verifyReauth, verifySecondFactor) did
 * `SELECT … ; set failed_attempts = user.failedAttempts + 1` — a read-modify-write
 * with no row lock. N wrong guesses that overlap in flight all read the same
 * starting value and all write the same result, so a burst of N advances the
 * counter by 1, not N — a ~N× amplification of the documented lockout, and on
 * /login/mfa the account lock is the ONLY account-level backstop on the 6-digit
 * code. The fix is an atomic `failed_attempts = failed_attempts + 1` in SQL.
 */
describe("failed-login lockout counts concurrent attempts atomically (P1)", () => {
  let s: Suite;
  const raw = createDb(TEST_DB);
  const email = "lockout-race@paperboy.test";

  beforeAll(async () => {
    s = await setupApi();
    await createUser(s.app.db, {
      email,
      name: "Lockout Race",
      password: "Correct!Passw0rd",
      roles: ["Viewer"],
      sections: [],
    });
  });
  afterAll(async () => {
    await s.app.close();
    await raw.sql.end();
  });

  it("four simultaneous wrong passwords advance the counter by four, not one", async () => {
    // Four < MAX_FAILED (5), so none of these should hit the locked branch that
    // returns before incrementing — every one is a countable wrong guess.
    const attempts = Array.from({ length: 4 }, () =>
      verifyLogin(s.app.db, email, "wrong-password").then(
        () => "resolved",
        () => "rejected",
      ),
    );
    const outcomes = await Promise.all(attempts);
    expect(outcomes.every((o) => o === "rejected")).toBe(true);

    const rows = (await raw.sql`SELECT failed_attempts FROM users WHERE email=${email}`) as Array<{ failed_attempts: number }>;
    // Read-modify-write recorded 1; the atomic increment records all 4.
    expect(rows[0]!.failed_attempts).toBe(4);
  });
});
