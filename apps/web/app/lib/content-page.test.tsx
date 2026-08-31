import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeliveryContent } from "@paperboycms/client";

vi.mock("next/headers", () => ({ draftMode: async () => ({ isEnabled: false }) }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("./delivery", () => ({ fetchStart: vi.fn(), fetchByPath: vi.fn(), fetchList: vi.fn() }));

import ContentPage from "../[locale]/[[...path]]/page";
import { fetchByPath, fetchList } from "./delivery";

const seo: NonNullable<DeliveryContent["seo"]> = {
  title: "About",
  description: null,
  canonicalPath: "/about",
  robots: "index, follow",
  og: { title: "About", description: null, type: "website", image: null, siteName: null },
  twitter: { card: "summary" },
  jsonLd: { "@type": "WebPage", name: "About" },
  breadcrumb: [{ name: "Home", urlPath: "/" }, { name: "About", urlPath: "/about" }],
};
function content(over: Partial<DeliveryContent> = {}): DeliveryContent {
  return { documentId: "p1", type: "StandardPage", kind: "page", locale: "en", name: "About", slug: "about", urlPath: "/about", cv: 1, data: {}, fieldTypes: {}, seo, ...over };
}
async function render(path: string[]): Promise<string> {
  return renderToStaticMarkup(await ContentPage({ params: Promise.resolve({ locale: "en", path }), searchParams: Promise.resolve({}) }));
}
const jsonLd = (html: string) => html.match(/<script type="application\/ld\+json">(.*?)<\/script>/)?.[1] ?? "";

afterEach(() => vi.unstubAllEnvs());

describe("content page — JSON-LD origin", () => {
  // Compose never set SITE_ORIGIN (and passes "" when the host has none), so
  // every deploy advertised http://localhost:8092 as the page's @id/url and
  // breadcrumb items. Without a real origin, omit the absolute values.
  it("omits @id/url/item in production when SITE_ORIGIN is unset or empty", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SITE_ORIGIN", "");
    vi.mocked(fetchByPath).mockResolvedValue(content());
    const ld = jsonLd(await render(["about"]));
    expect(ld).toContain('"@type":"WebPage"');
    expect(ld).toContain("BreadcrumbList");
    expect(ld).not.toContain("localhost");
    expect(ld).not.toContain('"@id"');
    expect(ld).not.toContain('"url"');
    expect(ld).not.toContain('"item"');
  });

  it("absolutizes against SITE_ORIGIN when it is configured", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SITE_ORIGIN", "https://www.example.com/");
    vi.mocked(fetchByPath).mockResolvedValue(content());
    const ld = jsonLd(await render(["about"]));
    expect(ld).toContain('"@id":"https://www.example.com/about"');
    expect(ld).toContain('"item":"https://www.example.com/"');
  });

  it("keeps the localhost default outside production (dev still gets full JSON-LD)", async () => {
    vi.stubEnv("SITE_ORIGIN", "");
    vi.mocked(fetchByPath).mockResolvedValue(content());
    expect(jsonLd(await render(["about"]))).toContain('"@id":"http://localhost:8092/about"');
  });
});

describe("content page — ListPage", () => {
  it("lists children in the delivery response order (the container's child_sort)", async () => {
    vi.mocked(fetchByPath).mockResolvedValue(content({ type: "ListPage", data: { listedType: "BlogPost", pageSize: 20 } }));
    const post = (name: string, publishDate: string): DeliveryContent =>
      content({ documentId: name, type: "BlogPost", name, slug: name, urlPath: `/about/${name}`, data: { title: name, publishDate }, seo: null });
    vi.mocked(fetchList).mockResolvedValue([post("older", "2020-01-01"), post("newer", "2024-01-01")]);
    const html = await render(["about"]);
    expect(html.indexOf("/en/about/older")).toBeLessThan(html.indexOf("/en/about/newer"));
  });
});
