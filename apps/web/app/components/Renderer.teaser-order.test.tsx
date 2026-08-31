import { renderToReadableStream } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { DeliveryContent } from "@paperboycms/client";

vi.mock("../lib/delivery", () => ({ fetchList: vi.fn() }));

import { fetchList } from "../lib/delivery";
import { Renderer } from "./Renderer";

// Delivery already orders a page's children by the container's declared
// child_sort; re-sorting newest-first here overrode whatever the editor chose.
// And a child with no public path linked to "#" instead of not linking at all.
function item(name: string, publishDate: string, urlPath: string | null): DeliveryContent {
  return { documentId: name, type: "BlogPost", kind: "page", locale: "en", name, slug: name, urlPath, cv: 1, data: { title: name, publishDate }, fieldTypes: {}, seo: null };
}
const listPage: DeliveryContent = {
  documentId: "p1",
  type: "StandardPage",
  kind: "page",
  locale: "en",
  name: "Home",
  slug: "home",
  urlPath: "/home",
  cv: 1,
  data: { mainArea: [{ blockType: "ListBlock", display: "automatic", shared: false, data: { heading: "Latest", source: { documentId: "list1" }, count: 5 } }] },
  fieldTypes: { mainArea: "contentArea" },
  seo: null,
};

// ListBlock is an async server component: stream it (renderToStaticMarkup can't).
async function render(): Promise<string> {
  const stream = await renderToReadableStream(<Renderer content={listPage} />);
  await stream.allReady;
  return new Response(stream).text();
}

describe("Renderer — ListBlock teasers", () => {
  it("keeps the delivery response order (the container's child_sort), no newest-first re-sort", async () => {
    vi.mocked(fetchList).mockResolvedValue([item("older", "2020-01-01", "/older"), item("newer", "2024-01-01", "/newer")]);
    const html = await render();
    expect(html.indexOf("/en/older")).toBeLessThan(html.indexOf("/en/newer"));
  });

  it("renders no link for a child without a public path (never href=\"#\")", async () => {
    vi.mocked(fetchList).mockResolvedValue([item("hidden", "2024-01-01", null), item("shown", "2020-01-01", "/shown")]);
    const html = await render();
    expect(html).not.toContain('href="#"');
    expect(html).toContain("/en/shown");
  });
});
