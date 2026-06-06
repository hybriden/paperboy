import { mkdirSync } from "node:fs";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import swagger from "@fastify/swagger";
import swaggerUI from "@fastify/swagger-ui";
import { AppError, createDb, getAccessContext, getSessionUser, readSession, runScheduledPublish } from "@paperboy/db";
import Fastify, { type FastifyInstance } from "fastify";
import {
  type ZodTypeProvider,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { ZodError } from "zod";
import type { Env } from "./env.js";
import { registerAiRoutes } from "./routes/ai.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerDeliveryRoutes } from "./routes/delivery.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerMediaRoutes } from "./routes/media.js";
import { registerManageRoutes } from "./routes/manage.js";
import "./types.js";

export interface BuildOptions {
  env: Env;
  /** Inject a db (tests); otherwise created from env.DATABASE_URL. */
  db?: FastifyInstance["db"];
}

export async function buildApp(opts: BuildOptions): Promise<FastifyInstance> {
  const { env } = opts;
  const app = Fastify({
    logger: env.NODE_ENV === "test" ? false : { level: "info" },
    trustProxy: true,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const db = opts.db ?? createDb(env.DATABASE_URL).db;
  app.decorate("db", db);
  app.decorate("cookieSecure", env.COOKIE_SECURE);
  app.decorate("cookieName", env.COOKIE_SECURE ? "__Host-paperboy_sid" : "paperboy_sid");
  app.decorate("corsOrigin", env.CORS_ORIGIN);
  app.decorate("sessionSecret", env.SESSION_SECRET);
  // Brute-force limit on login; relaxed under test so multi-login specs aren't flaky.
  app.decorate("loginRateMax", env.NODE_ENV === "test" ? 100_000 : env.LOGIN_RATE_MAX);

  // Media uploads: ensure the dir exists and expose config to the db helper + routes.
  mkdirSync(env.UPLOADS_DIR, { recursive: true });
  process.env.MEDIA_PUBLIC_BASE = env.MEDIA_PUBLIC_BASE;
  app.decorate("uploadsDir", env.UPLOADS_DIR);
  app.decorate("aiConfig", { apiKey: env.ANTHROPIC_API_KEY, model: env.AI_MODEL });
  app.decorate("stockConfig", { unsplashKey: env.UNSPLASH_ACCESS_KEY });

  await app.register(cookie, { secret: env.SESSION_SECRET });
  await app.register(cors, { origin: env.CORS_ORIGIN, credentials: true });
  await app.register(multipart, {
    limits: { files: 1, fileSize: 5 * 1024 * 1024, fields: 5, fieldNameSize: 100, fieldSize: 1024 },
  });
  // Public, hardened static serving of uploaded media (bytes are public-by-URL;
  // field-level privacy hides the *reference*, not the bytes — documented).
  await app.register(fastifyStatic, {
    root: env.UPLOADS_DIR,
    prefix: "/api/v1/media/",
    decorateReply: false, // avoid colliding with @fastify/swagger-ui's static
    index: false,
    dotfiles: "deny",
    setHeaders: (res) => {
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    },
  });
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: "1 minute",
    // Delivery/preview keys and login have their own tighter limits per route.
  });

  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: { title: "Paperboy API", version: "0.1.0", description: "Headless CMS — Management + Delivery API" },
      tags: [
        { name: "auth", description: "Authentication" },
        { name: "manage", description: "Management API (authenticated)" },
        { name: "ai", description: "AI editorial assistant" },
        { name: "delivery", description: "Delivery API (read-only, key-scoped)" },
      ],
    },
    transform: jsonSchemaTransform,
  });
  // Mounted under /api so it's reachable through the admin's nginx `/api/` proxy
  // (which forwards the full path). The admin's "API docs" link points to /api/docs.
  await app.register(swaggerUI, { routePrefix: "/api/docs" });

  // Per-request session loading (does not enforce auth; routes decide).
  app.decorateRequest("user", null);
  app.decorateRequest("accessCtx", null);
  app.decorateRequest("sessionToken", null);
  app.decorateRequest("sessionCsrf", null);
  app.addHook("onRequest", async (req) => {
    const token = req.cookies[app.cookieName];
    if (!token) return;
    const sess = await readSession(db, token);
    if (!sess) return;
    req.sessionToken = token;
    req.sessionCsrf = sess.csrfToken;
    req.user = await getSessionUser(db, sess.userId);
    req.accessCtx = await getAccessContext(db, sess.userId);
  });

  // Unified error handling.
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.status).send({ error: err.code, message: err.message });
    }
    if (err instanceof ZodError) {
      return reply.code(422).send({ error: "validation_error", message: err.message, issues: err.issues });
    }
    if ((err as { statusCode?: number }).statusCode === 429) {
      return reply.code(429).send({ error: "rate_limited", message: "Too many requests" });
    }
    if ((err as { validation?: unknown }).validation) {
      return reply.code(422).send({ error: "validation_error", message: (err as Error).message });
    }
    // Honor 4xx from plugins (e.g. @fastify/multipart "file too large" → 413).
    const sc = (err as { statusCode?: number }).statusCode;
    if (sc && sc >= 400 && sc < 500) {
      return reply.code(sc).send({ error: "request_error", message: (err as Error).message });
    }
    req.log.error({ err }, "unhandled error");
    return reply.code(500).send({ error: "internal_error", message: "Internal server error" });
  });

  await app.register(registerHealthRoutes);
  await app.register(registerAuthRoutes, { prefix: "/api/v1/auth" });
  await app.register(registerManageRoutes, { prefix: "/api/v1/manage" });
  await app.register(registerAiRoutes, { prefix: "/api/v1/ai" });
  await app.register(registerDeliveryRoutes, { prefix: "/api/v1/delivery" });
  // Image transforms (?w=&format=&q=) — the :file param route also serves
  // originals; the static wildcard above remains as fallback for nested paths.
  await app.register(registerMediaRoutes);

  // Scheduled-publish ticker: promotes due drafts and expires due content. Single
  // long-lived process (one container); the query uses no cross-request state.
  // Disabled under test — specs drive runScheduledPublish(db, now) directly.
  if (env.NODE_ENV !== "test") {
    void runScheduledPublish(db).catch((err) => app.log.error({ err }, "scheduled publish (boot) failed"));
    const schedTimer = setInterval(() => {
      void runScheduledPublish(db).catch((err) => app.log.error({ err }, "scheduled publish failed"));
    }, 60_000);
    if (typeof schedTimer.unref === "function") schedTimer.unref();
    app.addHook("onClose", async () => clearInterval(schedTimer));
  }

  return app;
}
