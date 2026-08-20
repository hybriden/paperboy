/**
 * Proxy a CMS-generated public file (robots.txt / sitemap.xml / llms.txt /
 * security.txt) through this frontend's origin. The CMS generates the content
 * (so it never goes stale on publish); the frontend only owns the URL. One
 * helper, four route handlers — the reference pattern for any frontend.
 */
const API = process.env.PAPERBOY_API_URL ?? "http://localhost:8091";
const PUBLIC_KEY = process.env.PAPERBOY_PUBLIC_KEY ?? "pk_live_seed_public_key_value";

export async function publicFileResponse(file: "robots.txt" | "sitemap.xml" | "llms.txt" | "security.txt"): Promise<Response> {
  const res = await fetch(`${API}/api/v1/delivery/${file}`, {
    headers: { authorization: `Bearer ${PUBLIC_KEY}` },
    // Per-request, never cached at BUILD time: an ISR/static fetch here makes
    // `next build` execute the route and dial the API, which isn't running in
    // CI/Docker builds — the whole build failed on it. The response's own
    // Cache-Control (below) keeps crawler traffic cheap instead.
    cache: "no-store",
  });
  if (!res.ok) {
    // Unconfigured (e.g. no security contact set) → an honest 404 on this origin.
    return new Response("Not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  return new Response(await res.text(), {
    status: 200,
    headers: {
      "content-type": res.headers.get("content-type") ?? "text/plain; charset=utf-8",
      "cache-control": "public, max-age=300, stale-while-revalidate=600",
    },
  });
}
