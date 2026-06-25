import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import argon2 from "argon2";
import { and, asc, desc, eq, gte, like, lte, sql } from "drizzle-orm";
import {
  type Permission,
  ROLE_PERMISSIONS,
  RoleName,
  type SessionUser,
} from "@paperboy/shared";
import { nanoid } from "nanoid";
import type { Database } from "./client.js";
import { Errors } from "./errors.js";
import { type AccessContext, requirePermission } from "./scope.js";
import { getDefaultSite } from "./sites.js";
import { DEFAULT_SITE_ID, auditLog, contentItem, deliveryKey, session, userRole, userScope, users } from "./schema.js";
import {
  decryptSecret,
  encryptSecret,
  generateBackupCodes,
  generateSecret,
  hashBackupCode,
  matchTotpStep,
  totpUri,
  verifyTotp,
} from "./totp.js";

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
// Absolute session lifetime: a login is valid for this long regardless of
// activity. Exported so the api can pin the session COOKIE's Max-Age to the
// same value (a persistent cookie that outlived the server session, or vice
// versa, would surprise-logout the user). The idle window is set to match, so
// inactivity alone never logs you out before the absolute cap is reached.
export const SESSION_ABSOLUTE_HOURS = 24 * 30; // 30 days
const SESSION_IDLE_MINUTES = 60 * 24 * 30; // 30 days

/** Argon2id parameters (OWASP-recommended baseline). */
const ARGON2_OPTS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 65536, // 64 MiB
  timeCost: 3,
  parallelism: 1,
};

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/* --------------------------------- users ---------------------------------- */

/** A section is a top-level content_item; its scope must be stored under that
 *  document's OWN site, not the column DEFAULT — getAccessContext filters scopes
 *  by the active site, so a mismatched site_id silently hides the assignment. */
async function sectionSiteId(db: Database, sectionId: string): Promise<string> {
  const rows = await db
    .select({ siteId: contentItem.siteId })
    .from(contentItem)
    .where(eq(contentItem.documentId, sectionId))
    .limit(1);
  return rows[0]?.siteId ?? DEFAULT_SITE_ID;
}

export async function createUser(
  db: Database,
  input: {
    email: string;
    name: string;
    password: string;
    roles: RoleName[];
    sections?: string[];
  },
): Promise<string> {
  const id = nanoid(16);
  const passwordHash = await argon2.hash(input.password, ARGON2_OPTS);
  await db.insert(users).values({ id, email: input.email, name: input.name, passwordHash });
  for (const role of input.roles) {
    await db.insert(userRole).values({ userId: id, role }).onConflictDoNothing();
  }
  for (const sectionId of input.sections ?? []) {
    const siteId = await sectionSiteId(db, sectionId);
    await db.insert(userScope).values({ userId: id, sectionId, siteId }).onConflictDoNothing();
  }
  return id;
}

/**
 * Verify credentials with account lockout. Returns the user id on success.
 * Throws a generic unauthorized error on any failure (no user enumeration).
 */
export async function verifyLogin(db: Database, email: string, password: string): Promise<string> {
  const rows = await db.select().from(users).where(eq(users.email, email)).limit(1);
  const user = rows[0];
  const generic = Errors.unauthorized("Invalid email or password");

  if (!user) {
    // Spend time to blunt timing-based enumeration.
    await argon2.hash(password, ARGON2_OPTS).catch(() => undefined);
    throw generic;
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    // SECURITY: do not reveal lock state (enumeration); spend time to match the
    // verify path, then return the SAME generic error as a wrong password.
    await argon2.verify(user.passwordHash, password).catch(() => false);
    throw generic;
  }

  const ok = await argon2.verify(user.passwordHash, password).catch(() => false);
  if (!ok) {
    const failed = user.failedAttempts + 1;
    const locked = failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null;
    // Keep the running counter (do NOT reset to 0 on lock) so a relocked account
    // does not regain a fresh attempt window after the lock expires.
    await db
      .update(users)
      .set({ failedAttempts: failed, lockedUntil: locked })
      .where(eq(users.id, user.id));
    throw generic;
  }

  if (user.failedAttempts > 0 || user.lockedUntil) {
    await db.update(users).set({ failedAttempts: 0, lockedUntil: null }).where(eq(users.id, user.id));
  }
  return user.id;
}

