import { createDb } from "@paperboy/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, TEST_DB, authHeaders, login, setupApi } from "./helpers.js";

/**
 * Five wrong guesses lock an account for 15 minutes. The counter was never
 * reset when a lock ran out, so ONE wrong guess after expiry locked it again:
 * anyone who knew an address kept that account locked with four requests an
 * hour, and nothing in the product could let the owner back in.
 */
describe("account lockout", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  const { sql } = createDb(TEST_DB);
  const EMAIL = "editor@paperboy.test";
  const PASSWORD = "Editor!Passw0rd";
  const attempt = (password: string) => s.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: EMAIL, password } });
  const lockOut = async () => {
    for (let i = 0; i < 5; i++) expect((await attempt("wrong-password-1")).statusCode).toBe(401);
    expect((await attempt(PASSWORD)).statusCode, "locked: even the right password is refused").toBe(401);
  };
  const expireLock = () => sql`update users set locked_until = now() - interval '1 second' where email = ${EMAIL}`;

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
    await sql.end();
  });

  it("a lock that ran out takes a fresh set of guesses to renew, not one", async () => {
    await lockOut();
    await expireLock();
    expect((await attempt("wrong-password-2")).statusCode).toBe(401);
    expect((await attempt(PASSWORD)).statusCode, "one wrong guess must not re-lock").toBe(200);
  });

  it("an Admin can unlock an account", async () => {
    await lockOut();
    const users = (await s.app.inject({ method: "GET", url: "/api/v1/manage/users", headers: authHeaders(admin) })).json() as Array<{ id: string; email: string; locked: boolean }>;
    const target = users.find((u) => u.email === EMAIL)!;
    expect(target.locked).toBe(true);

    const unlocked = await s.app.inject({ method: "POST", url: `/api/v1/manage/users/${target.id}/unlock`, headers: authHeaders(admin) });
    expect(unlocked.statusCode, unlocked.body).toBe(200);
    expect((await attempt(PASSWORD)).statusCode).toBe(200);
    const [row] = (await sql`select count(*)::int as n from audit_log where action = 'user.unlock'`) as Array<{ n: number }>;
    expect(row!.n).toBe(1);
  });

  it("only an Admin can", async () => {
    const editor = await login(s.app, EMAIL, PASSWORD);
    const users = (await s.app.inject({ method: "GET", url: "/api/v1/manage/users", headers: authHeaders(admin) })).json() as Array<{ id: string; email: string }>;
    const adminId = users.find((u) => u.email === "admin@paperboy.test")!.id;
    expect((await s.app.inject({ method: "POST", url: `/api/v1/manage/users/${adminId}/unlock`, headers: authHeaders(editor) })).statusCode).toBe(403);
  });
});
