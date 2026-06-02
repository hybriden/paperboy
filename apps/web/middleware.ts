import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Dynamic CSP frame-ancestors so the admin can embed the preview iframe on ANY
 * host. The admin and web share a hostname (different ports), so we allow the
 * same hostname on :8090 (the admin), plus localhost and any ADMIN_ORIGINS. This
 * is host-agnostic (localhost / LAN IP / domain) without a hard-coded origin,
 * while still blocking arbitrary third-party framing.
 */
export function middleware(req: NextRequest) {
  const res = NextResponse.next();
  const hostname = (req.headers.get("host") ?? "").split(":")[0];
  const extra = (process.env.ADMIN_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const ancestors = [
    "'self'",
    hostname ? `http://${hostname}:8090` : "",
    hostname ? `https://${hostname}:8090` : "",
    "http://localhost:8090",
    "http://localhost:8093",
    ...extra,
  ].filter(Boolean).join(" ");
  res.headers.set("Content-Security-Policy", `frame-ancestors ${ancestors}`);
  return res;
}

export const config = { matcher: "/:path*" };
