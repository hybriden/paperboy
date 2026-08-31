import { type NextRequest } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Same-origin media proxy. Media URLs from the Delivery API are relative
 * (/api/v1/media/…) so they work on any host; this runtime handler streams the
 * bytes from the API (read from PAPERBOY_API_URL at REQUEST time — not baked at
 * build time like a rewrite would be).
 */
const API = process.env.PAPERBOY_API_URL ?? "http://localhost:8091";

const plain = (body: string, status: number) => new Response(body, { status, headers: { "content-type": "text/plain" } });

export async function GET(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  // Guard against path traversal; the API only serves flat hashed filenames.
  const safe = path.filter((p) => p && !p.includes("..") && !p.includes("/"));
  const upstream = new URL(`${API}/api/v1/media/${safe.map(encodeURIComponent).join("/")}`);
  // The variant params (?w=&format=&q=) that mediaUrl()/mediaSrcset() emit —
  // without them every srcset candidate served the original bytes.
  upstream.search = req.nextUrl.search;
  let res: Response;
  try {
    res = await fetch(upstream.href);
  } catch {
    return plain("Media upstream unreachable", 502);
  }
  if (!res.ok) return plain(res.status === 404 ? "Not found" : `Media upstream error ${res.status}`, res.status);
  const headers = new Headers({
    "cache-control": res.headers.get("cache-control") ?? "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
  });
  for (const name of ["content-type", "etag"]) {
    const value = res.headers.get(name);
    if (value) headers.set(name, value);
  }
  // fetch hands back a DECODED body, so an upstream content-length is only true
  // when nothing was content-encoded.
  const length = res.headers.get("content-length");
  if (length && !res.headers.get("content-encoding")) headers.set("content-length", length);
  return new Response(res.body, { status: 200, headers });
}