/* ---------------------- user administration (Admin) ----------------------- */

export interface ManagedUser {
  id: string;
  email: string;
  name: string;
  roles: RoleName[];
  sections: string[];
  locked: boolean;
  createdAt: string;
}

export async function listUsers(db: Database, ctx: AccessContext): Promise<ManagedUser[]> {
  requirePermission(ctx, "user.manage");
  const rows = await db.select().from(users).orderBy(asc(users.createdAt));
  const roleRows = await db.select().from(userRole);
  const scopeRows = await db.select().from(userScope);
  const now = new Date();
  return rows.map((u) => ({
    id: u.id,
    email: u.email,
    name: u.name,
    roles: roleRows.filter((r) => r.userId === u.id).map((r) => r.role as RoleName),
    sections: scopeRows.filter((s) => s.userId === u.id).map((s) => s.sectionId),
    locked: Boolean(u.lockedUntil && u.lockedUntil > now),
    createdAt: u.createdAt.toISOString(),
  }));
}

export async function adminCreateUser(
  db: Database,
  ctx: AccessContext,
  input: { email: string; name: string; password: string; roles: RoleName[]; sections?: string[] },
): Promise<string> {
  requirePermission(ctx, "user.manage");
  if (input.password.length < 10) throw Errors.badRequest("Password must be at least 10 characters");
  for (const r of input.roles) RoleName.parse(r);
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, input.email)).limit(1);
  if (existing[0]) throw Errors.conflict("A user with that email already exists");
  return createUser(db, input);
}

/** Update a user's profile (name/email), roles and section scopes. */
export async function adminUpdateUser(
  db: Database,
  ctx: AccessContext,
  userId: string,
  input: { name?: string; email?: string; roles?: RoleName[]; sections?: string[] },
): Promise<void> {
  requirePermission(ctx, "user.manage");
  const target = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const current = target[0];
  if (!current) throw Errors.notFound("User");
  if (input.roles) for (const r of input.roles) RoleName.parse(r);

  // Email is the login identity — keep it unique. Sessions are keyed by
  // userId, so the user's existing sessions survive the change.
  const email = input.email?.trim();
  const emailChanged = !!email && email !== current.email;
  if (emailChanged) {
    const taken = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (taken[0]) throw Errors.conflict("That email is already in use");
  }

  // Guard: never strip the last Admin (avoid locking everyone out).
  if (input.roles && !input.roles.includes("Admin")) {
    const admins = await db.select().from(userRole).where(eq(userRole.role, "Admin"));
    if (admins.length === 1 && admins[0]!.userId === userId) {
      throw Errors.conflict("Cannot remove the last administrator");
    }
  }
  // Resolve each section's own site BEFORE the tx (the content_item rows are
  // already committed) so the scope rows are filed under the correct site.
  const scopeSites = new Map<string, string>();
  if (input.sections) {
    for (const sectionId of input.sections) scopeSites.set(sectionId, await sectionSiteId(db, sectionId));
  }
  await db.transaction(async (tx) => {
    if (input.name !== undefined) await tx.update(users).set({ name: input.name }).where(eq(users.id, userId));
    if (emailChanged) await tx.update(users).set({ email }).where(eq(users.id, userId));
    if (input.roles) {
      await tx.delete(userRole).where(eq(userRole.userId, userId));
      for (const role of input.roles) await tx.insert(userRole).values({ userId, role }).onConflictDoNothing();
    }
    if (input.sections) {
      await tx.delete(userScope).where(eq(userScope.userId, userId));
      for (const sectionId of input.sections) {
        await tx
          .insert(userScope)
          .values({ userId, sectionId, siteId: scopeSites.get(sectionId) ?? DEFAULT_SITE_ID })
          .onConflictDoNothing();
      }
    }
  });
}

