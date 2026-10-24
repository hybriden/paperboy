import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_DB, type Suite, authHeaders, login, setupApi } from "./helpers.js";
import { McpClient } from "./mcp-stdio-client.js";

/**
 * The A/B experiments toolset (#125) through the real stdio MCP server: an
 * agent sets up a test, is told it waits for a human under agent review, a
 * human starts it, and the agent reads the results and ends it.
 */
describe("MCP experiments toolset", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  let mcp: McpClient;
  let pageId: string;
  const card = (title: string) => ({ key: `k${title.replace(/\W/g, "")}`, blockType: "CardBlock", display: "automatic", inline: { title }, ref: null });
  const manage = (method: "GET" | "POST" | "PUT", url: string, payload?: object) => s.app.inject({ method, url: `/api/v1/manage${url}`, headers: authHeaders(admin), ...(payload ? { payload } : {}) });

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    const users = (await manage("GET", "/users")).json() as Array<{ id: string; email: string }>;
    const minted = await manage("POST", "/mcp-tokens", { name: "ab-suite", userId: users.find((u) => u.email === "admin@paperboy.test")!.id });
    mcp = new McpClient({ DATABASE_URL: TEST_DB, MCP_TOKEN: minted.json().token as string, MCP_HTTP_PORT: "" });
    await mcp.initialize();
    pageId = (await manage("POST", "/content", { type: "ArticlePage", locale: "en", name: "MCP AB page" })).json().documentId;
    await manage("PUT", `/content/${pageId}?locale=en`, { data: { heading: "MCP AB", mainArea: [card("Control")] } });
    await manage("POST", `/content/${pageId}/publish?locale=en`);
  }, 90_000);
  afterAll(async () => {
    mcp?.kill();
    await s.app.close();
  });

  it("create → waits for review → a human starts it → results → end", async () => {
    await manage("POST", "/site/agent-review", { required: true });
    const bad = await mcp.call("create_experiment", { documentId: pageId, locale: "en", area: "mainArea", name: "Bad", arms: [{ blocks: [{ key: "x", blockType: "NoSuchBlock", display: "automatic", inline: {}, ref: null }] }] });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/Version B:/);

    const created = await mcp.call("create_experiment", { documentId: pageId, locale: "en", area: "mainArea", name: "Card title", baselineRate: 0.1, mde: 0.3, arms: [{ label: "Shorter", blocks: [card("Challenger")] }] });
    expect(created.isError, created.text).toBe(false);
    const exp = created.json as { id: number; needsReview: boolean; status: string };
    expect(exp).toMatchObject({ needsReview: true, status: "draft" });

    const refused = await mcp.call("start_experiment", { id: exp.id });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/waiting for approval.*human/);
    expect((await manage("POST", `/experiments/${exp.id}/start`)).statusCode).toBe(200);

    const editRunning = await mcp.call("update_experiment", { id: exp.id, name: "Renamed" });
    expect(editRunning.text).toMatch(/pause_experiment|Pause it first/);
    expect((await mcp.call("pause_experiment", { id: exp.id })).isError).toBe(false);

    const got = await mcp.call("get_experiment", { id: exp.id });
    expect((got.json as { verdict: { summary: string } }).verdict.summary).toBe("No visitors counted yet.");
    const listed = await mcp.call("list_experiments", { status: "paused" });
    expect((listed.json as Array<{ id: number }>).map((e) => e.id)).toContain(exp.id);

    const ended = await mcp.call("end_experiment", { id: exp.id, winner: "b", apply: "draft" });
    expect(ended.isError, ended.text).toBe(false);
    expect(ended.json).toMatchObject({ applied: "draft", experiment: { status: "ended", winner: "b" } });

    const entries = (await manage("GET", "/audit?limit=50")).json() as Array<{ action: string; ip: string | null }>;
    expect(entries.filter((e) => e.action.startsWith("experiment.") && e.ip === "mcp").map((e) => e.action)).toEqual(expect.arrayContaining(["experiment.create", "experiment.pause", "experiment.end"]));
    await manage("POST", "/site/agent-review", { required: false });
  });
});
