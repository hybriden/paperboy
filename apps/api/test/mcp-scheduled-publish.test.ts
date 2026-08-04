import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PUBLIC_KEY, TEST_DB, type Suite, authHeaders, login, setupApi } from "./helpers.js";
import { McpClient } from "./mcp-stdio-client.js";

/**
 * Reported bug (harmonix automation, 2026-08-04): scheduled publishing exists
 * end-to-end (schedulePublish, the ticker, the manage /schedule route, the
 * dashboard panel) — but NO MCP tool accepted a go-live time; `publish` took
 * only documentId/locale/allowLanguageMismatch. An automation wanting "go live
 * at 09:00" was forced to publish immediately and gate visibility on a data
 * field, ending in a state the CMS itself misreports: status "published",
 * dashboard "Nothing scheduled", yet no reader can see the page. The MCP
 * `publish` tool must carry publishAt/expireAt through the SAME schedulePublish
 * chokepoint the manage route uses.
 */

describe("MCP publish carries publishAt/expireAt (scheduled publishing over MCP)", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  let mcp: McpClient;

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    const users = (await s.app.inject({ method: "GET", url: "/api/v1/manage/users", headers: { cookie: admin.cookie } })).json() as Array<{ id: string; email: string }>;
    const adminId = users.find((u) => u.email === "admin@paperboy.test")!.id;
    const minted = await s.app.inject({ method: "POST", url: "/api/v1/manage/mcp-tokens", headers: authHeaders(admin), payload: { name: "sched-suite", userId: adminId } });
    expect(minted.statusCode).toBe(200);
    mcp = new McpClient({ DATABASE_URL: TEST_DB, MCP_TOKEN: minted.json().token as string, MCP_HTTP_PORT: "" });
    await mcp.initialize();
  }, 90_000);

  afterAll(async () => {
    mcp?.kill();
    await s.app.close();
  });

  /** Create a publishable ArticlePage draft via the MCP surface itself. */
  async function makeDraft(name: string): Promise<string> {
    const created = await mcp.call("create_content", { type: "ArticlePage", name, data: { heading: name } });
    expect(created.isError).toBe(false);
    return (created.json as { documentId: string }).documentId;
  }

  const detail = async (id: string) =>
    (await s.app.inject({ method: "GET", url: `/api/v1/manage/content/${id}?locale=en`, headers: authHeaders(admin) })).json() as {
      status: string;
      publishAt: string | null;
      expireAt: string | null;
    };

  const delivered = (id: string) =>
    s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${id}?locale=en`, headers: { authorization: `Bearer ${PUBLIC_KEY}` } });

  it("a future publishAt schedules the go-live instead of publishing now", async () => {
    const id = await makeDraft("Scheduled Via MCP");
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const res = await mcp.call("publish", { documentId: id, locale: "en", publishAt: future });
    expect(res.isError).toBe(false);

    // The draft holds the schedule — it is NOT live.
    const d = await detail(id);
    expect(d.status).toBe("draft");
    expect(d.publishAt).toBe(future);

    // No reader can see it (published delivery perspective)...
    expect((await delivered(id)).statusCode).toBe(404);

    // ...and the dashboard reports it under Scheduled publishing (the report's
    // "Nothing scheduled" gap).
    const dash = (await s.app.inject({ method: "GET", url: "/api/v1/manage/dashboard", headers: authHeaders(admin) })).json() as {
      scheduled: Array<{ documentId: string; action: string }>;
    };
    expect(dash.scheduled.some((e) => e.documentId === id && e.action === "publish")).toBe(true);
  }, 60_000);

  it("expireAt alone publishes now and carries the expiry", async () => {
    const id = await makeDraft("Expiring Via MCP");
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const res = await mcp.call("publish", { documentId: id, locale: "en", expireAt: future });
    expect(res.isError).toBe(false);

    const d = await detail(id);
    expect(d.status).toBe("published");
    expect(d.expireAt).toBe(future);
    expect((await delivered(id)).statusCode).toBe(200);
  }, 60_000);

  it("a bare local datetime (the reporter's exact format) is rejected with a self-teaching error", async () => {
    const id = await makeDraft("Ambiguous Time");
    // Depending on SDK version, invalid args come back in-band (isError) or as a
    // JSON-RPC error (the client rejects) — treat both as the error path.
    const res = await mcp
      .call("publish", { documentId: id, locale: "en", publishAt: "2026-08-04T09:00" })
      .catch((e: Error) => ({ text: e.message, json: null, isError: true }));
    expect(res.isError).toBe(true);
    expect(res.text).toContain("publishAt");
    expect(res.text).toMatch(/ISO 8601/);
    // And nothing was published or scheduled by the failed call.
    const d = await detail(id);
    expect(d.status).toBe("draft");
    expect(d.publishAt).toBeNull();
  }, 60_000);
});
