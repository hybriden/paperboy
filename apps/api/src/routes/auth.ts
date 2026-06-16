import { createHmac, timingSafeEqual } from "node:crypto";
import {
  audit,
  beginTotpSetup,
  changePassword,
  createSession,
  destroySession,
  disableTotp,
  enableTotp,
  findLoginMethod,
  getMfaStatus,
  getSessionUser,
  SESSION_ABSOLUTE_HOURS,
  verifyLogin,
  verifySecondFactor,
} from "@paperboy/db";
import { AppError } from "@paperboy/db";
import { LoginRequest, SessionUser } from "@paperboy/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAuth, requireCsrf } from "../security.js";

const MeResponse = z.object({ user: SessionUser, csrfToken: z.string() });
const MfaChallenge = z.object({ mfaRequired: z.literal(true), mfaToken: z.string() });
const PasswordRequired = z.object({ passwordRequired: z.literal(true) });
const LoginResponse = z.union([MeResponse, MfaChallenge, PasswordRequired]);

export async function registerAuthRoutes(appBase: FastifyInstance): Promise<void> {
  const app = appBase.withTypeProvider<ZodTypeProvider>();

  const cookieOpts = () => ({ httpOnly: true, secure: app.cookieSecure, sameSite: "lax" as const, path: "/" });
  // Persist the session cookie across browser restarts, pinned to the server-side
  // absolute lifetime so the two expire together. Applied to the login cookie only —
  // clearCookie (logout) must not carry a Max-Age or it would re-set, not clear.
  const SESSION_COOKIE_MAX_AGE = SESSION_ABSOLUTE_HOURS * 3600; // seconds

  /** Short-lived signed token proving the password step passed (5 min). Stateless. */
  function signMfaToken(userId: string): string {
    const exp = Date.now() + 5 * 60_000;
    // base64url-encode the userId so the "." field separator stays unambiguous
    // even if an id ever contains a dot (today's nanoid ids don't, but the token
    // format must not silently depend on that). The signature covers this exact
    // encoded body, and verify re-signs the same components — they can't drift.
    const body = `${Buffer.from(userId, "utf8").toString("base64url")}.${exp}`;
    const sig = createHmac("sha256", app.sessionSecret).update(`mfa.${body}`).digest("base64url");
    return `${body}.${sig}`;
  }
  function verifyMfaToken(token: string): string | null {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [encodedId, expStr, sig] = parts;
    const expected = createHmac("sha256", app.sessionSecret).update(`mfa.${encodedId}.${expStr}`).digest("base64url");
    if (sig!.length !== expected.length || !timingSafeEqual(Buffer.from(sig!), Buffer.from(expected))) return null;
    if (Number(expStr) < Date.now()) return null;
    return Buffer.from(encodedId!, "base64url").toString("utf8");
  }

  async function issueSession(userId: string, reply: import("fastify").FastifyReply, ip?: string) {
    const { token, csrfToken } = await createSession(app.db, userId);
    reply.setCookie(app.cookieName, token, { ...cookieOpts(), maxAge: SESSION_COOKIE_MAX_AGE });
    await audit(app.db, { actorUserId: userId, action: "auth.login", ip });
    return { user: await getSessionUser(app.db, userId), csrfToken };
  }

  app.post(
    "/login",
    { config: { rateLimit: { max: app.loginRateMax, timeWindow: "1 minute" } }, schema: { tags: ["auth"], body: LoginRequest, response: { 200: LoginResponse } } },
    async (req, reply) => {
      const { email, password } = req.body;
      // Email-first. A 2FA-enabled account logs in PASSWORDLESS: skip the password
      // entirely and go straight to the TOTP challenge (email + TOTP). The TOTP
      // device is the single factor — the password is not part of this path.
      const method = await findLoginMethod(app.db, email);
      if (method?.totpEnabled) {
        return { mfaRequired: true as const, mfaToken: signMfaToken(method.userId) };
      }
      // Non-2FA accounts (and unknown emails) authenticate with email + password.
      if (!password) {
        return { passwordRequired: true as const };
      }
      const userId = await verifyLogin(app.db, email, password);
      // Defence-in-depth: if 2FA got enabled between the lookup and here, challenge.
      if ((await getMfaStatus(app.db, userId)).enabled) {
        return { mfaRequired: true as const, mfaToken: signMfaToken(userId) };
      }
      return issueSession(userId, reply, req.ip);
    },
  );

  app.post(
    "/login/mfa",
    { config: { rateLimit: { max: app.loginRateMax, timeWindow: "1 minute" } }, schema: { tags: ["auth"], body: z.object({ mfaToken: z.string(), code: z.string().min(6).max(20) }), response: { 200: MeResponse } } },
    async (req, reply) => {
      const userId = verifyMfaToken(req.body.mfaToken);
      if (!userId) throw new AppError(401, "unauthorized", "Session expired — sign in again");
      if (!(await verifySecondFactor(app.db, userId, req.body.code))) {
        await audit(app.db, { actorUserId: userId, action: "auth.mfa_failed", ip: req.ip });
        throw new AppError(401, "unauthorized", "Invalid authentication code");
      }
      return issueSession(userId, reply, req.ip);
    },
  );

  app.post(
    "/logout",
    { preHandler: requireAuth, schema: { tags: ["auth"], response: { 200: z.object({ ok: z.boolean() }) } } },
    async (req, reply) => {
      if (req.sessionToken) await destroySession(app.db, req.sessionToken);
      reply.clearCookie(app.cookieName, cookieOpts());
      await audit(app.db, { actorUserId: req.user?.id, action: "auth.logout", ip: req.ip });
      return { ok: true };
    },
  );

  app.get(
    "/me",
    { preHandler: requireAuth, schema: { tags: ["auth"], response: { 200: MeResponse } } },
    async (req) => ({ user: req.user!, csrfToken: req.sessionCsrf! }),
  );

  app.post(
    "/change-password",
    { preHandler: requireCsrf, schema: { tags: ["auth"], body: z.object({ oldPassword: z.string().min(1).max(200), newPassword: z.string().min(10).max(200) }), response: { 200: z.object({ ok: z.boolean() }) } } },
    async (req, reply) => {
      await changePassword(app.db, req.user!.id, req.body.oldPassword, req.body.newPassword);
      await audit(app.db, { actorUserId: req.user!.id, action: "auth.change_password", ip: req.ip });
      reply.clearCookie(app.cookieName, cookieOpts());
      return { ok: true };
    },
  );

  /* ----------------------------- two-factor ----------------------------- */
  app.get(
    "/2fa/status",
    { preHandler: requireAuth, schema: { tags: ["auth"], response: { 200: z.object({ enabled: z.boolean(), backupCodesRemaining: z.number() }) } } },
    async (req) => getMfaStatus(app.db, req.user!.id),
  );
  app.post(
    "/2fa/setup",
    { preHandler: requireCsrf, schema: { tags: ["auth"], response: { 200: z.object({ secret: z.string(), uri: z.string() }) } } },
    async (req) => beginTotpSetup(app.db, req.user!.id),
  );
  app.post(
    "/2fa/enable",
    { preHandler: requireCsrf, schema: { tags: ["auth"], body: z.object({ code: z.string().min(6).max(8) }), response: { 200: z.object({ backupCodes: z.array(z.string()) }) } } },
    async (req) => {
      const r = await enableTotp(app.db, req.user!.id, req.body.code);
      await audit(app.db, { actorUserId: req.user!.id, action: "auth.2fa_enabled", ip: req.ip });
      return r;
    },
  );
  app.post(
    "/2fa/disable",
    { preHandler: requireCsrf, schema: { tags: ["auth"], body: z.object({ password: z.string().min(1).max(200) }), response: { 200: z.object({ ok: z.boolean() }) } } },
    async (req) => {
      await disableTotp(app.db, req.user!.id, req.body.password);
      await audit(app.db, { actorUserId: req.user!.id, action: "auth.2fa_disabled", ip: req.ip });
      return { ok: true };
    },
  );
}
