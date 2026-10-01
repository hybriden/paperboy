import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import type { Database } from "./client.js";
import { Errors } from "./errors.js";
import { getAccessContext } from "./auth-store.js";
import type { AccessContext } from "./scope.js";
import { oauthClient, oauthCode, oauthGrant, site, userScope, users } from "./schema.js";

/**
 * OAuth 2.1 for the remote MCP server, as the MCP authorization spec lays it
 * out: authorization code + PKCE (S256 only), dynamic client registration
 * (RFC 7591), resource indicators (RFC 8707) and rotating refresh tokens.
 *
 * Paperboy's own part is the SITE: consent confines a connection to one site,
 * or (siteId null) every site, bounded by what the consenting user can see —
 * the same cap an mcp_token carries, so the MCP server enforces both through
 * one code path. The connection acts AS that user, with their roles and
 * section scopes, re-resolved on every request.
 */

export const OAUTH_ACCESS_TTL_S = 3600;
const CODE_TTL_MS = 10 * 60_000;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const secret = (prefix: string) => `${prefix}${randomBytes(32).toString("base64url")}`; // 256-bit
/** Resource identifiers compare without a trailing slash (".../mcp" === ".../mcp/"). */
const sameResource = (a: string, b: string) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "");

/** An error in the RFC 6749 wire format (`error` + `error_description`). */
export class OAuthError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

/* ------------------------------- clients -------------------------------- */

const BLOCKED_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:", "blob:", "about:"]);
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * A redirect URI we will send authorization codes to: https, http only on the
 * loopback interface (native clients listening locally), or a private-use
 * scheme (e.g. `cursor://`). Never a fragment — the code would leak into it.
 */
function assertRedirectUri(uri: string): void {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new OAuthError("invalid_redirect_uri", `"${uri}" is not an absolute URI`);
  }
  if (url.hash) throw new OAuthError("invalid_redirect_uri", `"${uri}" must not contain a fragment`);
  if (url.protocol === "https:") return;
  if (url.protocol === "http:") {
    if (LOOPBACK.has(url.hostname)) return;
    throw new OAuthError("invalid_redirect_uri", `"${uri}" uses http:// — only loopback addresses (localhost, 127.0.0.1) may; use https`);
  }
  if (BLOCKED_SCHEMES.has(url.protocol)) throw new OAuthError("invalid_redirect_uri", `"${uri}" uses a scheme that can't be a redirect target`);
}

export type TokenEndpointAuthMethod = "none" | "client_secret_post" | "client_secret_basic";

export async function registerOAuthClient(
  db: Database,
  input: { clientName?: string; redirectUris: unknown; tokenEndpointAuthMethod?: string },
): Promise<{ clientId: string; clientName: string; redirectUris: string[]; tokenEndpointAuthMethod: TokenEndpointAuthMethod; clientSecret?: string }> {
  const uris = input.redirectUris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every((u) => typeof u === "string" && u.length <= 2000)) {
    throw new OAuthError("invalid_redirect_uri", "redirect_uris must be a list of 1–10 URIs");
  }
  for (const uri of uris as string[]) assertRedirectUri(uri);
  const method = (input.tokenEndpointAuthMethod ?? "none") as TokenEndpointAuthMethod;
  if (!["none", "client_secret_post", "client_secret_basic"].includes(method)) {
    throw new OAuthError("invalid_client_metadata", `token_endpoint_auth_method "${method}" is not supported (use none, client_secret_post or client_secret_basic)`);
  }
  const clientName = (input.clientName ?? "").trim().slice(0, 200) || "MCP client";
  const clientId = `mcpc_${randomBytes(16).toString("base64url")}`;
  const clientSecret = method === "none" ? undefined : secret("mcps_");
  await db.insert(oauthClient).values({
    clientId,
    clientName,
    redirectUris: uris as string[],
    clientSecretHash: clientSecret ? sha256(clientSecret) : null,
  });
  return { clientId, clientName, redirectUris: uris as string[], tokenEndpointAuthMethod: method, clientSecret };
}

async function getClient(db: Database, clientId: string) {
  return (await db.select().from(oauthClient).where(eq(oauthClient.clientId, clientId)).limit(1))[0] ?? null;
}

