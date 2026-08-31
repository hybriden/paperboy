import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DeliveryContent } from "@paperboycms/client";
import { Renderer } from "./Renderer";

function page(data: Record<string, unknown>, fieldTypes: Record<string, string>): DeliveryContent {
  return { documentId: "doc1", type: "StandardPage", kind: "page", locale: "en", name: "Test", slug: "test", urlPath: "/test", cv: 1, data, fieldTypes, seo: null };
}

describe("Renderer — on-page-editing markers follow the SCHEMA", () => {
  // The heading got data-pb-field on every non-BlogPost type, even one with no
  // `heading` field — a click then opened an editor for a field the type lacks.
  it("marks the heading editable only when the type declares a heading field", () => {
    const withHeading = renderToStaticMarkup(<Renderer content={page({ heading: "Hi", mainArea: [] }, { heading: "text", mainArea: "contentArea" })} />);
    expect(withHeading).toContain('data-pb-field="heading"');
    const without = renderToStaticMarkup(<Renderer content={page({ mainArea: [] }, { mainArea: "contentArea" })} />);
    expect(without).toContain("Test"); // the name still renders as the title
    expect(without).not.toContain('data-pb-field="heading"');
  });
});

describe("Renderer — HeroBlock CTA", () => {
  it("drops a protocol-relative CTA (//evil.example is not a relative path)", () => {
    const hero = page(
      { heading: "Hi", mainArea: [{ blockType: "HeroBlock", display: "automatic", shared: false, data: { title: "Hero", ctaUrl: "//evil.example/x" } }] },
      { heading: "text", mainArea: "contentArea" },
    );
    const html = renderToStaticMarkup(<Renderer content={hero} />);
    expect(html).not.toContain("evil.example");
    expect(html).not.toContain("<a ");
  });
});
