import { defineConfig, devices } from "@playwright/test";

/**
 * DEBUGGING suite config — NOT for CI.
 *
 * This is the toolbox an engineer reaches for when chasing a bug: traces are
 * ALWAYS on (so you can open any run in the trace viewer), video is retained on
 * failure, one worker / no parallelism so the shared dev DB stays sane and the
 * trace timeline is linear. Run a single slice with:
 *
 *   pnpm --filter @paperboy/admin test:e2e:debug e2e-debug/<file>.debug.spec.ts
 *
 * See e2e-debug/README.md for the full how-to (starting the stack, headed runs,
 * the trace viewer).
 */
export default defineConfig({
  testDir: "./e2e-debug",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  // A debugging suite never auto-retries — a flake you can't see is useless.
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env.ADMIN_URL ?? "http://localhost:8090",
    // Debugging suite: traces always, video on failure, screenshot on failure.
    trace: "on",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        channel: undefined,
        launchOptions: { args: ["--no-sandbox", "--disable-dev-shm-usage"] },
        viewport: { width: 1440, height: 900 },
      },
    },
  ],
});
