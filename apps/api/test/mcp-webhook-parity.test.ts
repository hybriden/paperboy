import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_DB, type Suite, authHeaders, login, setupApi } from "./helpers.js";
import { McpClient } from "./mcp-stdio-client.js";

/**
 * publish/unpublish webhooks fired from the MANAGE ROUTE, so the MCP tools —
 * which call the same publishContent/unpublishContent — published without any
 * integration hearing about it: an agent publish never triggered a rebuild.
 * The dispatch belongs in the query layer, where every surface shares it.
 */
function startStub(): Promise<{ server: Server; url: string; events: string[] }> {
  const events: string[] = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        events.push(String(req.headers["x-paperboy-event"] ?? ""));
        res.writeHead(200).end("ok");
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}/hook`, events });
    });
  });
}

async function waitFor(events: string[], name: string, from: number): Promise<boolean> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (events.slice(from).includes(name)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

describe("MCP publish/unpublish fire the same webhooks as the manage routes", () => {
  let s: Suite;
  let mcp: McpClient;
  let stub: Awaited<ReturnType<typeof startStub>>;
  const savedPrivateFlag = process.env.PAPERBOY_WEBHOOK_ALLOW_PRIVATE;

  beforeAll(async () => {
    process.env.PAPERBOY_WEBHOOK_ALLOW_PRIVATE = "true"; // loopback stub target
    s = await setupApi();
    const admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    stub = await startStub();
    const hook = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/webhooks",
      headers: authHeaders(admin),
      payload: { name: "stub", url: stub.url, events: ["content.published", "content.unpublished"] },
    });
    expect(hook.statusCode, hook.body).toBe(200);

    const users = (await s.app.inject({ method: "GET", url: "/api/v1/manage/users", headers: { cookie: admin.cookie } })).json() as Array<{ id: string; email: string }>;
    const adminId = users.find((u) => u.email === "admin@paperboy.test")!.id;
    const minted = await s.app.inject({ method: "POST", url: "/api/v1/manage/mcp-tokens", headers: authHeaders(admin), payload: { name: "hook-suite", userId: adminId, password: "Admin!Passw0rd" } });
    expect(minted.statusCode, minted.body).toBe(200);
    // The MCP process must deliver to the loopback stub too.
    mcp = new McpClient({ DATABASE_URL: TEST_DB, MCP_TOKEN: minted.json().token as string, MCP_HTTP_PORT: "", PAPERBOY_WEBHOOK_ALLOW_PRIVATE: "true" });
    await mcp.initialize();
  }, 90_000);

  afterAll(async () => {
    mcp?.kill();
    stub?.server.close();
    await s.app.close();
    if (savedPrivateFlag === undefined) delete process.env.PAPERBOY_WEBHOOK_ALLOW_PRIVATE;
    else process.env.PAPERBOY_WEBHOOK_ALLOW_PRIVATE = savedPrivateFlag;
  });

  it("the MCP `publish` tool delivers content.published; `unpublish` delivers content.unpublished", async () => {
    const created = await mcp.call("create_content", { type: "ArticlePage", name: "Hooked by MCP", data: { heading: "Hooked by MCP" } });
    expect(created.isError, created.text).toBe(false);
    const { documentId } = created.json as { documentId: string };

    const before = stub.events.length;
    const published = await mcp.call("publish", { documentId, locale: "en" });
    expect(published.isError, published.text).toBe(false);
    expect(await waitFor(stub.events, "content.published", before), `events: ${stub.events.join(",")}`).toBe(true);

    const mid = stub.events.length;
    const unpublished = await mcp.call("unpublish", { documentId, locale: "en" });
    expect(unpublished.isError, unpublished.text).toBe(false);
    expect(await waitFor(stub.events, "content.unpublished", mid), `events: ${stub.events.join(",")}`).toBe(true);
  }, 60_000);
});
