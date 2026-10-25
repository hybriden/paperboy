import { createDb } from "@paperboy/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, TEST_DB, setupApi } from "./helpers.js";

/**
 * Azure App Service's front end puts the client's PORT in X-Forwarded-For
 * ("203.0.113.7:9577", found live on cms.skya.no). req.ip then differed per
 * TCP connection, so every per-IP rate limit and the login lockout counted
 * connections instead of visitors, and audit rows carried a port.
 */
describe("a forwarded address with a port is the address", () => {
  let s: Suite;
  const { sql } = createDb(TEST_DB);
  const lastFailedLoginIp = async (forwardedFor: string) => {
    const res = await s.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { "x-forwarded-for": forwardedFor },
      payload: { email: "editor@paperboy.test", password: "definitely-wrong" },
    });
    expect(res.statusCode).toBe(401);
    const rows = (await sql`select ip from audit_log where action = 'auth.login_failed' order by id desc limit 1`) as Array<{ ip: string }>;
    return rows[0]!.ip;
  };

  beforeAll(async () => {
    s = await setupApi({ TRUST_PROXY: "true" });
  });
  afterAll(async () => {
    await s.app.close();
    await sql.end();
  });

  it("IPv4 with a port", async () => {
    expect(await lastFailedLoginIp("203.0.113.7:9577")).toBe("203.0.113.7");
  });
  it("bracketed IPv6 with a port", async () => {
    expect(await lastFailedLoginIp("[2001:db8::1]:443")).toBe("2001:db8::1");
  });
  it("a plain address is untouched", async () => {
    expect(await lastFailedLoginIp("198.51.100.4")).toBe("198.51.100.4");
  });
});