export async function adminDeleteUser(db: Database, ctx: AccessContext, userId: string): Promise<void> {
  requirePermission(ctx, "user.manage");
  if (userId === ctx.userId) throw Errors.conflict("You cannot delete your own account");
  const admins = await db.select().from(userRole).where(eq(userRole.role, "Admin"));
  if (admins.length === 1 && admins[0]!.userId === userId) {
    throw Errors.conflict("Cannot delete the last administrator");
  }
  await db.transaction(async (tx) => {
    await tx.delete(userRole).where(eq(userRole.userId, userId));
    await tx.delete(userScope).where(eq(userScope.userId, userId));
    await tx.delete(session).where(eq(session.userId, userId));
    await tx.delete(users).where(eq(users.id, userId));
  });
}

/** Self-service password change: verify the current password, then re-hash. */
/**
 * Re-verify the account password for a sensitive action (change-password,
 * disable-2FA) WITH the same per-account lockout as login (S3-L3) — otherwise a
 * session holder could brute-force the password on these unguarded reauth paths.
 * Throws a generic unauthorized on any failure (locked, wrong, or unknown).
 */
async function verifyReauth(db: Database, userId: string, password: string): Promise<void> {
  const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const user = rows[0];
  const generic = Errors.unauthorized("Current password is incorrect");
  if (!user) throw generic;
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    await argon2.verify(user.passwordHash, password).catch(() => false); // match the verify path's timing
    throw generic;
  }
  const ok = await argon2.verify(user.passwordHash, password).catch(() => false);
  if (!ok) {
    const failed = user.failedAttempts + 1;
    const locked = failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null;
    await db.update(users).set({ failedAttempts: failed, lockedUntil: locked }).where(eq(users.id, user.id));
    throw generic;
  }
  if (user.failedAttempts > 0 || user.lockedUntil) {
    await db.update(users).set({ failedAttempts: 0, lockedUntil: null }).where(eq(users.id, user.id));
  }
}

export async function changePassword(
  db: Database,
  userId: string,
  oldPassword: string,
  newPassword: string,
): Promise<void> {
  if (newPassword.length < 10) throw Errors.badRequest("New password must be at least 10 characters");
  await verifyReauth(db, userId, oldPassword);
  const passwordHash = await argon2.hash(newPassword, ARGON2_OPTS);
  await db.update(users).set({ passwordHash }).where(eq(users.id, userId));
  // Invalidate all OTHER sessions (keep none — force re-login everywhere).
  await db.delete(session).where(eq(session.userId, userId));
}

export async function getRoles(db: Database, userId: string): Promise<RoleName[]> {
  const rows = await db.select().from(userRole).where(eq(userRole.userId, userId));
  return rows.map((r) => r.role as RoleName);
}

export async function getAccessContext(
  db: Database,
  userId: string,
  activeSiteId?: string,
): Promise<AccessContext> {
  const roles = await getRoles(db, userId);
  const permissions = new Set<Permission>();
  for (const role of roles) for (const p of ROLE_PERMISSIONS[role] ?? []) permissions.add(p);
  // Admin/Editor/Viewer operate site-wide (within the active site); Author is
  // restricted to its sections.
  const siteWide = roles.some((r) => r === "Admin" || r === "Editor" || r === "Viewer");
  // The active site: an explicit choice (admin site switcher, Phase 3) or the
  // Default site. Section scopes are per-site, so only this site's scopes apply.
  const siteId = activeSiteId ?? (await getDefaultSite(db)).id;
  const scopeRows = await db
    .select()
    .from(userScope)
    .where(and(eq(userScope.userId, userId), eq(userScope.siteId, siteId)));
  return {
    userId,
    permissions: [...permissions],
    siteId,
    siteWide,
    sections: scopeRows.map((s) => s.sectionId),
  };
}

