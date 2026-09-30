import {
  type AuthorizeParams,
  OAuthError,
  audit,
  createAuthorizationCode,
  exchangeAuthorizationCode,
  listOAuthGrants,
  refreshOAuthToken,
  registerOAuthClient,
  revokeOAuthGrant,
  revokeOAuthToken,
  sitesForConsent,
  validateAuthorizeRequest,
} from "@paperboy/db";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAuth, requireCsrf } from "../security.js";

/**
 * OAuth 2.1 for the remote MCP server (the MCP authorization spec). The API is
 * the authorization server; the MCP server is the protected resource and points
 * clients here through its protected-resource metadata.
 *
 *  - Discovery: /.well-known/oauth-authorization-server (RFC 8414) and
 *    /.well-known/oauth-protected-resource[/mcp] (RFC 9728), at the ROOT of the
 *    public origin — nginx routes them here.
 *  - Clients register themselves (RFC 7591) and use code + PKCE (S256 only).
 *  - The authorization endpoint is the admin's /oauth/authorize page: it reuses
 *    the admin's own login (and 2FA) and shows the consent screen, including the
 *    site picker. It calls the two session endpoints below.
 *  - The token, registration and revocation endpoints carry no cookie and grant
 *    any origin (a browser-based MCP client calls them directly).
 */

export interface OAuthConfig {
  /** The issuer and base of the endpoints — the public origin (plus any path). */
  issuer: string;
  /** The MCP endpoint's public URL — the only resource tokens are issued for. */
  resource: string;
}

/** Normalise a configured URL: absolute, no trailing slash. */
export function oauthConfigFrom(env: { PUBLIC_URL?: string; MCP_PUBLIC_URL?: string; CORS_ORIGIN: string }): OAuthConfig {
  const clean = (name: string, v: string): string => {
    let url: URL;
    try {
      url = new URL(v);
    } catch {
      throw new Error(`${name} must be a full URL such as https://cms.example.com (got "${v}")`);
    }
    return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  };
  const issuer = clean("PUBLIC_URL", env.PUBLIC_URL ?? env.CORS_ORIGIN);
  return { issuer, resource: clean("MCP_PUBLIC_URL", env.MCP_PUBLIC_URL ?? `${issuer}/mcp`) };
}

const AuthorizeQuery = z.object({
  response_type: z.string().optional(),
  client_id: z.string().optional(),
  redirect_uri: z.string().optional(),
  code_challenge: z.string().optional(),
  code_challenge_method: z.string().optional(),
  state: z.string().max(2000).optional(),
  resource: z.string().optional(),
  scope: z.string().optional(),
});

function sendOAuthError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof OAuthError) {
    return reply.code(err.status).send({ error: err.code, error_description: err.message });
  }
  throw err;
}

/** The redirect back to the client, carrying `state` untouched. */
function clientRedirect(redirectUri: string, params: Record<string, string | undefined>): string {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  return url.toString();
}

