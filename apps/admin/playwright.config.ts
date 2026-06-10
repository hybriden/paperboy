import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  // CI runners render slowly under load — the 5s default expect timeout reads
  // as roving "element not visible" flakes right after navigations. 15s is
  // still far below the 60s test budget, so real hangs surface unchanged.
  expect: { timeout: process.env.CI ? 15_000 : 5_000 },
  fullyParallel: false,
  workers: 1,
  // Local runs fail fast; CI absorbs the flake budget of a real browser + composed stack.
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["list"], ["github"]] : [["list"]],
  use: {
    baseURL: process.env.ADMIN_URL ?? "http://localhost:8090",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
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