export async function getSessionUser(db: Database, userId: string): Promise<SessionUser> {
  const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!rows[0]) throw Errors.unauthorized();
  const ctx = await getAccessContext(db, userId);
  const roles = await getRoles(db, userId);
  return {
    id: rows[0].id,
    email: rows[0].email,
    name: rows[0].name,
    roles,
    permissions: ctx.permissions,
    mfaEnabled: rows[0].totpEnabled,
  };
}

/* --------------------------- two-factor (TOTP) ---------------------------- */

/**
 * Resolve how an account authenticates, by email, WITHOUT verifying a password.
 * Used by the email-first login: a 2FA account goes straight to a TOTP challenge
 * (passwordless); everyone else is asked for a password. Returns null for unknown
 * emails so the caller can treat them like a password account (no enumeration of
 * existence beyond the unavoidable "this email has 2FA" signal).
 */
export async function findLoginMethod(db: Database, email: string): Promise<{ userId: string; totpEnabled: boolean } | null> {
  const rows = await db.select({ id: users.id, totp: users.totpEnabled }).from(users).where(eq(users.email, email)).limit(1);
  const row = rows[0];
  return row ? { userId: row.id, totpEnabled: Boolean(row.totp) } : null;
}

export async function getMfaStatus(db: Database, userId: string): Promise<{ enabled: boolean; backupCodesRemaining: number }> {
  const rows = await db.select({ enabled: users.totpEnabled, codes: users.backupCodes }).from(users).where(eq(users.id, userId)).limit(1);
  const row = rows[0];
  return { enabled: Boolean(row?.enabled), backupCodesRemaining: Array.isArray(row?.codes) ? (row!.codes as string[]).length : 0 };
}

/** Start enrollment: generate a secret (stored encrypted, NOT yet enabled) + return the otpauth URI. */
export async function beginTotpSetup(db: Database, userId: string): Promise<{ secret: string; uri: string }> {
  const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const user = rows[0];
  if (!user) throw Errors.unauthorized();
  if (user.totpEnabled) throw Errors.conflict("Two-factor is already enabled");
  const secret = generateSecret();
  await db.update(users).set({ totpSecret: encryptSecret(secret), totpEnabled: false }).where(eq(users.id, userId));
  return { secret, uri: totpUri(secret, user.email) };
}

/** Confirm enrollment with a code → enable 2FA and issue one-time backup codes. */
export async function enableTotp(db: Database, userId: string, code: string): Promise<{ backupCodes: string[] }> {
  const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const user = rows[0];
  if (!user?.totpSecret) throw Errors.badRequest("Start 2FA setup first");
  if (!verifyTotp(decryptSecret(user.totpSecret), code)) throw Errors.unauthorized("Invalid code");
  const codes = generateBackupCodes();
  await db.update(users).set({ totpEnabled: true, backupCodes: codes.map(hashBackupCode) }).where(eq(users.id, userId));
  return { backupCodes: codes };
}

/** Disable 2FA (requires the account password — a re-auth gate). */
export async function disableTotp(db: Database, userId: string, password: string): Promise<void> {
  await verifyReauth(db, userId, password); // same per-account lockout as login (S3-L3)
  await db.update(users).set({ totpSecret: null, totpEnabled: false, backupCodes: null }).where(eq(users.id, userId));
}

/**
 * Verify a TOTP code OR consume a one-time backup code (the 2FA login step).
 * For a 2FA account this is the SOLE factor, so it carries the same protections
 * as the password path: a per-account lockout after repeated failures (H4), and
 * single-use TOTP codes — a step <= the last accepted one is a replay (M12).
 */
