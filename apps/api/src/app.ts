import { mkdirSync } from "node:fs";
import { safeErrSerializer } from "./logging.js";
import compress from "@fastify/compress";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import swagger from "@fastify/swagger";
import swaggerUI from "@fastify/swagger-ui";
import {
  AppError,
  PG_FOREIGN_KEY_VIOLATION,
  PG_INVALID_TEXT_REPRESENTATION,
  PG_UNIQUE_VIOLATION,
  audit,
  createDb,
  pgErrorCode,
  resolveSessionRequest,
  runAuditRetention,
  runScheduledPublish,
  runSessionRetention,
  runRedirectRetention,
  runOAuthClientRetention,
  runExperimentTicker,
  runMailDeliveryRetention,
  runSubmissionRetention,
  runWebhookDeliveryRetention,
  resolveMailConfig,
  resolveMailRuntimeConfig,
  sendDueMail,
} from "@paperboy/db";
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyServerOptions } from "fastify";
import {
  type ZodTypeProvider,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { ZodError } from "zod";
import { isAdminSpaPath, registerAdminSpa } from "./admin-spa.js";
import { type Env, parseTrustProxy } from "./env.js";
import { registerMcpForward } from "./mcp-forward.js";
import { registerAiRoutes } from "./routes/ai.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerDeliveryRoutes } from "./routes/delivery.js";
import { registerSubmitRoutes } from "./routes/submit.js";
import { registerRedirectRoutes } from "./routes/redirects.js";
import { registerExperimentRoutes } from "./routes/experiments.js";
import { registerTrafficRoutes } from "./routes/traffic.js";
import { oauthConfigFrom, registerOAuthRoutes } from "./routes/oauth.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerMediaRoutes } from "./routes/media.js";
import { registerManageRoutes } from "./routes/manage.js";
import { registerUploadRoutes } from "./routes/uploads.js";
import "./types.js";

export interface BuildOptions {
  env: Env;
  /** Inject a db (tests); otherwise created from env.DATABASE_URL. */
  db?: FastifyInstance["db"];
}

export async function buildApp(opts: BuildOptions): Promise<FastifyInstance> {
  const { env } = opts;
  const serverOpts: FastifyServerOptions = {
    // A custom `err` serializer so a DrizzleQueryError can't log bound params
    // (which include the session token) — see ./logging.ts.
    logger: (env.NODE_ENV === "test" ? false : { level: "info", serializers: { err: safeErrSerializer } }) as FastifyServerOptions["logger"],
    // Configurable trusted-proxy boundary (M9). Defaults to trusting NOTHING;
    // operators pin the CIDRs or presets of the proxies actually in front, so
    // req.ip can't be spoofed via X-Forwarded-For. A HOP COUNT is refused —
    // parseTrustProxy explains why. (req.ip backs the IP rate-limits and audit
    // IPs, and request.host/protocol back generated URLs and cookie decisions.)
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    // Azure's front end forwards "203.0.113.7:9577". With the port, req.ip changed
    // per connection, so per-IP limits counted connections. req.ip is computed
    // from this header on read; rewriteUrl runs before anything reads it, the
    // "incoming request" log line included (an onRequest hook ran after it).
    rewriteUrl: (raw) => {
      const xff = raw.headers["x-forwarded-for"];
      if (typeof xff === "string" && xff.includes(":")) raw.headers["x-forwarded-for"] = stripForwardedPorts(xff);
      return raw.url ?? "/";
    },
  };
  const app = Fastify(serverOpts).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Own the pool only when we created it (a caller-supplied db is the caller's to
  // close). Close it on app shutdown so connections aren't leaked — harmless for a
  // long-lived prod app, but essential for the test suite, where dozens of apps are
  // built and torn down against one Postgres (else: "too many clients already").
  const owned = opts.db ? null : createDb(env.DATABASE_URL, { max: env.DATABASE_POOL_MAX });
  const db = opts.db ?? owned!.db;
  if (owned) app.addHook("onClose", async () => owned.sql.end());
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
  // Signs the short-lived preview tokens the admin's iframe uses. Server-side
  // only — it must never be inlined into the admin bundle again.
  app.decorate("previewSecret", env.PREVIEW_SECRET);

  // Baseline security headers on EVERY response (S3-M2) — done inline rather than
  // pulling in @fastify/helmet. HSTS only when cookies are Secure (i.e. real HTTPS),
  // so a non-TLS internal/demo deploy isn't told to force https. A CSP is left to
  // the edge/frontends (a meaningful one for the JSON API + Swagger UI needs nonces).
  app.addHook("onSend", async (_req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Frame-Options", "DENY");
    if (env.COOKIE_SECURE) reply.header("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  });
  // The env-side AI settings; resolveAiRuntimeConfig combines them with the
  // CMS-stored config at request time (stored unit wins — see @paperboy/db).
  app.decorate("aiEnv", {
    AI_PROVIDER: env.AI_PROVIDER,
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: env.OPENAI_API_KEY,
    OPENAI_BASE_URL: env.OPENAI_BASE_URL,
    AI_MODEL: env.AI_MODEL,
  });
  app.decorate("stockConfig", { unsplashKey: env.UNSPLASH_ACCESS_KEY });
  app.decorate("formConfig", {
    turnstileSecret: env.TURNSTILE_SECRET_KEY,
    submitRateMax: env.NODE_ENV === "test" ? 100_000 : env.FORM_SUBMIT_RATE_MAX,
    retentionDays: env.SUBMISSION_RETENTION_DAYS,
  });
  // Form notification email. The env side is validated here (a half-configured
  // provider refuses to boot); Settings → Email can override it as a unit, so
  // every use resolves the two together (resolveMailRuntimeConfig).
  const adminUrl = env.PUBLIC_URL ?? env.CORS_ORIGIN;
  app.decorate("mailEnv", { env: resolveMailConfig(env, adminUrl), adminUrl, maxPerFormPerHour: env.MAIL_MAX_PER_FORM_PER_HOUR });

  await app.register(cookie, { secret: env.SESSION_SECRET });
  await app.register(cors, { origin: env.CORS_ORIGIN, credentials: true });
  // Gzip responses for clients that accept it (nginx used to do this for /api).
  // Pre-compressed admin assets already carry Content-Encoding and are left
  // alone, as are hijacked streams (the Build-from-brief SSE, the /mcp forward).
  await app.register(compress, { encodings: ["gzip"] });
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
    setHeaders: (res, path) => {
      // @fastify/static v10 hands the FastifyReply here (not the raw response).
      res.header("X-Content-Type-Options", "nosniff");
      res.header("Cache-Control", "public, max-age=31536000, immutable");
      // Force download for active-content formats so they never render inline.
      if (path.toLowerCase().endsWith(".pdf")) res.header("Content-Disposition", "attachment");
    },
  });
  await app.register(rateLimit, {
    global: true,
    max: env.NODE_ENV === "test" ? 100_000 : env.RATE_LIMIT_MAX,
    timeWindow: "1 minute",
    // Delivery/preview keys and login have their own tighter limits per route.
    // The admin's pages and assets are exempt: a cold load fetches dozens of
    // chunks, and an office behind one IP must not lock itself out of the editor.
    // Decided on the ROUTE the router matched, not the URL string: every spelling
    // it normalises (percent-encoding, an absolute-form `POST http://host/api/…`)
    // lands on the same route. No route = the SPA fallback, judged by its path.
    ...(env.ADMIN_DIST_DIR ? { allowList: (req: FastifyRequest) => isAdminSpaPath(req.routeOptions.url ?? req.url) } : {}),
  });

  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: { title: "Paperboy API", version: "0.1.0", description: "Headless CMS — Management + Delivery API" },
      tags: [
        { name: "health", description: "Liveness and readiness probes" },
        { name: "auth", description: "Authentication" },
        { name: "manage", description: "Management API (authenticated)" },
        { name: "ai", description: "AI editorial assistant" },
        { name: "delivery", description: "Delivery API (read-only, key-scoped)" },
      ],
    },
    transform: jsonSchemaTransform,
  });
  // Mounted under /api, beside everything else the API owns, so it never
  // collides with an admin route. The admin's "API docs" link points to /api/docs.
  await app.register(swaggerUI, { routePrefix: "/api/docs" });

  // Per-request session loading (does not enforce auth; routes decide).
  app.decorateRequest("user", null);
  app.decorateRequest("accessCtx", null);
  app.decorateRequest("sessionToken", null);
  app.decorateRequest("sessionCsrf", null);
  app.addHook("onRequest", async (req) => {
    const token = req.cookies[app.cookieName];
    if (!token) return;
    // Active site (multisite): the admin site switcher sends x-paperboy-site.
    // Honoured only when it exists AND the user can open it; an unknown, absent
    // or closed site falls back to the user's home site (a one-site Admin's own).
    const siteHeader = req.headers["x-paperboy-site"];
    const auth = await resolveSessionRequest(db, token, typeof siteHeader === "string" && siteHeader ? siteHeader : undefined);
    if (!auth) return;
    req.sessionToken = token;
    req.sessionCsrf = auth.csrfToken;
    req.user = auth.user;
    // via:"web" — session writes are human; the MCP server tags its ctx "mcp".
    // Drives provenance (content_version.created_via) + the agent-review flag.
    req.accessCtx = { ...auth.accessCtx, via: "web" };
  });

  // Unified error handling.
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      // `fields` is additive: present only on validation errors that name the
      // content fields at fault, so the admin can show the message inline.
      return reply.code(err.status).send({ error: err.code, message: err.message, ...(err.fields?.length ? { fields: err.fields } : {}) });
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
    // Safety net for a driver error that escaped the query layer: every "does it
    // exist?" pre-check races, and the loser's unique/FK violation is a client
    // condition, not a server fault.
    switch (pgErrorCode(err)) {
      case PG_UNIQUE_VIOLATION:
        return reply.code(409).send({ error: "conflict", message: "A record with the same unique value already exists — re-read and retry with a different value." });
      case PG_FOREIGN_KEY_VIOLATION:
        return reply.code(409).send({ error: "conflict", message: "The record is referenced by other rows (or references one that does not exist) — remove the dependents first." });
      case PG_INVALID_TEXT_REPRESENTATION:
        return reply.code(400).send({ error: "bad_request", message: "A value has the wrong format for its column (e.g. text where a number or id is expected)." });
    }
    req.log.error({ err }, "unhandled error");
    return reply.code(500).send({ error: "internal_error", message: "Internal server error" });
  });

  await app.register(registerHealthRoutes);
  await app.register(registerAuthRoutes, { prefix: "/api/v1/auth" });
  await app.register(registerManageRoutes, { prefix: "/api/v1/manage" });
  await app.register(registerRedirectRoutes, { prefix: "/api/v1/manage" });
  await app.register(registerExperimentRoutes, { prefix: "/api/v1/manage" });
  await app.register(registerAiRoutes, { prefix: "/api/v1/ai" });
  await app.register(registerDeliveryRoutes, { prefix: "/api/v1/delivery" });
  // Public form submissions. Registered SEPARATELY from the delivery routes
  // even though it shares their URL prefix: delivery is the read chokepoint and
  // its preHandler resolves a read perspective, while this is the one anonymous
  // WRITE path and owns its own credential check, rate limit and CORS rules.
  await app.register(registerSubmitRoutes, { prefix: "/api/v1/delivery" });
  // Frontend traffic reports (redirect hits, 404 paths): the second public
  // write, with the same separation and its own credential check.
  await app.register(registerTrafficRoutes, { prefix: "/api/v1/delivery" });
  // Image transforms (?w=&format=&q=) — the :file param route also serves
  // originals; the static wildcard above remains as fallback for nested paths.
  await app.register(registerMediaRoutes);
  // OAuth for the remote MCP server — registered unprefixed: its discovery
  // documents live at the root (/.well-known/…), its endpoints under /api/v1.
  await app.register(registerOAuthRoutes, { config: oauthConfigFrom(env) });
  // Upload links (MCP create_upload_link): its own credential, never the session.
  await app.register(registerUploadRoutes, { uploadsDir: env.UPLOADS_DIR });
  // The remote MCP endpoint on this same origin, at /mcp.
  if (env.MCP_UPSTREAM_URL) await registerMcpForward(app, env.MCP_UPSTREAM_URL);
  // The admin SPA on this same origin — last, because it owns the not-found handler.
  if (env.ADMIN_DIST_DIR) await registerAdminSpa(app, env.ADMIN_DIST_DIR);

  // Scheduled-publish ticker: promotes due drafts and expires due content. Single
  // long-lived process (one container); the query uses no cross-request state.
  // Disabled under test — specs drive runScheduledPublish(db, now) directly.
  if (env.NODE_ENV !== "test") {
    // A tick that outlives its interval (slow database) must not stack a second
    // run on top of itself, so each ticker skips while its previous run is in flight.
    const ticker = (label: string, run: () => Promise<void>, everyMs: number): void => {
      let inFlight: Promise<void> | null = null;
      const tick = (): void => {
        if (inFlight) return;
        inFlight = run()
          .catch((err) => app.log.error({ err }, `${label} failed`))
          .finally(() => (inFlight = null));
      };
      tick();
      const timer = setInterval(tick, everyMs).unref();
      app.addHook("onClose", async () => clearInterval(timer));
    };

    // Scheduled-publish ticker: promotes due drafts and expires due content.
    ticker(
      "scheduled publish",
      async () => {
        await runScheduledPublish(db);
      },
      60_000,
    );

    // A/B experiments end themselves at ends_at, and when their page or area
    // goes away (the page then shows its control again).
    ticker(
      "experiments",
      async () => {
        const { ended, statsSwept } = await runExperimentTicker(db);
        for (const e of ended) await audit(db, { siteId: e.siteId, action: "experiment.end", documentId: e.documentId, detail: { id: e.id, reason: e.reason } });
        if (statsSwept > 0) app.log.info({ deleted: statsSwept }, "old experiment counts pruned");
      },
      60_000,
    );

    // Form notification email: sends what is queued and retries failures with
    // backoff. Claims rows first, so it never doubles up with the submit
    // route's immediate attempt (or another process).
    ticker(
      "form email",
      async () => {
        const { config } = await resolveMailRuntimeConfig(db, app.mailEnv);
        if (!config) return;
        const r = await sendDueMail(db, config);
        if (r.sent || r.failed || r.retrying) app.log.info(r, "form email sent");
      },
      60_000,
    );

    // Submission retention sweep. In-process and ON BY DEFAULT, deliberately:
    // Umbraco Forms ships the same per-form policy but it silently does nothing
    // until a separate scheduled task is enabled in configuration, so editors
    // believe data is being deleted when it isn't. Hourly is plenty for a
    // day-granularity policy, and each sweep logs its count so deletion is provable.
    ticker(
      "retention sweep",
      async () => {
        const { deleted } = await runSubmissionRetention(db);
        if (deleted > 0) {
          app.log.info({ deleted }, "form submissions deleted by retention policy");
          await audit(db, { action: "form.retention_sweep", detail: { deleted } });
        }
        // Same timer prunes the two append-only log tables so neither grows
        // without bound. webhook_delivery has a 90-day default; audit_log prunes
        // only when AUDIT_RETENTION_DAYS is set (compliance trail — kept by default).
        const wh = await runWebhookDeliveryRetention(db, env.WEBHOOK_DELIVERY_RETENTION_DAYS);
        if (wh.deleted > 0) app.log.info({ deleted: wh.deleted }, "webhook deliveries pruned by retention policy");
        const ml = await runMailDeliveryRetention(db);
        if (ml.deleted > 0) app.log.info({ deleted: ml.deleted }, "form email deliveries pruned");
        const au = await runAuditRetention(db, env.AUDIT_RETENTION_DAYS);
        if (au.deleted > 0) app.log.info({ deleted: au.deleted }, "audit rows pruned by retention policy");
        // Expired sessions are otherwise deleted only when their cookie is presented again.
        const se = await runSessionRetention(db);
        if (se.deleted > 0) app.log.info({ deleted: se.deleted }, "expired sessions pruned");
        const nf = await runRedirectRetention(db);
        if (nf.notFoundSwept > 0) app.log.info({ deleted: nf.notFoundSwept }, "404 log pruned");
        const oc = await runOAuthClientRetention(db);
        if (oc.deleted > 0) app.log.info({ deleted: oc.deleted }, "unused OAuth clients pruned");
      },
      3_600_000,
    );
  }

  return app;
}

/** "203.0.113.7:9577, [2001:db8::1]:443" → "203.0.113.7, 2001:db8::1"; a bare IPv6 is left alone. */
export function stripForwardedPorts(xff: string): string {
  return xff
    .split(",")
    .map((hop) => hop.trim().replace(/^\[([^\]]+)\](?::\d+)?$/, "$1").replace(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/, "$1"))
    .join(", ");
}
