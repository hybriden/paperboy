import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "../src/env.js";

/**
 * The documented quickstart must actually boot.
 *
 * Before scripts/setup.sh existed, `docker compose up -d` from a clean checkout
 * could not start: compose injects `SESSION_SECRET: ${SESSION_SECRET:-prod-session-
 * secret-please-override-32+chars}`, env.ts refuses that placeholder under
 * NODE_ENV=production, api crash-looped, and because web/admin wait on
 * `service_healthy` the whole stack never came up. The README's literal command
 * (and the Windows walkthrough) therefore led every new user into a crash-loop.
 *
 * This pins BOTH halves: the compose defaults are still refused (the guard must
 * not be weakened to "fix" the quickstart), and the config scripts/setup.sh
 * generates is accepted by the same guard.
 */
const REPO = resolve(import.meta.dirname, "../../..");

/** Parse the KEY=value lines of a generated .env (no quoting/escaping is emitted). */
function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return out;
}

describe("documented quickstart produces a bootable configuration", () => {
  let dir: string;
  let generated: Record<string, string>;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "paperboy-setup-"));
    mkdirSync(join(dir, "scripts"));
    copyFileSync(join(REPO, "scripts/setup.sh"), join(dir, "scripts/setup.sh"));
    execFileSync("sh", ["scripts/setup.sh"], { cwd: dir, stdio: "pipe" });
    generated = parseEnvFile(readFileSync(join(dir, ".env"), "utf8"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // The repro: this is what a clean `docker compose up -d` used to hand the api.
  it("REPRO: compose's shipped placeholder secrets are refused in production", () => {
    expect(() =>
      loadEnv({
        DATABASE_URL: "postgresql://paperboy:paperboy@db:5432/paperboy",
        NODE_ENV: "production",
        COOKIE_SECURE: "true",
        SESSION_SECRET: "prod-session-secret-please-override-32+chars",
        CSRF_SECRET: "prod-csrf-secret-please-override-32+chars",
      }),
    ).toThrow(/SESSION_SECRET|CSRF_SECRET/);
  });

  it("generates every secret the production guard checks", () => {
    for (const key of ["SESSION_SECRET", "CSRF_SECRET", "MFA_SECRET", "PREVIEW_SECRET"]) {
      expect(generated[key], `${key} missing from generated .env`).toBeTruthy();
      expect(generated[key]).not.toMatch(/change-me|please-override/i);
      expect(generated[key]!.length).toBeGreaterThanOrEqual(16);
    }
  });

  it("the generated config boots under NODE_ENV=production", () => {
    expect(() =>
      loadEnv({
        DATABASE_URL: "postgresql://paperboy:paperboy@db:5432/paperboy",
        NODE_ENV: "production",
        SESSION_SECRET: generated.SESSION_SECRET,
        CSRF_SECRET: generated.CSRF_SECRET,
        MFA_SECRET: generated.MFA_SECRET,
        // The generated .env targets localhost, where a Secure cookie would be
        // dropped — so it opts into the documented insecure-cookie escape hatch.
        COOKIE_SECURE: generated.COOKIE_SECURE as "false",
        ALLOW_INSECURE_COOKIES: generated.ALLOW_INSECURE_COOKIES as "true",
      }),
    ).not.toThrow();
  });

  it("generates seed credentials that satisfy the production seed guard", () => {
    // Same conditions as assertSeedCredentialsSafe in packages/db/src/seed.ts.
    expect(generated.SEED_ADMIN_PASSWORD).toBeTruthy();
    expect(generated.SEED_ADMIN_PASSWORD).not.toBe("Admin!Passw0rd");
    expect(generated.PAPERBOY_PUBLIC_KEY).not.toBe("pk_live_seed_public_key_value");
    expect(generated.PAPERBOY_PREVIEW_KEY).not.toBe("prv_seed_preview_key_value");
    for (const key of ["SEED_ADMIN_PASSWORD", "PAPERBOY_PUBLIC_KEY", "PAPERBOY_PREVIEW_KEY"]) {
      expect(generated[key]).not.toMatch(/change-me|please-override/i);
    }
  });

  it("gives each install DIFFERENT secrets", () => {
    const other = mkdtempSync(join(tmpdir(), "paperboy-setup-"));
    try {
      mkdirSync(join(other, "scripts"));
      copyFileSync(join(REPO, "scripts/setup.sh"), join(other, "scripts/setup.sh"));
      execFileSync("sh", ["scripts/setup.sh"], { cwd: other, stdio: "pipe" });
      const second = parseEnvFile(readFileSync(join(other, ".env"), "utf8"));
      expect(second.SESSION_SECRET).not.toBe(generated.SESSION_SECRET);
      expect(second.SEED_ADMIN_PASSWORD).not.toBe(generated.SEED_ADMIN_PASSWORD);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("never overwrites an existing .env", () => {
    const before = readFileSync(join(dir, ".env"), "utf8");
    execFileSync("sh", ["scripts/setup.sh"], { cwd: dir, stdio: "pipe" });
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(before);
  });
});
