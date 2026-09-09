import { createHash, randomBytes } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { Errors } from "./errors.js";
import { type AccessContext, requirePermission } from "./scope.js";
import { getSiteById } from "./sites.js";
import { mcpToken, users } from "./schema.js";

/**
 * MCP access tokens. A token authenticates the MCP server AS a Paperboy user, so
 * it inherits that user's roles/section scopes — instead of embedding a password.
 * Stored sha-256-hashed; the secret is shown once at creation; revocable.
 */
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export async function createMcpToken(
  db: Database,
  ctx: AccessContext,
  input: { name: string; userId: string; siteId?: string | null },
): Promise<{ token: string }> {
  requirePermission(ctx, "user.manage");
  const u = await db.select({ id: users.id }).from(users).where(eq(users.id, input.userId)).limit(1);
  if (!u[0]) throw Errors.badRequest("Unknown user");
  // `undefined` means "the site this was minted in" (the deny-by-default the
  // admin sends); an explicit null is the deliberate cross-site token.
  const siteId = input.siteId === undefined ? ctx.siteId : input.siteId;
  if (siteId !== null && !(await getSiteById(db, siteId))) throw Errors.badRequest(`Unknown site '${siteId}'`);
  const token = `mcp_${randomBytes(32).toString("base64url")}`; // 256-bit
  await db.insert(mcpToken).values({ name: input.name, tokenHash: sha256(token), tokenPrefix: "mcp_", userId: input.userId, siteId });
  return { token };
}

/** List MCP tokens (metadata only — never the secret). */
export async function listMcpTokens(db: Database, ctx: AccessContext) {
  requirePermission(ctx, "user.manage");
  const rows = await db
    .select({
      id: mcpToken.id,
      name: mcpToken.name,
      userId: mcpToken.userId,
      siteId: mcpToken.siteId,
      email: users.email,
      createdAt: mcpToken.createdAt,
      lastUsedAt: mcpToken.lastUsedAt,
      revokedAt: mcpToken.revokedAt,
    })
    .from(mcpToken)
    .leftJoin(users, eq(users.id, mcpToken.userId))
    .orderBy(desc(mcpToken.id));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    userId: r.userId,
    siteId: r.siteId,
    email: r.email ?? "(deleted user)",
    createdAt: r.createdAt.toISOString(),
    lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
    revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null,
  }));
}

export async function revokeMcpToken(db: Database, ctx: AccessContext, id: number): Promise<void> {
  requirePermission(ctx, "user.manage");
  const updated = await db
    .update(mcpToken)
    .set({ revokedAt: new Date() })
    .where(eq(mcpToken.id, id))
    .returning({ id: mcpToken.id });
  if (!updated[0]) throw Errors.notFound("MCP token");
}

/**
 * What the database knows about a presented token.
 *
 * "revoked" and "unknown" both mean "don't authenticate", but the MCP server has
 * to tell them apart: it may be booted with an env-only MCP_TOKEN that has no row
 * at all ("unknown", and legitimately usable), while a token that DOES have a row
 * and was revoked in Settings → MCP must stop working immediately — even if it is
 * the same string the process booted with.
 */
export type McpTokenState =
  | { state: "active"; userId: string; siteId: string | null }
  | { state: "revoked"; userId: string; siteId: string | null }
  | { state: "unknown"; userId: null; siteId: null };

/** Look a token up without authenticating it. Does not touch last-used. */
export async function mcpTokenState(db: Database, token: string): Promise<McpTokenState> {
  if (!token || !token.startsWith("mcp_")) return { state: "unknown", userId: null, siteId: null };
  const rows = await db.select().from(mcpToken).where(eq(mcpToken.tokenHash, sha256(token))).limit(1);
  const row = rows[0];
  if (!row) return { state: "unknown", userId: null, siteId: null };
  return row.revokedAt
    ? { state: "revoked", userId: row.userId, siteId: row.siteId }
    : { state: "active", userId: row.userId, siteId: row.siteId };
}

/**
 * Authenticate a token → the user it acts as and the site it is confined to
 * (`siteId: null` = every site), or null. Updates last-used.
 *
 * Shaped like `verifyDeliveryKey`, which returns `{type, siteId}` for the same
 * reason: the credential, not the caller, decides which site it can reach.
 */
export async function verifyMcpToken(
  db: Database,
  token: string,
): Promise<{ userId: string; siteId: string | null } | null> {
  const found = await mcpTokenState(db, token);
  if (found.state !== "active") return null;
  await db.update(mcpToken).set({ lastUsedAt: new Date() }).where(eq(mcpToken.tokenHash, sha256(token)));
  return { userId: found.userId, siteId: found.siteId };
}
