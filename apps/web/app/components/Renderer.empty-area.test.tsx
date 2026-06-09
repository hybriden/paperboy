import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DeliveryContent } from "@paperboy/shared";
import { Renderer } from "./Renderer";

// Reported bug: a page with an EMPTY content area shows nothing to drop a block
// onto in the live preview — the area renders zero DOM, so on-page editing has
// no target. The preview needs a visible, clickable empty-area marker the
// PreviewBridge can outline (data-pb-field) and route back to the form.

function page(data: Record<string, unknown>): DeliveryContent {
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
    seo: null,
  };
}

describe("Renderer — empty content area (preview on-page editing)", () => {
  it("renders a clickable empty-area target in preview when the area has no blocks", () => {
    const html = renderToStaticMarkup(<Renderer content={page({ heading: "Hi", mainArea: [] })} preview />);
    // The bridge outlines [data-pb-field] on hover and posts paperboy:edit on
    // click; without this marker an empty area is invisible/undroppable.
    expect(html).toContain('data-pb-area="true"');
    expect(html).toContain('data-pb-field="mainArea"');
  });

  it("does NOT render the empty-area placeholder on the public (non-preview) page", () => {
    const html = renderToStaticMarkup(<Renderer content={page({ heading: "Hi", mainArea: [] })} />);
    expect(html).not.toContain("data-pb-area");
  });

  it("still renders block content when the area is non-empty (no placeholder)", () => {
    const html = renderToStaticMarkup(
      <Renderer
        content={page({
          heading: "Hi",
          mainArea: [{ blockType: "CardBlock", display: "automatic", shared: false, data: { title: "Card A" } }],
        })}
        preview
      />,
    );
    expect(html).toContain("Card A");
    expect(html).not.toContain("data-pb-area");
  });
});
