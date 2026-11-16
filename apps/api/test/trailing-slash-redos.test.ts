import { matchRedirect as clientMatch } from "@paperboycms/client";
import { type RedirectManifest, matchRedirect as sharedMatch, trimTrailingSlashes } from "@paperboy/shared";
import { describe, expect, it } from "vitest";

/**
 * CodeQL js/polynomial-redos: `s.replace(/\/+$/, "")` is quadratic in V8 on a
 * long run of slashes that is NOT at the end (each start position re-scans the
 * run, then fails at `$`). 100k slashes took seconds, so one stored redirect
 * target or AI base URL could stall the single-process API.
 */
const slashes = "/".repeat(100_000);
const fast = (fn: () => unknown) => {
  const t = performance.now();
  fn();
  return performance.now() - t;
};

describe("trailing-slash trimming is linear", () => {
  it("trimTrailingSlashes handles a long inner run of slashes", () => {
    expect(fast(() => trimTrailingSlashes(`/a${slashes}b`))).toBeLessThan(100);
    expect(trimTrailingSlashes(`/a${slashes}b`)).toBe(`/a${slashes}b`);
    expect(trimTrailingSlashes("https://x.example/v1///")).toBe("https://x.example/v1");
    expect(trimTrailingSlashes("///")).toBe("");
    expect(trimTrailingSlashes("")).toBe("");
  });

  it("matchRedirect (shared and client) onto a target with a long slash run", () => {
    const manifest: RedirectManifest = {
      version: 1,
      rules: [{ id: 1, from: "/old", match: "prefix", to: `/new${slashes}x`, status: 301, keepQuery: true }],
    };
    for (const match of [sharedMatch, clientMatch]) {
      let location: string | null | undefined;
      expect(fast(() => (location = match(manifest, "/old/page")?.location))).toBeLessThan(100);
      expect(location).toBe(`/new${slashes}x/page`);
    }
  });
});
