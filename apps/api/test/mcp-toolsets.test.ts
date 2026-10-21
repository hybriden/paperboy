import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_DB, type Suite, authHeaders, login, setupApi } from "./helpers.js";
import { McpClient } from "./mcp-stdio-client.js";

/**
 * Toolsets (#120) and the same-risk merges (#121). An agent picks tools from
 * the listing, and 64 of them — users, keys, webhooks and audit beside the
 * page it is writing — was "an extreme count" in Glama's review. The default
 * listing is the CONTENT toolset; the rest is opt-in per server
 * (PAPERBOY_TOOLSETS) or per HTTP connection (?toolsets=). Roles still decide
 * what may be called; toolsets only decide what is listed.
 */

/** What an agent writing content needs, and nothing else. */
const CONTENT = [
  "assist_writing", "copy_variant", "create_content", "create_upload_link", "delete_asset", "discard_draft",
  "duplicate_content", "get_content", "list_assets", "list_content", "list_content_types", "list_sites",
  "list_tree", "list_versions", "move_content", "publish_content", "restore_content", "restore_version",
  "search_stock_images", "set_field", "trash_content", "unpublish_content", "update_asset_alt", "update_content", "upload_asset",
];

describe("MCP toolsets", () => {
  let s: Suite;
  let token: string;
  const clients: McpClient[] = [];

  async function boot(toolsets: string): Promise<McpClient> {
    const c = new McpClient({ DATABASE_URL: TEST_DB, MCP_TOKEN: token, MCP_HTTP_PORT: "", PAPERBOY_TOOLSETS: toolsets });
    clients.push(c);
    await c.initialize();
    return c;
  }

  beforeAll(async () => {
    s = await setupApi();
    const admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    // Every site: instance-wide tools refuse a site-scoped token.
    const minted = await s.app.inject({ method: "POST", url: "/api/v1/manage/mcp-tokens", headers: authHeaders(admin), payload: { name: "toolsets-suite", allSites: true } });
    expect(minted.statusCode).toBe(200);
    token = minted.json().token as string;
  }, 90_000);

  afterAll(async () => {
    for (const c of clients) c.kill();
    await s.app.close();
  });

  it("lists only the content toolset by default", async () => {
    const c = await boot("");
    expect(await c.listToolNames()).toEqual([...CONTENT].sort());
  }, 60_000);

  it("lists every tool with all, and a union for a comma list", async () => {
    const all = await (await boot("all")).listToolNames();
    expect(all).toHaveLength(60);
    expect(all).toEqual(expect.arrayContaining([...CONTENT, "list_users", "delivery_get", "create_redirect", "list_forms", "create_content_type"]));

    const some = await (await boot("content,redirects")).listToolNames();
    expect(some).toEqual(expect.arrayContaining([...CONTENT, "create_redirect", "test_redirect"]));
    expect(some).not.toContain("list_users");
  }, 60_000);

  it("an unlisted tool answers with the toolset to enable, not a bare 'not found'", async () => {
    const res = await (await boot("")).call("list_users");
    expect(res.isError).toBe(true);
    expect(res.text).toContain('"admin" toolset');
    expect(res.text).toContain("PAPERBOY_TOOLSETS");
    expect(res.text).toContain("?toolsets=");
  }, 60_000);

  it("refuses to boot with an unknown toolset, naming the real ones", async () => {
    const c = new McpClient({ DATABASE_URL: TEST_DB, MCP_TOKEN: token, MCP_HTTP_PORT: "", PAPERBOY_TOOLSETS: "content,contnet" });
    clients.push(c);
    expect(await c.exited()).toBe(1);
    expect(c.stderr).toContain('"contnet"');
    expect(c.stderr).toContain("content, delivery, schema, redirects, forms, admin");
  }, 60_000);

  it("tools over data every site shares don't offer a `site` they would ignore", async () => {
    const tools = await (await boot("all")).listTools();
    const hasSite = (name: string) => Object.hasOwn(tools.find((t) => t.name === name)!.inputSchema.properties ?? {}, "site");
    for (const name of ["list_users", "create_user", "list_content_types", "update_content_type", "list_type_templates", "instantiate_type_template", "list_audit", "assist_writing"]) {
      expect(hasSite(name), name).toBe(false);
    }
    for (const name of ["list_content", "list_tree", "create_content", "list_redirects", "list_webhooks", "list_sites"]) {
      expect(hasSite(name), name).toBe(true);
    }
  }, 60_000);

  describe("merged tools (#121)", () => {
    let c: McpClient;
    beforeAll(async () => {
      c = await boot("all");
    }, 60_000);

    it("list_content {kind:'trash'} lists what trash_content removed", async () => {
      const made = await c.call("create_content", { type: "ArticlePage", locale: "en", name: "Toolsets trash probe" });
      expect(made.isError, made.text).toBe(false);
      const { documentId } = made.json as { documentId: string };
      expect((await c.call("trash_content", { documentId })).isError).toBe(false);
      const trash = await c.call("list_content", { kind: "trash" });
      expect(trash.isError, trash.text).toBe(false);
      expect((trash.json as Array<{ documentId: string }>).map((t) => t.documentId)).toContain(documentId);
    }, 60_000);

    it("list_sites reports the enabled locales and the default", async () => {
      const res = await c.call("list_sites");
      const locales = (res.json as { locales: Array<{ code: string; isDefault: boolean }> }).locales;
      expect(locales.map((l) => l.code)).toContain("en");
      expect(locales.filter((l) => l.isDefault)).toHaveLength(1);
    }, 60_000);

    it("upload_asset takes a stockImageId (the stock import path)", async () => {
      // No stock provider in the test env: reaching the provider's own error
      // proves the argument was accepted and routed to the stock import.
      const res = await c.call("upload_asset", { stockImageId: "abc123" });
      expect(res.isError).toBe(true);
      expect(res.text).toContain("No stock image provider is configured");
    }, 60_000);

    it("upload_asset refuses two sources at once", async () => {
      const res = await c.call("upload_asset", { stockImageId: "abc123", url: "https://example.com/a.jpg" });
      expect(res.isError).toBe(true);
      expect(res.text).toContain("exactly one of url, dataBase64 or stockImageId");
    }, 60_000);

    it("erase_form_submissions erases one submission by id", async () => {
      const res = await c.call("erase_form_submissions", { submissionId: "sub_does_not_exist" });
      expect(res.isError, res.text).toBe(false);
      expect(res.json).toEqual({ deleted: 0 });
    }, 60_000);

    it("erase_form_submissions wants exactly one of submissionId or email", async () => {
      const res = await c.call("erase_form_submissions", {});
      expect(res.isError).toBe(true);
      expect(res.text).toContain("exactly one of submissionId or email");
    }, 60_000);

    it("an old tool name says what replaced it", async () => {
      for (const [old, now] of [["list_trash", "list_content"], ["list_locales", "list_sites"], ["import_stock_image", "upload_asset"], ["delete_form_submission", "erase_form_submissions"]]) {
        const res = await c.call(old!);
        expect(res.isError, old).toBe(true);
        expect(res.text, old).toContain(`merged into ${now}`);
      }
      // Renamed to the verb_noun pattern the rest of the surface uses.
      for (const [old, now] of [["publish", "publish_content"], ["unpublish", "unpublish_content"], ["ai_assist", "assist_writing"]]) {
        const res = await c.call(old!, { documentId: "x" });
        expect(res.isError, old).toBe(true);
        expect(res.text, old).toContain(`renamed to ${now}`);
      }
    }, 60_000);
  });
});
