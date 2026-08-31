import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "@paperboy/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_DB, type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * The seed CLI guard (packages/db/src/seed.ts, `tsx src/seed.ts`) has prevented
 * two production wipes: the compose `init` service runs it on every `up`, and a
 * populated database must be left alone — migrations applied, nothing truncated
 * — unless FORCE_SEED=1 says otherwise. Tests import seed() directly, so the
 * CLI branch had no coverage at all.
 */
const DB_DIR = fileURLToPath(new URL("../../../packages/db", import.meta.url));
const MARKER_EMAIL = "seed-guard-marker@paperboy.test";

function runSeedCli(force: boolean) {
  const tsxCli = createRequire(join(DB_DIR, "package.json")).resolve("tsx/cli");
  const env: Record<string, string | undefined> = { ...process.env, DATABASE_URL: TEST_DB, NODE_ENV: "test" };
  if (force) env.FORCE_SEED = "1";
  else delete env.FORCE_SEED;
  return spawnSync(process.execPath, [tsxCli, "src/seed.ts"], { cwd: DB_DIR, env, encoding: "utf8", timeout: 120_000 });
}

describe("seed CLI guard — a populated database is never wiped without FORCE_SEED", () => {
  let s: Suite;
  const raw = createDb(TEST_DB);
  const markerCount = async () =>
    Number(((await raw.sql`select count(*)::int as c from users where email = ${MARKER_EMAIL}`) as Array<{ c: number }>)[0]!.c);

  beforeAll(async () => {
    s = await setupApi();
    const admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/users",
      headers: authHeaders(admin),
      payload: { email: MARKER_EMAIL, name: "Marker", password: "Marker!Passw0rd1", roles: ["Viewer"] },
    });
    expect(created.statusCode, created.body).toBe(200);
    expect(await markerCount()).toBe(1);
  });
  afterAll(async () => {
    await s.app.close();
    await raw.sql.end();
  });

  it("SKIPS the wipe on a populated database (exit 0) and still applies migrations", async () => {
    // Forget one applied migration so the skip run has real work to prove itself with.
    const [latest] = (await raw.sql`select name from _migrations order by name desc limit 1`) as Array<{ name: string }>;
    await raw.sql`delete from _migrations where name = ${latest!.name}`;
    const r = runSeedCli(false);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("Seed SKIPPED");
    expect(await markerCount(), "the guard must not have touched existing rows").toBe(1);
    const reapplied = (await raw.sql`select 1 from _migrations where name = ${latest!.name}`) as unknown[];
    expect(reapplied, `${latest!.name} must be re-applied by the guarded run`).toHaveLength(1);
  }, 150_000);

  it("FORCE_SEED=1 really does wipe and reseed (exit 0)", async () => {
    const r = runSeedCli(true);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).not.toContain("Seed SKIPPED");
    expect(await markerCount(), "a forced reseed truncates everything").toBe(0);
  }, 150_000);
});
