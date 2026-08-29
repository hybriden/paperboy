import type { Metadata } from "next";
import { draftMode } from "next/headers";
import { notFound } from "next/navigation";
import { PreviewBridge } from "../../../../components/PreviewBridge";
import { StandaloneBlock } from "../../../../components/Renderer";
import { fetchById } from "../../../../lib/delivery";
import { isPreviewRequest } from "../../../../lib/preview";

export const dynamic = "force-dynamic";

/**
 * Standalone block preview — part of the documented preview contract.
 *
 * The CMS editor frames this route to show a shared block WITHOUT a host page:
 * a block that isn't placed anywhere yet (a form being built, say) previews
 * here, rendered by the same component that renders it inline on pages.
 *
 * Preview-authenticated ONLY (draft cookie / ?pbt token / ?pb secret), and a
 * hard 404 otherwise: this is editor chrome, not a public surface — without
 * the gate it would open draft reads by documentId enumeration on the public
 * site, bypassing the published-only perspective the public key enforces.
 */
export const metadata: Metadata = { title: "Block preview", robots: "noindex, nofollow" };

export default async function BlockPreviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; documentId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale, documentId } = await params;
  const preview = await isPreviewRequest((await draftMode()).isEnabled, await searchParams);
  if (!preview) notFound();

  const content = await fetchById(documentId, locale, true);
  if (!content) notFound();

  return (
    <>
      <div className="draft-ribbon">Standalone preview — this block renders here without a page</div>
      <StandaloneBlock content={content} locale={locale} preview />
      <PreviewBridge parentOrigin={process.env.ADMIN_ORIGINS?.split(",")[0]?.trim() || undefined} />
    </>
  );
}
