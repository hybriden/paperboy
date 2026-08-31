import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * Minting an MCP token needs the signed-in admin's PASSWORD, the same re-auth
 * gate as enabling/disabling 2FA.
 *
 * An mcp_token row never expires and survives a password change or a 2FA
 * enrolment (both evict sessions only). So a hijacked admin session could mint
 * itself a permanent credential that outlives every remedy the owner has —
 * unless the mint demands something the session holder does not have.
 */
describe("POST /manage/mcp-tokens requires the admin's password (re-auth)", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  let adminId: string;

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    const users = (await s.app.inject({ method: "GET", url: "/api/v1/manage/users", headers: { cookie: admin.cookie } })).json() as Array<{ id: string; email: string }>;
    adminId = users.find((u) => u.email === "admin@paperboy.test")!.id;
  });
  afterAll(async () => {
    await s.app.close();
  });

  const listNames = async (): Promise<string[]> =>
    ((await s.app.inject({ method: "GET", url: "/api/v1/manage/mcp-tokens", headers: { cookie: admin.cookie } })).json() as Array<{ name: string }>).map((r) => r.name);

  const mint = (payload: Record<string, unknown>) =>
    s.app.inject({ method: "POST", url: "/api/v1/manage/mcp-tokens", headers: authHeaders(admin), payload });

  it("refuses a WRONG password and mints nothing", async () => {
    const res = await mint({ name: "hijacked-session", userId: adminId, password: "not-the-admin-password" });
    expect(res.statusCode, res.body).toBe(401);
    expect(res.json()).not.toHaveProperty("token");
    expect(await listNames()).not.toContain("hijacked-session");
  });

  it("refuses a request with no password at all (schema), mints nothing", async () => {
    const res = await mint({ name: "no-password", userId: adminId });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json()).not.toHaveProperty("token");
    expect(await listNames()).not.toContain("no-password");
  });

  it("mints with the RIGHT password — and never writes the password to the audit log", async () => {
    const res = await mint({ name: "reauthed", userId: adminId, password: "Admin!Passw0rd" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().token as string).toMatch(/^mcp_/);
    expect(await listNames()).toContain("reauthed");

    const audit = await s.app.inject({ method: "GET", url: "/api/v1/manage/audit?action=mcptoken.create", headers: { cookie: admin.cookie } });
    expect((audit.json() as Array<{ action: string }>).some((r) => r.action === "mcptoken.create")).toBe(true);
    expect(audit.body).not.toContain("Admin!Passw0rd");
  });
});
