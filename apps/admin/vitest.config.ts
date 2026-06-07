import { defineConfig } from "vitest/config";

// Unit tests for pure admin logic (no DOM, no network). The e2e suite
// (Playwright) covers the real UI; this covers extracted decision functions.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
