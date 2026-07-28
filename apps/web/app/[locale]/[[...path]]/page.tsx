import type { Metadata } from "next";
import { draftMode } from "next/headers";
import { notFound } from "next/navigation";
import { PreviewBridge } from "../../components/PreviewBridge";
import { Renderer } from "../../components/Renderer";
import { fetchByPath, fetchList, fetchStart } from "../../lib/delivery";
import { matchesPreviewSecret, matchesPreviewToken } from "../../lib/preview";

export const dynamic = "force-dynamic";

/** Public origin used to absolutize the relative URLs in the delivered `seo`
 *  block. Configure SITE_ORIGIN in production; the fallback keeps dev working. */
function publicOrigin(): string {
  return (process.env.SITE_ORIGIN ?? "http://localhost:8092").replace(/\/+$/, "");
}

/** Preview can be entered two ways: Next draft-mode cookie, OR a ?pb=<secret>
 *  query param. The query path avoids Secure cookies/redirects, so it works over
 *  plain HTTP and any host (the in-editor preview iframe uses it). The secret is
 *  compared in constant time and the committed dev default never matches in prod. */
function isPreview(enabled: boolean, sp: Record<string, string | string[] | undefined>): boolean {
  if (enabled) return true;
  // ?pbt= — a short-lived token minted by the API for a signed-in editor. This is
  // what the in-editor iframe uses; the browser never holds the long-lived secret.
  if (matchesPreviewToken(typeof sp.pbt === "string" ? sp.pbt : undefined)) return true;
  // ?pb= — the long-lived secret. Still honoured for server-side/CLI callers that
  // legitimately hold it, but nothing browser-delivered should ever carry it.
  return matchesPreviewSecret(typeof sp.pb === "string" ? sp.pb : undefined);
}

/** Empty path ("/{locale}") → the configured START PAGE; otherwise resolve the
 *  hierarchical URL path through the page tree. */
async function resolve(locale: string, path: string[] | undefined, preview: boolean) {
  const segments = path ?? [];
  return segments.length === 0
    ? fetchStart(locale, preview)
    : fetchByPath(`/${segments.join("/")}`, locale, preview);
}

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; path?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<Metadata> {
  const { locale, path } = await params;
  const preview = isPreview((await draftMode()).isEnabled, await searchParams);
  const content = await resolve(locale, path, preview);
  if (!content) return { title: "Not found" };

  // Read the SERVER-COMPUTED `seo` block. This used to hand-roll metadata from
  // hardcoded field names (metaTitle, ogImage, noIndex…), which is exactly the
  // value-sniffing the schema-driven contract exists to remove: it only worked for
  // types that happened to use those names, silently emitted nothing for any other
  // type, and duplicated resolution rules (title fallbacks, preview → noindex,
  // private-field exclusion) that delivery already applies post-sanitize.
  const seo = content.seo;
  if (!seo) return { title: content.name };

  const ogImages = seo.og.image ? [{ url: seo.og.image.url, alt: seo.og.image.alt }] : undefined;
  return {
    title: seo.title,
    description: seo.description ?? undefined,
    // `robots` is already the resolved directive string (always noindex,nofollow
    // in preview) — pass it through rather than re-deriving it.
    robots: seo.robots,
    alternates: seo.canonicalPath ? { canonical: seo.canonicalPath } : undefined,
    openGraph: {
      title: seo.og.title,
      description: seo.og.description ?? undefined,
      type: seo.og.type as "website" | "article",
      siteName: seo.og.siteName ?? undefined,
      images: ogImages,
    },
    twitter: {
      card: seo.twitter.card as "summary" | "summary_large_image",
      title: seo.og.title,
      description: seo.og.description ?? undefined,
      images: ogImages,
    },
  };
}

/**
 * JSON-LD for the page entity plus its breadcrumb trail.
 *
 * Delivery computes the page node (per-@type correct) and leaves origin-dependent
 * URLs RELATIVE, as the contract documents — so absolutizing them is the
 * frontend's job. This is the reference implementation of that step: a customer
 * copying this file gets structured data instead of nothing.
 */
function JsonLd({ seo, origin }: { seo: NonNullable<Awaited<ReturnType<typeof resolve>>>["seo"]; origin: string }) {
  if (!seo) return null;
  const abs = (p: string) => (p.startsWith("http") ? p : `${origin}${p.startsWith("/") ? "" : "/"}${p}`);
  const graph: Record<string, unknown>[] = [
    { ...seo.jsonLd, ...(seo.canonicalPath ? { "@id": abs(seo.canonicalPath), url: abs(seo.canonicalPath) } : {}) },
  ];
  const trail = seo.breadcrumb.filter((b) => b.urlPath);
  if (trail.length > 1) {
    graph.push({
      "@type": "BreadcrumbList",
      itemListElement: trail.map((b, i) => ({
        "@type": "ListItem",
        position: i + 1,
        name: b.name,
        item: abs(b.urlPath!),
      })),
    });
  }
  return (
    <script
      type="application/ld+json"
      // Serialised server-side from server-computed, post-sanitize data.
      dangerouslySetInnerHTML={{
        __html: JSON.stringify({ "@context": "https://schema.org", "@graph": graph }).replace(/</g, "\\u003c"),
      }}
    />
  );
}

export default async function ContentPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; path?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale, path } = await params;
  const isRoot = (path ?? []).length === 0;
  const urlPath = isRoot ? "" : `/${(path ?? []).join("/")}`;
  const preview = isPreview((await draftMode()).isEnabled, await searchParams);
  const content = await resolve(locale, path, preview);

  // A ListPage lists its children of the configured type (newest first) —
  // behavior comes from the content model, never from the URL.
  let posts: Awaited<ReturnType<typeof fetchList>> | undefined;
  if (content && content.type === "ListPage") {
    const cfg = content.data as Record<string, unknown>;
    const listedType = typeof cfg.listedType === "string" && cfg.listedType ? cfg.listedType : "BlogPost";
    const pageSize = typeof cfg.pageSize === "number" && cfg.pageSize > 0 ? cfg.pageSize : 20;
    posts = await fetchList(listedType, locale, preview, content.documentId);
    const pubDate = (c: { data: unknown }): string => {
      const v = (c.data as Record<string, unknown>).publishDate;
      return typeof v === "string" ? v : "";
    };
    posts.sort((a, b) => pubDate(b).localeCompare(pubDate(a)));
    posts = posts.slice(0, pageSize);
  }

  if (!content) {
    // notFound() — NOT a 404-looking body with HTTP 200. A soft 404 gets indexed
    // as a real page, and it lies to every client that reads the status code.
    // app/not-found.tsx renders the message (and keeps the start-page hint).
    notFound();
  }

  return (
    <>
      <JsonLd seo={content.seo} origin={publicOrigin()} />
      {preview && (
        <div className="draft-ribbon">Preview — viewing the latest draft</div>
      )}
      <div className="langbar">
        Language: <strong>{content.locale}</strong> · URL <strong>/{locale}{urlPath || " (start page)"}</strong> · cv {content.cv}
      </div>
      <Renderer content={content} posts={posts} locale={locale} basePath={urlPath} preview={preview} />
      {/* ADMIN_ORIGINS is the same env var that drives the CSP frame-ancestors; its
          first entry is the admin that embeds this preview. */}
      {preview && <PreviewBridge parentOrigin={process.env.ADMIN_ORIGINS?.split(",")[0]?.trim() || undefined} />}
    </>
  );
}
