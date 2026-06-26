import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * Stock image provider (Unsplash) — config, search, and import. All provider
 * HTTP is stubbed via global fetch (app.inject doesn't use fetch, so the stub
 * only intercepts outbound provider calls).
 */

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

const PHOTO = {
  id: "abc123",
  description: "A misty fjord",
  alt_description: "Misty fjord at dawn",
  width: 4000,
  height: 3000,
  urls: { regular: "https://images.unsplash.com/photo-abc123?w=1080", small: "https://images.unsplash.com/photo-abc123?w=400" },
  links: { html: "https://unsplash.com/photos/abc123", download_location: "https://api.unsplash.com/photos/abc123/download" },
  user: { name: "Jane Doe", links: { html: "https://unsplash.com/@janedoe" } },
};

/** Mutable per-test knobs read by the fetch stub. */
const knobs = {
  photo: PHOTO as typeof PHOTO | Record<string, unknown>,
  imageBytes: PNG as Buffer,
  trackingCalls: 0,
};

function stubFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith("https://api.unsplash.com/search/photos")) {
      return new Response(JSON.stringify({ results: [PHOTO] }), { status: 200 });
    }
    if (url.startsWith("https://api.unsplash.com/photos/abc123/download")) {
      knobs.trackingCalls += 1;
      return new Response(JSON.stringify({ url: "https://images.unsplash.com/photo-abc123" }), { status: 200 });
    }
    if (url.startsWith("https://api.unsplash.com/photos/")) {
      if (url.includes("missing404")) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify(knobs.photo), { status: 200 });
    }
    // The image download itself (whatever host the photo's urls.regular points at).
    return new Response(new Uint8Array(knobs.imageBytes), { status: 200 });
  });
}

