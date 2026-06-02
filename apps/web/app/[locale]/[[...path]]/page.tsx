import type { Metadata } from "next";
import { draftMode } from "next/headers";
import { PreviewBridge } from "../../components/PreviewBridge";
import { Renderer } from "../../components/Renderer";
import { fetchByPath, fetchList, fetchStart } from "../../lib/delivery";

export const dynamic = "force-dynamic";

const PREVIEW_SECRET = process.env.PREVIEW_SECRET ?? "dev-preview-secret-change-me";
/** Preview can be entered two ways: Next draft-mode cookie, OR a ?pb=<secret>
 *  query param. The query path avoids Secure cookies/redirects, so it works over
 *  plain HTTP and any host (the in-editor preview iframe uses it). */
function isPreview(enabled: boolean, sp: Record<string, string | string[] | undefined>): boolean {
  return enabled || sp.pb === PREVIEW_SECRET;
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

  const d = content.data as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const ogImg = d.ogImage as { url?: string } | null | undefined;
  const title = str(d.metaTitle) ?? content.name;
  const description = str(d.metaDescription);
  const ogImages = ogImg?.url ? [{ url: ogImg.url }] : undefined;

  return {
    title,
    description,
    robots: d.noIndex ? { index: false, follow: false } : undefined,
    alternates: str(d.canonicalUrl) ? { canonical: str(d.canonicalUrl) } : undefined,
    openGraph: {
      title: str(d.ogTitle) ?? title,
      description: str(d.ogDescription) ?? description,
      type: (str(d.ogType) as "website" | "article") ?? "website",
      images: ogImages,
    },
    twitter: {
      card: (str(d.twitterCard) as "summary" | "summary_large_image") ?? "summary_large_image",
      title: str(d.ogTitle) ?? title,
      description: str(d.ogDescription) ?? description,
      images: ogImages,
    },
  };
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

  // The Blog index lists its BlogPost children (newest first).
  let posts: Awaited<ReturnType<typeof fetchList>> | undefined;
  if (content && content.type === "StandardPage" && urlPath === "/blog") {
    posts = await fetchList("BlogPost", locale, preview);
    posts.sort((a, b) =>
      String((b.data as Record<string, unknown>).publishDate ?? "").localeCompare(
        String((a.data as Record<string, unknown>).publishDate ?? ""),
      ),
    );
  }

  if (!content) {
    return (
      <div className="notfound">
        <h1>404 — Not found</h1>
        <p>
          No {preview ? "draft or published" : "published"} content at /{locale}{urlPath}
          {isRoot ? " (no start page is set — choose one in the CMS tree → “Set as start page”)." : "."}
        </p>
      </div>
    );
  }

  return (
    <>
      {preview && (
        <div className="draft-ribbon">Preview — viewing the latest draft</div>
      )}
      <div className="langbar">
        Language: <strong>{content.locale}</strong> · URL <strong>/{locale}{urlPath || " (start page)"}</strong> · cv {content.cv}
      </div>
      <Renderer content={content} posts={posts} locale={locale} />
      {preview && <PreviewBridge />}
    </>
  );
}
