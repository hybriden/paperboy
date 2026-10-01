import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_DB, type Suite, authHeaders, login, setupApi } from "./helpers.js";
import { MCP_DIR } from "./mcp-stdio-client.js";

/**
 * The MCP server as an OAuth protected resource (the MCP authorization spec).
 *
 * Booted WITHOUT an MCP_TOKEN: in HTTP mode with OAuth configured there is no
 * process identity any more — every request acts as the user whose token it
 * presents, confined to the site that user chose at consent. A 401 tells the
 * client where the protected-resource metadata lives, which is how an MCP
 * client discovers the authorization server in the first place.
 */

const PUBLIC_URL = "https://cms.example.org";
const MCP_URL = `${PUBLIC_URL}/mcp`;
const REDIRECT = "https://client.example.net/callback";
const PORT = 19000 + Math.floor(Math.random() * 1000);
const LOCAL = `http://127.0.0.1:${PORT}`;

async function spawnOAuthMcp(): Promise<ChildProcess> {
  const requireFromMcp = createRequire(join(MCP_DIR, "package.json"));
  const tsxCli = requireFromMcp.resolve("tsx/cli");
  let stderr = "";
  const env = { ...process.env, DATABASE_URL: TEST_DB, MCP_HTTP_PORT: String(PORT), PUBLIC_URL };
  delete env.MCP_TOKEN;
  delete env.MCP_EMAIL;
  delete env.MCP_PASSWORD;
  const proc = spawn(process.execPath, [tsxCli, "src/server.ts"], { cwd: MCP_DIR, env, stdio: ["ignore", "ignore", "pipe"] });
  proc.stderr!.on("data", (c: Buffer) => {
    stderr += c.toString();
  });
  const deadline = Date.now() + 60_000;
  while (!stderr.includes("ready on http") && Date.now() < deadline) {
    if (proc.exitCode != null) throw new Error(`mcp exited early: ${stderr.slice(-1500)}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!stderr.includes("ready on http")) throw new Error(`mcp never came up: ${stderr.slice(-1500)}`);
  return proc;
}

class Client {
  sessionId: string | null = null;
  private id = 1;
  constructor(public bearer: string) {}
  post(body: unknown, opts: { bearer?: string; session?: string | null } = {}): Promise<Response> {
    const session = opts.session === undefined ? this.sessionId : opts.session;
    return fetch(`${LOCAL}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${opts.bearer ?? this.bearer}`,
        ...(session ? { "mcp-session-id": session } : {}),
      },
      body: JSON.stringify(body),
    });
  }
  async init(): Promise<void> {
    const res = await this.post({ jsonrpc: "2.0", id: this.id++, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "oauth-suite", version: "0" } } });
    expect(res.status).toBe(200);
    this.sessionId = res.headers.get("mcp-session-id");
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
  }
  async call(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean; json: unknown }> {
    const res = await this.post({ jsonrpc: "2.0", id: this.id++, method: "tools/call", params: { name, arguments: args } });
    const body = (await res.json()) as { result?: { content?: Array<{ text?: string }>; isError?: boolean }; error?: { message: string } };
    if (body.error) return { text: body.error.message, isError: true, json: null };
    const text = body.result?.content?.[0]?.text ?? "";
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { text, isError: Boolean(body.result?.isError), json };
  }
}

describe("MCP over HTTP with OAuth (no MCP_TOKEN, per-user identity)", () => {
  let s: Suite;
  let proc: ChildProcess;
  let admin: Awaited<ReturnType<typeof login>>;
  let editor: Awaited<ReturnType<typeof login>>;
  let clientId: string;
  let brandB: string;

  /** The whole OAuth dance through the real API routes → an access token. */
  async function connect(who: typeof admin, siteId: string | null): Promise<{ access_token: string; refresh_token: string }> {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const params = { response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "s", resource: MCP_URL };
    const ok = await s.app.inject({ method: "POST", url: "/api/v1/oauth/authorize", headers: authHeaders(who), payload: { ...params, approve: true, siteId } });
    const code = new URL(ok.json().redirectTo as string).searchParams.get("code")!;
    const tok = await s.app.inject({
      method: "POST",
      url: "/api/v1/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT, resource: MCP_URL }).toString(),
    });
    expect(tok.statusCode, tok.body).toBe(200);
    return tok.json();
  }

  beforeAll(async () => {
    s = await setupApi({ PUBLIC_URL });
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    editor = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
    const site = await s.app.inject({ method: "POST", url: "/api/v1/manage/sites", headers: authHeaders(admin), payload: { slug: "brand-b", name: "Brand B", defaultLocale: "en" } });
    brandB = site.json().id as string;
    const reg = await s.app.inject({ method: "POST", url: "/api/v1/oauth/register", payload: { client_name: "HTTP suite", redirect_uris: [REDIRECT] } });
    clientId = reg.json().client_id as string;
    proc = await spawnOAuthMcp();
  }, 90_000);
  afterAll(async () => {
    proc?.kill();
    await s.app.close();
  });

  it("a request without a token is 401 and points at the protected-resource metadata", async () => {
    const res = await fetch(`${LOCAL}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource/mcp"`);
  });

  it("serves its own protected-resource metadata (for setups where /mcp has its own host)", async () => {
    const res = await fetch(`${LOCAL}/.well-known/oauth-protected-resource/mcp`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ resource: MCP_URL, authorization_servers: [PUBLIC_URL] });
  });

  it("each token acts as ITS user: an Editor's connection can't manage users, an Admin's can", async () => {
    const ed = new Client((await connect(editor, null)).access_token);
    await ed.init();
    const denied = await ed.call("list_users");
    expect(denied.isError).toBe(true);
    expect(denied.text).toMatch(/permission/i);

    const ad = new Client((await connect(admin, null)).access_token);
    await ad.init();
    const allowed = await ad.call("list_users");
    expect(allowed.isError, allowed.text).toBe(false);
  }, 60_000);

  it("a connection is confined to the site chosen at consent", async () => {
    const c = new Client((await connect(admin, brandB)).access_token);
    await c.init();
    const sites = await c.call("list_sites");
    expect(sites.isError, sites.text).toBe(false);
    expect(sites.json).toMatchObject({ tokenScopedTo: brandB });
    const escape = await c.call("list_pages", { site: "default" });
    expect(escape.isError).toBe(true);
    // Instance-wide changes need a connection to every site.
    const create = await c.call("create_user", { email: "scoped-oauth@paperboy.test", name: "X", password: "Scoped!Passw0rd1", roles: ["Viewer"] });
    expect(create.isError).toBe(true);
    expect(create.text).toMatch(/every site/i);
  }, 60_000);

  it("a session belongs to the user who opened it", async () => {
    const ad = new Client((await connect(admin, null)).access_token);
    await ad.init();
    const edToken = (await connect(editor, null)).access_token;
    const hijack = await ad.post({ jsonrpc: "2.0", id: 99, method: "tools/call", params: { name: "list_users", arguments: {} } }, { bearer: edToken });
    expect(hijack.status).toBe(403);
  }, 60_000);

  it("a revoked connection is refused on the next request", async () => {
    const t = await connect(editor, null);
    const c = new Client(t.access_token);
    await c.init();
    const grants = (await s.app.inject({ method: "GET", url: "/api/v1/manage/oauth-grants", headers: authHeaders(editor) })).json() as Array<{ id: number; revokedAt: string | null }>;
    for (const g of grants.filter((x) => !x.revokedAt)) {
      await s.app.inject({ method: "POST", url: `/api/v1/manage/oauth-grants/${g.id}/revoke`, headers: authHeaders(editor) });
    }
    const res = await c.post({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "list_sites", arguments: {} } });
    expect(res.status).toBe(401);
  }, 60_000);
});
