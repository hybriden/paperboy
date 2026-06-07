import { type ChildProcess, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PUBLIC_KEY, TEST_DB, type Suite, authHeaders, login, setupApi } from "./helpers.js";
import { MCP_DIR } from "./mcp-stdio-client.js";

/**
 * Streamable-HTTP transport suite. This is the transport harmonix ACTUALLY
 * uses in production (http://paperboy-mcp:8093/mcp, Bearer auth) — and the
 * layer where the real incidents lived (token rotation, 401s, session
 * handling), yet until now only stdio was under test.
 *
 * Boots the real apps/mcp server in HTTP mode against the test DB and drives
 * it with fetch exactly like harmonix's McpClient does: initialize → session
 * id header → tools/call, JSON responses.
 */

const PORT = 18000 + Math.floor(Math.random() * 1000);
const URL_ = `http://127.0.0.1:${PORT}/mcp`;

class HttpMcp {
  sessionId: string | null = null;
  private nextId = 1;
  constructor(private bearer: string) {}

  /** Raw POST — returns the fetch Response (for status assertions). */
  async post(body: unknown, opts: { bearer?: string | null; session?: string | null } = {}): Promise<Response> {
    const bearer = opts.bearer === undefined ? this.bearer : opts.bearer;
    const session = opts.session === undefined ? this.sessionId : opts.session;
    return fetch(URL_, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...(session ? { "mcp-session-id": session } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  async initialize(): Promise<Response> {
    const res = await this.post({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "http-suite", version: "0" } },
    });
    this.sessionId = res.headers.get("mcp-session-id");
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
    return res;
  }

  /** tools/call returning the same {text, json, isError} shape as the stdio client. */
  async call(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; json: unknown; isError: boolean }> {
    const res = await this.post({ jsonrpc: "2.0", id: this.nextId++, method: "tools/call", params: { name, arguments: args } });
    const body = (await res.json()) as { result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean }; error?: { message: string } };
    if (body.error) return { text: body.error.message, json: null, isError: true };
    const text = body.result?.content?.find((c) => c.type === "text")?.text ?? "";
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* error strings are not JSON */
    }
    return { text, json, isError: Boolean(body.result?.isError) };
  }
}

// Long markdown body — over HTTP this exercises the exact byte path harmonix's
// drafters use for their ~2 500-word posts.
const LONG_BODY = `# HTTP transport roundtrip\n\n${"Avsnitt med æøå, «sitater» og kode: `pnpm -r typecheck`.\n\n".repeat(60)}`;

