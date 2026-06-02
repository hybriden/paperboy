import type { FastifyReply, FastifyRequest } from "fastify";
import type { Permission } from "@paperboy/shared";
import { AppError, constantTimeEqual as ctEq } from "@paperboy/db";

/** Require an authenticated session. */
export async function requireAuth(req: FastifyRequest): Promise<void> {
  if (!req.user || !req.accessCtx) {
    throw new AppError(401, "unauthorized", "Authentication required");
  }
}

/** Coarse RBAC verb gate (object-level scope is re-checked in the data layer). */
export function requirePermission(perm: Permission) {
  return async (req: FastifyRequest): Promise<void> => {
    await requireAuth(req);
    if (!req.accessCtx!.permissions.includes(perm)) {
      throw new AppError(403, "forbidden", `Missing permission: ${perm}`);
    }
  };
}

/**
 * CSRF defense for cookie-authenticated mutations: a synchronizer token bound
 * to the server-side session, echoed by the SPA in X-CSRF-Token, plus an
 * Origin/Referer allowlist check. SameSite is defense-in-depth on top.
 */
export async function requireCsrf(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireAuth(req);
  const header = req.headers["x-csrf-token"];
  const token = Array.isArray(header) ? header[0] : header;
  if (!token || !req.sessionCsrf || !ctEq(String(token), req.sessionCsrf)) {
    throw new AppError(403, "csrf_failed", "Invalid or missing CSRF token");
  }
  // Origin/Referer check (independent of the token), FAIL-CLOSED: a
  // state-changing request must carry a matching Origin or Referer. Accepted if
  // it equals the configured CORS origin OR is genuinely same-origin with this
  // request (its host matches the Host header). The same-origin clause lets the
  // SPA work behind any hostname (localhost, LAN IP, a domain) — the admin and
  // API share an origin via the nginx proxy — while still blocking true
  // cross-site requests (their Origin host won't match our Host).
  const allowed = req.server.corsOrigin;
  const host = req.headers.host; // proxied through as the public host (proxy_set_header Host $host)
  const origin = req.headers.origin;
  const referer = req.headers.referer;
  const refererOrigin = referer ? safeOrigin(referer) : null;
  const hostName = host?.split(":")[0]; // tolerate a proxy that dropped the port
  const matches = (o: string | null | undefined): boolean => {
    if (!o) return false;
    if (o === allowed) return true;
    if (!host) return false;
    const oh = safeHost(o);
    return oh === host || (!!oh && oh.split(":")[0] === hostName);
  };
  if (!matches(origin) && !matches(refererOrigin)) {
    throw new AppError(403, "bad_origin", "Missing or disallowed Origin/Referer");
  }
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
