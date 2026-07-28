import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MCP_DIR, McpClient } from "./mcp-stdio-client.js";
import { type Suite, TEST_DB, authHeaders, login, setupApi } from "./helpers.js";

/**
 * MCP authorization. CLAUDE.md's central MCP claim is that it "calls the same
 * functions the API does, so it inherits RBAC" — but the seven delivery_* tools
 * called the delivery chokepoint with no permission check at all. On the HTTP API
 * those reads are authorized by `verifyDeliveryKey` (a public key gets published
 * only; a preview key gets drafts); MCP skipped that layer and substituted nothing.
 *
 * So a token minted for the section-scoped Author — whose session can only reach
 * its own section — could call delivery_search/delivery_list with preview:true and
 * read every unpublished draft in the site, because the delivery chokepoint is
 * KEY-scoped, not section-scoped.
 *
 * Separately: bearerOk compared the presented bearer against the in-memory boot
 * MCP_TOKEN *before* the DB lookup, so revoking that token in Settings → MCP had
 * no effect on the running server — the admin saw "revoked" while the holder kept
 * full access.
 */
describe("MCP authorization — delivery tools and token revocation", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  let authorToken: string;
  let authorMcp: McpClient;

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    const users = (
      await s.app.inject({ method: "GET", url: "/api/v1/manage/users", headers: { cookie: admin.cookie } })
    ).json() as Array<{ id: string; email: string }>;
    const authorId = users.find((u) => u.email === "author@paperboy.test")!.id;

    const minted = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/mcp-tokens",
      headers: authHeaders(admin),
      payload: { name: "authz-suite-author", userId: authorId },
    });
    expect(minted.statusCode, minted.body).toBe(200);
    authorToken = minted.json().token as string;

    authorMcp = new McpClient({ DATABASE_URL: TEST_DB, MCP_TOKEN: authorToken, MCP_HTTP_PORT: "" });
    await authorMcp.initialize();
  }, 90_000);

  afterAll(async () => {
    authorMcp?.kill();
    await s.app.close();
  });

  it("a section-scoped token cannot read drafts through delivery_search (preview)", async () => {
    const r = await authorMcp.call("delivery_search", { query: "Unpublished", preview: true });
    expect(r.isError, `expected refusal, got: ${r.text}`).toBe(true);
  }, 60_000);

  it("a section-scoped token cannot read drafts through delivery_list (preview)", async () => {
    const r = await authorMcp.call("delivery_list", { type: "ArticlePage", preview: true });
    expect(r.isError, `expected refusal, got: ${r.text}`).toBe(true);
  }, 60_000);

  it("the refusal is self-teaching: it names the limitation and the tool to use instead", async () => {
    const r = await authorMcp.call("delivery_list", { type: "ArticlePage", preview: true });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/section/i);
    expect(r.text).toMatch(/list_content|get_content/);
  }, 60_000);

  it("the PUBLISHED perspective still works for a scoped token (it is public data)", async () => {
    // A public delivery key would serve exactly this, so refusing it would be
    // security theatre that breaks a legitimate agent use case.
    const r = await authorMcp.call("delivery_list", { type: "ArticlePage" });
    expect(r.isError, r.text).toBe(false);
  }, 60_000);

  it("revoking the boot token locks the running HTTP server out (no restart)", async () => {
    const rows = (
      await s.app.inject({ method: "GET", url: "/api/v1/manage/mcp-tokens", headers: { cookie: admin.cookie } })
    ).json() as Array<{ id: number; name: string }>;
    const id = rows.find((r) => r.name === "authz-suite-author")!.id;

    const port = 18990;
    const requireFromMcp = createRequire(join(MCP_DIR, "package.json"));
    const tsxCli = requireFromMcp.resolve("tsx/cli");
    let stderr = "";
    const proc = spawn(process.execPath, [tsxCli, "src/server.ts"], {
      cwd: MCP_DIR,
      env: { ...process.env, DATABASE_URL: TEST_DB, MCP_TOKEN: authorToken, MCP_HTTP_PORT: String(port) },
      stdio: ["ignore", "ignore", "pipe"],
    });
    proc.stderr!.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    try {
      const deadline = Date.now() + 60_000;
      while (!stderr.includes("ready on http") && Date.now() < deadline) {
        if (proc.exitCode != null) throw new Error(`mcp exited early: ${stderr.slice(-1500)}`);
        await new Promise((r) => setTimeout(r, 150));
      }
      if (!stderr.includes("ready on http")) throw new Error(`mcp never came up: ${stderr.slice(-1500)}`);

      const ping = (): Promise<Response> =>
        fetch(`http://127.0.0.1:${port}/mcp`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${authorToken}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
        });

      expect((await ping()).status, "the live token should be accepted before revocation").not.toBe(401);

      const revoked = await s.app.inject({
        method: "POST",
        url: `/api/v1/manage/mcp-tokens/${id}/revoke`,
        headers: authHeaders(admin),
      });
      expect(revoked.statusCode, revoked.body).toBe(200);

      expect((await ping()).status, "a revoked token must stop working without a restart").toBe(401);
    } finally {
      proc.kill();
    }
  }, 90_000);
});
