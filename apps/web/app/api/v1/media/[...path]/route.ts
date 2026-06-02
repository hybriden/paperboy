import { type NextRequest } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Same-origin media proxy. Media URLs from the Delivery API are relative
 * (/api/v1/media/…) so they work on any host; this runtime handler streams the
 * bytes from the API (read from PAPERBOY_API_URL at REQUEST time — not baked at
 * build time like a rewrite would be).
 */
const API = process.env.PAPERBOY_API_URL ?? "http://localhost:8091";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  // Guard against path traversal; the API only serves flat hashed filenames.
  const safe = path.filter((p) => p && !p.includes("..") && !p.includes("/"));
  const upstream = `${API}/api/v1/media/${safe.map(encodeURIComponent).join("/")}`;
  const res = await fetch(upstream);
  if (!res.ok) return new Response("Not found", { status: res.status });
  const headers = new Headers();
  const ct = res.headers.get("content-type");
  if (ct) headers.set("content-type", ct);
  headers.set("cache-control", res.headers.get("cache-control") ?? "public, max-age=31536000, immutable");
  headers.set("x-content-type-options", "nosniff");
  return new Response(res.body, { status: 200, headers });
}
