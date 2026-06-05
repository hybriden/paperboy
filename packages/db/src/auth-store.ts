import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import argon2 from "argon2";
import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
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
import { auditLog, deliveryKey, session, userRole, userScope, users } from "./schema.js";
import {
  decryptSecret,
  encryptSecret,
  generateBackupCodes,
  generateSecret,
  hashBackupCode,
  totpUri,
  verifyTotp,
} from "./totp.js";

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const SESSION_ABSOLUTE_HOURS = 12;
const SESSION_IDLE_MINUTES = 60;

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
    await db.insert(userScope).values({ userId: id, sectionId }).onConflictDoNothing();
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
  await db.transaction(async (tx) => {
    if (input.name !== undefined) await tx.update(users).set({ name: input.name }).where(eq(users.id, userId));
    if (emailChanged) await tx.update(users).set({ email }).where(eq(users.id, userId));
    if (input.roles) {
      await tx.delete(userRole).where(eq(userRole.userId, userId));
      for (const role of input.roles) await tx.insert(userRole).values({ userId, role }).onConflictDoNothing();
    }
    if (input.sections) {
      await tx.delete(userScope).where(eq(userScope.userId, userId));
      for (const sectionId of input.sections) await tx.insert(userScope).values({ userId, sectionId }).onConflictDoNothing();
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
export async function changePassword(
  db: Database,
  userId: string,
  oldPassword: string,
  newPassword: string,
): Promise<void> {
  if (newPassword.length < 10) throw Errors.badRequest("New password must be at least 10 characters");
  const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const user = rows[0];
  if (!user) throw Errors.unauthorized();
  const ok = await argon2.verify(user.passwordHash, oldPassword).catch(() => false);
  if (!ok) throw Errors.unauthorized("Current password is incorrect");
  const passwordHash = await argon2.hash(newPassword, ARGON2_OPTS);
  await db.update(users).set({ passwordHash }).where(eq(users.id, userId));
  // Invalidate all OTHER sessions (keep none — force re-login everywhere).
  await db.delete(session).where(eq(session.userId, userId));
}

export async function getRoles(db: Database, userId: string): Promise<RoleName[]> {
  const rows = await db.select().from(userRole).where(eq(userRole.userId, userId));
  return rows.map((r) => r.role as RoleName);
}

export async function getAccessContext(db: Database, userId: string): Promise<AccessContext> {
  const roles = await getRoles(db, userId);
  const permissions = new Set<Permission>();
  for (const role of roles) for (const p of ROLE_PERMISSIONS[role] ?? []) permissions.add(p);
  // Admin/Editor/Viewer operate site-wide; Author is restricted to its sections.
  const siteWide = roles.some((r) => r === "Admin" || r === "Editor" || r === "Viewer");
  const scopeRows = await db.select().from(userScope).where(eq(userScope.userId, userId));
  return {
    userId,
    permissions: [...permissions],
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
  const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const user = rows[0];
  if (!user) throw Errors.unauthorized();
  const ok = await argon2.verify(user.passwordHash, password).catch(() => false);
  if (!ok) throw Errors.unauthorized("Password is incorrect");
  await db.update(users).set({ totpSecret: null, totpEnabled: false, backupCodes: null }).where(eq(users.id, userId));
}

/** Verify a TOTP code OR consume a one-time backup code (used at the 2FA login step). */
export async function verifySecondFactor(db: Database, userId: string, code: string): Promise<boolean> {
  const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const user = rows[0];
  if (!user?.totpEnabled || !user.totpSecret) return false;
  if (verifyTotp(decryptSecret(user.totpSecret), code)) return true;
  // Fall back to a backup code (one-time): match its hash, then remove it.
  const hashes = Array.isArray(user.backupCodes) ? (user.backupCodes as string[]) : [];
  const used = hashBackupCode(code);
  if (hashes.includes(used)) {
    await db.update(users).set({ backupCodes: hashes.filter((h) => h !== used) }).where(eq(users.id, userId));
    return true;
  }
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
  name: string,
  type: "public" | "preview",
): Promise<{ key: string }> {
  const prefix = type === "public" ? "pk_live_" : "prv_";
  const secret = randomBytes(32).toString("base64url"); // 256-bit
  const key = `${prefix}${secret}`;
  await db.insert(deliveryKey).values({ name, keyHash: sha256(key), keyPrefix: prefix, type });
  return { key };
}

/** List delivery keys (metadata only — never the secret). */
export async function listDeliveryKeys(db: Database, ctx: AccessContext) {
  requirePermission(ctx, "deliverykey.manage");
  const rows = await db.select().from(deliveryKey).orderBy(desc(deliveryKey.id));
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
    .where(eq(deliveryKey.id, id))
    .returning({ id: deliveryKey.id });
  if (!updated[0]) throw Errors.notFound("Delivery key");
}

/** Rename a delivery key (the secret is unaffected). 404 if it doesn't exist. */
export async function renameDeliveryKey(db: Database, ctx: AccessContext, id: number, name: string): Promise<void> {
  requirePermission(ctx, "deliverykey.manage");
  const updated = await db
    .update(deliveryKey)
    .set({ name })
    .where(eq(deliveryKey.id, id))
    .returning({ id: deliveryKey.id });
  if (!updated[0]) throw Errors.notFound("Delivery key");
}

/** Returns the key's perspective-bearing type, or null if invalid/revoked. */
export async function verifyDeliveryKey(
  db: Database,
  key: string,
): Promise<"public" | "preview" | null> {
  if (!key) return null;
  const rows = await db
    .select()
    .from(deliveryKey)
    .where(eq(deliveryKey.keyHash, sha256(key)))
    .limit(1);
  const row = rows[0];
  if (!row || row.revokedAt) return null;
  return row.type as "public" | "preview";
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

/** Read the append-only audit log (most-recent first), joined to actor names. */
export async function listAudit(
  db: Database,
  ctx: AccessContext,
  opts: { limit?: number; before?: number } = {},
) {
  requirePermission(ctx, "audit.read");
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const where = opts.before ? sql`${auditLog.id} < ${opts.before}` : undefined;
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
