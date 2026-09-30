import { createHash, randomBytes } from "node:crypto";
import { createDb, verifyOAuthAccessToken } from "@paperboy/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_DB, type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * OAuth 2.1 for the remote MCP server (the MCP authorization spec): Paperboy's
 * API is the authorization server, the MCP server the protected resource.
 *
 * The part that is Paperboy's own: consent picks WHICH SITE the connection
 * reaches — one site, or every site — and the choice is bounded by what the
 * signing-in user can see. The resulting grant carries the same `siteId` a
 * minted MCP token does (NULL = every site), so every per-site rule the MCP
 * already enforces applies to OAuth connections unchanged.
 */

const PUBLIC_URL = "https://cms.example.org";
const MCP_URL = `${PUBLIC_URL}/mcp`;
const REDIRECT = "https://client.example.net/callback";

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

describe("MCP OAuth (authorization server)", () => {
  let s: Suite;
  const raw = createDb(TEST_DB, { max: 1 });
  let admin: Awaited<ReturnType<typeof login>>;
  let editor: Awaited<ReturnType<typeof login>>;
  let author: Awaited<ReturnType<typeof login>>;
  let otherSiteId: string;
  let defaultSiteId: string;
  let clientId: string;

  beforeAll(async () => {
    s = await setupApi({ PUBLIC_URL });
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    editor = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
    author = await login(s.app, "author@paperboy.test", "Author!Passw0rd");
    const site = await s.app.inject({ method: "POST", url: "/api/v1/manage/sites", headers: authHeaders(admin), payload: { slug: "brand-b", name: "Brand B", defaultLocale: "en" } });
    expect(site.statusCode, site.body).toBe(200);
    otherSiteId = site.json().id as string;
    defaultSiteId = ((await raw.sql`SELECT id FROM site WHERE id = 'site_default'`) as Array<{ id: string }>)[0]!.id;
    const reg = await s.app.inject({ method: "POST", url: "/api/v1/oauth/register", payload: { client_name: "Test Agent", redirect_uris: [REDIRECT] } });
    expect(reg.statusCode, reg.body).toBe(201);
    clientId = reg.json().client_id as string;
  });
  afterAll(async () => {
    await raw.sql.end();
    await s.app.close();
  });

  const authParams = (challenge: string, extra: Record<string, string> = {}) => ({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "xyz",
    resource: MCP_URL,
    ...extra,
  });

  /** Consent as `who` for `siteId` (null = every site) → the authorization code. */
  async function consent(who: typeof editor, siteId: string | null, challenge: string): Promise<string> {
    const res = await s.app.inject({ method: "POST", url: "/api/v1/oauth/authorize", headers: authHeaders(who), payload: { ...authParams(challenge), approve: true, siteId } });
    expect(res.statusCode, res.body).toBe(200);
    const to = new URL(res.json().redirectTo as string);
    expect(to.origin + to.pathname).toBe(REDIRECT);
    expect(to.searchParams.get("state")).toBe("xyz");
    return to.searchParams.get("code")!;
  }
  const token = (form: Record<string, string>) =>
    s.app.inject({
      method: "POST",
      url: "/api/v1/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams(form).toString(),
    });
  const exchange = (code: string, verifier: string, extra: Record<string, string> = {}) =>
    token({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT, resource: MCP_URL, ...extra });

  it("publishes discovery documents built from PUBLIC_URL", async () => {
    const as = await s.app.inject({ method: "GET", url: "/.well-known/oauth-authorization-server" });
    expect(as.statusCode).toBe(200);
    expect(as.json()).toMatchObject({
      issuer: PUBLIC_URL,
      authorization_endpoint: `${PUBLIC_URL}/oauth/authorize`,
      token_endpoint: `${PUBLIC_URL}/api/v1/oauth/token`,
      registration_endpoint: `${PUBLIC_URL}/api/v1/oauth/register`,
      code_challenge_methods_supported: ["S256"],
    });
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const prm = await s.app.inject({ method: "GET", url: path });
      expect(prm.statusCode, path).toBe(200);
      expect(prm.json()).toMatchObject({ resource: MCP_URL, authorization_servers: [PUBLIC_URL] });
    }
  });

  it("registration refuses dangerous redirect URIs", async () => {
    for (const uri of ["javascript:alert(1)", "http://evil.example/cb", "https://ok.example/cb#frag"]) {
      const res = await s.app.inject({ method: "POST", url: "/api/v1/oauth/register", payload: { client_name: "Bad", redirect_uris: [uri] } });
      expect(res.statusCode, uri).toBe(400);
      expect(res.json().error).toBe("invalid_redirect_uri");
    }
    const loopback = await s.app.inject({ method: "POST", url: "/api/v1/oauth/register", payload: { client_name: "Local", redirect_uris: ["http://127.0.0.1:33418/callback"] } });
    expect(loopback.statusCode).toBe(201);
  });

  it("the consent request is refused (not redirected) for an unregistered redirect URI", async () => {
    const { challenge } = pkce();
    const q = new URLSearchParams(authParams(challenge, { redirect_uri: "https://attacker.example/cb" })).toString();
    const res = await s.app.inject({ method: "GET", url: `/api/v1/oauth/authorize/request?${q}`, headers: authHeaders(editor) });
    expect(res.statusCode).toBe(400);
  });

  it("consent lists only the sites the user can see — Editor: every site, and may pick 'every site'", async () => {
    const { challenge } = pkce();
    const q = new URLSearchParams(authParams(challenge)).toString();
    const res = await s.app.inject({ method: "GET", url: `/api/v1/oauth/authorize/request?${q}`, headers: authHeaders(editor) });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().client.name).toBe("Test Agent");
    expect((res.json().sites as Array<{ id: string }>).map((x) => x.id).sort()).toEqual([defaultSiteId, otherSiteId].sort());
    expect(res.json().allSitesAllowed).toBe(true);
  });

  it("an Author sees only the sites they have a section in, and cannot pick 'every site' or another site", async () => {
    const { challenge } = pkce();
    const q = new URLSearchParams(authParams(challenge)).toString();
    const res = await s.app.inject({ method: "GET", url: `/api/v1/oauth/authorize/request?${q}`, headers: authHeaders(author) });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json().sites as Array<{ id: string }>).map((x) => x.id)).toEqual([defaultSiteId]);
    expect(res.json().allSitesAllowed).toBe(false);
    for (const siteId of [null, otherSiteId]) {
      const post = await s.app.inject({ method: "POST", url: "/api/v1/oauth/authorize", headers: authHeaders(author), payload: { ...authParams(challenge), approve: true, siteId } });
      expect(post.statusCode, String(siteId)).toBe(403);
    }
  });

  it("code + PKCE → a token confined to the chosen site, acting as the consenting user", async () => {
    const { verifier, challenge } = pkce();
    const code = await consent(editor, otherSiteId, challenge);
    const res = await exchange(code, verifier);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ token_type: "Bearer", expires_in: 3600 });
    const who = await verifyOAuthAccessToken(s.app.db, res.json().access_token as string, MCP_URL);
    const editorId = ((await raw.sql`SELECT id FROM users WHERE email = 'editor@paperboy.test'`) as Array<{ id: string }>)[0]!.id;
    expect(who).toMatchObject({ userId: editorId, siteId: otherSiteId });
  });

  it("'every site' is stored as a cross-site grant (siteId null)", async () => {
    const { verifier, challenge } = pkce();
    const code = await consent(editor, null, challenge);
    const res = await exchange(code, verifier);
    const who = await verifyOAuthAccessToken(s.app.db, res.json().access_token as string, MCP_URL);
    expect(who?.siteId).toBeNull();
  });

  it("a wrong verifier, a reused code, a different redirect or resource are all refused", async () => {
    const a = pkce();
    const codeA = await consent(editor, defaultSiteId, a.challenge);
    expect((await exchange(codeA, pkce().verifier)).json().error).toBe("invalid_grant");

    const b = pkce();
    const codeB = await consent(editor, defaultSiteId, b.challenge);
    expect((await exchange(codeB, b.verifier, { redirect_uri: "https://client.example.net/other" })).json().error).toBe("invalid_grant");

    const c = pkce();
    const codeC = await consent(editor, defaultSiteId, c.challenge);
    expect((await exchange(codeC, c.verifier, { resource: "https://other.example/mcp" })).json().error).toBe("invalid_target");

    const d = pkce();
    const codeD = await consent(editor, defaultSiteId, d.challenge);
    const first = await exchange(codeD, d.verifier);
    expect(first.statusCode).toBe(200);
    const again = await exchange(codeD, d.verifier);
    expect(again.json().error).toBe("invalid_grant");
    // A replayed code revokes what it issued (RFC 6749 §4.1.2).
    expect(await verifyOAuthAccessToken(s.app.db, first.json().access_token as string, MCP_URL)).toBeNull();
  });

  it("refresh rotates both tokens; the old refresh token stops working", async () => {
    const { verifier, challenge } = pkce();
    const first = (await exchange(await consent(editor, defaultSiteId, challenge), verifier)).json();
    const refreshed = await token({ grant_type: "refresh_token", refresh_token: first.refresh_token as string, client_id: clientId });
    expect(refreshed.statusCode, refreshed.body).toBe(200);
    expect(refreshed.json().refresh_token).not.toBe(first.refresh_token);
    expect(await verifyOAuthAccessToken(s.app.db, refreshed.json().access_token as string, MCP_URL)).not.toBeNull();
    expect(await verifyOAuthAccessToken(s.app.db, first.access_token as string, MCP_URL)).toBeNull();
    const reused = await token({ grant_type: "refresh_token", refresh_token: first.refresh_token as string, client_id: clientId });
    expect(reused.json().error).toBe("invalid_grant");
  });

  it("an expired access token is refused, and a token is only valid for its own resource", async () => {
    const { verifier, challenge } = pkce();
    const t = (await exchange(await consent(editor, defaultSiteId, challenge), verifier)).json();
    expect(await verifyOAuthAccessToken(s.app.db, t.access_token as string, "https://other.example/mcp")).toBeNull();
    await raw.sql`UPDATE oauth_grant SET access_expires_at = now() - interval '1 minute'`;
    expect(await verifyOAuthAccessToken(s.app.db, t.access_token as string, MCP_URL)).toBeNull();
  });

  it("denying consent redirects back with access_denied and the state", async () => {
    const { challenge } = pkce();
    const res = await s.app.inject({ method: "POST", url: "/api/v1/oauth/authorize", headers: authHeaders(editor), payload: { ...authParams(challenge), approve: false, siteId: null } });
    const to = new URL(res.json().redirectTo as string);
    expect(to.searchParams.get("error")).toBe("access_denied");
    expect(to.searchParams.get("state")).toBe("xyz");
    expect(to.searchParams.get("code")).toBeNull();
  });

  it("connected apps are listed per user and revocation is immediate", async () => {
    const { verifier, challenge } = pkce();
    const t = (await exchange(await consent(editor, defaultSiteId, challenge), verifier)).json();
    const mine = await s.app.inject({ method: "GET", url: "/api/v1/manage/oauth-grants", headers: authHeaders(editor) });
    expect(mine.statusCode, mine.body).toBe(200);
    const grants = mine.json() as Array<{ id: number; clientName: string; email: string; siteId: string | null; revokedAt: string | null }>;
    expect(grants.every((g) => g.email === "editor@paperboy.test")).toBe(true);
    const active = grants.find((g) => !g.revokedAt && g.clientName === "Test Agent")!;
    // Another non-admin can't see or revoke it.
    expect(((await s.app.inject({ method: "GET", url: "/api/v1/manage/oauth-grants", headers: authHeaders(author) })).json() as unknown[]).length).toBe(0);
    expect((await s.app.inject({ method: "POST", url: `/api/v1/manage/oauth-grants/${active.id}/revoke`, headers: authHeaders(author) })).statusCode).toBe(404);
    // The owner can.
    const revoke = await s.app.inject({ method: "POST", url: `/api/v1/manage/oauth-grants/${active.id}/revoke`, headers: authHeaders(editor) });
    expect(revoke.statusCode).toBe(200);
    expect(await verifyOAuthAccessToken(s.app.db, t.access_token as string, MCP_URL)).toBeNull();
    // An admin sees every user's connections.
    const all = (await s.app.inject({ method: "GET", url: "/api/v1/manage/oauth-grants", headers: authHeaders(admin) })).json() as Array<{ email: string }>;
    expect(all.some((g) => g.email === "editor@paperboy.test")).toBe(true);
  });
});
