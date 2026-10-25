import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import argon2 from "argon2";
import { and, asc, desc, eq, gte, isNotNull, isNull, like, lte, ne, or, sql } from "drizzle-orm";
import {
  INSTANCE_PERMISSIONS,
  type Permission,
  ROLE_PERMISSIONS,
  RoleName,
  type SessionUser,
} from "@paperboy/shared";
import { nanoid } from "nanoid";
import type { Database } from "./client.js";
import { Errors } from "./errors.js";
import { type AccessContext, requirePermission } from "./scope.js";
import { getSiteById } from "./sites.js";
import { DEFAULT_SITE_ID, auditLog, contentItem, deliveryKey, session, site, userRole, userScope, users } from "./schema.js";
import {
  decryptSecret,
  encryptSecret,
  generateBackupCodes,
  generateSecret,
  hashBackupCode,
  verifyBackupCode,
  matchTotpStep,
  totpUri,
  verifyTotp,
} from "./totp.js";

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

/**
 * Count one failed authentication attempt and lock the account if it crosses the
 * threshold — ATOMICALLY. `failed_attempts = failed_attempts + 1` is evaluated
 * by Postgres under the row lock, so N concurrent wrong guesses advance the
 * counter by N. The previous read-modify-write (`set(user.failedAttempts + 1)`)
 * advanced a concurrent burst by 1, letting it slip the lockout (a botnet, or a
 * single host once X-Forwarded-For was spoofable). The running counter is NOT
 * reset on lock, so each attempt past the threshold renews the 15-minute window
 * rather than handing back a fresh set of tries.
 */
/**
 * Reserve one guess BEFORE checking it: count it and lock the account on the
 * MAX_FAILED-th, in one atomic UPDATE that only matches an unlocked row. A
 * gate that read `locked_until`, checked the guess and only then counted the
 * failure let every request already in flight be checked — a parallel burst
 * got far more than MAX_FAILED guesses. Returns false when the account is
 * locked (the guess must then be refused unchecked). A correct guess resets
 * the counter via clearFailedAuth.
 */
async function reserveAuthAttempt(db: Database, userId: string): Promise<boolean> {
  const reserved = await db
    .update(users)
    .set({
      failedAttempts: sql`${users.failedAttempts} + 1`,
      lockedUntil: sql`case when ${users.failedAttempts} + 1 >= ${MAX_FAILED}
        then now() + (${LOCK_MINUTES} * interval '1 minute') else ${users.lockedUntil} end`,
    })
    .where(and(eq(users.id, userId), or(isNull(users.lockedUntil), lte(users.lockedUntil, sql`now()`))))
    .returning({ id: users.id });
  return reserved.length > 0;
}

async function clearFailedAuth(db: Database, userId: string): Promise<void> {
  await db.update(users).set({ failedAttempts: 0, lockedUntil: null }).where(eq(users.id, userId));
}
// Absolute session lifetime: a login is valid for this long regardless of
// activity. Exported so the api can pin the session COOKIE's Max-Age to the
// same value (a persistent cookie that outlived the server session, or vice
// versa, would surprise-logout the user). The idle window is set to match, so
// inactivity alone never logs you out before the absolute cap is reached.
export const SESSION_ABSOLUTE_HOURS = 24 * 30; // 30 days
const SESSION_IDLE_MINUTES = 60 * 24 * 30; // 30 days
const SESSION_SLIDE_STEP_MS = 60_000; // readSession moves the idle window at most once a minute

