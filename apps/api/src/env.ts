import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string(),
  API_PORT: z.coerce.number().default(8091),
  SESSION_SECRET: z.string().min(16).default("dev-session-secret-change-me-min-32-chars"),
  CSRF_SECRET: z.string().min(16).default("dev-csrf-secret-change-me-min-32-chars-long"),
  // Encryption key for TOTP secrets and the stored AI/stock keys at rest
  // (packages/db/src/totp.ts encKey → sha256 → AES-256-GCM). Optional: unset
  // falls back to SESSION_SECRET. But it must go through the SAME placeholder
  // guard as the other two — TOTP login is passwordless, so a shipped-constant
  // MFA_SECRET turns one leaked `users` row into a full account takeover.
  // Empty string counts as unset: compose ships `MFA_SECRET: ${MFA_SECRET:-}`.
  MFA_SECRET: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(16).optional()),
  // Shared with the frontend (apps/web): the API SIGNS short-lived preview tokens
  // with it and the frontend verifies them. Must be the same value on both, and it
  // must never reach the browser — that is the whole point of the token indirection
  // (the admin used to ship this secret itself, inlined into its public JS bundle).
  // Unset ⇒ the mint route reports 503 and in-editor preview is unavailable.
  PREVIEW_SECRET: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(16).optional()),
  COOKIE_SECURE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  CORS_ORIGIN: z.string().default("http://localhost:8090"),
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
  // AI editorial assistant. When ANTHROPIC_API_KEY is set the API calls Claude;
  // otherwise a deterministic local fallback keeps the feature usable offline.
  ANTHROPIC_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default("claude-haiku-4-5-20251001"),
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
  // How much of the X-Forwarded-For chain to trust for req.ip (rate-limit keys +
  // audit IPs). "true" trusts ALL hops (a client can then spoof its IP) — fine only
  // when the API is unreachable except through a trusted proxy that overwrites XFF.
  // Harden by setting the exact boundary: a hop COUNT ("1" = one trusted proxy) or
  // a CSV of trusted proxy IPs/CIDRs. "false" = trust none (req.ip = socket peer).
  // Defaults to "false" (trust NO hops) so an unconfigured deploy fails safe: with
  // "true", anyone who can reach the API directly sets their own X-Forwarded-For and
  // every per-IP rate limit and audit IP becomes attacker-chosen. The shipped compose
  // and .env.example set "1" (exactly one trusted proxy) — that is the opt-in.
  TRUST_PROXY: z.string().default("false"),
});

/** Parse TRUST_PROXY into the shape Fastify's `trustProxy` accepts:
 *  boolean | hop-count number | list of trusted proxy IPs/CIDRs. */
export function parseTrustProxy(value: string): boolean | number | string[] {
  const v = value.trim();
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^\d+$/.test(v)) return Number(v);
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