export async function verifySecondFactor(db: Database, userId: string, code: string): Promise<boolean> {
  const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const user = rows[0];
  if (!user?.totpEnabled || !user.totpSecret) return false;
  // Locked: refuse even a correct code (matches verifyLogin), no enumeration.
  if (user.lockedUntil && user.lockedUntil > new Date()) return false;

  const clearLock = { failedAttempts: 0, lockedUntil: null as Date | null };
  const step = matchTotpStep(decryptSecret(user.totpSecret), code);
  if (step !== null) {
    // Replay of an already-consumed (or older) step — reject without counting it
    // as a brute-force guess (a legitimate double-submit shouldn't lock the user).
    if (user.lastTotpStep != null && step <= user.lastTotpStep) return false;
    await db.update(users).set({ ...clearLock, lastTotpStep: step }).where(eq(users.id, userId));
    return true;
  }
  // Fall back to a backup code (one-time): match its hash, then remove it.
  const hashes = Array.isArray(user.backupCodes) ? (user.backupCodes as string[]) : [];
  const used = hashBackupCode(code);
  if (hashes.includes(used)) {
    await db.update(users).set({ ...clearLock, backupCodes: hashes.filter((h) => h !== used) }).where(eq(users.id, userId));
    return true;
  }
  // Wrong code → count toward the per-account lockout (same policy as passwords).
  const failed = user.failedAttempts + 1;
  const locked = failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null;
  await db.update(users).set({ failedAttempts: failed, lockedUntil: locked }).where(eq(users.id, userId));
  return false;
}

/* -------------------------------- sessions -------------------------------- */

export async function createSession(
  db: Database,
  userId: string,
): Promise<{ token: string; csrfToken: string }> {
  const token = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(32).toString("base64url");
  const now = Date.now();
  await db.insert(session).values({
    id: sha256(token),
    userId,
    csrfToken,
    expiresAt: new Date(now + SESSION_ABSOLUTE_HOURS * 3600_000),
    idleExpiresAt: new Date(now + SESSION_IDLE_MINUTES * 60_000),
  });
  return { token, csrfToken };
}

export async function readSession(
  db: Database,
  token: string,
): Promise<{ userId: string; csrfToken: string } | null> {
  const id = sha256(token);
  const rows = await db.select().from(session).where(eq(session.id, id)).limit(1);
  const s = rows[0];
  if (!s) return null;
  const now = new Date();
  if (s.expiresAt < now || s.idleExpiresAt < now) {
    await db.delete(session).where(eq(session.id, id));
    return null;
  }
  // Slide the idle window.
  await db
    .update(session)
    .set({ idleExpiresAt: new Date(Date.now() + SESSION_IDLE_MINUTES * 60_000) })
    .where(eq(session.id, id));
  return { userId: s.userId, csrfToken: s.csrfToken };
}

export async function destroySession(db: Database, token: string): Promise<void> {
  await db.delete(session).where(eq(session.id, sha256(token)));
}

/* ------------------------------ delivery keys ----------------------------- */

export async function createDeliveryKey(
  db: Database,
  siteId: string,
  name: string,
  type: "public" | "preview",
): Promise<{ key: string }> {
  const prefix = type === "public" ? "pk_live_" : "prv_";
  const secret = randomBytes(32).toString("base64url"); // 256-bit
  const key = `${prefix}${secret}`;
  // D1: the key belongs to the active site — it will only ever see that site.
  await db.insert(deliveryKey).values({ name, keyHash: sha256(key), keyPrefix: prefix, type, siteId });
  return { key };
}

/** List delivery keys (metadata only — never the secret). */
export async function listDeliveryKeys(db: Database, ctx: AccessContext) {
  requirePermission(ctx, "deliverykey.manage");
  const rows = await db
    .select()
    .from(deliveryKey)
    .where(eq(deliveryKey.siteId, ctx.siteId)) // only the active site's keys
    .orderBy(desc(deliveryKey.id));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    keyPrefix: r.keyPrefix,
    type: r.type as "public" | "preview",
    createdAt: r.createdAt.toISOString(),
    revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null,
  }));
}

export async function revokeDeliveryKey(db: Database, ctx: AccessContext, id: number): Promise<void> {
  requirePermission(ctx, "deliverykey.manage");
  // Return the affected row so a no-op (missing/typo id) is a 404, not a false
  // success that writes a misleading "revoked" audit entry.
  const updated = await db
    .update(deliveryKey)
    .set({ revokedAt: new Date() })
    .where(and(eq(deliveryKey.id, id), eq(deliveryKey.siteId, ctx.siteId))) // active site only
    .returning({ id: deliveryKey.id });
  if (!updated[0]) throw Errors.notFound("Delivery key");
}