/** A confidential client must present its secret; a public one must not need to. */
function assertClientAuthenticated(client: typeof oauthClient.$inferSelect, presented: string | undefined): void {
  if (!client.clientSecretHash) return;
  const got = Buffer.from(sha256(presented ?? ""));
  const want = Buffer.from(client.clientSecretHash);
  if (!presented || got.length !== want.length || !timingSafeEqual(got, want)) {
    throw new OAuthError("invalid_client", "Client authentication failed", 401);
  }
}

/* ------------------------------- consent -------------------------------- */

/**
 * The sites a user may connect an MCP client to, and whether "every site" is
 * on offer. Roles are global: a site-wide reader (Admin, Editor, Viewer) sees
 * every site, so may pick any one of them or all. A section-scoped user
 * (Author) sees only the sites they hold a section in, and never "every site" —
 * that would also reach sites added later, which they have no part in.
 */
export async function sitesForConsent(
  db: Database,
  userId: string,
): Promise<{ sites: Array<{ id: string; slug: string; name: string }>; allSitesAllowed: boolean }> {
  const ctx = await getAccessContext(db, userId);
  const all = await db.select({ id: site.id, slug: site.slug, name: site.name }).from(site).orderBy(site.createdAt, site.slug);
  if (ctx.readSiteWide) return { sites: all, allSitesAllowed: true };
  const scoped = new Set((await db.select({ siteId: userScope.siteId }).from(userScope).where(eq(userScope.userId, userId))).map((r) => r.siteId));
  return { sites: all.filter((s) => scoped.has(s.id)), allSitesAllowed: false };
}

export interface AuthorizeParams {
  response_type?: string;
  client_id?: string;
  redirect_uri?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  state?: string;
  resource?: string;
  scope?: string;
}

/**
 * Validate an authorization request. Errors about the client or its redirect
 * URI are shown to the user and NEVER redirected (the redirect target is not
 * trusted yet); anything else is reported back to the client's redirect URI.
 */
export async function validateAuthorizeRequest(
  db: Database,
  params: AuthorizeParams,
  expectedResource: string,
): Promise<{ clientId: string; clientName: string; redirectUri: string; resource: string; redirectError?: { error: string; description: string } }> {
  const client = params.client_id ? await getClient(db, params.client_id) : null;
  if (!client) throw new OAuthError("invalid_client", "Unknown client_id — the application must register first");
  const redirectUri = params.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
  if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
    throw new OAuthError("invalid_request", "redirect_uri does not match any URI this client registered");
  }
  const base = { clientId: client.clientId, clientName: client.clientName, redirectUri, resource: params.resource ?? expectedResource };
  if (params.response_type !== "code") {
    return { ...base, redirectError: { error: "unsupported_response_type", description: "Only response_type=code is supported" } };
  }
  if (!params.code_challenge || params.code_challenge_method !== "S256") {
    return { ...base, redirectError: { error: "invalid_request", description: "PKCE is required: send code_challenge with code_challenge_method=S256" } };
  }
  if (params.resource && !sameResource(params.resource, expectedResource)) {
    return { ...base, redirectError: { error: "invalid_target", description: `This server only issues tokens for ${expectedResource}` } };
  }
  return base;
}

/**
 * Record the user's consent and mint a one-time authorization code. The site
 * choice is checked against what the user can see HERE, on the server — the
 * picker only offers the allowed ones, but a forged request must not widen it.
 */
export async function createAuthorizationCode(
  db: Database,
  input: { clientId: string; userId: string; siteId: string | null; redirectUri: string; codeChallenge: string; resource: string },
): Promise<string> {
  const { sites, allSitesAllowed } = await sitesForConsent(db, input.userId);
  if (input.siteId === null ? !allSitesAllowed : !sites.some((s) => s.id === input.siteId)) {
    throw Errors.forbidden(
      input.siteId === null
        ? "You can only connect to the sites you have access to — pick one of them instead of every site"
        : "You don't have access to that site",
    );
  }
  const code = secret("mcpz_");
  await db.insert(oauthCode).values({
    codeHash: sha256(code),
    clientId: input.clientId,
    userId: input.userId,
    siteId: input.siteId,
    redirectUri: input.redirectUri,
    codeChallenge: input.codeChallenge,
    resource: input.resource,
    expiresAt: new Date(Date.now() + CODE_TTL_MS),
  });
  return code;
}

