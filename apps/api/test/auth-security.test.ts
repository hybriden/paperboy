import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ORIGIN, TEST_DB, type Suite, login, setupApi } from "./helpers.js";

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

  // The Origin/Referer check is INDEPENDENT of the token: every other CSRF test
  // omits both the token and the Origin, which never exercised the fail-closed
  // branch on its own. A valid token with a foreign Origin must still be refused.
  it("a valid CSRF token with a foreign Origin is refused (bad_origin) and the session survives", async () => {
    const ctx = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    const res = await s.app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { cookie: ctx.cookie, "x-csrf-token": ctx.csrf, origin: "http://evil.example" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("bad_origin");
    const me = await s.app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie: ctx.cookie } });
    expect(me.statusCode, "the refused request must not have logged the user out").toBe(200);
  });

  it("the configured CORS origin is accepted as Origin", async () => {
    const ctx = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    const res = await s.app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { cookie: ctx.cookie, "x-csrf-token": ctx.csrf, origin: ORIGIN },
    });
    expect(res.statusCode, res.body).toBe(200);
  });

  // The clause is fail-CLOSED: a request with neither header must be refused even
  // with a valid cookie + token. Without this case an `if (!origin) return true`
  // shortcut would pass every other Origin test in this file.
  it("a valid CSRF token with NO Origin and NO Referer is refused (bad_origin)", async () => {
    const ctx = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    const res = await s.app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { cookie: ctx.cookie, "x-csrf-token": ctx.csrf },
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error).toBe("bad_origin");
  });

  it("no Origin but a matching Referer is accepted (older browsers on same-origin form posts)", async () => {
    const ctx = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    const res = await s.app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { cookie: ctx.cookie, "x-csrf-token": ctx.csrf, referer: `${ORIGIN}/admin/settings` },
    });
    expect(res.statusCode, res.body).toBe(200);
  });

  it("a failed password login leaves an auth.login_failed audit row with the IP only (no email)", async () => {
    const { createDb } = await import("@paperboy/db");
    const { sql } = createDb(TEST_DB);
    try {
      const count = async () => Number(((await sql`select count(*)::int as c from audit_log where action = 'auth.login_failed'`) as Array<{ c: number }>)[0]!.c);
      const before = await count();
      const res = await s.app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: "editor@paperboy.test", password: "definitely-wrong" },
      });
      expect(res.statusCode).toBe(401);
      expect(await count()).toBe(before + 1);
      const rows = (await sql`select actor_user_id, ip, detail::text as detail from audit_log where action = 'auth.login_failed' order by id desc limit 1`) as Array<{ actor_user_id: string | null; ip: string | null; detail: string | null }>;
      expect(rows[0]!.ip).toBeTruthy();
      // Credential stuffing must be visible in Settings → Audit, but the log must
      // not become a list of tried emails (or, worse, passwords).
      expect(rows[0]!.actor_user_id).toBeNull();
      expect(JSON.stringify(rows[0])).not.toContain("editor@paperboy.test");
      expect(JSON.stringify(rows[0])).not.toContain("definitely-wrong");
    } finally {
      await sql.end();
    }
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