/** Argon2id parameters (OWASP-recommended baseline). */
const ARGON2_OPTS: argon2.HashOptions = {
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
    siteRoles?: Array<{ siteId: string; role: RoleName }>;
  },
): Promise<string> {
  const id = nanoid(16);
  const passwordHash = await argon2.hash(input.password, ARGON2_OPTS);
  await db.insert(users).values({ id, email: input.email, name: input.name, passwordHash });
  for (const role of input.roles) {
    await db.insert(userRole).values({ userId: id, role }).onConflictDoNothing();
  }
  for (const g of input.siteRoles ?? []) {
    await db.insert(userRole).values({ userId: id, role: g.role, siteId: g.siteId }).onConflictDoNothing();
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
  if (!(await reserveAuthAttempt(db, user.id))) {
    // SECURITY: do not reveal lock state (enumeration); spend time to match the
    // verify path, then return the SAME generic error as a wrong password.
    await argon2.verify(user.passwordHash, password).catch(() => false);
    throw generic;
  }

  const ok = await argon2.verify(user.passwordHash, password).catch(() => false);
  if (!ok) throw generic; // already counted by the reservation

  await clearFailedAuth(db, user.id);
  return user.id;
}

/* ---------------------- user administration (Admin) ----------------------- */

export interface ManagedUser {
  id: string;
  email: string;
  name: string;
  /** Roles held in EVERY site. */
  roles: RoleName[];
  /** Roles held in one site each (#130). */
  siteRoles: Array<{ siteId: string; role: RoleName }>;
  sections: string[];
  locked: boolean;
  createdAt: string;
}

/**
 * How far the caller's user administration reaches: an every-site Admin
 * (user.manage) manages every user; a one-site Admin (siteuser.manage) only the
 * roles and sections users hold in the ACTIVE site. Throws for anyone else.
 */
function userAdminReach(ctx: AccessContext): "instance" | "site" {
  if (ctx.permissions.includes("user.manage")) return "instance";
  requirePermission(ctx, "siteuser.manage");
  return "site";
}

const everySiteAdmins = (db: Database) =>
  db.select().from(userRole).where(and(eq(userRole.role, "Admin"), isNull(userRole.siteId)));

async function assertSitesExist(db: Database, siteIds: string[]): Promise<void> {
  for (const id of new Set(siteIds)) {
    if (!(await getSiteById(db, id))) throw Errors.badRequest(`Unknown site '${id}' in siteRoles — use a site id from GET /manage/sites`);
  }
}

/** A one-site Admin may only scope users to sections of their own site. */
async function assertSectionsInSite(db: Database, siteId: string, sections: string[] | undefined): Promise<void> {
  for (const sectionId of sections ?? []) {
    if ((await sectionSiteId(db, sectionId)) !== siteId) throw Errors.badRequest(`Section '${sectionId}' is not in this site`);
  }
}

export async function listUsers(db: Database, ctx: AccessContext): Promise<ManagedUser[]> {
  const reach = userAdminReach(ctx);
  const rows = await db.select().from(users).orderBy(asc(users.createdAt));
  const roleRows = await db.select().from(userRole);
  const scopeRows = await db.select().from(userScope);
  const now = new Date();
  // A one-site Admin sees the users who hold a role in this site, and only
  // what they hold here (plus their every-site roles, which they can't edit).
  const shown = (siteId: string | null) => reach === "instance" || siteId === ctx.siteId;
  const visible = reach === "instance" ? rows : rows.filter((u) => roleRows.some((r) => r.userId === u.id && r.siteId === ctx.siteId));
  return visible.map((u) => {
    const mine = roleRows.filter((r) => r.userId === u.id);
    return {
      id: u.id,
      email: u.email,
      name: u.name,
      roles: mine.filter((r) => r.siteId === null).map((r) => r.role as RoleName),
      siteRoles: mine.filter((r) => r.siteId !== null && shown(r.siteId)).map((r) => ({ siteId: r.siteId!, role: r.role as RoleName })),
      sections: scopeRows.filter((s) => s.userId === u.id && shown(s.siteId)).map((s) => s.sectionId),
      locked: Boolean(u.lockedUntil && u.lockedUntil > now),
      createdAt: u.createdAt.toISOString(),
    };
  });
}

/**
 * Create a user. An every-site Admin sets every-site `roles` and/or one-site
 * `siteRoles`. A one-site Admin's `roles` apply in the active site only; given
 * an email that already has an account (and no password) it ADDS that user to
 * this site instead — it never touches the account itself.
 */
export async function adminCreateUser(
  db: Database,
  ctx: AccessContext,
  input: { email: string; name: string; password?: string; roles: RoleName[]; sections?: string[]; siteRoles?: Array<{ siteId: string; role: RoleName }> },
): Promise<string> {
  const reach = userAdminReach(ctx);
  for (const r of input.roles) RoleName.parse(r);
  const existing = (await db.select({ id: users.id }).from(users).where(eq(users.email, input.email)).limit(1))[0];
  if (reach === "site") {
    if (input.siteRoles?.length) throw Errors.forbidden("A site Admin grants roles in this site only — send them as roles");
    await assertSectionsInSite(db, ctx.siteId, input.sections);
    if (existing) {
      if (input.password) throw Errors.conflict("That email already has an account. Leave the password empty to add them to this site.");
      for (const role of input.roles) await db.insert(userRole).values({ userId: existing.id, role, siteId: ctx.siteId }).onConflictDoNothing();
      for (const sectionId of input.sections ?? []) await db.insert(userScope).values({ userId: existing.id, sectionId, siteId: ctx.siteId }).onConflictDoNothing();
      return existing.id;
    }
  }
  if (!input.password || input.password.length < 10) throw Errors.badRequest("Password must be at least 10 characters");
  if (existing) throw Errors.conflict("A user with that email already exists");
  if (reach === "site") {
    return createUser(db, { ...input, password: input.password, roles: [], siteRoles: input.roles.map((role) => ({ siteId: ctx.siteId, role })) });
  }
  for (const g of input.siteRoles ?? []) RoleName.parse(g.role);
  await assertSitesExist(db, (input.siteRoles ?? []).map((g) => g.siteId));
  return createUser(db, { ...input, password: input.password });
}

/**
 * Update a user's profile (name/email), roles and section scopes. `roles`
 * replaces the every-site roles, `siteRoles` the one-site ones. A one-site
 * Admin changes only the roles and sections the user holds in the active site
 * (removing every role there takes them out of the site); never the account.
 */
export async function adminUpdateUser(
  db: Database,
  ctx: AccessContext,
  userId: string,
  input: { name?: string; email?: string; roles?: RoleName[]; sections?: string[]; siteRoles?: Array<{ siteId: string; role: RoleName }> },
): Promise<void> {
  const reach = userAdminReach(ctx);
  const target = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const current = target[0];
  if (!current) throw Errors.notFound("User");
  if (input.roles) for (const r of input.roles) RoleName.parse(r);
  if (reach === "site") return updateSiteMember(db, ctx, current, input);
  for (const g of input.siteRoles ?? []) RoleName.parse(g.role);
  if (input.siteRoles) await assertSitesExist(db, input.siteRoles.map((g) => g.siteId));

  // Email is the login identity — keep it unique. Sessions are keyed by
  // userId, so the user's existing sessions survive the change.
  const email = input.email?.trim();
  const emailChanged = !!email && email !== current.email;
  if (emailChanged) {
    const taken = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (taken[0]) throw Errors.conflict("That email is already in use");
  }

  // Guard: never strip the last every-site Admin (avoid locking everyone out
  // of the instance — a one-site Admin can't manage users, sites or keys).
  if (input.roles && !input.roles.includes("Admin")) {
    const admins = await everySiteAdmins(db);
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
      await tx.delete(userRole).where(and(eq(userRole.userId, userId), isNull(userRole.siteId)));
      for (const role of input.roles) await tx.insert(userRole).values({ userId, role }).onConflictDoNothing();
    }
    if (input.siteRoles) {
      await tx.delete(userRole).where(and(eq(userRole.userId, userId), isNotNull(userRole.siteId)));
      for (const g of input.siteRoles) await tx.insert(userRole).values({ userId, role: g.role, siteId: g.siteId }).onConflictDoNothing();
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

/** A one-site Admin's edit: this site's roles and sections, nothing else. */
async function updateSiteMember(
  db: Database,
  ctx: AccessContext,
  current: typeof users.$inferSelect,
  input: { name?: string; email?: string; roles?: RoleName[]; sections?: string[]; siteRoles?: unknown[] },
): Promise<void> {
  // An unchanged name/email (the edit form sends them back) is not a change.
  const touchesAccount = (input.name !== undefined && input.name !== current.name) || (input.email !== undefined && input.email.trim() !== current.email);
  if (touchesAccount || input.siteRoles) {
    throw Errors.forbidden("A site Admin can only change the roles and sections a user holds in this site — ask an every-site Admin to change the account");
  }
  const userId = current.id;
  const member = await db.select().from(userRole).where(and(eq(userRole.userId, userId), eq(userRole.siteId, ctx.siteId))).limit(1);
  if (!member[0]) throw Errors.notFound("User");
  await assertSectionsInSite(db, ctx.siteId, input.sections);
  await db.transaction(async (tx) => {
    if (input.roles) {
      await tx.delete(userRole).where(and(eq(userRole.userId, userId), eq(userRole.siteId, ctx.siteId)));
      for (const role of input.roles) await tx.insert(userRole).values({ userId, role, siteId: ctx.siteId }).onConflictDoNothing();
    }
    if (input.sections) {
      await tx.delete(userScope).where(and(eq(userScope.userId, userId), eq(userScope.siteId, ctx.siteId)));
      for (const sectionId of input.sections) await tx.insert(userScope).values({ userId, sectionId, siteId: ctx.siteId }).onConflictDoNothing();
    }
  });
}

export async function adminDeleteUser(db: Database, ctx: AccessContext, userId: string): Promise<void> {
  requirePermission(ctx, "user.manage");
  if (userId === ctx.userId) throw Errors.conflict("You cannot delete your own account");
  const admins = await everySiteAdmins(db);
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

/**
 * Re-verify the account password for a sensitive action (change-password,
 * enable/disable-2FA) WITH the same per-account lockout as
 * login (S3-L3) — otherwise a session holder could brute-force the password on
 * these unguarded reauth paths. Throws a generic unauthorized on any failure
 * (locked, wrong, or unknown).
 */
export async function verifyReauth(db: Database, userId: string, password: string): Promise<void> {
  const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const user = rows[0];
  const generic = Errors.unauthorized("Current password is incorrect");
  if (!user) throw generic;
  if (!(await reserveAuthAttempt(db, user.id))) {
    await argon2.verify(user.passwordHash, password).catch(() => false); // match the verify path's timing
    throw generic;
  }
  const ok = await argon2.verify(user.passwordHash, password).catch(() => false);
  if (!ok) throw generic; // already counted by the reservation
  await clearFailedAuth(db, user.id);
}

/** Self-service password change: verify the current password, then re-hash. */
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

/**
 * Everything a user's access is computed from, read in ONE parallel round trip
 * (it runs on every admin request; one query after another it was ~10 round
 * trips before the route did any work): all their roles and section scopes,
 * and the sites in their stable order.
 */
interface Grants {
  roleRows: Array<{ role: string; siteId: string | null }>;
  scopeRows: Array<{ sectionId: string; siteId: string }>;
  siteIds: string[];
}
async function loadGrants(db: Database, userId: string): Promise<Grants> {
  const [roleRows, scopeRows, sites] = await Promise.all([
    db.select({ role: userRole.role, siteId: userRole.siteId }).from(userRole).where(eq(userRole.userId, userId)),
    db.select({ sectionId: userScope.sectionId, siteId: userScope.siteId }).from(userScope).where(eq(userScope.userId, userId)),
    db.select({ id: site.id }).from(site).orderBy(asc(site.createdAt), asc(site.slug)),
  ]);
  return { roleRows, scopeRows, siteIds: sites.map((r) => r.id) };
}

/** The sites a user can open (same rule as userSiteIds in sites.ts). */
function openSitesOf(g: Grants): string[] | "all" {
  if (g.roleRows.some((r) => r.siteId === null)) return "all";
  const held = new Set(g.roleRows.map((r) => r.siteId));
  return g.siteIds.filter((id) => held.has(id));
}

/** The roles a user holds in `siteId`: their every-site roles plus that site's own. */
function rolesIn(g: Grants, siteId: string): Array<{ role: RoleName; everySite: boolean }> {
  return g.roleRows.filter((r) => r.siteId === null || r.siteId === siteId).map((r) => ({ role: r.role as RoleName, everySite: r.siteId === null }));
}

/** Where a request with no site choice lands: the Default site, unless the
 *  user only holds roles in other sites — then the first of those. */
function homeSiteId(g: Grants): string {
  const ids = openSitesOf(g);
  if (ids !== "all" && ids.length > 0 && !ids.includes(DEFAULT_SITE_ID)) return ids[0]!;
  if (!g.siteIds.includes(DEFAULT_SITE_ID)) throw Errors.notFound("Default site"); // 0012 guarantees it exists
  return DEFAULT_SITE_ID;
}

export async function getAccessContext(
  db: Database,
  userId: string,
  activeSiteId?: string,
): Promise<AccessContext> {
  return accessContextFrom(userId, await loadGrants(db, userId), activeSiteId);
}

function accessContextFrom(userId: string, g: Grants, activeSiteId?: string): AccessContext {
  // The active site: an explicit choice (admin site switcher, Phase 3) or the
  // user's home site. Roles and section scopes both depend on it.
  const siteId = activeSiteId ?? homeSiteId(g);
  const grants = rolesIn(g, siteId);
  const roles = grants.map((g) => g.role);
  const permissions = new Set<Permission>();
  for (const g of grants) {
    for (const p of ROLE_PERMISSIONS[g.role] ?? []) {
      // A one-site role never reaches what every site shares (#130).
      if (g.everySite || !INSTANCE_PERMISSIONS.includes(p)) permissions.add(p);
    }
  }
  // Site-wide WRITE is Admin/Editor only; a Viewer's site-wide reach is READ.
  // Splitting these is what stops `[Author, Viewer]` from becoming a site-wide
  // writer — see AccessContext.siteWide. Author alone is section-scoped for both.
  const siteWide = roles.some((r) => r === "Admin" || r === "Editor");
  const readSiteWide = siteWide || roles.includes("Viewer");
  return {
    userId,
    permissions: [...permissions],
    siteId,
    siteWide,
    readSiteWide,
    sections: g.scopeRows.filter((s) => s.siteId === siteId).map((s) => s.sectionId),
  };
}

async function loadUser(db: Database, userId: string) {
  const rows = await db.select({ id: users.id, email: users.email, name: users.name, totpEnabled: users.totpEnabled }).from(users).where(eq(users.id, userId)).limit(1);
  if (!rows[0]) throw Errors.unauthorized();
  return rows[0];
}
function sessionUserFrom(user: Awaited<ReturnType<typeof loadUser>>, g: Grants, ctx: AccessContext): SessionUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    roles: [...new Set(rolesIn(g, ctx.siteId).map((r) => r.role))],
    permissions: ctx.permissions,
    mfaEnabled: user.totpEnabled,
  };
}

/** The signed-in user as the admin sees them: roles and permissions IN the active site. */
export async function getSessionUser(db: Database, userId: string, activeSiteId?: string): Promise<SessionUser> {
  const [user, g] = await Promise.all([loadUser(db, userId), loadGrants(db, userId)]);
  return sessionUserFrom(user, g, accessContextFrom(userId, g, activeSiteId));
}

/**
 * A browser request's whole auth state, in two round trips: the session
 * (checked and slid in one statement), then the user and their grants at once.
 * `siteHeader` (the admin's site switcher) is honoured only for a site that
 * exists AND that the user can open; otherwise the request lands on their home
 * site. Same rules as readSession + getSessionUser + getAccessContext.
 */
export async function resolveSessionRequest(
  db: Database,
  token: string,
  siteHeader: string | undefined,
): Promise<{ userId: string; csrfToken: string; user: SessionUser; accessCtx: AccessContext } | null> {
  const sess = await readSession(db, token);
  if (!sess) return null;
  const [user, g] = await Promise.all([loadUser(db, sess.userId), loadGrants(db, sess.userId)]);
  const open = openSitesOf(g);
  const activeSiteId = siteHeader && g.siteIds.includes(siteHeader) && (open === "all" || open.includes(siteHeader)) ? siteHeader : undefined;
  const accessCtx = accessContextFrom(sess.userId, g, activeSiteId);
  return { ...sess, user: sessionUserFrom(user, g, accessCtx), accessCtx };
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
  await db.update(users).set({ totpSecret: encryptSecret(secret, "totp"), totpEnabled: false }).where(eq(users.id, userId));
  return { secret, uri: totpUri(secret, user.email) };
}

/** Evict the user's sessions on a security-posture change. Keeps the current
 *  request's session (keepToken) so the actor isn't logged out mid-action; all
 *  OTHER sessions are dropped so a held/hijacked session can't outlive the change. */
async function evictOtherSessions(db: Database, userId: string, keepToken?: string | null): Promise<void> {
  if (keepToken) {
    await db.delete(session).where(and(eq(session.userId, userId), ne(session.id, sha256(keepToken))));
  } else {
    await db.delete(session).where(eq(session.userId, userId));
  }
}

/**
 * Confirm enrollment with a code → enable 2FA and issue one-time backup codes.
 *
 * Requires the account PASSWORD, exactly like disableTotp. Without it a stolen
 * session could enrol the attacker's own authenticator, and the evictOtherSessions
 * below would then sign the real owner out — permanently, because a 2FA account
 * logs in passwordlessly (email → code), so the owner's password no longer reaches
 * any login path and /2fa/disable needs a session they can't obtain.
 */
export async function enableTotp(db: Database, userId: string, code: string, password: string, keepSessionToken?: string | null): Promise<{ backupCodes: string[] }> {
  await verifyReauth(db, userId, password); // same per-account lockout as login (S3-L3)
  const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const user = rows[0];
  if (!user?.totpSecret) throw Errors.badRequest("Start 2FA setup first");
  if (!verifyTotp(decryptSecret(user.totpSecret, "totp"), code)) throw Errors.unauthorized("Invalid code");
  const codes = generateBackupCodes();
  const hashed = await Promise.all(codes.map(hashBackupCode));
  await db.update(users).set({ totpEnabled: true, backupCodes: hashed }).where(eq(users.id, userId));
  // Turning 2FA on is a posture change — evict the user's other sessions (S2-L1).
  await evictOtherSessions(db, userId, keepSessionToken);
  return { backupCodes: codes };
}

/** Disable 2FA (requires the account password — a re-auth gate). */
export async function disableTotp(db: Database, userId: string, password: string, keepSessionToken?: string | null): Promise<void> {
  await verifyReauth(db, userId, password); // same per-account lockout as login (S3-L3)
  await db.update(users).set({ totpSecret: null, totpEnabled: false, backupCodes: null }).where(eq(users.id, userId));
  await evictOtherSessions(db, userId, keepSessionToken); // posture change → drop other sessions (S2-L1)
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
  // The reservation counts this guess up front, so a parallel burst can't
  // outrun the lockout.
  if (!(await reserveAuthAttempt(db, userId))) return false;

  const clearLock = { failedAttempts: 0, lockedUntil: null as Date | null };
  const step = matchTotpStep(decryptSecret(user.totpSecret, "totp"), code);
  if (step !== null) {
    // Replay of an already-consumed (or older) step — refused, and counted like
    // any other failed attempt (one double-submit is far below the lock threshold).
    if (user.lastTotpStep != null && step <= user.lastTotpStep) return false;
    await db.update(users).set({ ...clearLock, lastTotpStep: step }).where(eq(users.id, userId));
    return true;
  }
  // Fall back to a backup code (one-time): match its hash, then remove it.
  const hashes = Array.isArray(user.backupCodes) ? (user.backupCodes as string[]) : [];
  const used = await verifyBackupCode(code, hashes);
  if (used) {
    await db.update(users).set({ ...clearLock, backupCodes: hashes.filter((h) => h !== used) }).where(eq(users.id, userId));
    return true;
  }
  // Wrong code: already counted toward the per-account lockout by the reservation.
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
  const now = new Date();
  const slid = new Date(now.getTime() + SESSION_IDLE_MINUTES * 60_000);
  // Check the session and slide its idle window in ONE statement (this runs on
  // every admin request). The window only moves when it is more than a minute
  // behind: a write is a durable commit, and against a 30-day window a minute
  // is invisible, so most requests write (and wait for) nothing.
  const rows = (await db.execute(sql`
    WITH live AS (
      SELECT user_id, csrf_token FROM session
      WHERE id = ${id} AND expires_at >= ${now.toISOString()}::timestamptz AND idle_expires_at >= ${now.toISOString()}::timestamptz
    ), slide AS (
      UPDATE session SET idle_expires_at = ${slid.toISOString()}::timestamptz
      WHERE id = ${id} AND idle_expires_at < ${new Date(slid.getTime() - SESSION_SLIDE_STEP_MS).toISOString()}::timestamptz AND EXISTS (SELECT 1 FROM live)
    )
    SELECT user_id, csrf_token FROM live`)) as unknown as Array<{ user_id: string; csrf_token: string }>;
  if (rows[0]) return { userId: rows[0].user_id, csrfToken: rows[0].csrf_token };
  // Missing or expired: an expired row is removed (a no-op for a missing one).
  await db.delete(session).where(eq(session.id, id));
  return null;
}

export async function destroySession(db: Database, token: string): Promise<void> {
  await db.delete(session).where(eq(session.id, sha256(token)));
}

/* ------------------------------ delivery keys ----------------------------- */

export async function createDeliveryKey(
  db: Database,
  ctx: AccessContext,
  name: string,
  type: "public" | "preview",
): Promise<{ key: string }> {
  requirePermission(ctx, "deliverykey.manage");
  const prefix = type === "public" ? "pk_live_" : "prv_";
  const secret = randomBytes(32).toString("base64url"); // 256-bit
  const key = `${prefix}${secret}`;
  // D1: the key belongs to the active site — it will only ever see that site.
  await db.insert(deliveryKey).values({ name, keyHash: sha256(key), keyPrefix: prefix, type, siteId: ctx.siteId });
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
  const resolved = await verifyDeliveryKeyWithEpoch(db, key);
  return resolved && { type: resolved.type, siteId: resolved.siteId };
}

/** verifyDeliveryKey plus the delivery epoch (webhooks.ts) in the SAME round
 *  trip: the delivery response cache needs both on every request, and a hit
 *  then costs one query. */
export async function verifyDeliveryKeyWithEpoch(
  db: Database,
  key: string,
): Promise<{ type: "public" | "preview"; siteId: string; epoch: string } | null> {
  if (!key) return null;
  const rows = await db
    .select({
      type: deliveryKey.type,
      siteId: deliveryKey.siteId,
      revokedAt: deliveryKey.revokedAt,
      epoch: sql<string>`(SELECT last_value FROM delivery_epoch)::text`,
    })
    .from(deliveryKey)
    .where(eq(deliveryKey.keyHash, sha256(key)))
    .limit(1);
  const row = rows[0];
  if (!row || row.revokedAt) return null;
  return { type: row.type as "public" | "preview", siteId: row.siteId, epoch: row.epoch };
}

/**
 * Delete sessions past their absolute expiry. readSession removes an expired row
 * only when its cookie is presented again, so sessions that simply stop being
 * used would otherwise accumulate forever. Swept hourly with the other retention jobs.
 */
export async function runSessionRetention(db: Database, now: Date = new Date()): Promise<{ deleted: number }> {
  const res = await db.delete(session).where(lte(session.expiresAt, now)).returning({ id: session.id });
  return { deleted: res.length };
}

/* --------------------------------- audit ---------------------------------- */

/**
 * Prune audit rows older than `days`. days<=0 keeps everything (the default —
 * audit_log is a compliance trail, pruned only on an explicit opt-in). Swept on
 * the same hourly timer as submission retention.
 */
export async function runAuditRetention(db: Database, days: number, now: Date = new Date()): Promise<{ deleted: number }> {
  if (!days || days <= 0) return { deleted: 0 };
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  const res = await db.delete(auditLog).where(lte(auditLog.ts, cutoff)).returning({ id: auditLog.id });
  return { deleted: res.length };
}

/**
 * Actions over what every site shares. They are filed under no site, so a
 * one-site Admin's log never shows sign-ins, tokens or the shared model.
 * (user.* is filed by its route: under the site only when a site Admin acts.)
 */
const INSTANCE_ACTIONS = /^(auth|contenttype|type_template|locale|mcptoken|mcp\.oauth)\.|^site\.(create|rename|delete|ai_config|stock_config|agent_review)$/;

export async function audit(
  db: Database,
  entry: {
    /** The site it happened in (the request's active site); dropped for INSTANCE_ACTIONS. */
    siteId?: string | null;
    actorUserId?: string | null;
    action: string;
    documentId?: string | null;
    locale?: string | null;
    ip?: string | null;
    detail?: unknown;
  },
): Promise<void> {
  await db.insert(auditLog).values({
    siteId: INSTANCE_ACTIONS.test(entry.action) ? null : (entry.siteId ?? null),
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
  // A one-site Admin reads their own site's log; instance rows stay hidden.
  if (!ctx.permissions.includes("user.manage")) conds.push(eq(auditLog.siteId, ctx.siteId));
  if (opts.before) conds.push(sql`${auditLog.id} < ${opts.before}`);
    // Prefix match so "content." selects the whole category; exact actions work
    // too. LIKE wildcards in the input are escaped, not interpreted (stripping
    // `_` was a bug: actions like "type_template.create" became unfilterable).
    if (opts.action) conds.push(like(auditLog.action, `${opts.action.replace(/[\\%_]/g, (c) => `\\${c}`)}%`));
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
