import { describe, expect, it } from "vitest";
import { isPreviewOrigin, originOf } from "./preview-origin.js";

/**
 * The admin's postMessage handler turns `paperboy:drop` into a block append that
 * then autosaves, so accepting a message from the wrong sender is a content-write
 * primitive running under the editor's own session. These pin the trust boundary.
 */
describe("originOf", () => {
  it("extracts the origin of an absolute URL", () => {
    expect(originOf("https://web.example.com/en/about?x=1")).toBe("https://web.example.com");
    expect(originOf("http://localhost:8092/en")).toBe("http://localhost:8092");
  });

  it("keeps a non-default port as part of the origin", () => {
    expect(originOf("https://web.example.com:8443/en")).toBe("https://web.example.com:8443");
  });

  it("returns null for anything unparseable", () => {
    expect(originOf("")).toBeNull();
    expect(originOf(null)).toBeNull();
    expect(originOf(undefined)).toBeNull();
    expect(originOf("/en/about")).toBeNull(); // relative — no origin to trust
    expect(originOf("not a url")).toBeNull();
  });
});

describe("isPreviewOrigin", () => {
  const preview = "https://web.example.com/en/about";

  it("accepts a message from the preview frontend's origin", () => {
    expect(isPreviewOrigin("https://web.example.com", preview)).toBe(true);
  });

  it("rejects a different origin", () => {
    expect(isPreviewOrigin("https://evil.example.com", preview)).toBe(false);
  });

  it("rejects a scheme or port mismatch on the same host", () => {
    expect(isPreviewOrigin("http://web.example.com", preview)).toBe(false);
    expect(isPreviewOrigin("https://web.example.com:8443", preview)).toBe(false);
  });

  it("rejects a subdomain that merely looks similar", () => {
    expect(isPreviewOrigin("https://web.example.com.evil.test", preview)).toBe(false);
    expect(isPreviewOrigin("https://notweb.example.com", preview)).toBe(false);
  });

  it("fails closed on a missing or opaque event origin", () => {
    expect(isPreviewOrigin(null, preview)).toBe(false);
    expect(isPreviewOrigin(undefined, preview)).toBe(false);
    expect(isPreviewOrigin("", preview)).toBe(false);
    // A sandboxed frame reports the literal string "null" — never trust it, even
    // though an unparseable preview URL would also produce no origin.
    expect(isPreviewOrigin("null", preview)).toBe(false);
    expect(isPreviewOrigin("null", "null")).toBe(false);
  });

  it("fails closed when the preview URL isn't known yet", () => {
    // e.g. the site query hasn't resolved — accept nothing rather than everything.
    expect(isPreviewOrigin("https://web.example.com", undefined)).toBe(false);
    expect(isPreviewOrigin("https://web.example.com", "")).toBe(false);
  });
});
