import { defineConfig } from "vitest/config";

// Unit tests for the reference frontend's pure rendering (renderToStaticMarkup,
// no DOM/network needed). Covers the HTML/markers the editor's preview bridge
// relies on (e.g. on-page-editing targets). Per-file `@vitest-environment
// happy-dom` docblocks opt individual files into a DOM.
export default defineConfig({
  test: {
    environment: "node",
    include: ["app/**/*.test.{ts,tsx}"],
  },
});
