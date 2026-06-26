import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * Reported bug: importing the SAME stock photo more than once piled up
 * byte-identical duplicate assets (one production photo ended up tripled —
 * every duplicate came in via the MCP `import_stock_image` tool, where an agent
 * re-running the same "find a photo of X" task searched, got the same top hit,
 * and imported it again because nothing deduped). The import chokepoint
 * (`importStockImage`) minted a fresh documentId + file + asset row every call.
 *
 * Fix: import is idempotent per provider photo within a site — a second import
 * of the same provider+providerId returns the existing asset instead of a copy.
 *
 * Faithful surface: the real `POST /stock/import` route (parity-wrapped with the
 * MCP tool over the same `importStockImage`). The provider HTTP calls are mocked
 * so the test never touches the network.
 */

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

/** Stand in for Unsplash: photo lookup → JSON, download-tracking → ok, CDN → PNG bytes. */
function mockUnsplashFetch(): typeof globalThis.fetch {
  return (async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/download")) return new Response("ok", { status: 200 }); // tracking ping (best-effort)
    if (url.startsWith("https://api.unsplash.com/photos/")) {
      const id = decodeURIComponent(url.split("/photos/")[1].split(/[?/]/)[0]);
      return new Response(
        JSON.stringify({
          id,
          alt_description: `a photo of ${id}`,
          description: null,
          width: 1080,
          height: 720,
          urls: { regular: `https://images.unsplash.com/photo-${id}`, small: `https://images.unsplash.com/thumb-${id}` },
          links: { html: `https://unsplash.com/photos/${id}`, download_location: `https://api.unsplash.com/photos/${id}/download` },
          user: { name: "Jane Doe", links: { html: "https://unsplash.com/@jane" } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.startsWith("https://images.unsplash.com/")) return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof globalThis.fetch;
}

describe("Stock import is idempotent per provider photo (no duplicate assets)", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  let realFetch: typeof globalThis.fetch;

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    // Configure a provider key (env fallback) so resolveStockProvider returns Unsplash.
    (s.app as unknown as { stockConfig: { unsplashKey?: string } }).stockConfig.unsplashKey = "test-key";
    realFetch = globalThis.fetch;
    globalThis.fetch = mockUnsplashFetch();
  });
  afterAll(async () => {
    globalThis.fetch = realFetch;
    await s.app.close();
  });

  const importPhoto = (providerId: string, alt?: string) =>
    s.app.inject({
      method: "POST",
      url: "/api/v1/manage/stock/import",
      headers: authHeaders(admin),
      payload: { providerId, ...(alt ? { alt } : {}) },
    });

  const stockAssets = async (providerId: string) => {
    const res = await s.app.inject({ method: "GET", url: "/api/v1/manage/assets", headers: authHeaders(admin) });
    return (res.json() as Array<{ documentId: string; sourceMeta: { providerId?: string } | null }>).filter(
      (a) => a.sourceMeta?.providerId === providerId,
    );
  };

  it("re-importing the same photo returns the existing asset, not a duplicate", async () => {
    const first = await importPhoto("dup-photo");
    expect(first.statusCode).toBe(200);
    const a = first.json();

    const second = await importPhoto("dup-photo", "a different alt on the retry");
    expect(second.statusCode).toBe(200);
    const b = second.json();

    // The crux of the reported bug: a second import must NOT mint a new asset.
    expect(b.documentId).toBe(a.documentId);
    expect(await stockAssets("dup-photo")).toHaveLength(1);
  });

  it("a different photo still imports as its own asset (dedup is not over-broad)", async () => {
    const other = await importPhoto("other-photo");
    expect(other.statusCode).toBe(200);
    expect(other.json().documentId).not.toBe("");
    expect(await stockAssets("other-photo")).toHaveLength(1);
  });
});
