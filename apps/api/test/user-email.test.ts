import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, authHeaders, login, setupApi } from "./helpers.js";

/** Admins can change a user's email (the login identity). Unique-checked. */
describe("user admin: email change", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  let userId: string;

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/users",
      headers: authHeaders(admin),
      payload: { email: "old@paperboy.test", name: "Renamee", password: "Renamee!Pass1", roles: ["Editor"] },
    });
    expect(created.statusCode).toBe(200);
    userId = created.json().id;
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("changes the email; the new one logs in, the old one no longer does", async () => {
    const res = await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/users/${userId}`,
      headers: authHeaders(admin),
      payload: { email: "new@paperboy.test" },
    });
    expect(res.statusCode).toBe(200);

    const fresh = await login(s.app, "new@paperboy.test", "Renamee!Pass1");
    expect(fresh.cookie).toBeTruthy();
    const stale = await s.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "old@paperboy.test", password: "Renamee!Pass1" },
    });
    expect(stale.statusCode).toBe(401);
  });

  it("rejects an email another user already has", async () => {
    const res = await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/users/${userId}`,
      headers: authHeaders(admin),
      payload: { email: "admin@paperboy.test" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("already in use");
  });

  it("rejects a malformed email", async () => {
    const res = await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/users/${userId}`,
      headers: authHeaders(admin),
      payload: { email: "not-an-email" },
    });
    expect(res.statusCode).toBe(422);
  });
});
