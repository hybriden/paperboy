import { draftMode } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import { fetchByPath, fetchBySlug } from "../../lib/delivery";

const PREVIEW_SECRET = process.env.PREVIEW_SECRET ?? "dev-preview-secret-change-me";

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

  if (secret !== PREVIEW_SECRET) {
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
  // Build the absolute URL from the forwarded host (NOT req.url, whose host is
  // Next's internal bind address → would emit localhost and break LAN/domain).
  const proto = req.headers.get("x-forwarded-proto") ?? "http";
  const host = req.headers.get("host") ?? new URL(req.url).host;
  return NextResponse.redirect(new URL(redirectTo, `${proto}://${host}`));
}
