import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DeliveryContent } from "@paperboy/shared";
import { Renderer } from "./Renderer";

// Reported bugs around the on-page-editing drop protocol (data-pb-area):
//  1. An EMPTY content area rendered zero DOM, so on-page editing had no target.
//  2. The empty-area marker carried data-pb-area="true" — but the bridge posts
//     the attribute VALUE as the field name (paperboy:drop {field}), so the
//     editor looked up a field literally called "true" and silently ignored
//     every drop. The value must be the contentArea FIELD NAME.
//  3. A POPULATED area had no data-pb-area wrapper at all, so dragging a shared
//     block onto a page that already has blocks could never hit a drop zone.

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

describe("Renderer — content-area drop targets (preview on-page editing)", () => {
  it("renders a clickable empty-area target in preview, named after the area field", () => {
    const html = renderToStaticMarkup(<Renderer content={page({ heading: "Hi", mainArea: [] })} preview />);
    // The bridge posts paperboy:drop { field: <data-pb-area value> } — the value
    // must be the contentArea field name, never a boolean-ish marker.
    expect(html).toContain('data-pb-area="mainArea"');
    expect(html).not.toContain('data-pb-area="true"');
    expect(html).toContain('data-pb-field="mainArea"');
  });

  it("does NOT render the empty-area placeholder on the public (non-preview) page", () => {
    const html = renderToStaticMarkup(<Renderer content={page({ heading: "Hi", mainArea: [] })} />);
    expect(html).not.toContain("data-pb-area");
  });

  it("wraps a POPULATED area in a data-pb-area drop zone in preview", () => {
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
    expect(html).toContain('data-pb-area="mainArea"');
  });

  it("keeps the public (non-preview) page free of editor markers for populated areas", () => {
    const html = renderToStaticMarkup(
      <Renderer
        content={page({
          heading: "Hi",
          mainArea: [{ blockType: "CardBlock", display: "automatic", shared: false, data: { title: "Card A" } }],
        })}
      />,
    );
    expect(html).toContain("Card A");
    expect(html).not.toContain("data-pb-area");
  });
});
