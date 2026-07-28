import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    hookTimeout: 60_000,
    testTimeout: 30_000,
    // Tests share one Postgres DB and re-seed per file, so run them serially.
    fileParallelism: false,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    coverage: {
      provider: "v8",
      // This suite drives the API over real HTTP against a real Postgres, so it
      // also exercises packages/db (the authz + query layer) and packages/shared
      // (schemas, coercion, sanitizer). Measure all three or the number lies —
      // allowExternal is what lets the two out-of-root packages be counted.
      allowExternal: true,
      include: [
        "**/apps/api/src/**/*.ts",
        "**/packages/db/src/**/*.ts",
        "**/packages/shared/src/**/*.ts",
      ],
      exclude: ["**/*.d.ts", "**/seed.ts", "**/migrate.ts"],
      reporter: ["text-summary", "json-summary", "html"],
      reportsDirectory: "./coverage",
      // Set just under the measured baseline (2026-07-28: 93.24% lines/statements,
      // 92.94% functions, 82.73% branches) so a real regression fails CI while
      // normal churn doesn't. RATCHET ONLY: raise these as coverage rises, never
      // lower them to make a red run go green — fix or cover the code instead.
      thresholds: { lines: 92, statements: 92, functions: 91, branches: 81 },
    },
  },
});