/* -------------------------------- tokens -------------------------------- */

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

const fresh = () => {
  const access = secret("mcpa_");
  const refresh = secret("mcpr_");
  return {
    access,
    refresh,
    columns: {
      accessTokenHash: sha256(access),
      refreshTokenHash: sha256(refresh),
      accessExpiresAt: new Date(Date.now() + OAUTH_ACCESS_TTL_S * 1000),
    },
  };
};
const tokenResponse = (t: { access: string; refresh: string }): TokenResponse => ({
  access_token: t.access,
  token_type: "Bearer",
  expires_in: OAUTH_ACCESS_TTL_S,
  refresh_token: t.refresh,
  scope: "mcp",
});

const pkceMatches = (verifier: string, challenge: string): boolean => {
  const got = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
  const want = Buffer.from(challenge);
  return got.length === want.length && timingSafeEqual(got, want);
};

export async function exchangeAuthorizationCode(
  db: Database,
  input: { code?: string; codeVerifier?: string; clientId?: string; clientSecret?: string; redirectUri?: string; resource?: string },
  expectedResource: string,
): Promise<TokenResponse> {
  if (!input.code || !input.codeVerifier || !input.clientId) {
    throw new OAuthError("invalid_request", "code, code_verifier and client_id are required");
  }
  if (input.resource && !sameResource(input.resource, expectedResource)) {
    throw new OAuthError("invalid_target", `This server only issues tokens for ${expectedResource}`);
  }
  const client = await getClient(db, input.clientId);
  if (!client) throw new OAuthError("invalid_client", "Unknown client", 401);
  assertClientAuthenticated(client, input.clientSecret);

  const outcome = await db.transaction(async (tx) => {
    const row = (await tx.select().from(oauthCode).where(eq(oauthCode.codeHash, sha256(input.code!))).for("update").limit(1))[0];
    if (!row || row.clientId !== input.clientId) return { error: "The authorization code is invalid" };
    if (row.usedAt) {
      // A replayed code: whoever holds it now may have stolen it. Revoke what the
      // first exchange issued (RFC 6749 §4.1.2).
      if (row.grantId) await tx.update(oauthGrant).set({ revokedAt: new Date() }).where(eq(oauthGrant.id, row.grantId));
      return { error: "The authorization code was already used" };
    }
    if (row.expiresAt <= new Date()) return { error: "The authorization code has expired" };
    if (input.redirectUri !== undefined && input.redirectUri !== row.redirectUri) return { error: "redirect_uri does not match the authorization request" };
    if (!pkceMatches(input.codeVerifier!, row.codeChallenge)) return { error: "code_verifier does not match the code_challenge" };
    const t = fresh();
    const [grant] = await tx
      .insert(oauthGrant)
      .values({ clientId: row.clientId, userId: row.userId, siteId: row.siteId, resource: row.resource, ...t.columns })
      .returning({ id: oauthGrant.id });
    await tx.update(oauthCode).set({ usedAt: new Date(), grantId: grant!.id }).where(eq(oauthCode.codeHash, row.codeHash));
    return { tokens: tokenResponse(t) };
  });
  if ("error" in outcome) throw new OAuthError("invalid_grant", outcome.error!);
  return outcome.tokens;
}