describe("Stock images: config (encrypted, write-only), search, import", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  let editor: Awaited<ReturnType<typeof login>>;

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    editor = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
    vi.stubGlobal("fetch", stubFetch());
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await s.app.close();
  });

  it("search without any configured provider → self-teaching 400", async () => {
    const res = await s.app.inject({ method: "GET", url: "/api/v1/manage/stock/search?q=fjord", headers: { cookie: admin.cookie } });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("Settings → Stock images");
  });

  it("stores the key encrypted and never echoes it (configured/source/last4 only)", async () => {
    const KEY = "unsplash-access-SECRET-7777";
    const post = await s.app.inject({ method: "POST", url: "/api/v1/manage/stock/config", headers: authHeaders(admin), payload: { provider: "unsplash", apiKey: KEY } });
    expect(post.statusCode).toBe(200);
    expect(post.json()).toMatchObject({ configured: true, provider: "unsplash", source: "db", last4: "7777" });
    expect(JSON.stringify(post.json())).not.toContain(KEY);

    const get = await s.app.inject({ method: "GET", url: "/api/v1/manage/stock/config", headers: { cookie: admin.cookie } });
    expect(get.statusCode).toBe(200);
    expect(JSON.stringify(get.json())).not.toContain(KEY);
    expect(get.json().last4).toBe("7777");
  });

  it("config is Admin-only (Editor denied read + write); search is open to content.read", async () => {
    const get = await s.app.inject({ method: "GET", url: "/api/v1/manage/stock/config", headers: { cookie: editor.cookie } });
    expect(get.statusCode).toBe(403);
    const post = await s.app.inject({ method: "POST", url: "/api/v1/manage/stock/config", headers: authHeaders(editor), payload: { apiKey: "x" } });
    expect(post.statusCode).toBe(403);

    const search = await s.app.inject({ method: "GET", url: "/api/v1/manage/stock/search?q=fjord", headers: { cookie: editor.cookie } });
    expect(search.statusCode).toBe(200);
  });

  it("search maps provider photos to normalized results with UTM-tagged attribution", async () => {
    const res = await s.app.inject({ method: "GET", url: "/api/v1/manage/stock/search?q=fjord", headers: { cookie: admin.cookie } });
    expect(res.statusCode).toBe(200);
    const [hit] = res.json() as Array<Record<string, unknown>>;
    expect(hit).toMatchObject({
      id: "abc123",
      description: "Misty fjord at dawn",
      credit: "Jane Doe",
    });
    expect(hit!.creditUrl).toBe("https://unsplash.com/@janedoe?utm_source=paperboy&utm_medium=referral");
    expect(hit!.sourceUrl).toBe("https://unsplash.com/photos/abc123?utm_source=paperboy&utm_medium=referral");
  });

  it("import downloads the photo into the asset library with alt + sourceMeta, fires download tracking, audits", async () => {
    knobs.trackingCalls = 0;
    const res = await s.app.inject({ method: "POST", url: "/api/v1/manage/stock/import", headers: authHeaders(admin), payload: { providerId: "abc123" } });
    expect(res.statusCode).toBe(200);
    const asset = res.json();
    expect(asset.mime).toBe("image/png");
    expect(asset.alt).toBe("Misty fjord at dawn");
    expect(asset.sourceMeta).toMatchObject({ provider: "unsplash", providerId: "abc123", credit: "Jane Doe", providerName: "Unsplash" });
    expect(knobs.trackingCalls).toBe(1); // Unsplash download-tracking fired on import

    // The file is a regular asset — served from /api/v1/media like an upload.
    const served = await s.app.inject({ method: "GET", url: new URL(asset.url).pathname });
    expect(served.statusCode).toBe(200);
    expect(served.headers["content-type"]).toContain("image/png");

    // Audit trail, like the upload route.
    const audit = await s.app.inject({ method: "GET", url: "/api/v1/manage/audit?action=asset.import", headers: authHeaders(admin) });
    const rows = audit.json() as Array<{ action: string; documentId: string }>;
    expect(rows.some((r) => r.documentId === asset.documentId)).toBe(true);
  });

  // Each download-path test below uses its OWN photo id: stock import is
  // idempotent per provider photo, so re-importing "abc123" would return the
  // asset stored by the import test above instead of exercising the download.
  it("an alt override wins over the provider description", async () => {
    knobs.photo = { ...PHOTO, id: "alt-override" };
    try {
      const res = await s.app.inject({ method: "POST", url: "/api/v1/manage/stock/import", headers: authHeaders(admin), payload: { providerId: "alt-override", alt: "Custom alt" } });
      expect(res.statusCode).toBe(200);
      expect(res.json().alt).toBe("Custom alt");
    } finally {
      knobs.photo = PHOTO;
    }
  });

  it("rejects non-image bytes from the provider by magic sniff (415, nothing persisted)", async () => {
    knobs.photo = { ...PHOTO, id: "sniff-bad" };
    knobs.imageBytes = Buffer.from("<html>not an image, definitely</html>");
    try {
      const res = await s.app.inject({ method: "POST", url: "/api/v1/manage/stock/import", headers: authHeaders(admin), payload: { providerId: "sniff-bad" } });
      expect(res.statusCode).toBe(415);
    } finally {
      knobs.imageBytes = PNG;
      knobs.photo = PHOTO;
    }
  });

  it("rejects downloads over the 5 MB asset cap (413)", async () => {
    knobs.photo = { ...PHOTO, id: "too-big" };
    knobs.imageBytes = Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024, 2)]);
    try {
      const res = await s.app.inject({ method: "POST", url: "/api/v1/manage/stock/import", headers: authHeaders(admin), payload: { providerId: "too-big" } });
      expect(res.statusCode).toBe(413);
    } finally {
      knobs.imageBytes = PNG;
      knobs.photo = PHOTO;
    }
  });

  it("SSRF guard: refuses a download URL outside the provider's hosts (400)", async () => {
    knobs.photo = { ...PHOTO, id: "ssrf", urls: { ...PHOTO.urls, regular: "https://evil.example.com/grab?x=1" } };
    try {
      const res = await s.app.inject({ method: "POST", url: "/api/v1/manage/stock/import", headers: authHeaders(admin), payload: { providerId: "ssrf" } });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain("evil.example.com");
    } finally {
      knobs.photo = PHOTO;
    }
  });

  it("import requires CSRF (403 without token)", async () => {
    const res = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/stock/import",
      headers: { cookie: admin.cookie, origin: "http://localhost:8090" },
      payload: { providerId: "abc123" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("an unknown photo id surfaces the provider's self-teaching error", async () => {
    const res = await s.app.inject({ method: "POST", url: "/api/v1/manage/stock/import", headers: authHeaders(admin), payload: { providerId: "missing404" } });
    expect(res.statusCode).toBe(502); // provider error, message preserved (self-teaching)
    expect(res.json().message).toContain("search");
  });

  it("clearing the key disables stock search again", async () => {
    const post = await s.app.inject({ method: "POST", url: "/api/v1/manage/stock/config", headers: authHeaders(admin), payload: { apiKey: null } });
    expect(post.json()).toMatchObject({ configured: false, source: "none", last4: null });
    const search = await s.app.inject({ method: "GET", url: "/api/v1/manage/stock/search?q=fjord", headers: { cookie: admin.cookie } });
    expect(search.statusCode).toBe(400);
  });
});
