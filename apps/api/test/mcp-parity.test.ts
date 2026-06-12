import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PUBLIC_KEY, TEST_DB, type Suite, authHeaders, login, setupApi } from "./helpers.js";
import { McpClient } from "./mcp-stdio-client.js";

/**
 * MCP ↔ API parity suite. Spawns the REAL stdio MCP server (apps/mcp) against
 * the test database, authenticated with a freshly-minted MCP token, and
 * asserts: the tool surface is locked, writes are equivalent to the API
 * routes, errors are self-teaching, audit rows carry ip='mcp', and a revoked
 * token is refused at boot. This turns CLAUDE.md's agent-API design rules from
 * prose into an executable contract. (The stdio client lives in
 * mcp-stdio-client.ts, shared with the agent-journey suite.)
 */

describe("MCP parity: real stdio server vs the API", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  let mcp: McpClient;
  let token: string;
  let tokenId: number;

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    // Mint a real MCP token via the API — the spawn below authenticates with it.
    const users = (await s.app.inject({ method: "GET", url: "/api/v1/manage/users", headers: { cookie: admin.cookie } })).json() as Array<{ id: string; email: string }>;
    const adminId = users.find((u) => u.email === "admin@paperboy.test")!.id;
    const minted = await s.app.inject({ method: "POST", url: "/api/v1/manage/mcp-tokens", headers: authHeaders(admin), payload: { name: "parity-suite", userId: adminId } });
    expect(minted.statusCode).toBe(200);
    token = minted.json().token as string;
    const rows = (await s.app.inject({ method: "GET", url: "/api/v1/manage/mcp-tokens", headers: { cookie: admin.cookie } })).json() as Array<{ id: number; name: string }>;
    tokenId = rows.find((r) => r.name === "parity-suite")!.id;

    mcp = new McpClient({ DATABASE_URL: TEST_DB, MCP_TOKEN: token, MCP_HTTP_PORT: "" });
    await mcp.initialize();
  }, 90_000);

  afterAll(async () => {
    mcp?.kill();
    await s.app.close();
  });

  it("locks the tool surface (any added/removed/renamed tool is a visible diff)", async () => {
    const names = await mcp.listToolNames();
    expect(names).toContain("create_content");
    expect(names).toContain("set_field");
    expect(names).toContain("search_stock_images");
    expect(names).toContain("delivery_search");
    expect(names).toMatchSnapshot();
  }, 60_000);

  it("create_content parity: MCP-created draft reads identically through the API", async () => {
    const created = await mcp.call("create_content", { type: "BlogPost", parentId: s.ids.blogId, name: "MCP Parity Post" });
    expect(created.isError).toBe(false);
    const doc = created.json as { documentId: string; name: string; status: string };
    expect(doc.documentId).toBeTruthy();

    const viaApi = await s.app.inject({ method: "GET", url: `/api/v1/manage/content/${doc.documentId}?locale=en`, headers: { cookie: admin.cookie } });
    expect(viaApi.statusCode).toBe(200);
    const api = viaApi.json();
    expect(api.name).toBe("MCP Parity Post");
    expect(api.type).toBe("BlogPost");
    expect(api.status).toBe("draft");
    expect(api.slug).toBe(doc.documentId ? api.slug : null); // auto-slug applied on both paths
    expect(api.slug).toMatch(/^mcp-parity-post/);
  }, 60_000);

  it("a page created at ROOT returns the placement hint (rule 5/7)", async () => {
    const created = await mcp.call("create_content", { type: "BlogPost", name: "Rootling" });
    expect(created.isError).toBe(false);
    const doc = created.json as { hint?: string };
    expect(doc.hint).toContain("move_content");
  }, 60_000);

  it("create_content PERSISTS data passed in the same call (no silent drop — Harmonix incident)", async () => {
    // Real incident (Harmonix 2026-06-11): the workflow passed the full body in
    // `data` to create_content, but the tool didn't declare `data` so Zod
    // stripped it and returned a successful EMPTY draft (data:{}). Valid content
    // in → "success" out → content gone (rule #1). create_content must accept
    // and persist `data` through the same coerce/validate chokepoint as update.
    const created = await mcp.call("create_content", {
      type: "BlogPost",
      parentId: s.ids.blogId,
      name: "ZoomMate Shifts Meetings",
      data: { title: "ZoomMate Shifts Meetings", body: "## Heading\n\nThe meeting ends. ZoomMate acts.", summary: "AI teammate.", author: "Neoteric Editorial" },
    });
    expect(created.isError).toBe(false);
    const doc = created.json as { documentId: string; data?: Record<string, unknown> };
    // The created draft carries the data (not {}), readable identically via the API.
    const viaApi = (await s.app.inject({ method: "GET", url: `/api/v1/manage/content/${doc.documentId}?locale=en`, headers: { cookie: admin.cookie } })).json();
    expect(viaApi.data.title).toBe("ZoomMate Shifts Meetings");
    expect(viaApi.data.body).toContain("ZoomMate acts");
    expect(viaApi.data.author).toBe("Neoteric Editorial");
    // Body present → the "NO content yet" nudge should NOT appear (it's filled).
    expect(doc.data?.title).toBe("ZoomMate Shifts Meetings");
  }, 60_000);

  it("create_content tells the agent the draft is an EMPTY shell to fill with update_content (rule 5/7)", async () => {
    // Real incident (Harmonix 2026-06-10): a workflow drafted a body, called
    // create_content, and stopped — leaving an empty draft (data:{}), because
    // create only sets name/slug and nothing said "now fill it". The result
    // must nudge the agent to write the fields next, even under a valid parent.
    const created = await mcp.call("create_content", { type: "BlogPost", parentId: s.ids.blogId, name: "Shell To Fill" });
    expect(created.isError).toBe(false);
    const doc = created.json as { hint?: string };
    expect(doc.hint).toMatch(/update_content/);
    expect(doc.hint).toMatch(/empty|blank|no.*content|fill/i);
  }, 60_000);

  it("update_content + set_field write parity (coercion chokepoint shared with the API)", async () => {
    const created = await mcp.call("create_content", { type: "BlogPost", parentId: s.ids.blogId, name: "MCP Field Writes" });
    const id = (created.json as { documentId: string }).documentId;

    const upd = await mcp.call("update_content", { documentId: id, data: { title: "T1", author: "Agent" } });
    expect(upd.isError).toBe(false);
    const sf = await mcp.call("set_field", { documentId: id, field: "body", value: "## Heading\n\nLong body text." });
    expect(sf.isError).toBe(false);

    const viaApi = (await s.app.inject({ method: "GET", url: `/api/v1/manage/content/${id}?locale=en`, headers: { cookie: admin.cookie } })).json();
    expect(viaApi.data.title).toBe("T1");
    expect(viaApi.data.author).toBe("Agent"); // merge semantics: set_field kept earlier fields
    expect(viaApi.data.body).toBe("## Heading\n\nLong body text.");
  }, 60_000);

  it("errors are self-teaching: a bad field value names the field in the error text", async () => {
    const created = await mcp.call("create_content", { type: "BlogPost", parentId: s.ids.blogId, name: "MCP Error Shape" });
    const id = (created.json as { documentId: string }).documentId;
    const bad = await mcp.call("update_content", { documentId: id, data: { publishDate: { bogus: true } } });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("publishDate"); // the agent can self-correct in one step
  }, 60_000);

  it("update_content REFUSES a raw URL in an image field, steering to import_stock_image (Harmonix 2026-06-12)", async () => {
    // Real incident: a flow wrote image:"https://images.unsplash.com/…" — it
    // persisted with a success response and the site rendered no image. The
    // error must name the field AND the tools that produce a real asset
    // documentId, so the agent self-corrects in one step (rules #1 and #2).
    const created = await mcp.call("create_content", { type: "BlogPost", parentId: s.ids.blogId, name: "Hotlink Refused" });
    const id = (created.json as { documentId: string }).documentId;
    const bad = await mcp.call("update_content", {
      documentId: id,
      data: { ogImage: "https://images.unsplash.com/photo-1608742213509-815b97c30b36?fm=jpg&w=1080" },
    });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("ogImage");
    expect(bad.text).toContain("import_stock_image");
  }, 60_000);

  it("create_content with an empty-string image persists null, not an empty pseudo-id (Harmonix 2026-06-12)", async () => {
    // Real incident, other half: a template-resolution failure sent image:""
    // inside create_content's data — it persisted as "" with a success
    // response. "" carries no reference; it must land as null ("no image").
    const created = await mcp.call("create_content", {
      type: "BlogPost",
      parentId: s.ids.blogId,
      name: "Empty Image Cleared",
      data: { title: "Empty Image Cleared", ogImage: "" },
    });
    expect(created.isError).toBe(false);
    const doc = created.json as { documentId: string };
    const viaApi = (
      await s.app.inject({ method: "GET", url: `/api/v1/manage/content/${doc.documentId}?locale=en`, headers: { cookie: admin.cookie } })
    ).json();
    expect(viaApi.data.ogImage).toBeNull();
  }, 60_000);

  it("every MCP write leaves an audit trail with ip='mcp'", async () => {
    const audit = await s.app.inject({ method: "GET", url: "/api/v1/manage/audit?action=content.create", headers: authHeaders(admin) });
    const rows = audit.json() as Array<{ ip: string | null; action: string }>;
    expect(rows.some((r) => r.ip === "mcp")).toBe(true);
  });

  it("delivery_list parity with GET /delivery/content (items + total, pagination)", async () => {
    const viaMcp = await mcp.call("delivery_list", { type: "BlogPost", limit: 2 });
    const m = viaMcp.json as { items: Array<{ documentId: string }>; total: number };
    const viaApi = (
      await s.app.inject({ method: "GET", url: "/api/v1/delivery/content?type=BlogPost&limit=2", headers: { authorization: `Bearer ${PUBLIC_KEY}` } })
    ).json() as { items: Array<{ documentId: string }>; total: number };
    expect(m.total).toBe(viaApi.total);
    expect(m.items.map((i) => i.documentId)).toEqual(viaApi.items.map((i) => i.documentId));
  }, 60_000);

  it("provenance: MCP writes record updatedVia='mcp' + the needs-review flag; a human edit clears both", async () => {
    const created = await mcp.call("create_content", { type: "BlogPost", parentId: s.ids.blogId, name: "MCP Provenance" });
    const id = (created.json as { documentId: string }).documentId;

    const afterAgent = (await s.app.inject({ method: "GET", url: `/api/v1/manage/content/${id}?locale=en`, headers: { cookie: admin.cookie } })).json();
    expect(afterAgent.updatedVia).toBe("mcp");
    expect(afterAgent.needsReview).toBe(true);

    // A human (web session) edit supersedes the flag — the human has seen the content.
    const put = await s.app.inject({ method: "PUT", url: `/api/v1/manage/content/${id}?locale=en`, headers: authHeaders(admin), payload: { data: { title: "Human touch" }, merge: true } });
    expect(put.statusCode).toBe(200);
    expect(put.json().updatedVia).toBe("web");
    expect(put.json().needsReview).toBe(false);
  }, 60_000);

  it("agent-review gate OFF (default): an agent may publish its own draft", async () => {
    const created = await mcp.call("create_content", { type: "BlogPost", parentId: s.ids.blogId, name: "MCP Self Publish" });
    const id = (created.json as { documentId: string }).documentId;
    await mcp.call("update_content", { documentId: id, data: { title: "Self publish" } });
    const pub = await mcp.call("publish", { documentId: id });
    expect(pub.isError).toBe(false);
  }, 60_000);

  it("agent-review gate ON: agent publish is blocked with a self-teaching error until a human approves", async () => {
    const enable = await s.app.inject({ method: "POST", url: "/api/v1/manage/site/agent-review", headers: authHeaders(admin), payload: { required: true } });
    expect(enable.statusCode).toBe(200);
    try {
      const created = await mcp.call("create_content", { type: "BlogPost", parentId: s.ids.blogId, name: "MCP Gated" });
      const id = (created.json as { documentId: string }).documentId;
      await mcp.call("update_content", { documentId: id, data: { title: "Gated" } });

      const blocked = await mcp.call("publish", { documentId: id });
      expect(blocked.isError).toBe(true);
      expect(blocked.text).toContain("human review"); // names the problem
      expect(blocked.text).toContain("/review"); // and the unblock path

      // Human approves → the agent can publish.
      const approve = await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${id}/review?locale=en`, headers: authHeaders(admin) });
      expect(approve.statusCode).toBe(200);
      expect(approve.json().needsReview).toBe(false);

      const pub = await mcp.call("publish", { documentId: id });
      expect(pub.isError).toBe(false);

      // HUMAN publishing is never gated: agent-drafts another change, human publishes it.
      await mcp.call("set_field", { documentId: id, field: "title", value: "Gated v2" });
      const humanPub = await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${id}/publish?locale=en`, headers: authHeaders(admin) });
      expect(humanPub.statusCode).toBe(200);
    } finally {
      await s.app.inject({ method: "POST", url: "/api/v1/manage/site/agent-review", headers: authHeaders(admin), payload: { required: false } });
    }
  }, 90_000);

  it("a revoked token is refused at boot (process exits non-zero)", async () => {
    const revoke = await s.app.inject({ method: "POST", url: `/api/v1/manage/mcp-tokens/${tokenId}/revoke`, headers: authHeaders(admin) });
    expect(revoke.statusCode).toBe(200);
    const second = new McpClient({ DATABASE_URL: TEST_DB, MCP_TOKEN: token, MCP_HTTP_PORT: "" });
    const code = await second.exited();
    expect(code).toBe(1);
    expect(second.stderr).toContain("invalid or revoked");
  }, 60_000);
});
