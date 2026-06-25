import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string(),
  API_PORT: z.coerce.number().default(8091),
  SESSION_SECRET: z.string().min(16).default("dev-session-secret-change-me-min-32-chars"),
  CSRF_SECRET: z.string().min(16).default("dev-csrf-secret-change-me-min-32-chars-long"),
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
});

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
