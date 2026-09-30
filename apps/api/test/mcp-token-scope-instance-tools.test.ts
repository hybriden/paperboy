import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, TEST_DB, authHeaders, login, setupApi } from "./helpers.js";
import { McpClient } from "./mcp-stdio-client.js";

/**
 * Audit 2026-09-30: an MCP token's site scope is a credential-level cap
 * (CLAUDE.md), but it was only enforced on site-partitioned data. The tools
 * that change what EVERY site shares — users and their (global) roles, content
 * types, type templates — and the instance-wide audit trail ignored it, so an
 * Admin token scoped to one site could `create_user {roles:["Admin"]}` and sign
 * in with access to every site. Those tools now require a cross-site token.
 */
describe("a site-scoped MCP token cannot use instance-wide tools", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  let scoped: McpClient;
  let crossSite: McpClient;

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    const mint = async (payload: Record<string, unknown>) => {
      const res = await s.app.inject({ method: "POST", url: "/api/v1/manage/mcp-tokens", headers: authHeaders(admin), payload });
      expect(res.statusCode, res.body).toBe(200);
      return res.json().token as string;
    };
    scoped = new McpClient({ DATABASE_URL: TEST_DB, MCP_TOKEN: await mint({ name: "one-site" }), MCP_HTTP_PORT: "" });
    crossSite = new McpClient({ DATABASE_URL: TEST_DB, MCP_TOKEN: await mint({ name: "all-sites", allSites: true }), MCP_HTTP_PORT: "" });
    await scoped.initialize();
    await crossSite.initialize();
  }, 90_000);
  afterAll(async () => {
    scoped?.kill();
    crossSite?.kill();
    await s.app.close();
  });

  const typeDef = { name: "ScopeProbe", displayName: "Scope Probe", kind: "block", fields: [{ name: "t", displayName: "T", type: "text" }] };

  it.each([
    ["create_user", { email: "escalate@paperboy.test", name: "Esc", password: "Escalate!Passw0rd1", roles: ["Admin"] }],
    ["create_content_type", { definition: typeDef }],
    ["create_type_template", { definition: { ...typeDef, name: "ScopeProbeTemplate" } }],
    ["list_audit", {}],
  ])("%s is refused for a site-scoped token, with a self-teaching error", async (tool, args) => {
    const res = await scoped.call(tool, args);
    expect(res.isError, res.text).toBe(true);
    expect(res.text).toMatch(/every site/i);
  }, 30_000);

  it("the escalation did not happen", async () => {
    const users = (await s.app.inject({ method: "GET", url: "/api/v1/manage/users", headers: authHeaders(admin) })).json() as Array<{ email: string }>;
    expect(users.some((u) => u.email === "escalate@paperboy.test")).toBe(false);
  });

  it("a cross-site token can still manage users", async () => {
    const res = await crossSite.call("create_user", { email: "allowed@paperboy.test", name: "Ok", password: "Allowed!Passw0rd1", roles: ["Viewer"] });
    expect(res.isError, res.text).toBe(false);
  }, 30_000);
});
