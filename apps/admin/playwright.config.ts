import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
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
