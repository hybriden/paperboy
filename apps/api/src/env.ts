import { z } from "zod";

/** "" counts as unset: compose passes every variable through, empty when the host has none. */
const emptyToUndefined = (v: unknown): unknown => (v === "" ? undefined : v);

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string(),
  /** Connections in the Postgres pool. Reads inside a transaction reuse its
   *  connection (see Queryable in @paperboy/db), so this bounds concurrency, not
   *  correctness; size it below the server's max_connections across replicas. */
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  API_PORT: z.coerce.number().default(8091),
  SESSION_SECRET: z.string().min(16).default("dev-session-secret-change-me-min-32-chars"),
  CSRF_SECRET: z.string().min(16).default("dev-csrf-secret-change-me-min-32-chars-long"),
  // Encryption key for TOTP secrets and the stored AI/stock keys at rest
  // (packages/db/src/totp.ts encKey → sha256 → AES-256-GCM). Optional: unset
  // falls back to SESSION_SECRET. But it must go through the SAME placeholder
  // guard as the other two — TOTP login is passwordless, so a shipped-constant
  // MFA_SECRET turns one leaked `users` row into a full account takeover.
  MFA_SECRET: z.preprocess(emptyToUndefined, z.string().min(16).optional()),
  // Shared with the frontend (apps/web): the API SIGNS short-lived preview tokens
  // with it and the frontend verifies them. Must be the same value on both, and it
  // must never reach the browser — that is the whole point of the token indirection
  // (the admin used to ship this secret itself, inlined into its public JS bundle).
  // Unset ⇒ the mint route reports 503 and in-editor preview is unavailable.
  PREVIEW_SECRET: z.preprocess(emptyToUndefined, z.string().min(16).optional()),
  COOKIE_SECURE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // Normalised to an ORIGIN (scheme://host[:port]): the CSRF check compares it
  // to the browser's Origin header byte-for-byte, and a configured trailing slash
  // or path would refuse every mutation from the admin.
  CORS_ORIGIN: z
    .string()
    .default("http://localhost:8090")
    .transform((v, ctx) => {
      try {
        return new URL(v).origin;
      } catch {
        ctx.addIssue({ code: "custom", message: `CORS_ORIGIN must be a full URL such as https://cms.example.com (got "${v}")` });
        return z.NEVER;
      }
    }),
  // Browser-reachable base for media URLs. Default "" = RELATIVE URLs
  // (/api/v1/media/…), which resolve same-origin via each app's proxy and so
  // work on any host (localhost, LAN IP, domain). Set an absolute base only if
  // media must be served from a different origin than the app.
  MEDIA_PUBLIC_BASE: z.string().default(""),
  UPLOADS_DIR: z.string().default("/app/uploads"),
  // Escape hatch for non-TLS internal/demo deployments. Must be set explicitly.
  ALLOW_INSECURE_COOKIES: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // AI editorial assistant. Two providers: Anthropic (ANTHROPIC_API_KEY) or any
  // OpenAI-compatible Chat Completions endpoint (OPENAI_API_KEY + optional
  // OPENAI_BASE_URL). AI_PROVIDER picks one when both keys are set; a config
  // stored in the CMS (Settings → AI) overrides all of these. Each env key is
  // bound to its own provider — see resolveAiRuntimeConfig in @paperboy/db.
  // Without any key a deterministic local fallback keeps the truncation tasks
  // usable offline. AI_MODEL has NO default here: the per-provider default
  // lives in DEFAULT_AI_MODELS (an Anthropic default baked in env would leak
  // into OpenAI configs).
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().optional(),
  AI_PROVIDER: z.preprocess(emptyToUndefined, z.enum(["anthropic", "openai"]).optional()),
  AI_MODEL: z.string().optional(),
  // Stock images (Settings → Stock images). Env fallback for the Unsplash
  // access key; a key stored in the CMS takes precedence.
  UNSPLASH_ACCESS_KEY: z.string().optional(),
  // Brute-force limit on login (per IP per minute). Raise for e2e runs where
  // one runner IP legitimately logs in many times; leave at 10 in production.
  LOGIN_RATE_MAX: z.coerce.number().int().positive().default(10),
  // Global per-IP request ceiling (per minute). Raise for e2e runs — 30 tests
  // plus retries from ONE runner IP brush against 300, and the 429s surface as
  // flaky "treeitem not visible" failures; leave at 300 in production.
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  // Form submissions per IP per form per minute. A real visitor sends one; the
  // headroom is for a corrected re-submit after a validation error. Counted per
  // (IP, form) so one scraped form can't exhaust the budget the others share.
  FORM_SUBMIT_RATE_MAX: z.coerce.number().int().positive().default(10),
  // Cloudflare Turnstile secret, for forms whose spam protection asks for a
  // challenge. Server-side only — the SITE key belongs in the frontend. Without
  // it, a form that requires a challenge REFUSES submissions rather than
  // accepting unverifiable ones.
  TURNSTILE_SECRET_KEY: z.string().optional(),
  // How long submissions live when a form declares no retention of its own.
  // Storage limitation is a GDPR requirement, so the default is finite: one year.
  SUBMISSION_RETENTION_DAYS: z.coerce.number().int().positive().default(365),
  // Prune the two append-only log tables so they can't grow without bound.
  // webhook_delivery is pure delivery noise with no compliance value → a safe
  // 90-day default. audit_log IS the compliance/forensics trail, so it defaults
  // to 0 (keep everything) and is pruned only when an operator opts in.
  WEBHOOK_DELIVERY_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(90),
  AUDIT_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(0),
  // How much of the X-Forwarded-For chain to trust for req.ip (rate-limit keys +
  // audit IPs). "true" trusts ALL hops (a client can then spoof its IP) — fine only
  // when the API is unreachable except through a trusted proxy that overwrites XFF.
  // Harden by setting the exact boundary: a hop COUNT ("1" = one trusted proxy) or
  // a CSV of trusted proxy IPs/CIDRs. "false" = trust none (req.ip = socket peer).
  // Defaults to "false" (trust NO hops) so an unconfigured deploy fails safe: with
  // "true", anyone who can reach the API directly sets their own X-Forwarded-For and
  // every per-IP rate limit and audit IP becomes attacker-chosen. The shipped compose
  // and .env.example opt in with "uniquelocal" — an ADDRESS-VALIDATING value; a hop
  // count is refused (see parseTrustProxy).
  TRUST_PROXY: z.string().default("false"),
});

