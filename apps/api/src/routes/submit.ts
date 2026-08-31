import {
  dispatchWebhooks,
  formSiteId,
  getSiteById,
  loadPublishedForm,
  resolveDefaultLocale,
  submitForm,
  verifyDeliveryKey,
  audit,
} from "@paperboy/db";
import { MAX_ANSWER_LENGTH, checkSpamHeuristics } from "@paperboy/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { nanoid } from "nanoid";
import { z } from "zod";

/**
 * The PUBLIC form-submission endpoint — Paperboy's only anonymous write path.
 *
 * It lives in its own module, with its own registration, for a reason: the
 * delivery routes are the single READ chokepoint and stay GET-only, and a
 * reviewer must be able to see every rule that applies to public writes in one
 * file. The rules, and what each is for:
 *
 *  - **This handler ignores the session, so CSRF has nothing to ride.** The
 *    global onRequest hook DOES resolve a session cookie into `req.user` for
 *    every route (app.ts) — this handler simply never consults it; its only
 *    credential is the delivery key. So an anti-CSRF token here would protect
 *    nothing. The guarantee is the OUTCOME, not the absence of the hook:
 *    forms-submit.test.ts asserts a cookie-bearing request is treated exactly
 *    like an anonymous one, and this handler must never be refactored to read
 *    `req.user`/`req.accessCtx` or to share code with a session route.
 *  - **The delivery key pins the site.** A key for site A cannot submit to a
 *    form in site B; a cross-site form id reads as not-found.
 *  - **Heuristics before the database.** The honeypot and timing checks run
 *    before any query, so a naive bot costs us nothing but a JSON parse.
 *  - **Turnstile server-side**, single-use token, when the form asks for it.
 *  - **Validation from the live definition** happens in the db chokepoint, not
 *    here — so no future caller can bypass it.
 *  - **A spam drop looks exactly like a success.** Telling a bot which check
 *    caught it is free tuning information; the audit log records the truth.
 */

const SubmitBody = z.object({
  /** The answers, keyed by field name. */
  values: z.record(z.string(), z.unknown()).default({}),
  /** The honeypot input. A human never sees it, so it must arrive empty. */
  honeypot: z.string().max(200).optional(),
  /** Milliseconds between the form rendering and the visitor submitting. */
  elapsedMs: z.number().int().min(0).max(7 * 24 * 3600 * 1000).optional(),
  /** Cloudflare Turnstile token, when the form requires a challenge. */
  turnstileToken: z.string().max(4096).optional(),
  locale: z.string().max(20).optional(),
});

const SubmitOk = z.object({
  ok: z.literal(true),
  submissionId: z.string(),
  confirmation: z.object({
    type: z.enum(["message", "redirect"]),
    text: z.unknown().optional(),
    redirectTo: z.object({ href: z.string(), text: z.string().optional() }).nullable().optional(),
  }),
});

const SubmitInvalid = z.object({
  ok: z.literal(false),
  error: z.literal("validation"),
  /** One message per field, so a frontend can render it beside that input. */
  fields: z.record(z.string(), z.string()),
});

/** Shape of every non-success answer here. Declared so the typed reply accepts
 *  each status the handler can actually return. */
const SubmitError = z.object({ error: z.string(), message: z.string() });

const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * Verify a Turnstile token with Cloudflare. Tokens are single-use and live ~300s;
 * a replay comes back as `timeout-or-duplicate`, which is a failure here.
 * Without a configured secret the challenge cannot be verified, and an
 * unverifiable challenge must FAIL rather than wave the submission through.
 */
async function verifyTurnstile(
  secret: string | undefined,
  token: string | undefined,
  remoteIp: string | undefined,
): Promise<boolean> {
  if (!secret) return false;
  if (!token) return false;
  const body = new URLSearchParams({ secret, response: token });
  if (remoteIp) body.set("remoteip", remoteIp);
  try {
    const res = await fetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return false;
    const json = (await res.json()) as { success?: boolean };
    return json.success === true;
  } catch {
    return false;
  }
}

/** The frontend origins a site is allowed to submit from. Echoing the specific
 *  origin (never `*`) keeps the response honest about who may read it. */
