import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The production admin is served by nginx with a strict CSP (nginx.conf) that
 * the dev server never sends — so a CSP regression is invisible in dev and in
 * the Playwright suite, and only shows up deployed. Pin the policy here.
 *
 * Found live 2026-08-28: `img-src 'self' data: blob:` silently blanked every
 * stock-image search thumbnail (Unsplash hotlinks, which their API terms
 * require — importing worked because the download becomes a local asset).
 */
const conf = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "nginx.conf"), "utf8");
const policies = [...conf.matchAll(/Content-Security-Policy "([^"]+)"/g)].map((m) => m[1]!);
const directive = (policy: string, name: string) =>
  policy
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.startsWith(`${name} `) || d === name);

describe("admin nginx CSP", () => {
  it("is present on both response paths (index.html and the SPA fallback)", () => {
    expect(policies).toHaveLength(2);
    // One policy, stated twice — nginx add_header does not inherit, so the two
    // copies MUST stay identical or behavior differs by entry route.
    expect(policies[0]).toBe(policies[1]);
  });

  it("img-src allows the stock provider's image CDNs (search thumbnails are hotlinked)", () => {
    const img = directive(policies[0]!, "img-src") ?? "";
    for (const host of ["https://images.unsplash.com", "https://plus.unsplash.com"]) {
      expect(img).toContain(host);
    }
  });

  it("keeps the load-bearing restrictions", () => {
    const p = policies[0]!;
    expect(directive(p, "script-src")).toBe("script-src 'self'");
    expect(directive(p, "object-src")).toBe("object-src 'none'");
    expect(directive(p, "frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(directive(p, "base-uri")).toBe("base-uri 'none'");
    expect(directive(p, "form-action")).toBe("form-action 'self'");
    // connect-src stays 'self': the SPA talks only to its own origin (/api).
    expect(directive(p, "connect-src")).toBe("connect-src 'self'");
  });
});
