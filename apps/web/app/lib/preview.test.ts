import { afterEach, describe, expect, it, vi } from "vitest";
import { buildContentSecurityPolicy } from "./csp";
import { matchesPreviewSecret, safeRedirectLocation } from "./preview";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("matchesPreviewSecret (S2-M11 + S2-M2)", () => {
  it("matches a correct, non-default secret", () => {
    vi.stubEnv("PREVIEW_SECRET", "a-real-preview-secret");
    expect(matchesPreviewSecret("a-real-preview-secret")).toBe(true);
    expect(matchesPreviewSecret("nope")).toBe(false);
  });
  it("never matches an absent/empty candidate", () => {
    vi.stubEnv("PREVIEW_SECRET", "a-real-preview-secret");
    expect(matchesPreviewSecret(undefined)).toBe(false);
    expect(matchesPreviewSecret("")).toBe(false);
  });
  it("refuses the committed dev default in production (no draft exposure)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PREVIEW_SECRET", "dev-preview-secret-change-me"); // the committed default
    expect(matchesPreviewSecret("dev-preview-secret-change-me")).toBe(false);
  });
});

describe("safeRedirectLocation (S2-M12)", () => {
  it("keeps a normal internal path", () => {
    expect(safeRedirectLocation("/en/about")).toBe("/en/about");
  });
  it("collapses leading slashes so it can't go protocol-relative", () => {
    expect(safeRedirectLocation("//evil.com/x")).toBe("/evil.com/x");
    expect(safeRedirectLocation("///evil.com")).toBe("/evil.com");
  });
});

describe("buildContentSecurityPolicy (S3-L1)", () => {
  it("includes frame-ancestors plus object-src/base-uri hardening", () => {
    const csp = buildContentSecurityPolicy("'self' http://localhost:8090");
    expect(csp).toContain("frame-ancestors 'self' http://localhost:8090");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
  });
});
