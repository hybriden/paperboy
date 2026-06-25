import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/env.js";

// S2-H2: the production fail-fast guard must refuse ALL shipped placeholder
// secrets — including the docker-compose `prod-*-please-override` defaults that
// a plain `docker compose up` injects, not only the `.env.example` dev-* strings.
const base = {
  DATABASE_URL: "postgresql://paperboy:paperboy@localhost:5433/paperboy",
  NODE_ENV: "production" as const,
  COOKIE_SECURE: "true" as const,
};
const STRONG_SESSION = "a-genuinely-strong-session-secret-value";
const STRONG_CSRF = "a-genuinely-strong-csrf-secret-value-x";

describe("loadEnv production secret guard", () => {
  it("refuses the docker-compose prod-*-please-override SESSION_SECRET default", () => {
    expect(() =>
      loadEnv({ ...base, SESSION_SECRET: "prod-session-secret-please-override-32+chars", CSRF_SECRET: STRONG_CSRF }),
    ).toThrow(/SESSION_SECRET|CSRF_SECRET/);
  });

  it("refuses the docker-compose prod-*-please-override CSRF_SECRET default", () => {
    expect(() =>
      loadEnv({ ...base, SESSION_SECRET: STRONG_SESSION, CSRF_SECRET: "prod-csrf-secret-please-override-32+chars" }),
    ).toThrow(/SESSION_SECRET|CSRF_SECRET/);
  });

  it("still refuses the .env.example dev-* defaults (regression)", () => {
    // No SESSION_SECRET/CSRF_SECRET override → schema applies the dev-* defaults.
    expect(() => loadEnv({ ...base })).toThrow(/SESSION_SECRET|CSRF_SECRET/);
  });

  it("accepts genuinely strong secrets in production", () => {
    expect(() =>
      loadEnv({ ...base, SESSION_SECRET: STRONG_SESSION, CSRF_SECRET: STRONG_CSRF }),
    ).not.toThrow();
  });
});
