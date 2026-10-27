import { existsSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance, FastifyReply } from "fastify";

/**
 * The admin SPA, served by the API itself (ADMIN_DIST_DIR), so Paperboy runs as
 * ONE process on one port and the SPA and API share an origin without a proxy —
 * which the `__Host-` session cookie and the Origin/Referer CSRF check rely on.
 * This took over everything the admin's nginx used to do; admin-spa.test.ts pins it.
 */

/**
 * The admin's Content-Security-Policy, on every HTML response. The admin is the
 * authenticated editor (publish/delete/settings/token minting), so it must NEVER
 * be framed (frame-ancestors 'none'; X-Frame-Options DENY is set on every
 * response in app.ts). script-src 'self' means an XSS can't load remote code.
 * The app itself only frames the cross-origin preview (PreviewPane), which
 * frame-src http:/https: permits. img-src carries the stock provider's CDNs:
 * search thumbnails are HOTLINKED (Unsplash API terms require it — proxying
 * them would break those terms), so a bare 'self' blanked every stock search
 * result (found live 2026-08-28).
 */
export const ADMIN_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob: https://images.unsplash.com https://plus.unsplash.com; font-src 'self' data:; " +
  "connect-src 'self'; frame-src http: https:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

// A page that window.open()s the admin gets a closed handle, so it can't post
// messages into the editor or navigate it. The preview iframe is unaffected (COOP
// governs top-level windows) and the admin opens its own popups with noopener.
const ADMIN_COOP = "same-origin";

// The entry point must never be cached, or a browser keeps an old index.html
// that references hashed chunks the next deploy deleted ("Failed to fetch
// dynamically imported module"). Hashed /assets/ are immutable instead.
const NO_CACHE = "no-cache, no-store, must-revalidate";
const IMMUTABLE = "public, max-age=31536000, immutable";
// Unhashed files (manifest, icons): a change must roll out within a day.
const ONE_DAY = "public, max-age=86400";

/** Paths owned by the API and the MCP forward. Everything else is the admin's. */
const API_PATHS = ["/api", "/health", "/.well-known", "/mcp"];

/** True for a request path the admin SPA owns (its pages and static files). */
export function isAdminSpaPath(url: string): boolean {
  let path = url.split("?")[0]!;
  // Decoded as the router decodes it, or /%61pi/v1/auth/login is the login route
  // to the router but an admin page here, exempt from every rate limit.
  try {
    path = decodeURI(path);
  } catch {
    return false;
  }
  return !API_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
}

/**
 * Serve the built admin from `distDir`: static files (pre-compressed .gz
 * variants when the image built them), index.html for every client-side
 * route, and a robots.txt that keeps crawlers out. Registered on the ROOT
 * instance because it owns the not-found handler.
 */
export async function registerAdminSpa(app: FastifyInstance, distDir: string): Promise<void> {
  const indexPath = join(distDir, "index.html");
  if (!existsSync(indexPath)) {
    throw new Error(
      `ADMIN_DIST_DIR="${distDir}" has no index.html. Point it at the built admin ` +
        "(`pnpm --filter @paperboy/admin build` writes apps/admin/dist), or unset it to serve the API only.",
    );
  }
  // Read once: a new admin only ever arrives with a new deploy (a restart).
  const indexHtml = readFileSync(indexPath, "utf8");
  const sendIndex = (reply: FastifyReply) =>
    reply
      .code(200)
      .type("text/html; charset=utf-8")
      .header("Cache-Control", NO_CACHE)
      .header("Content-Security-Policy", ADMIN_CSP)
      .header("Cross-Origin-Opener-Policy", ADMIN_COOP)
      .send(indexHtml);

  // The admin is a private tool. (The robots.txt a SITE serves comes from
  // delivery, under /api/v1/delivery/robots.txt, and is proxied by the frontend.)
  app.get("/robots.txt", { schema: { hide: true } }, async (_req, reply) =>
    reply.type("text/plain; charset=utf-8").send("User-agent: *\nDisallow: /\n"),
  );

  // Explicit, because the static plugin answers a bare directory with 403.
  app.get("/", { schema: { hide: true } }, async (_req, reply) => sendIndex(reply));

  await app.register(fastifyStatic, {
    root: distDir,
    prefix: "/",
    decorateReply: false, // the media static in app.ts and swagger-ui register their own
    index: false, // index.html is answered by sendIndex, with its headers
    preCompressed: true,
    setHeaders: (res, filePath) => {
      const rel = relative(distDir, filePath).split(sep).join("/");
      if (/\.html(\.gz|\.br)?$/.test(rel)) {
        res.header("Cache-Control", NO_CACHE);
        res.header("Content-Security-Policy", ADMIN_CSP);
        res.header("Cross-Origin-Opener-Policy", ADMIN_COOP);
      } else {
        res.header("Cache-Control", rel.startsWith("assets/") ? IMMUTABLE : ONE_DAY);
      }
    },
  });

  app.setNotFoundHandler(async (req, reply) => {
    const path = req.url.split("?")[0]!;
    // GET/HEAD of an admin page → the SPA. A missing /assets/ file stays a 404:
    // HTML under a .js URL is the dynamic-import failure, only harder to see.
    if ((req.method === "GET" || req.method === "HEAD") && isAdminSpaPath(path) && !path.startsWith("/assets/")) {
      return sendIndex(reply);
    }
    // Fastify's own 404 body, so API clients see exactly what they did before.
    return reply.code(404).send({ message: `Route ${req.method}:${req.url} not found`, error: "Not Found", statusCode: 404 });
  });
}
