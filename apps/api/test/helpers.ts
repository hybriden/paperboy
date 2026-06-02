import { type SeedResult, seed } from "@paperboy/db";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadEnv } from "../src/env.js";

export const TEST_DB =
  process.env.TEST_DATABASE_URL ??
  "postgresql://paperboy:paperboy@localhost:5433/paperboy_test";

export const PUBLIC_KEY = "pk_live_test_public";
export const PREVIEW_KEY = "prv_test_preview";
export const ORIGIN = "http://localhost:8090";

export interface Suite {
  app: FastifyInstance;
  ids: SeedResult;
}

/** Fresh migrate+seed + a ready Fastify app. Call in beforeAll. */
export async function setupApi(): Promise<Suite> {
  process.env.DATABASE_URL = TEST_DB;
  process.env.SEED_ADMIN_EMAIL = "admin@paperboy.test";
  process.env.SEED_ADMIN_PASSWORD = "Admin!Passw0rd";
  process.env.PAPERBOY_PUBLIC_KEY = PUBLIC_KEY;
  process.env.PAPERBOY_PREVIEW_KEY = PREVIEW_KEY;
  const ids = await seed(TEST_DB);
  const env = loadEnv({
    DATABASE_URL: TEST_DB,
    NODE_ENV: "test",
    CORS_ORIGIN: ORIGIN,
    COOKIE_SECURE: "false",
    MEDIA_PUBLIC_BASE: "http://localhost:8091",
    UPLOADS_DIR: `${process.env.TMPDIR ?? "/tmp"}/paperboy-uploads-test`,
  });
  const app = await buildApp({ env });
  await app.ready();
  return { app, ids };
}

export interface AuthCtx {
  cookie: string;
  csrf: string;
}

/** Log in and return the session cookie + CSRF token for authed requests. */
export async function login(
  app: FastifyInstance,
  email: string,
  password: string,
): Promise<AuthCtx> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, password },
  });
  if (res.statusCode !== 200) {
    throw new Error(`login failed (${res.statusCode}): ${res.body}`);
  }
  const setCookie = res.cookies.find((c) => c.name.includes("paperboy_sid"));
  if (!setCookie) throw new Error("no session cookie set");
  const body = res.json() as { csrfToken: string };
  return { cookie: `${setCookie.name}=${setCookie.value}`, csrf: body.csrfToken };
}

/** Headers for an authenticated, CSRF-protected mutation. */
export function authHeaders(ctx: AuthCtx): Record<string, string> {
  return { cookie: ctx.cookie, "x-csrf-token": ctx.csrf, origin: ORIGIN };
}
