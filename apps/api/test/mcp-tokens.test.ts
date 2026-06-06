import { verifyMcpToken } from "@paperboy/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ORIGIN, type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * CONTRACT FREEZE — MCP token management routes (previously ZERO coverage).
 * Pins: token shown exactly once + format/prefix, list NEVER exposes the secret
 * or its hash, revoke makes verifyMcpToken fail, permission gating (user.manage),
 * and CSRF on mutations.
 */

describe("MCP token routes", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  let editor: Awaited<ReturnType<typeof login>>;
  let adminUserId: string;

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    editor = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
    // Resolve the admin user id via the users list (needed as the token's subject).
    const users = await s.app.inject({ method: "GET", url: "/api/v1/manage/users", headers: { cookie: admin.cookie } });
    const list = users.json() as Array<{ id: string; email: string }>;
    adminUserId = list.find((u) => u.email === "admin@paperboy.test")!.id;
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("create returns the token EXACTLY ONCE with the mcp_ prefix", async () => {
    const res = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/mcp-tokens",
      headers: authHeaders(admin),
      payload: { name: "CI token", userId: adminUserId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    // The ONLY field returned is the token; no id/hash echoed back.
    expect(Object.keys(body)).toEqual(["token"]);
    expect(typeof body.token).toBe("string");
    expect(body.token as string).toMatch(/^mcp_[A-Za-z0-9_-]+$/);
    // 256-bit base64url ≈ 43 chars + "mcp_" prefix.
    expect((body.token as string).length).toBeGreaterThan(40);
  });

  it("create with an unknown userId is rejected (400)", async () => {
    const res = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/mcp-tokens",
      headers: authHeaders(admin),
      payload: { name: "bad", userId: "doesnotexist000000000000" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("list shows metadata but NEVER the token value or hash", async () => {
    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/mcp-tokens",
      headers: authHeaders(admin),
      payload: { name: "Listable token", userId: adminUserId },
    });
    const secret = created.json().token as string;

    const list = await s.app.inject({ method: "GET", url: "/api/v1/manage/mcp-tokens", headers: { cookie: admin.cookie } });
    expect(list.statusCode).toBe(200);
    const rows = list.json() as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);

    const row = rows.find((r) => r.name === "Listable token")!;
    expect(row).toBeTruthy();
    // Exact metadata shape — no token/tokenHash/hash keys.
    expect(Object.keys(row).sort()).toEqual(
      ["createdAt", "email", "id", "lastUsedAt", "name", "revokedAt", "userId"].sort(),
    );
    expect(row.email).toBe("admin@paperboy.test");
    expect(row.revokedAt).toBeNull();

    // The raw secret (and any substring of it) must not appear in the whole list.
    const serialized = list.body;
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(secret.slice(4)); // without the mcp_ prefix
    for (const r of rows) {
      expect(r).not.toHaveProperty("token");
      expect(r).not.toHaveProperty("tokenHash");
      expect(r).not.toHaveProperty("hash");
    }
  });

  it("a freshly created token authenticates via verifyMcpToken (acts AS the user)", async () => {
    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/mcp-tokens",
      headers: authHeaders(admin),
      payload: { name: "Verifiable token", userId: adminUserId },
    });
    const token = created.json().token as string;
    const userId = await verifyMcpToken(s.app.db, token);
    expect(userId).toBe(adminUserId);
  });

  it("revoke works and a revoked token's verifyMcpToken returns null", async () => {
    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/mcp-tokens",
      headers: authHeaders(admin),
      payload: { name: "Revokable token", userId: adminUserId },
    });
    const token = created.json().token as string;
    expect(await verifyMcpToken(s.app.db, token)).toBe(adminUserId);

    // Find its id from the list.
    const list = await s.app.inject({ method: "GET", url: "/api/v1/manage/mcp-tokens", headers: { cookie: admin.cookie } });
    const row = (list.json() as Array<{ id: number; name: string }>).find((r) => r.name === "Revokable token")!;

    const revoke = await s.app.inject({
      method: "POST",
      url: `/api/v1/manage/mcp-tokens/${row.id}/revoke`,
      headers: authHeaders(admin),
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json()).toEqual({ ok: true });

    // The token no longer authenticates.
    expect(await verifyMcpToken(s.app.db, token)).toBeNull();

    // And the list reflects revoked state.
    const list2 = await s.app.inject({ method: "GET", url: "/api/v1/manage/mcp-tokens", headers: { cookie: admin.cookie } });
    const row2 = (list2.json() as Array<{ id: number; revokedAt: string | null }>).find((r) => r.id === row.id)!;
    expect(row2.revokedAt).not.toBeNull();
  });

  it("revoking an unknown token id → 404", async () => {
    const res = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/mcp-tokens/9999999/revoke",
      headers: authHeaders(admin),
    });
    expect(res.statusCode).toBe(404);
  });

  it("permission gating: Editor (no user.manage) is DENIED list, create and revoke (403)", async () => {
    const list = await s.app.inject({ method: "GET", url: "/api/v1/manage/mcp-tokens", headers: { cookie: editor.cookie } });
    expect(list.statusCode).toBe(403);

    const create = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/mcp-tokens",
      headers: authHeaders(editor),
      payload: { name: "nope", userId: adminUserId },
    });
    expect(create.statusCode).toBe(403);

    const revoke = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/mcp-tokens/1/revoke",
      headers: authHeaders(editor),
    });
    expect(revoke.statusCode).toBe(403);
  });

  it("CSRF is required on create and revoke (403 without the x-csrf-token)", async () => {
    const create = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/mcp-tokens",
      headers: { cookie: admin.cookie, origin: ORIGIN },
      payload: { name: "no csrf", userId: adminUserId },
    });
    expect(create.statusCode).toBe(403);

    const revoke = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/mcp-tokens/1/revoke",
      headers: { cookie: admin.cookie, origin: ORIGIN },
    });
    expect(revoke.statusCode).toBe(403);
  });
});