/** Public OAuth endpoints: any origin, no credentials (they never read a cookie). */
function openCors(reply: FastifyReply): void {
  reply.header("Access-Control-Allow-Origin", "*");
  reply.header("Access-Control-Allow-Headers", "authorization, content-type, mcp-protocol-version");
  reply.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

export async function registerOAuthRoutes(appBase: FastifyInstance, opts: { config: OAuthConfig }): Promise<void> {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const { issuer, resource } = opts.config;
  const open = { cors: false };

  // The token and revocation endpoints are form-encoded (RFC 6749 §4.1.3).
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  const metadata = {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/api/v1/oauth/token`,
    registration_endpoint: `${issuer}/api/v1/oauth/register`,
    revocation_endpoint: `${issuer}/api/v1/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: ["mcp"],
  };
  const resourceMetadata = {
    resource,
    authorization_servers: [issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: ["mcp"],
    resource_name: "Paperboy MCP",
  };
  const hidden = { schema: { hide: true }, config: { cors: false } };
  const serve = (path: string, body: unknown) =>
    app.get(path, hidden, async (_req, reply) => {
      openCors(reply);
      return reply.send(body);
    });
  // Clients probe more than one documented location; answer each.
  serve("/.well-known/oauth-authorization-server", metadata);
  serve("/.well-known/openid-configuration", metadata);
  serve("/.well-known/oauth-protected-resource", resourceMetadata);
  serve(`/.well-known/oauth-protected-resource${new URL(resource).pathname}`, resourceMetadata);
  for (const path of ["/api/v1/oauth/register", "/api/v1/oauth/token", "/api/v1/oauth/revoke"]) {
    app.options(path, hidden, async (_req, reply) => {
      openCors(reply);
      return reply.code(204).send();
    });
  }

  app.post(
    "/api/v1/oauth/register",
    { schema: { hide: true }, config: { ...open, rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (req, reply) => {
      openCors(reply);
      const body = (req.body ?? {}) as { client_name?: string; redirect_uris?: unknown; token_endpoint_auth_method?: string };
      try {
        const c = await registerOAuthClient(app.db, {
          clientName: body.client_name,
          redirectUris: body.redirect_uris,
          tokenEndpointAuthMethod: body.token_endpoint_auth_method,
        });
        return reply.code(201).send({
          client_id: c.clientId,
          client_id_issued_at: Math.floor(Date.now() / 1000),
          client_name: c.clientName,
          redirect_uris: c.redirectUris,
          token_endpoint_auth_method: c.tokenEndpointAuthMethod,
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          ...(c.clientSecret ? { client_secret: c.clientSecret, client_secret_expires_at: 0 } : {}),
        });
      } catch (err) {
        return sendOAuthError(reply, err);
      }
    },
  );

  app.post(
    "/api/v1/oauth/token",
    { schema: { hide: true }, config: { ...open, rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (req, reply) => {
      openCors(reply);
      reply.header("Cache-Control", "no-store");
      const body = (req.body ?? {}) as Record<string, string | undefined>;
      // client_secret_basic: the client authenticates in the Authorization header.
      let clientId = body.client_id;
      let clientSecret = body.client_secret;
      const basic = /^Basic\s+(.+)$/i.exec(req.headers.authorization ?? "");
      if (basic) {
        const [id, pw] = Buffer.from(basic[1]!, "base64").toString("utf8").split(":");
        clientId = decodeURIComponent(id ?? "");
        clientSecret = decodeURIComponent(pw ?? "");
      }
      try {
        if (body.grant_type === "authorization_code") {
          return await exchangeAuthorizationCode(
            app.db,
            { code: body.code, codeVerifier: body.code_verifier, clientId, clientSecret, redirectUri: body.redirect_uri, resource: body.resource },
            resource,
          );
        }
        if (body.grant_type === "refresh_token") {
          return await refreshOAuthToken(app.db, { refreshToken: body.refresh_token, clientId, clientSecret, resource: body.resource }, resource);
        }
        throw new OAuthError("unsupported_grant_type", "Use grant_type=authorization_code or refresh_token");
      } catch (err) {
        return sendOAuthError(reply, err);
      }
    },
  );

  app.post("/api/v1/oauth/revoke", { schema: { hide: true }, config: { ...open, rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply) => {
    openCors(reply);
    const token = ((req.body ?? {}) as { token?: string }).token;
    if (token) await revokeOAuthToken(app.db, token);
    return reply.code(200).send({});
  });

  /* ---- consent (the admin's /oauth/authorize page; session-authenticated) ---- */

  app.get(
    "/api/v1/oauth/authorize/request",
    { preHandler: requireAuth, schema: { tags: ["oauth"], summary: "Validate an MCP authorization request and list the sites the user may connect", querystring: AuthorizeQuery } },
    async (req, reply) => {
      try {
        const v = await validateAuthorizeRequest(app.db, req.query as AuthorizeParams, resource);
        const q = req.query as AuthorizeParams;
        if (v.redirectError) {
          return { errorRedirect: clientRedirect(v.redirectUri, { error: v.redirectError.error, error_description: v.redirectError.description, state: q.state }) };
        }
        const { sites, allSitesAllowed } = await sitesForConsent(app.db, req.user!.id);
        return { client: { name: v.clientName, redirectUri: v.redirectUri }, sites, allSitesAllowed, activeSiteId: req.accessCtx!.siteId };
      } catch (err) {
        return sendOAuthError(reply, err);
      }
    },
  );

  app.post(
    "/api/v1/oauth/authorize",
    {
      preHandler: requireCsrf,
      schema: {
        tags: ["oauth"],
        summary: "Approve or deny an MCP connection (consent); returns where to send the browser",
        body: AuthorizeQuery.extend({ approve: z.boolean(), siteId: z.string().nullable() }),
      },
    },
    async (req, reply) => {
      const body = req.body as AuthorizeParams & { approve: boolean; siteId: string | null };
      try {
        const v = await validateAuthorizeRequest(app.db, body, resource);
        if (v.redirectError) {
          return { redirectTo: clientRedirect(v.redirectUri, { error: v.redirectError.error, error_description: v.redirectError.description, state: body.state }) };
        }
        if (!body.approve) {
          return { redirectTo: clientRedirect(v.redirectUri, { error: "access_denied", state: body.state }) };
        }
        const code = await createAuthorizationCode(app.db, {
          clientId: v.clientId,
          userId: req.user!.id,
          siteId: body.siteId,
          redirectUri: v.redirectUri,
          codeChallenge: body.code_challenge!,
          resource: v.resource,
        });
        await audit(app.db, {
          actorUserId: req.user!.id,
          action: "mcp.oauth.authorize",
          ip: req.ip,
          detail: { client: v.clientName, clientId: v.clientId, siteId: body.siteId },
        });
        return { redirectTo: clientRedirect(v.redirectUri, { code, state: body.state, iss: issuer }) };
      } catch (err) {
        return sendOAuthError(reply, err);
      }
    },
  );

  /* ---- connected apps (Settings → MCP) ---- */

  app.get(
    "/api/v1/manage/oauth-grants",
    { preHandler: requireAuth, schema: { tags: ["oauth"], summary: "List MCP connections made through OAuth (yours; everyone's with user.manage)" } },
    async (req) => listOAuthGrants(app.db, req.accessCtx!),
  );
  app.post(
    "/api/v1/manage/oauth-grants/:id/revoke",
    { preHandler: requireCsrf, schema: { tags: ["oauth"], summary: "Revoke an MCP connection (takes effect immediately)", params: z.object({ id: z.coerce.number().int() }) } },
    async (req) => {
      const { id } = req.params as { id: number };
      await revokeOAuthGrant(app.db, req.accessCtx!, id);
      await audit(app.db, { actorUserId: req.user!.id, action: "mcp.oauth.revoke", ip: req.ip, detail: { grantId: id } });
      return { ok: true };
    },
  );
}
