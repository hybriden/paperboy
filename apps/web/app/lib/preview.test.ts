import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildContentSecurityPolicy } from "./csp";
import { isPreviewRequest, matchesPreviewSecret, safeRedirectLocation } from "./preview";

afterEach(() => {
  vi.unstubAllEnvs();
});

// What the API mints (GET /manage/preview-token): the token and its site proof.
const SECRET = "a-real-preview-secret";
const mac = (m: string) => createHmac("sha256", SECRET).update(m).digest("hex");
function minted(site: string) {
  const exp = String(Date.now() + 60_000);
  return { pbt: `${exp}.${mac(exp)}`, pbs: `${site}.${mac(`site.${exp}.${site}`)}` };
}

// One PREVIEW_SECRET serves every site, so the token alone opened this site's
// drafts for anyone who could preview ANOTHER site of the instance.
describe("isPreviewRequest checks the site with PAPERBOY_SITE_ID", () => {
  it("accepts a token minted in this site and refuses one from another", async () => {
    vi.stubEnv("PREVIEW_SECRET", SECRET);
    vi.stubEnv("PAPERBOY_SITE_ID", "site_b");
    expect(await isPreviewRequest(false, minted("site_b"))).toBe(true);
    expect(await isPreviewRequest(false, minted("site_default"))).toBe(false);
    expect(await isPreviewRequest(false, { pbt: minted("site_b").pbt })).toBe(false);
  });

  it("without it, the token alone is enough (single-site instances)", async () => {
    vi.stubEnv("PREVIEW_SECRET", SECRET);
    expect(await isPreviewRequest(false, { pbt: minted("site_default").pbt })).toBe(true);
  });
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