/** Rotate a grant's tokens. The presented refresh token is spent either way. */
export async function refreshOAuthToken(
  db: Database,
  input: { refreshToken?: string; clientId?: string; clientSecret?: string; resource?: string },
  expectedResource: string,
): Promise<TokenResponse> {
  if (!input.refreshToken) throw new OAuthError("invalid_request", "refresh_token is required");
  if (input.resource && !sameResource(input.resource, expectedResource)) {
    throw new OAuthError("invalid_target", `This server only issues tokens for ${expectedResource}`);
  }
  const grant = (await db.select().from(oauthGrant).where(eq(oauthGrant.refreshTokenHash, sha256(input.refreshToken))).limit(1))[0];
  if (!grant || grant.revokedAt) throw new OAuthError("invalid_grant", "The refresh token is invalid or revoked");
  if (input.clientId && input.clientId !== grant.clientId) throw new OAuthError("invalid_grant", "The refresh token was issued to another client");
  const client = await getClient(db, grant.clientId);
  if (!client) throw new OAuthError("invalid_grant", "The client no longer exists");
  assertClientAuthenticated(client, input.clientSecret);
  const t = fresh();
  // Matching on the OLD hash makes rotation atomic: two concurrent refreshes with
  // the same token can't both succeed.
  const rotated = await db
    .update(oauthGrant)
    .set(t.columns)
    .where(and(eq(oauthGrant.id, grant.id), eq(oauthGrant.refreshTokenHash, sha256(input.refreshToken)), isNull(oauthGrant.revokedAt)))
    .returning({ id: oauthGrant.id });
  if (!rotated[0]) throw new OAuthError("invalid_grant", "The refresh token was already used");
  return tokenResponse(t);
}

/** RFC 7009: revoke by access or refresh token. Unknown tokens are not an error. */
export async function revokeOAuthToken(db: Database, token: string): Promise<void> {
  const h = sha256(token);
  await db
    .update(oauthGrant)
    .set({ revokedAt: new Date() })
    .where(and(or(eq(oauthGrant.accessTokenHash, h), eq(oauthGrant.refreshTokenHash, h)), isNull(oauthGrant.revokedAt)));
}

/**
 * Authenticate an OAuth access token presented to the MCP server → the user it
 * acts as and the site it is confined to (null = every site), or null. Shaped
 * like verifyMcpToken so the MCP handles both credentials the same way.
 */
export async function verifyOAuthAccessToken(
  db: Database,
  token: string,
  resource: string,
): Promise<{ userId: string; siteId: string | null; grantId: number } | null> {
  if (!token.startsWith("mcpa_")) return null;
  const grant = (
    await db
      .select()
      .from(oauthGrant)
      .where(and(eq(oauthGrant.accessTokenHash, sha256(token)), isNull(oauthGrant.revokedAt), gt(oauthGrant.accessExpiresAt, new Date())))
      .limit(1)
  )[0];
  if (!grant || !sameResource(grant.resource, resource)) return null;
  await db.update(oauthGrant).set({ lastUsedAt: new Date() }).where(eq(oauthGrant.id, grant.id));
  return { userId: grant.userId, siteId: grant.siteId, grantId: grant.id };
}

/* ------------------------- connected apps (admin) ------------------------ */

/** The caller's own connections — or everyone's, for a user manager. */
export async function listOAuthGrants(db: Database, ctx: AccessContext) {
  const everyone = ctx.permissions.includes("user.manage");
  const rows = await db
    .select({
      id: oauthGrant.id,
      clientName: oauthClient.clientName,
      userId: oauthGrant.userId,
      email: users.email,
      siteId: oauthGrant.siteId,
      createdAt: oauthGrant.createdAt,
      lastUsedAt: oauthGrant.lastUsedAt,
      revokedAt: oauthGrant.revokedAt,
    })
    .from(oauthGrant)
    .innerJoin(oauthClient, eq(oauthClient.clientId, oauthGrant.clientId))
    .innerJoin(users, eq(users.id, oauthGrant.userId))
    .where(everyone ? undefined : eq(oauthGrant.userId, ctx.userId))
    .orderBy(desc(oauthGrant.id));
  return rows.map((r) => ({
    ...r,
    createdAt: r.createdAt.toISOString(),
    lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
    revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null,
  }));
}

/** Revoke a connection — your own, or anyone's with user.manage. Immediate. */
export async function revokeOAuthGrant(db: Database, ctx: AccessContext, id: number): Promise<void> {
  const everyone = ctx.permissions.includes("user.manage");
  const updated = await db
    .update(oauthGrant)
    .set({ revokedAt: new Date() })
    .where(and(eq(oauthGrant.id, id), everyone ? undefined : eq(oauthGrant.userId, ctx.userId)))
    .returning({ id: oauthGrant.id });
  if (!updated[0]) throw Errors.notFound("Connection");
}
