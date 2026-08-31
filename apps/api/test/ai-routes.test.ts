import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * AI route honesty contract: with no provider key configured, model-requiring
 * tasks answer 409 with a self-teaching message (never the input dressed up as
 * a 200 "result"), while the deterministic truncation tasks still serve a
 * clearly-labeled fallback. /ai/alt-text is vision-only — no filename
 * heuristics — so it is 409 without a key too.
 */
describe("AI routes — no provider key", () => {
  let s: Suite;
  let ed: Awaited<ReturnType<typeof login>>;

  beforeAll(async () => {
    // Make the no-key state deterministic even if the host shell has a key.
    delete process.env.ANTHROPIC_API_KEY;
    s = await setupApi();
    ed = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("/ai/status reports disabled", async () => {
    const r = await s.app.inject({ method: "GET", url: "/api/v1/ai/status", headers: authHeaders(ed) });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().enabled).toBe(false);
  });

  it("/ai/assist: truncation tasks still work, labeled as fallback", async () => {
    const r = await s.app.inject({
      method: "POST",
      url: "/api/v1/ai/assist",
      headers: authHeaders(ed),
      payload: { task: "meta_title", input: "A long headline about something. And more." },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ result: "A long headline about something", provider: "fallback" });
  });

  for (const task of ["improve", "rewrite", "translate", "variants", "write", "schema_fields"]) {
    it(`/ai/assist: '${task}' answers 409 with a self-teaching message`, async () => {
      const r = await s.app.inject({
        method: "POST",
        url: "/api/v1/ai/assist",
        headers: authHeaders(ed),
        payload: { task, input: "some text", targetLocale: "nb" },
      });
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json().message).toContain("Settings → AI");
    });
  }

  it("/ai/assist: 'alt_text' is refused and points to the vision route (L1)", async () => {
    const r = await s.app.inject({ method: "POST", url: "/api/v1/ai/assist", headers: authHeaders(ed), payload: { task: "alt_text", input: "photo.jpg" } });
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().message).toMatch(/\/ai\/alt-text|vision/i);
  });

  it("/ai/alt-text requires a key (409), auth (401), and an existing asset", async () => {
    const noAuth = await s.app.inject({ method: "POST", url: "/api/v1/ai/alt-text", payload: { documentId: "x" } });
    expect(noAuth.statusCode).toBe(401);

    const r = await s.app.inject({
      method: "POST",
      url: "/api/v1/ai/alt-text",
      headers: authHeaders(ed),
      payload: { documentId: "does-not-exist" },
    });
    // No key configured → the route refuses before touching the asset.
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().message).toContain("Settings → AI");
  });

  // /ai/alt-text decodes the stored bytes with sharp. The media route caps the
  // decoded pixel count (a 40000×40000 header on a tiny file is a decompression
  // bomb); this route must use the same limit and answer with a self-teaching
  // 413, not a 500 or an unbounded decode.
  it("/ai/alt-text refuses an image whose header exceeds the pixel limit (413, names the limit)", async () => {
    const realFetch = globalThis.fetch;
    const { default: sharp } = await import("sharp");
    const { crc32 } = await import("node:zlib");
    const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: "#fff" } }).png().toBuffer();
    // Patch IHDR (bytes 16..23 = width, height) and recompute its CRC (over "IHDR" + data).
    png.writeUInt32BE(40_000, 16);
    png.writeUInt32BE(40_000, 20);
    png.writeUInt32BE(crc32(png.subarray(12, 29)) >>> 0, 29);

    const boundary = "----paperboyalt1234567890";
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="bomb.png"\r\nContent-Type: image/png\r\n\r\n`),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const up = await s.app.inject({ method: "POST", url: "/api/v1/manage/assets", headers: { ...authHeaders(ed), "content-type": `multipart/form-data; boundary=${boundary}` }, payload: body });
    expect(up.statusCode, up.body).toBe(200);

    s.app.aiEnv.ANTHROPIC_API_KEY = "sk-test";
    let modelCalls = 0;
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url instanceof Request ? url.url : url).includes("api.anthropic.com")) {
        modelCalls++;
        return new Response(JSON.stringify({ content: [{ type: "text", text: "never" }] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return realFetch(url as never, init as never);
    }) as typeof fetch;
    try {
      const r = await s.app.inject({ method: "POST", url: "/api/v1/ai/alt-text", headers: authHeaders(ed), payload: { documentId: up.json().documentId } });
      expect(r.statusCode, r.body).toBe(413);
      expect(r.json().message).toMatch(/pixel/i);
      expect(modelCalls).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
      s.app.aiEnv.ANTHROPIC_API_KEY = undefined;
    }
  });

  it("/ai/translate refuses with ai_unavailable when no key is set (no copy-source echo)", async () => {
    const r = await s.app.inject({
      method: "POST",
      url: "/api/v1/ai/translate",
      headers: authHeaders(ed),
      payload: { texts: ["Hello", "World"], targetLocale: "nb" },
    });
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error).toBe("ai_unavailable");
  });
});