/** Rename a delivery key (the secret is unaffected). 404 if it doesn't exist. */
export async function renameDeliveryKey(db: Database, ctx: AccessContext, id: number, name: string): Promise<void> {
  requirePermission(ctx, "deliverykey.manage");
  const updated = await db
    .update(deliveryKey)
    .set({ name })
    .where(and(eq(deliveryKey.id, id), eq(deliveryKey.siteId, ctx.siteId))) // active site only
    .returning({ id: deliveryKey.id });
  if (!updated[0]) throw Errors.notFound("Delivery key");
}

/**
 * Returns the key's perspective-bearing type AND the site it's scoped to (D1:
 * per-site delivery keys), or null if invalid/revoked. The site narrows EVERY
 * delivery read to that key's site — the structural no-leak boundary across sites.
 */
export async function verifyDeliveryKey(
  db: Database,
  key: string,
): Promise<{ type: "public" | "preview"; siteId: string } | null> {
  if (!key) return null;
  const rows = await db
    .select()
    .from(deliveryKey)
    .where(eq(deliveryKey.keyHash, sha256(key)))
    .limit(1);
  const row = rows[0];
  if (!row || row.revokedAt) return null;
  return { type: row.type as "public" | "preview", siteId: row.siteId };
}

/* --------------------------------- audit ---------------------------------- */

export async function audit(
  db: Database,
  entry: {
    actorUserId?: string | null;
    action: string;
    documentId?: string | null;
    locale?: string | null;
    ip?: string | null;
    detail?: unknown;
  },
): Promise<void> {
  await db.insert(auditLog).values({
    actorUserId: entry.actorUserId ?? null,
    action: entry.action,
    documentId: entry.documentId ?? null,
    locale: entry.locale ?? null,
    ip: entry.ip ?? null,
    detail: (entry.detail ?? null) as object | null,
  });
}

/** Read the append-only audit log (most-recent first), joined to actor names.
 *  Cursor-paged (`before` = id of the oldest row already shown) and filterable
 *  by action (prefix — "content." selects the category), actor, document and
 *  time range. */
export async function listAudit(
  db: Database,
  ctx: AccessContext,
  opts: {
    limit?: number;
    before?: number;
    action?: string;
    actorUserId?: string;
    documentId?: string;
    from?: string;
    to?: string;
  } = {},
) {
  requirePermission(ctx, "audit.read");
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const conds = [];
  if (opts.before) conds.push(sql`${auditLog.id} < ${opts.before}`);
  // Prefix match so "content." selects the whole category; exact actions work
  // too. LIKE wildcards in the input are stripped, not interpreted.
  if (opts.action) conds.push(like(auditLog.action, `${opts.action.replace(/[%_]/g, "")}%`));
  if (opts.actorUserId) conds.push(eq(auditLog.actorUserId, opts.actorUserId));
  if (opts.documentId) conds.push(eq(auditLog.documentId, opts.documentId));
  const from = opts.from ? new Date(opts.from) : null;
  if (from && !Number.isNaN(+from)) conds.push(gte(auditLog.ts, from));
  const to = opts.to ? new Date(opts.to) : null;
  if (to && !Number.isNaN(+to)) conds.push(lte(auditLog.ts, to));
  const where = conds.length ? and(...conds) : undefined;
  const rows = await db
    .select({
      id: auditLog.id,
      ts: auditLog.ts,
      actorUserId: auditLog.actorUserId,
      actorName: users.name,
      action: auditLog.action,
      documentId: auditLog.documentId,
      locale: auditLog.locale,
      ip: auditLog.ip,
      detail: auditLog.detail,
    })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorUserId))
    .where(where)
    .orderBy(desc(auditLog.id))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts.toISOString(),
    actorUserId: r.actorUserId,
    actorName: r.actorName,
    action: r.action,
    documentId: r.documentId,
    locale: r.locale,
    ip: r.ip,
    detail: r.detail,
  }));
}
