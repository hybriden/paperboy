import { describe, expect, it } from "vitest";
import { loadEnv, parseTrustProxy } from "../src/env.js";

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

// MFA_SECRET was outside the guard entirely (absent from EnvSchema), so a deploy
// could paste a shipped placeholder into it and boot. It is the AES-256-GCM KEK
// for users.totp_secret AND the stored AI/stock keys (packages/db/src/totp.ts
// encKey), and TOTP login is PASSWORDLESS — so a public-constant MFA_SECRET means
// anyone who reads one users row can mint valid codes and own the CMS.
// Found live 2026-07-28: MFA_SECRET was byte-for-byte the compose
// `prod-session-secret-please-override-32+chars` placeholder, which is committed
// in a public repo. Nothing objected, because nothing looked.
describe("loadEnv production guard on MFA_SECRET", () => {
  const strong = { SESSION_SECRET: STRONG_SESSION, CSRF_SECRET: STRONG_CSRF };

  it("refuses the exact placeholder found on the live box", () => {
    expect(() =>
      loadEnv({ ...base, ...strong, MFA_SECRET: "prod-session-secret-please-override-32+chars" }),
    ).toThrow(/MFA_SECRET/);
  });

  it("refuses a change-me placeholder MFA_SECRET", () => {
    expect(() => loadEnv({ ...base, ...strong, MFA_SECRET: "dev-mfa-secret-change-me-please-32x" })).toThrow(
      /MFA_SECRET/,
    );
  });

  it("accepts a genuinely strong MFA_SECRET", () => {
    expect(() =>
      loadEnv({ ...base, ...strong, MFA_SECRET: "a-genuinely-strong-mfa-secret-value-x" }),
    ).not.toThrow();
  });

  it("treats an empty MFA_SECRET as unset — compose ships `MFA_SECRET: ${MFA_SECRET:-}`", () => {
    // Empty must fall through to the SESSION_SECRET fallback, not trip min-length.
    expect(() => loadEnv({ ...base, ...strong, MFA_SECRET: "" })).not.toThrow();
  });

  it("refuses a too-short MFA_SECRET in any environment", () => {
    expect(() => loadEnv({ ...base, ...strong, MFA_SECRET: "short" })).toThrow();
  });
});

describe("parseTrustProxy (M9: configurable trusted-proxy boundary)", () => {
  it("maps true/false to booleans", () => {
    expect(parseTrustProxy("true")).toBe(true);
    expect(parseTrustProxy("false")).toBe(false);
  });
  it("maps a numeric string to a hop count", () => {
    expect(parseTrustProxy("1")).toBe(1);
    expect(parseTrustProxy("2")).toBe(2);
  });
  it("maps a CSV to a trimmed list of trusted proxies", () => {
    expect(parseTrustProxy("10.0.0.0/8, 172.16.0.0/12")).toEqual(["10.0.0.0/8", "172.16.0.0/12"]);
  });
});
