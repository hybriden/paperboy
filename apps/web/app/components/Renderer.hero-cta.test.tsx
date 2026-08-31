import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DeliveryContent } from "@paperboycms/client";
import { Renderer } from "./Renderer";

// The seed HeroBlock's CTA is a plain `text` field, so the write-time link-scheme
// guard (LinkValue) never sees it. React 19 neutralises `javascript:` but passes
// `data:` / `vbscript:` through — the renderer must scheme-guard the href itself.
function heroPage(data: Record<string, unknown>): DeliveryContent {
  return {
    documentId: "doc1",
    type: "StandardPage",
    kind: "page",
    locale: "en",
    name: "Test",
    slug: "test",
    urlPath: "/test",
    cv: 1,
    data: { heading: "Hi", mainArea: [{ blockType: "HeroBlock", display: "automatic", shared: false, data: { title: "Hero", ...data } }] },
    fieldTypes: { heading: "text", mainArea: "contentArea" },
    seo: null,
  };
}

describe("Renderer — HeroBlock CTA href is scheme-guarded", () => {
  it("drops a data: CTA entirely", () => {
    const html = renderToStaticMarkup(<Renderer content={heroPage({ ctaUrl: "data:text/html,<script>alert(1)</script>" })} />);
    expect(html).toContain("Hero");
    expect(html).not.toContain("data:text/html");
    expect(html).not.toContain("<a ");
  });

  it("drops a javascript: CTA entirely", () => {
    const html = renderToStaticMarkup(<Renderer content={heroPage({ ctaUrl: "javascript:alert(1)" })} />);
    expect(html).not.toContain("<a ");
  });

  it("is not fooled by case, surrounding whitespace, or C0 characters in the scheme", () => {
    for (const ctaUrl of ["JAVASCRIPT:alert(1)", "  javascript:alert(1)", "java\tscript:alert(1)", "javascript:alert(1)", "vbscript:x"]) {
      expect(renderToStaticMarkup(<Renderer content={heroPage({ ctaUrl })} />), ctaUrl).not.toContain("<a ");
    }
  });

  it("keeps a relative CTA (locale-prefixed) and an https CTA", () => {
    expect(renderToStaticMarkup(<Renderer content={heroPage({ ctaUrl: "/contact" })} />)).toContain('href="/en/contact"');
    expect(renderToStaticMarkup(<Renderer content={heroPage({ ctaUrl: "https://x" })} />)).toContain('href="https://x"');
  });

  // The built-in template HeroBlock declares `primaryLink` (a delivery-resolved
  // link value {href, text, …}) instead of the seed's `ctaUrl`.
  it("renders the template's primaryLink as the CTA, with its own text", () => {
    const html = renderToStaticMarkup(<Renderer content={heroPage({ primaryLink: { href: "/pricing", text: "See pricing" } })} />);
    expect(html).toContain('href="/en/pricing"');
    expect(html).toContain("See pricing");
  });
});
