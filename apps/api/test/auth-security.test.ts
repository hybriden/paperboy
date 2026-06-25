import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_DB, type Suite, login, setupApi } from "./helpers.js";

describe("Secure login (Argon2id, generic errors, lockout, sessions)", () => {
  let s: Suite;
  beforeAll(async () => {
    s = await setupApi();
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("rejects wrong passwords with a generic 401 (no user enumeration)", async () => {
    const wrong = await s.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "admin@paperboy.test", password: "wrong-password" },
    });
    expect(wrong.statusCode).toBe(401);
    const unknown = await s.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "nobody@paperboy.test", password: "whatever" },
    });
    expect(unknown.statusCode).toBe(401);
    // Same generic message for both (no enumeration signal).
    expect(wrong.json().message).toBe(unknown.json().message);
  });

  it("sets an HttpOnly session cookie and issues a CSRF token on login", async () => {
    const res = await s.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "admin@paperboy.test", password: "Admin!Passw0rd" },
    });
    expect(res.statusCode).toBe(200);
    const cookie = res.cookies.find((c) => c.name.includes("paperboy_sid"))!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite?.toLowerCase()).toBe("lax");
    expect(res.json().csrfToken).toBeTruthy();
  });

  it("issues a PERSISTENT session cookie (survives a browser restart, not a session cookie)", async () => {
    // A session cookie (no Max-Age/Expires) is dropped when the browser closes,
    // forcing a re-login every day. The login cookie must carry a Max-Age so the
    // session persists across restarts up to the absolute lifetime (~30 days).
    const res = await s.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "admin@paperboy.test", password: "Admin!Passw0rd" },
    });
    const cookie = res.cookies.find((c) => c.name.includes("paperboy_sid"))!;
    // maxAge is in seconds; expect ~30 days (allow a small floor for clock/setup).
    expect(cookie.maxAge).toBeGreaterThanOrEqual(29 * 24 * 60 * 60);
  });

  it("locks the account after repeated failures", async () => {
    const attempt = () =>
      s.app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: "viewer@paperboy.test", password: "bad" },
      });
    for (let i = 0; i < 5; i++) await attempt();
    // Even the CORRECT password is now refused while locked...
    const locked = await s.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "viewer@paperboy.test", password: "Viewer!Passw0rd" },
    });
    expect(locked.statusCode).toBe(401);
    // ...and the lock is NOT distinguishable from a wrong password (no enumeration).
    const wrong = await s.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "viewer@paperboy.test", password: "still-wrong" },
    });
    expect(locked.json().message).toBe(wrong.json().message);
  });

  it("/me requires authentication and logout destroys the session", async () => {
    const anon = await s.app.inject({ method: "GET", url: "/api/v1/auth/me" });
    expect(anon.statusCode).toBe(401);

    const ctx = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    const me = await s.app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie: ctx.cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe("admin@paperboy.test");

    const out = await s.app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { cookie: ctx.cookie, "x-csrf-token": ctx.csrf, origin: "http://localhost:8090" },
    });
    expect(out.statusCode).toBe(200);

    const after = await s.app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie: ctx.cookie } });
    expect(after.statusCode).toBe(401); // session no longer valid
  });

  it("/logout requires CSRF (cookie alone is not enough)", async () => {
    const ctx = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    // No x-csrf-token, no Origin → a cross-site forced logout must be refused.
    const res = await s.app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: { cookie: ctx.cookie } });
    expect(res.statusCode).toBe(403);
    // The session is still valid afterwards.
    const me = await s.app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie: ctx.cookie } });
    expect(me.statusCode).toBe(200);
  });

  it("stores passwords as Argon2id hashes (never plaintext)", async () => {
    // Verify directly against the seeded user row.
    const { createDb } = await import("@paperboy/db");
    const { sql } = createDb(TEST_DB);
    const rows = await sql`SELECT password_hash FROM users WHERE email = 'admin@paperboy.test'`;
    const hash = (rows[0] as { password_hash: string }).password_hash;
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(hash).not.toContain("Admin!Passw0rd");
    await sql.end();
  });
});