describe("MCP over Streamable HTTP (harmonix's real transport)", () => {
  let s: Suite;
  let proc: ChildProcess;
  let stderr = "";
  let envToken: string; // the MCP_TOKEN the server was booted with
  let adminId: string;
  let admin: Awaited<ReturnType<typeof login>>;

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    const users = (await s.app.inject({ method: "GET", url: "/api/v1/manage/users", headers: { cookie: admin.cookie } })).json() as Array<{ id: string; email: string }>;
    adminId = users.find((u) => u.email === "admin@paperboy.test")!.id;
    const minted = await s.app.inject({ method: "POST", url: "/api/v1/manage/mcp-tokens", headers: authHeaders(admin), payload: { name: "http-boot", userId: adminId } });
    envToken = minted.json().token as string;

    const requireFromMcp = createRequire(join(MCP_DIR, "package.json"));
    const tsxCli = requireFromMcp.resolve("tsx/cli");
    proc = spawn(process.execPath, [tsxCli, "src/server.ts"], {
      cwd: MCP_DIR,
      env: { ...process.env, DATABASE_URL: TEST_DB, MCP_TOKEN: envToken, MCP_HTTP_PORT: String(PORT) },
      stdio: ["ignore", "ignore", "pipe"],
    });
    proc.stderr!.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    // Wait for the listen line.
    const deadline = Date.now() + 60_000;
    while (!stderr.includes("ready on http") && Date.now() < deadline) {
      if (proc.exitCode != null) throw new Error(`mcp exited early: ${stderr.slice(-1500)}`);
      await new Promise((r) => setTimeout(r, 150));
    }
    if (!stderr.includes("ready on http")) throw new Error(`mcp never came up: ${stderr.slice(-1500)}`);
  }, 90_000);

  afterAll(async () => {
    proc?.kill();
    await s.app.close();
  });

  it("GET /health responds 200 (the production monitor probe)", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`);
    expect(res.status).toBe(200);
  });

  it("requests without a bearer are 401 with WWW-Authenticate", async () => {
    const c = new HttpMcp("");
    const res = await c.post({ jsonrpc: "2.0", id: 1, method: "ping" }, { bearer: null });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("a wrong bearer is 401 (no fallthrough)", async () => {
    const c = new HttpMcp("mcp_definitely-not-a-real-token");
    const res = await c.post({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect(res.status).toBe(401);
  });

  it("initialize hands out a session id; the full drafter write path works over HTTP", async () => {
    const c = new HttpMcp(envToken);
    const init = await c.initialize();
    expect(init.status).toBe(200);
    expect(c.sessionId).toBeTruthy();

    // The drafter sequence over the wire harmonix actually uses.
    const list = await c.call("delivery_list", { parentId: s.ids.blogId, type: "BlogPost" });
    expect(list.isError).toBe(false);

    const created = await c.call("create_content", {
      type: "BlogPost",
      locale: "en",
      name: "HTTP transport roundtrip",
      parentId: s.ids.blogId,
    });
    expect(created.isError, created.text.slice(0, 200)).toBe(false);
    const docId = (created.json as { documentId: string }).documentId;

    const body = await c.call("set_field", { documentId: docId, locale: "en", field: "body", value: LONG_BODY });
    expect(body.isError, body.text.slice(0, 200)).toBe(false);
    const title = await c.call("set_field", { documentId: docId, locale: "en", field: "title", value: "HTTP transport roundtrip" });
    expect(title.isError).toBe(false);

    const pub = await c.call("publish", { documentId: docId, locale: "en" });
    expect(pub.isError, pub.text.slice(0, 300)).toBe(false);

    // Verify through delivery: byte-identical body.
    const res = await s.app.inject({
      method: "GET",
      url: "/api/v1/delivery/content/by-slug?slug=http-transport-roundtrip&locale=en",
      headers: { "x-api-key": PUBLIC_KEY },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { data: { body: string } }).data.body).toBe(LONG_BODY);
  });

  it("a non-initialize request without a session id gets a JSON-RPC error, not a hang", async () => {
    const c = new HttpMcp(envToken);
    const res = await c.post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { session: null });
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error).toBeTruthy();
  });

  it("a separately minted admin token for the SAME boot user is accepted (token rotation works)", async () => {
    const minted = await s.app.inject({ method: "POST", url: "/api/v1/manage/mcp-tokens", headers: authHeaders(admin), payload: { name: "http-rotated", userId: adminId } });
    const rotated = minted.json().token as string;
    const c = new HttpMcp(rotated);
    const init = await c.initialize();
    expect(init.status).toBe(200);
    expect((await c.call("list_locales")).isError).toBe(false);
  });

  it("a minted token for a DIFFERENT user is refused — one process, one identity", async () => {
    const users = (await s.app.inject({ method: "GET", url: "/api/v1/manage/users", headers: { cookie: admin.cookie } })).json() as Array<{ id: string; email: string }>;
    const editorId = users.find((u) => u.email === "editor@paperboy.test")!.id;
    const minted = await s.app.inject({ method: "POST", url: "/api/v1/manage/mcp-tokens", headers: authHeaders(admin), payload: { name: "http-foreign", userId: editorId } });
    const foreign = minted.json().token as string;
    const c = new HttpMcp(foreign);
    const res = await c.post({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect(res.status).toBe(401);
  });

  it("a revoked minted token is refused on the next request", async () => {
    const minted = await s.app.inject({ method: "POST", url: "/api/v1/manage/mcp-tokens", headers: authHeaders(admin), payload: { name: "http-revoke-me", userId: adminId } });
    const token = minted.json().token as string;
    const c = new HttpMcp(token);
    expect((await c.initialize()).status).toBe(200);

    const rows = (await s.app.inject({ method: "GET", url: "/api/v1/manage/mcp-tokens", headers: { cookie: admin.cookie } })).json() as Array<{ id: number; name: string }>;
    const id = rows.find((r) => r.name === "http-revoke-me")!.id;
    await s.app.inject({ method: "POST", url: `/api/v1/manage/mcp-tokens/${id}/revoke`, headers: authHeaders(admin) });

    const res = await c.post({ jsonrpc: "2.0", id: 99, method: "tools/list" });
    expect(res.status).toBe(401);
  });
});
