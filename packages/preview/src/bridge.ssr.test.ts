// @vitest-environment node
import { describe, expect, it } from "vitest";
import { initPreviewBridge } from "./bridge.js";

// A frontend that calls initPreviewBridge() at module scope is evaluated on the
// server too (SSR, prerender) — where `document` does not exist. That must be a
// no-op with a callable teardown, not a ReferenceError that takes the page down.
describe("initPreviewBridge without a DOM", () => {
  it("returns a no-op teardown instead of throwing", () => {
    expect(typeof document).toBe("undefined");
    let teardown: (() => void) | undefined;
    expect(() => {
      teardown = initPreviewBridge();
    }).not.toThrow();
    expect(typeof teardown).toBe("function");
    expect(() => teardown!()).not.toThrow();
  });
});
