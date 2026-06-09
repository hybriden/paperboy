import { defineConfig } from "vitest/config";

// protocol.test.ts is pure (node); bridge.test.ts drives real DOM events via
// happy-dom. Per-file environment is set with a docblock comment.
export default defineConfig({
  test: { include: ["src/**/*.test.ts"] },
});
