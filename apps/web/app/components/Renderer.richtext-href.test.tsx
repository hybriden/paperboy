import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DeliveryContent } from "@paperboy/shared";
import { Renderer } from "./Renderer";

// Richtext link marks carry an author-supplied href. The delivery sanitizer keeps
// the `link` mark but does NOT scheme-check its href, so a hostile URL reaches the
// frontend. React 19 neutralises `javascript:` itself, but NOT `data:` — a
// `data:text/html` href is a real phishing/XSS vector that the platform passes
// through. The published @paperboycms/client renderer restricts hrefs to safe
// schemes (rtSafeHref → http(s)/mailto/tel/relative/anchor); apps/web must render
// through it rather than its own walker, which emitted the href verbatim.
function page(data: Record<string, unknown>, fieldTypes: Record<string, string> = {}): DeliveryContent {
  return {
    documentId: "doc1",
    type: "StandardPage",
    kind: "page",
    locale: "en",
    name: "Test",
    slug: "test",
    urlPath: "/test",
    cv: 1,
    data,
    fieldTypes,
    seo: null,
  };
}

const linkDoc = (href: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "click me", marks: [{ type: "link", attrs: { href } }] }] }],
});

describe("Renderer — richtext link href is scheme-guarded", () => {
  it("neutralises a data: href on a richtext link mark (React does not block this scheme)", () => {
    const html = renderToStaticMarkup(
      <Renderer content={page({ heading: "Hi", body: linkDoc("data:text/html,<script>alert(1)</script>"), mainArea: [] }, { body: "richtext" })} preview />,
    );
    expect(html).toContain("click me");
    expect(html).not.toContain("data:text/html");
    expect(html).toContain('href="#"');
  });

  it("preserves a normal https href", () => {
    const html = renderToStaticMarkup(
      <Renderer content={page({ heading: "Hi", body: linkDoc("https://example.com/ok"), mainArea: [] }, { body: "richtext" })} preview />,
    );
    expect(html).toContain('href="https://example.com/ok"');
  });
});
