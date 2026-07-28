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
      // Set just under the measured baseline so a real regression fails CI while
      // normal churn doesn't. RATCHET ONLY: raise these as coverage rises, never
      // lower them to make a red run go green — fix or cover the code instead.
      // Measured 2026-07-28: 93.78% lines/statements, 93.8% functions, 83.37% branches.
      thresholds: { lines: 93, statements: 93, functions: 93, branches: 83 },
    },
  },
});
