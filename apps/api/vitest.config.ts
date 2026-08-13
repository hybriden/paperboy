import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    hookTimeout: 60_000,
    testTimeout: 30_000,
    // Tests share one Postgres DB and re-seed per file, so run them serially.
    // (Vitest 4 removed poolOptions.forks.singleFork; maxWorkers is the
    // top-level equivalent of the old single-fork behaviour.)
    fileParallelism: false,
    pool: "forks",
    maxWorkers: 1,
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
      // RE-BASELINED 2026-08-13: @vitest/coverage-v8 2→4 (AST-aware remapping)
      // REMEASURES the same suite lower — 806/806 tests unchanged and green,
      // no code went uncovered; this is the instrument changing, not erosion.
      // Measured under v4: 92.15% lines, 88.16% statements, 88.28% functions,
      // 77.55% branches (old instrument 2026-07-28: 93.78/93.78/93.8/83.37).
      thresholds: { lines: 91.5, statements: 87.5, functions: 87.5, branches: 77 },
    },
  },
});