function allowedOrigins(site: { canonicalBaseUrl?: string | null; previewBaseUrl?: string | null } | null): string[] {
  const out: string[] = [];
  for (const raw of [site?.canonicalBaseUrl, site?.previewBaseUrl]) {
    if (!raw) continue;
    try {
      out.push(new URL(raw).origin);
    } catch {
      /* a malformed configured URL simply grants nothing */
    }
  }
  return out;
}

export async function registerSubmitRoutes(appBase: FastifyInstance): Promise<void> {
  const app = appBase.withTypeProvider<ZodTypeProvider>();

  app.post(
    "/forms/:documentId/submissions",
    {
      config: {
        // @fastify/cors is configured for the ADMIN origin; this route grants
        // the SITE's own origins itself (below), so the plugin must stay out.
        cors: false,
        // Tighter than the global per-IP ceiling, and per form as well as per
        // IP: one scraped form endpoint must not be able to exhaust the budget
        // every other site's forms share.
        rateLimit: {
          max: app.formConfig.submitRateMax,
          timeWindow: "1 minute",
          keyGenerator: (req: FastifyRequest) =>
            `${req.ip}:${(req.params as { documentId?: string }).documentId ?? "?"}`,
        },
      },
      schema: {
        tags: ["delivery"],
        summary: "Submit a form (public)",
        description:
          "Accepts one submission for a published Form in the site the delivery key belongs to. " +
          "Answers are validated server-side against the form's current published definition; " +
          "invalid input returns 422 with one message per field. Never authenticated by cookie.",
        params: z.object({ documentId: z.string().min(1).max(64) }),
        body: SubmitBody,
        response: { 202: SubmitOk, 401: SubmitError, 404: SubmitError, 413: SubmitError, 422: SubmitInvalid },
      },
    },
    async (req, reply) => {
      // Deliberately NOT req.user / req.session: this path has no ambient
      // authority. The only credential is the delivery key.
      const auth = req.headers.authorization;
      let key = "";
      if (auth?.startsWith("Bearer ")) key = auth.slice(7).trim();
      else if (typeof req.headers["x-api-key"] === "string") key = req.headers["x-api-key"];
      const resolved = await verifyDeliveryKey(app.db, key);
      if (!resolved) return reply.code(401).send({ error: "unauthorized", message: "Invalid or missing API key" });

      const { documentId } = req.params;
      const body = req.body;

      // Cheapest checks first: a bot should not reach the database.
      const spam = checkSpamHeuristics({ honeypot: body.honeypot, elapsedMs: body.elapsedMs });
      if (!spam.ok) {
        // Looks like a success from outside. The trail is in the audit log.
        // No IP here: the form isn't loaded yet (heuristics run before any DB
        // touch), so there is no captureMetadata opt-in to honour — and a
        // dropped bot's address is not ours to store. The reason is enough.
        await audit(app.db, {
          action: "form.submission_rejected",
          documentId,
          detail: { reason: spam.reason },
        });
        return reply.code(202).send({
          ok: true,
          // Shaped like a real id — a constant would be a bot-readable tell. The
          // `confirmation` shape is a residual tell by design: the form is
          // deliberately not loaded before the heuristics run.
          submissionId: `sub_${nanoid(18)}`,
          confirmation: { type: "message" as const },
        });
      }

      // Total answer size, so a form without per-field limits can't be used as
      // free storage. Field-level limits are enforced by the compiled schema.
      // Multi-select answers arrive as arrays, so their elements count too.
      const textLength = (v: unknown): number =>
        typeof v === "string" ? v.length : Array.isArray(v) ? v.reduce<number>((n, x) => n + textLength(x), 0) : 0;
      const totalLength = Object.values(body.values).reduce<number>((n, v) => n + textLength(v), 0);
      if (totalLength > MAX_ANSWER_LENGTH * 20) {
        return reply.code(413).send({ error: "payload_too_large", message: "The submission is too large." });
      }

      const site = await getSiteById(app.db, resolved.siteId);
      const locale = body.locale ?? (await resolveDefaultLocale(app.db, resolved.siteId));

      const form = await loadPublishedForm(app.db, resolved.siteId, documentId, locale);
      if (!form) return reply.code(404).send({ error: "not_found", message: "Form not found or not published." });

      if (form.spec.turnstile) {
        const okToken = await verifyTurnstile(app.formConfig.turnstileSecret, body.turnstileToken, req.ip);
        if (!okToken) {
          return reply.code(422).send({
            ok: false as const,
            error: "validation" as const,
            fields: {
              _form: app.formConfig.turnstileSecret
                ? "The anti-spam check did not pass. Please try again."
                : "This form requires a Turnstile challenge, but no Turnstile secret is configured on the server.",
            },
          });
        }
      }

      const idempotencyKey =
        typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"].slice(0, 120) : undefined;

      const result = await submitForm(app.db, {
        siteId: resolved.siteId,
        formId: documentId,
        locale,
        values: body.values,
        meta: {
          ip: req.ip,
          userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : undefined,
          referer: typeof req.headers.referer === "string" ? req.headers.referer : undefined,
        },
        idempotencyKey,
        defaultRetentionDays: app.formConfig.retentionDays,
      });

      if (!result.ok) {
        return reply.code(422).send({ ok: false as const, error: "validation" as const, fields: result.fields });
      }

      const origins = allowedOrigins(site);
      const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
      if (origin && origins.includes(origin)) {
        reply.header("Access-Control-Allow-Origin", origin);
        reply.header("Vary", "Origin");
      }

      if (!result.replayed) {
        await audit(app.db, {
          action: "form.submitted",
          documentId,
          detail: { submissionId: result.submissionId, locale: form.locale },
          // Only when the form opted in — same gate as form_submission.meta. An
          // IP is personal data; a form with "store IP" off must leave none,
          // including in the audit trail a data-subject erasure cannot reach.
          ip: form.settings.captureMetadata ? req.ip : undefined,
        });
        // Notification is an integration concern: Paperboy has no mail
        // transport, so this rides the existing signed webhook pipe.
        if (form.settings.notifyWebhooks) {
          void dispatchWebhooks(app.db, {
            event: "form.submitted",
            formId: documentId,
            formName: form.name,
            submissionId: result.submissionId,
            siteId: resolved.siteId,
            locale: form.locale,
            at: new Date().toISOString(),
            notifyEmail: form.settings.notifyEmail || undefined,
            // The VALIDATED answers, not the raw body — a receiver should never
            // see input the server rejected or normalised away. Sending them at
            // all is the editor's explicit choice ("Send to integrations"),
            // because this carries visitor personal data off the instance.
            values: result.values,
            fields: form.spec.fields
              .filter((f) => f.kind !== "static" && f.name)
              .map((f) => ({ name: f.name, label: f.label, kind: f.kind })),
          }).catch((err) => app.log.error({ err }, "form.submitted webhook dispatch failed"));
        }
      }

      return reply.code(202).send({
        ok: true as const,
        submissionId: result.submissionId,
        confirmation: {
          type: form.spec.confirmation,
          text: form.spec.confirmationText,
          redirectTo: form.spec.redirectTo,
        },
      });
    },
  );

  // Preflight for a JSON submission from a browser on the site's own origin. A
  // preflight carries NO credential (browsers strip Authorization), so the site
  // — and with it the grantable origins — comes from the form's own id.
  app.options("/forms/:documentId/submissions", { schema: { hide: true }, config: { cors: false } }, async (req, reply) => {
    const siteId = await formSiteId(app.db, (req.params as { documentId: string }).documentId);
    const site = siteId ? await getSiteById(app.db, siteId) : null;
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
    // An unknown form grants nothing — the browser then blocks the real request,
    // which is the correct outcome.
    if (origin && allowedOrigins(site).includes(origin)) {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Access-Control-Allow-Headers", "content-type, authorization, x-api-key, idempotency-key");
      reply.header("Access-Control-Allow-Methods", "POST, OPTIONS");
      reply.header("Access-Control-Max-Age", "600");
      reply.header("Vary", "Origin");
    }
    return reply.code(204).send();
  });
}