/**
 * Parse TRUST_PROXY into the shape Fastify's `trustProxy` accepts:
 * boolean | list of trusted proxy IPs / CIDRs / proxy-addr presets.
 *
 * A HOP COUNT is refused. It reads like the tightest option ("exactly one proxy
 * in front") and is the opposite: the hop-count form compiles to a predicate
 * that structurally ignores the connecting address, so fastify's
 * X-Forwarded-* guard reduces to `0 < n` — true for every n >= 1. Anyone with a
 * direct network path to this origin could spoof req.ip, request.host and
 * request.protocol exactly as if nothing were configured
 * (GHSA-3m5p-2c4r-xxw2). fastify 5.12.1 disabled the form at runtime and removed
 * it from the type, so silently passing it on would leave an operator believing
 * a boundary is enforced while it is not — a refusal is the only honest answer.
 */
export function parseTrustProxy(value: string): boolean | string[] {
  const v = value.trim();
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^\d+$/.test(v)) {
    throw new Error(
      `TRUST_PROXY="${v}" is a hop count, which no longer does what it looks like: that form ` +
        `ignores the connecting address, so X-Forwarded-* stays spoofable by anyone who can reach ` +
        `this origin directly (GHSA-3m5p-2c4r-xxw2 — fastify 5.12.1 disabled it at runtime). Use a ` +
        `value that validates the peer instead: a CIDR or CSV of the proxies in front ` +
        `(TRUST_PROXY=172.18.0.0/16), a proxy-addr preset (loopback, linklocal, uniquelocal), ` +
        `"true" to trust every hop, or "false" to trust none.`,
    );
  }
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

export type Env = z.infer<typeof EnvSchema>;

const INSECURE_DEFAULTS = [
  "dev-session-secret-change-me-min-32-chars",
  "dev-csrf-secret-change-me-min-32-chars-long",
];
// Any shipped placeholder must be refused in production — not just the two
// .env.example dev-* strings above, but also the docker-compose
// `prod-*-please-override` defaults a plain `docker compose up` injects.
const PLACEHOLDER_SECRET = /change-me|please-override/i;

function looksInsecure(secret: string): boolean {
  return INSECURE_DEFAULTS.includes(secret) || PLACEHOLDER_SECRET.test(secret);
}

export function loadEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): Env {
  const env = EnvSchema.parse({ ...process.env, ...overrides });
  // Refuse to boot a production server with dev/placeholder secrets (fail fast).
  if (env.NODE_ENV === "production") {
    if (looksInsecure(env.SESSION_SECRET) || looksInsecure(env.CSRF_SECRET)) {
      throw new Error("Refusing to start: SESSION_SECRET/CSRF_SECRET must be set to non-default values in production");
    }
    // PREVIEW_SECRET graduated from "a shared password" to "the signing key for a
    // draft-access credential" when preview tokens replaced the raw secret, so it
    // needs the same guard. apps/web fails closed on the committed dev default, but
    // a customer's own frontend — which the docs tell to verify with the same
    // secret — has no such backstop, and a world-known signing key means anyone can
    // forge ?pbt= and read every draft.
    if (env.PREVIEW_SECRET !== undefined && looksInsecure(env.PREVIEW_SECRET)) {
      throw new Error(
        "Refusing to start: PREVIEW_SECRET must be set to a non-default value in production — it signs the preview tokens that grant draft access. Generate one with `openssl rand -hex 32` (scripts/setup.sh does this), or leave it unset to disable in-editor preview.",
      );
    }
    if (env.MFA_SECRET !== undefined && looksInsecure(env.MFA_SECRET)) {
      throw new Error(
        "Refusing to start: MFA_SECRET must be set to a non-default value in production — it encrypts TOTP secrets and stored API keys, and 2FA login is passwordless. Generate one with `openssl rand -hex 32`, or leave MFA_SECRET unset to derive the key from SESSION_SECRET.",
      );
    }
    if (!env.COOKIE_SECURE && !env.ALLOW_INSECURE_COOKIES) {
      throw new Error(
        "Refusing to start: COOKIE_SECURE must be true in production (set ALLOW_INSECURE_COOKIES=true only for non-TLS internal demos)",
      );
    }
  }
  if (env.NODE_ENV === "production" && !env.COOKIE_SECURE) {
    // eslint-disable-next-line no-console
    console.warn("[paperboy] WARNING: cookies are not Secure — only acceptable behind a trusted non-TLS boundary.");
  }
  return env;
}
