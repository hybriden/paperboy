import { draftMode } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import { fetchByPath, fetchBySlug } from "../../lib/delivery";
import { matchesPreviewSecret, safeRedirectLocation } from "../../lib/preview";

/**
 * Draft-mode entry. Validates the shared secret AND that the target resolves to
 * a real (draft-or-published) entry, then enables draft mode and redirects to a
 * sanitized internal path (never the raw query param — avoids open redirect).
 * Prefers a hierarchical `path`; falls back to a single `slug`.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(req.url);
  const secret = searchParams.get("secret");
  const locale = searchParams.get("locale") ?? "en";
  const path = searchParams.get("path");
  const slug = searchParams.get("slug");

  if (!matchesPreviewSecret(secret)) {
    return new NextResponse("Invalid preview secret", { status: 401 });
  }

  let redirectTo: string | null = null;
  if (path) {
    const clean = `/${path.split("/").filter(Boolean).join("/")}`;
    const content = await fetchByPath(clean, locale, true);
    if (content) redirectTo = `/${locale}${clean}`;
  } else {
    const content = await fetchBySlug(slug ?? "home", locale, true);
    if (content) redirectTo = `/${locale}/${content.slug ?? slug ?? "home"}`;
  }
  if (!redirectTo) return new NextResponse("No such content", { status: 404 });

  (await draftMode()).enable();
  // RELATIVE Location: the browser resolves it against the origin it actually
  // connected to, so we neither trust the spoofable Host header (open redirect,
  // S2-M12) nor emit Next's internal bind address. safeRedirectLocation collapses
  // leading slashes so a crafted locale can't make it protocol-relative.
  return new NextResponse(null, { status: 307, headers: { Location: safeRedirectLocation(redirectTo) } });
}
