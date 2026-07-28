import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { buildContentSecurityPolicy, frameAncestorsFor } from "./app/lib/csp";

/** Next.js Draft Mode's bypass cookie — set once /api/draft has been entered, and
 *  carried by every later navigation inside the preview iframe. */
const DRAFT_COOKIE = "__prerender_bypass";

/**
 * Per-request CSP frame-ancestors: the admin may embed this response WHILE it is
 * being used as the preview, and an ordinary visitor is told `'none'`. See
 * frameAncestorsFor() for why the switch is `Sec-Fetch-Dest` and not the preview
 * token. Host-agnostic (localhost / LAN IP / domain) with no hard-coded origin.
 *
 * Deliberately no `X-Frame-Options`: it can only say DENY/SAMEORIGIN, so it
 * cannot express "only when framed by the CMS" and would block the preview
 * unconditionally. A customer frontend adopting this pattern must drop it too.
 */
export function middleware(req: NextRequest) {
  const res = NextResponse.next();
  const hostname = (req.headers.get("host") ?? "").split(":")[0] ?? "";
  const ancestors = frameAncestorsFor({
    secFetchDest: req.headers.get("sec-fetch-dest"),
    hasPreviewCredential:
      req.nextUrl.searchParams.has("pbt") ||
      req.nextUrl.searchParams.has("pb") ||
      req.cookies.has(DRAFT_COOKIE),
    hostname,
    adminOrigins: (process.env.ADMIN_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  });
  res.headers.set("Content-Security-Policy", buildContentSecurityPolicy(ancestors));
  return res;
}

export const config = { matcher: "/:path*" };
