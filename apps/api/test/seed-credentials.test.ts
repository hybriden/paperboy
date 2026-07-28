import { createDb, seed } from "@paperboy/db";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { TEST_DB } from "./helpers.js";

/**
 * The seeded logins and delivery keys are FIXTURES, and this file lives in a
 * PUBLIC repo — so `admin@paperboy.test / Admin!Passw0rd`,
 * `editor@paperboy.test / Editor!Passw0rd` (content.publish on every site, since
 * roles are global), `pk_live_seed_public_key_value` and
 * `prv_seed_preview_key_value` are published constants.
 *
 * The FORCE_SEED guard stops a reseed from WIPING a populated production DB, but
 * nothing stopped a FIRST seed from populating production with world-known
 * credentials — and the editor/author/viewer passwords took no env var at all, so
 * no amount of operator diligence removed them.
 *
 * These tests pin the credential guard. Note the deliberately unreachable
 * connection string: the guard must refuse BEFORE connecting or migrating, so a
 * refused production seed can never have touched the database.
 */
const UNREACHABLE = "postgresql://paperboy:paperboy@127.0.0.1:1/never-connects";

const SEED_ENV_KEYS = [
  "NODE_ENV",
  "ALLOW_DEMO_CREDENTIALS",
  "SEED_ADMIN_PASSWORD",
  "SEED_ADMIN_EMAIL",
  "PAPERBOY_PUBLIC_KEY",
  "PAPERBOY_PREVIEW_KEY",
] as const;

describe("seed credential guard — production must not get world-known logins", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(SEED_ENV_KEYS.map((k) => [k, process.env[k]]));
    process.env.NODE_ENV = "production";
    delete process.env.ALLOW_DEMO_CREDENTIALS;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("refuses a production seed that would use the default admin password", async () => {
    delete process.env.SEED_ADMIN_PASSWORD;
    process.env.PAPERBOY_PUBLIC_KEY = "pk_live_a_real_rotated_public_key";
    process.env.PAPERBOY_PREVIEW_KEY = "prv_a_real_rotated_preview_key";
    await expect(seed(UNREACHABLE)).rejects.toThrow(/SEED_ADMIN_PASSWORD/);
  });

  it("refuses a production seed that would use the default delivery keys", async () => {
    process.env.SEED_ADMIN_PASSWORD = "a-real-rotated-admin-password";
    delete process.env.PAPERBOY_PUBLIC_KEY;
    delete process.env.PAPERBOY_PREVIEW_KEY;
    await expect(seed(UNREACHABLE)).rejects.toThrow(/PAPERBOY_PUBLIC_KEY|PAPERBOY_PREVIEW_KEY/);
  });

  it("refuses a placeholder-looking admin password even when it is set explicitly", async () => {
    process.env.SEED_ADMIN_PASSWORD = "please-override-me";
    process.env.PAPERBOY_PUBLIC_KEY = "pk_live_a_real_rotated_public_key";
    process.env.PAPERBOY_PREVIEW_KEY = "prv_a_real_rotated_preview_key";
    await expect(seed(UNREACHABLE)).rejects.toThrow(/SEED_ADMIN_PASSWORD/);
  });

  it("names the fix in the error (self-teaching, per agent-API rule #2)", async () => {
    delete process.env.SEED_ADMIN_PASSWORD;
    await expect(seed(UNREACHABLE)).rejects.toThrow(/ALLOW_DEMO_CREDENTIALS/);
  });

  it("ALLOW_DEMO_CREDENTIALS=true is an explicit opt-out (CI/demo stacks)", async () => {
    // Past the guard it must fail on the unreachable DB, NOT on credentials —
    // that difference is the proof the opt-in works.
    process.env.ALLOW_DEMO_CREDENTIALS = "true";
    delete process.env.SEED_ADMIN_PASSWORD;
    await expect(seed(UNREACHABLE)).rejects.not.toThrow(/SEED_ADMIN_PASSWORD|PAPERBOY_/);
  });

  it("leaves non-production seeding completely unguarded (the whole test suite relies on it)", async () => {
    process.env.NODE_ENV = "test";
    delete process.env.SEED_ADMIN_PASSWORD;
    await expect(seed(UNREACHABLE)).rejects.not.toThrow(/SEED_ADMIN_PASSWORD|PAPERBOY_/);
  });
});

describe("seed credential guard — production omits the demo users entirely", () => {
  const { sql } = createDb(TEST_DB);
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(SEED_ENV_KEYS.map((k) => [k, process.env[k]]));
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  afterAll(async () => {
    // Restore the shared test DB to the normal seeded state for later files.
    await seed(TEST_DB);
    await sql.end();
  });

  it("seeds ONLY the admin — no editor/author/viewer with published passwords", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.ALLOW_DEMO_CREDENTIALS;
    process.env.SEED_ADMIN_EMAIL = "owner@example.test";
    process.env.SEED_ADMIN_PASSWORD = "a-real-rotated-admin-password";
    process.env.PAPERBOY_PUBLIC_KEY = "pk_live_a_real_rotated_public_key";
    process.env.PAPERBOY_PREVIEW_KEY = "prv_a_real_rotated_preview_key";

    await seed(TEST_DB);

    const rows = (await sql`SELECT email FROM users ORDER BY email`) as unknown as { email: string }[];
    expect(rows.map((r) => r.email)).toEqual(["owner@example.test"]);
  });

  it("still seeds all four demo users in development", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.SEED_ADMIN_EMAIL;
    delete process.env.SEED_ADMIN_PASSWORD;

    await seed(TEST_DB);

    const rows = (await sql`SELECT email FROM users ORDER BY email`) as unknown as { email: string }[];
    expect(rows.map((r) => r.email)).toEqual([
      "admin@paperboy.test",
      "author@paperboy.test",
      "editor@paperboy.test",
      "viewer@paperboy.test",
    ]);
  });
});
