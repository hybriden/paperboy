import { defineConfig } from "vitest/config";

// Unit tests for the pure render helpers (richtext sanitiser, content-area
// utilities). The SDK's HTTP surface is end-to-end tested against a live server
// in apps/api/test/client-sdk.test.ts.
export default defineConfig({
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
