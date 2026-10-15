import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_CSP } from "../src/admin-spa.js";
import { buildApp } from "../src/app.js";
import { loadEnv } from "../src/env.js";
import { type Suite, TEST_DB, setupApi } from "./helpers.js";

/**
 * The API serves the built admin SPA itself (ADMIN_DIST_DIR), so Paperboy runs
 * as ONE container on one port — no nginx in front. Everything nginx used to do
 * for the admin is pinned here: the strict CSP + no-cache on the entry point,
 * immutable hashed assets, pre-compressed bytes, the SPA fallback, the
 * crawler-blocking robots.txt — and that /api 404s stay JSON.
 */
const INDEX = `<!doctype html><html><head><script type="module" src="/assets/app-abc123.js"></script></head><body>admin</body></html>`;
const BUNDLE = `console.log("admin bundle");`.repeat(50);

function makeDist(): string {
  const dir = mkdtempSync(join(tmpdir(), "paperboy-admin-dist-"));
  mkdirSync(join(dir, "assets"));
  mkdirSync(join(dir, "icons"));
  writeFileSync(join(dir, "index.html"), INDEX);
  writeFileSync(join(dir, "assets", "app-abc123.js"), BUNDLE);
  writeFileSync(join(dir, "assets", "app-abc123.js.gz"), gzipSync(BUNDLE));
  writeFileSync(join(dir, "manifest.webmanifest"), `{"name":"Paperboy"}`);
  writeFileSync(join(dir, "icons", "icon-192.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return dir;
}

let suite: Suite;
beforeAll(async () => {
  suite = await setupApi({ ADMIN_DIST_DIR: makeDist() });
});
afterAll(async () => {
  await suite.app.close();
});

function expectEntryPoint(res: { statusCode: number; headers: Record<string, unknown>; body: string }): void {
  expect(res.statusCode).toBe(200);
  expect(String(res.headers["content-type"])).toMatch(/^text\/html/);
  expect(res.body).toBe(INDEX);
  expect(res.headers["content-security-policy"]).toBe(ADMIN_CSP);
  expect(res.headers["x-frame-options"]).toBe("DENY");
  // A cached index.html references hashed chunks the next deploy deleted.
  expect(res.headers["cache-control"]).toBe("no-cache, no-store, must-revalidate");
}

describe("admin SPA served by the API", () => {
  it("serves the entry point at / with the CSP and no-cache", async () => {
    expectEntryPoint(await suite.app.inject({ method: "GET", url: "/" }));
  });

  it("serves /index.html with the same headers", async () => {
    expectEntryPoint(await suite.app.inject({ method: "GET", url: "/index.html" }));
  });

  it("falls back to the entry point for client-side routes", async () => {
    for (const url of ["/content/abc", "/settings/site", "/oauth/authorize?client_id=x&state=y"]) {
      expectEntryPoint(await suite.app.inject({ method: "GET", url }));
    }
  });

  it("serves hashed assets pre-compressed and immutable", async () => {
    const res = await suite.app.inject({ method: "GET", url: "/assets/app-abc123.js", headers: { "accept-encoding": "gzip" } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-encoding"]).toBe("gzip");
    expect(String(res.headers["content-type"])).toMatch(/javascript/);
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(String(res.headers.vary)).toMatch(/accept-encoding/i);
  });

  it("serves the uncompressed asset to a client that does not accept gzip", async () => {
    const res = await suite.app.inject({ method: "GET", url: "/assets/app-abc123.js", headers: { "accept-encoding": "identity" } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(res.body).toBe(BUNDLE);
  });

  it("404s a missing asset instead of answering with index.html", async () => {
    // HTML under a .js URL is the "Failed to fetch dynamically imported module" trap.
    const res = await suite.app.inject({ method: "GET", url: "/assets/gone-after-deploy.js" });
    expect(res.statusCode).toBe(404);
    expect(String(res.headers["content-type"])).not.toMatch(/text\/html/);
  });

  it("keeps API 404s as JSON", async () => {
    const res = await suite.app.inject({ method: "GET", url: "/api/v1/no-such-route" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "Not Found", statusCode: 404 });
  });

  it("only falls back for GET/HEAD — a POST to an unknown path is a JSON 404", async () => {
    const res = await suite.app.inject({ method: "POST", url: "/content/abc", payload: {} });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "Not Found" });
  });

  it("serves a robots.txt that keeps crawlers out of the admin", async () => {
    const res = await suite.app.inject({ method: "GET", url: "/robots.txt" });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers["content-type"])).toMatch(/^text\/plain/);
    expect(res.body).toBe("User-agent: *\nDisallow: /\n");
  });

  it("serves the PWA manifest and icons with a short cache", async () => {
    const manifest = await suite.app.inject({ method: "GET", url: "/manifest.webmanifest" });
    expect(manifest.statusCode).toBe(200);
    expect(String(manifest.headers["content-type"])).toMatch(/^application\/manifest\+json/);
    expect(manifest.headers["cache-control"]).toBe("public, max-age=86400");
    const icon = await suite.app.inject({ method: "GET", url: "/icons/icon-192.png" });
    expect(icon.statusCode).toBe(200);
    expect(icon.headers["cache-control"]).toBe("public, max-age=86400");
  });
});

describe("admin SPA configuration", () => {
  it("refuses to boot when ADMIN_DIST_DIR has no index.html", async () => {
    const empty = mkdtempSync(join(tmpdir(), "paperboy-admin-empty-"));
    const env = loadEnv({ DATABASE_URL: TEST_DB, NODE_ENV: "test", ADMIN_DIST_DIR: empty });
    await expect(buildApp({ env })).rejects.toThrow(/ADMIN_DIST_DIR.*index\.html/);
  });

  it("does not serve anything at / when ADMIN_DIST_DIR is unset", async () => {
    const env = loadEnv({ DATABASE_URL: TEST_DB, NODE_ENV: "test" });
    const app = await buildApp({ env });
    try {
      const res = await app.inject({ method: "GET", url: "/" });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: "Not Found" });
    } finally {
      await app.close();
    }
  });

  it("does not count admin pages and assets against the API rate limit", async () => {
    // A cold admin load fetches dozens of chunks; nginx never rate-limited them,
    // and an office behind one IP must not lock itself out by opening the editor.
    // NODE_ENV=test lifts the limit out of reach, so use development with 2.
    const limited = await setupApi({ NODE_ENV: "development", RATE_LIMIT_MAX: "2", ADMIN_DIST_DIR: makeDist() });
    try {
      for (const url of ["/", "/assets/app-abc123.js", "/assets/app-abc123.js", "/content/abc", "/robots.txt"]) {
        expect((await limited.app.inject({ method: "GET", url })).statusCode).toBe(200);
      }
      // The limit itself is still in force for the API.
      const codes: number[] = [];
      for (let i = 0; i < 3; i++) codes.push((await limited.app.inject({ method: "GET", url: "/health" })).statusCode);
      expect(codes).toContain(429);
    } finally {
      await limited.app.close();
    }
  });
});

/**
 * The admin's Content-Security-Policy. Moved here from the nginx config, where
 * it was pinned by apps/admin/src/nginx-csp.test.ts.
 *
 * Found live 2026-08-28: `img-src 'self' data: blob:` silently blanked every
 * stock-image search thumbnail (Unsplash hotlinks, which their API terms
 * require — importing worked because the download becomes a local asset).
 */
describe("admin CSP", () => {
  const directive = (name: string) =>
    ADMIN_CSP.split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith(`${name} `) || d === name);

  it("img-src allows the stock provider's image CDNs (search thumbnails are hotlinked)", () => {
    const img = directive("img-src") ?? "";
    for (const host of ["https://images.unsplash.com", "https://plus.unsplash.com"]) {
      expect(img).toContain(host);
    }
  });

  it("keeps the load-bearing restrictions", () => {
    expect(directive("script-src")).toBe("script-src 'self'");
    expect(directive("object-src")).toBe("object-src 'none'");
    expect(directive("frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(directive("base-uri")).toBe("base-uri 'none'");
    expect(directive("form-action")).toBe("form-action 'self'");
    // connect-src stays 'self': the SPA talks only to its own origin (/api).
    expect(directive("connect-src")).toBe("connect-src 'self'");
  });
});
