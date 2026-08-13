import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { frameAncestorsFor } from "./csp";
import { proxy } from "../../proxy";

afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * The public site must NOT be framable in general — only while it is actually
 * being embedded as the CMS preview.
 *
 * The middleware used to emit the admin allowlist on EVERY response, so
 * `https://site.example` advertised `frame-ancestors 'self' https://cms…:8090`
 * to every anonymous visitor. That is a standing clickjacking surface on a
 * public marketing site (and it is the blanket change we were about to tell a
 * customer to make to their own frontend): the relaxation has to be scoped to
 * the framed request, not switched on site-wide.
 *
 * The discriminator is `Sec-Fetch-Dest`, a browser-controlled forbidden header a
 * page cannot forge. It reports what the response will be used AS, so it stays
 * correct when the editor clicks a link INSIDE the preview iframe — where the
 * `?pbt=` token is gone but framing must keep working. Emitting the allowlist
 * for a framed request is not itself permission: the browser still enforces
 * that the real ancestor is one of the listed admin origins.
 */
const ADMIN = "https://cms.neoteric.no";

function ancestors(overrides: Partial<Parameters<typeof frameAncestorsFor>[0]> = {}): string {
  return frameAncestorsFor({
    secFetchDest: null,
    hasPreviewCredential: false,
    hostname: "www.neoteric.no",
    adminOrigins: [ADMIN],
    ...overrides,
  });
}

describe("frameAncestorsFor: framing is scoped to the preview, not site-wide", () => {
  it("refuses framing on an ordinary top-level page view", () => {
    expect(ancestors({ secFetchDest: "document" })).toBe("'none'");
  });

  it("refuses framing on a subresource fetch too", () => {
    expect(ancestors({ secFetchDest: "empty" })).toBe("'none'");
  });

  it("allows the configured admin origin when the response IS being framed", () => {
    const csp = ancestors({ secFetchDest: "iframe" });
    expect(csp).toContain(ADMIN);
    expect(csp).not.toBe("'none'");
  });

  it("still allows framing after an in-iframe navigation drops the ?pbt= token", () => {
    // The regression this guards: keying the relaxation on the preview credential
    // alone blanks the pane the moment an editor clicks a link in the preview.
    expect(ancestors({ secFetchDest: "iframe", hasPreviewCredential: false })).toContain(ADMIN);
  });

  it("never allows an arbitrary third-party origin, even when framed", () => {
    expect(ancestors({ secFetchDest: "iframe" })).not.toContain("evil.com");
  });

  it("falls back to the preview credential when Sec-Fetch-Dest is absent (old browsers)", () => {
    expect(ancestors({ secFetchDest: null, hasPreviewCredential: true })).toContain(ADMIN);
    expect(ancestors({ secFetchDest: null, hasPreviewCredential: false })).toBe("'none'");
  });

  it("omits the localhost dev origins in production", () => {
    // Any process listening on :8090/:8093 on a visitor's own machine could
    // otherwise frame the customer's HTTPS site.
    const prod = ancestors({ secFetchDest: "iframe", isProduction: true });
    expect(prod).not.toContain("localhost");
    expect(prod, "the configured admin must still be allowed").toContain(ADMIN);
  });

  it("keeps the localhost dev origins outside production", () => {
    expect(ancestors({ secFetchDest: "iframe", isProduction: false })).toContain("http://localhost:8090");
  });

  it("allows the same hostname on the admin port, so a LAN/dev host needs no config", () => {
    const csp = ancestors({ secFetchDest: "iframe", hostname: "192.168.1.20", adminOrigins: [] });
    expect(csp).toContain("http://192.168.1.20:8090");
  });
});

describe("proxy wires the decision to the real request", () => {
  const cspOf = (res: Response) => res.headers.get("content-security-policy") ?? "";

  it("a plain visitor gets frame-ancestors 'none'", () => {
    vi.stubEnv("ADMIN_ORIGINS", ADMIN);
    const req = new NextRequest("https://www.neoteric.no/en/about", {
      headers: { host: "www.neoteric.no", "sec-fetch-dest": "document" },
    });
    expect(cspOf(proxy(req))).toContain("frame-ancestors 'none'");
  });

  it("the CMS preview iframe gets the admin origin", () => {
    vi.stubEnv("ADMIN_ORIGINS", ADMIN);
    const req = new NextRequest("https://www.neoteric.no/en/about?pbt=tok", {
      headers: { host: "www.neoteric.no", "sec-fetch-dest": "iframe" },
    });
    expect(cspOf(proxy(req))).toContain(ADMIN);
  });

  it("keeps the baseline hardening in both cases", () => {
    const req = new NextRequest("https://www.neoteric.no/", {
      headers: { host: "www.neoteric.no", "sec-fetch-dest": "document" },
    });
    const csp = cspOf(proxy(req));
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
  });

  it("sends Vary: Sec-Fetch-Dest, since the policy now depends on it", () => {
    // Without this a shared cache pins whichever policy it saw first: either the
    // preview blanks for editors, or the relaxed frame-ancestors is re-served to
    // the public — undoing the scoping entirely.
    const req = new NextRequest("https://www.neoteric.no/en/about", {
      headers: { host: "www.neoteric.no", "sec-fetch-dest": "document" },
    });
    expect(proxy(req).headers.get("vary")).toBe("Sec-Fetch-Dest");
  });

  it("does not send X-Frame-Options (it cannot express 'only when framed by the CMS')", () => {
    // XFO has no origin list — DENY/SAMEORIGIN only — so pairing it with a
    // conditional frame-ancestors would block the preview unconditionally. This
    // is exactly the header a customer frontend must DROP, so pin that we
    // practise it.
    const req = new NextRequest("https://www.neoteric.no/en/about?pbt=tok", {
      headers: { host: "www.neoteric.no", "sec-fetch-dest": "iframe" },
    });
    expect(proxy(req).headers.get("x-frame-options")).toBeNull();
  });
});
