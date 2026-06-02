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
});

export type Env = z.infer<typeof EnvSchema>;

const INSECURE_DEFAULTS = [
  "dev-session-secret-change-me-min-32-chars",
  "dev-csrf-secret-change-me-min-32-chars-long",
];

export function loadEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): Env {
  const env = EnvSchema.parse({ ...process.env, ...overrides });
  // Refuse to boot a production server with dev defaults (fail fast).
  if (env.NODE_ENV === "production") {
    if (INSECURE_DEFAULTS.includes(env.SESSION_SECRET) || INSECURE_DEFAULTS.includes(env.CSRF_SECRET)) {
      throw new Error("Refusing to start: SESSION_SECRET/CSRF_SECRET must be set in production");
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
