import { describe, expect, it } from "vitest";
import { PREVIEW_TOKEN_SKEW_MS, isPreviewActivity, isPreviewOrigin, originOf, previewTokenUsable } from "./preview-origin.js";

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

describe("isPreviewActivity", () => {
  const preview = "https://web.example.com/en/blog";

  // Reported 2026-08-04: the "Preview looks empty? … refusing to be framed"
  // hint showed while the preview was rendering fine — the pane only counted
  // paperboy:preview-ready as proof of life, so a page whose bridge speaks any
  // OTHER message (or an older bridge without ready) still looked "silent".
  // ANY valid paperboy:* message from the preview origin proves the frame is
  // alive and rendering; the hint must only appear when nothing arrives.
  it("counts any paperboy:* message from the preview origin as proof of life", () => {
    expect(isPreviewActivity("https://web.example.com", preview, { type: "paperboy:preview-ready", version: 1 })).toBe(true);
    expect(isPreviewActivity("https://web.example.com", preview, { type: "paperboy:rect", field: "body" })).toBe(true);
    expect(isPreviewActivity("https://web.example.com", preview, { type: "paperboy:edit", field: "title" })).toBe(true);
  });

  it("rejects messages from any other origin (trust boundary unchanged)", () => {
    expect(isPreviewActivity("https://evil.example.com", preview, { type: "paperboy:preview-ready" })).toBe(false);
    expect(isPreviewActivity("null", preview, { type: "paperboy:preview-ready" })).toBe(false);
  });

  it("ignores non-bridge messages (react devtools, ads, random postMessage noise)", () => {
    expect(isPreviewActivity("https://web.example.com", preview, { type: "webpackWarnings" })).toBe(false);
    expect(isPreviewActivity("https://web.example.com", preview, "paperboy:preview-ready")).toBe(false);
    expect(isPreviewActivity("https://web.example.com", preview, { type: 42 })).toBe(false);
    expect(isPreviewActivity("https://web.example.com", preview, null)).toBe(false);
  });
});

describe("previewTokenUsable", () => {
  const now = 1_700_000_000_000;

  it("accepts a token with comfortable life left", () => {
    expect(previewTokenUsable(now + 10 * 60_000, now)).toBe(true);
  });

  it("rejects an EXPIRED token — framing one drops preview mode silently", () => {
    // The frontend renders published content with no bridge, which the admin
    // then reports as "no response from the preview bridge" (2026-08-22).
    expect(previewTokenUsable(now - 1, now)).toBe(false);
    expect(previewTokenUsable(now - 20 * 60_000, now)).toBe(false);
  });

  it("rejects a token inside the skew window (it can die mid-load)", () => {
    expect(previewTokenUsable(now + 30_000, now)).toBe(false);
    expect(previewTokenUsable(now + PREVIEW_TOKEN_SKEW_MS, now)).toBe(false);
    expect(previewTokenUsable(now + PREVIEW_TOKEN_SKEW_MS + 1, now)).toBe(true);
  });

  it("rejects a missing or nonsense expiry", () => {
    expect(previewTokenUsable(undefined, now)).toBe(false);
    expect(previewTokenUsable(null, now)).toBe(false);
    expect(previewTokenUsable(Number.NaN, now)).toBe(false);
    expect(previewTokenUsable(Number.POSITIVE_INFINITY, now)).toBe(false);
  });
});
