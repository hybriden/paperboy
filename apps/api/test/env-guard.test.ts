import { describe, expect, it } from "vitest";
import Fastify from "fastify";
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
  // GHSA-3m5p-2c4r-xxw2: the hop-count form compiles to a predicate that
  // structurally IGNORES the connecting address, so fastify's X-Forwarded-*
  // guard degrades to `0 < n` — true for every n >= 1. Anyone who can reach this
  // origin directly could still spoof req.ip, request.host and request.protocol.
  // fastify 5.12.1 disabled the form at runtime and dropped it from the type, so
  // accepting it here would leave an operator believing a boundary is enforced
  // while it silently is not. It is REFUSED, not coerced (rule #1).
  it("REFUSES a hop count and teaches the replacement", () => {
    expect(() => parseTrustProxy("1")).toThrow(/hop count/i);
    expect(() => parseTrustProxy("2")).toThrow(/TRUST_PROXY/);
    expect(() => parseTrustProxy("1")).toThrow(/GHSA-3m5p-2c4r-xxw2/);
    // A refusal that does not say what to write instead is a dead end.
    expect(() => parseTrustProxy("1")).toThrow(/uniquelocal|CIDR/);
  });

  it("keeps the address-validating forms usable", () => {
    expect(parseTrustProxy("uniquelocal")).toEqual(["uniquelocal"]);
    expect(parseTrustProxy("10.0.0.0/8")).toEqual(["10.0.0.0/8"]);
  });

  // The values docker-compose and .env.example ship must actually BOOT. Fastify
  // validates trustProxy when the instance is created, so a bad default would be
  // a crash on start — worse than the spoofing it replaced.
  it("the shipped defaults are values fastify accepts", () => {
    for (const shipped of ["uniquelocal", "false", "10.0.0.0/8, 172.16.0.0/12"]) {
      expect(() => Fastify({ logger: false, trustProxy: parseTrustProxy(shipped) }).close()).not.toThrow();
    }
  });
  it("maps a CSV to a trimmed list of trusted proxies", () => {
    expect(parseTrustProxy("10.0.0.0/8, 172.16.0.0/12")).toEqual(["10.0.0.0/8", "172.16.0.0/12"]);
  });
});
