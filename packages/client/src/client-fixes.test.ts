import { describe, expect, it } from "vitest";
import { createClient, renderRichText } from "./index.js";

// Minimal Response-like stub for the SDK's fetch usage.
function ok(body: unknown, etag?: string) {
  return {
    status: 200,
    ok: true,
    json: async () => body,
    headers: { get: (k: string) => (k.toLowerCase() === "etag" ? etag ?? null : null) },
  };
}

describe("client SDK fixes (S2-L4, S2-L3, S2-M5)", () => {
  it("S2-L4: renderRichText emits a valid heading for a non-numeric level (no <hNaN>)", () => {
    const html = renderRichText({
      type: "doc",
      content: [{ type: "heading", attrs: { level: "abc" }, content: [{ type: "text", text: "x" }] }],
    });
    expect(html).not.toContain("hNaN");
    expect(html).toContain("<h2>"); // falls back to level 2
  });

  it("S2-L3: an explicit empty-string filter value is sent, not silently dropped", async () => {
    let captured = "";
    const fetch = (async (url: string) => {
      captured = url;
      return ok({ items: [], total: 0, cv: 0 });
    }) as unknown as typeof globalThis.fetch;
    const client = createClient({ baseUrl: "http://x", key: "pk_live_x", fetch });
    await client.list("BlogPost", { filter: { status: "" } });
    expect(captured).toContain("data.status=");
  });

  it("S2-M5: the etag cache is bounded — the oldest entry is evicted (LRU)", async () => {
    const seen: Array<{ ifNoneMatch: unknown }> = [];
    const fetch = (async (_url: string, init: { headers?: Record<string, string> }) => {
      seen.push({ ifNoneMatch: init?.headers?.["if-none-match"] });
      return ok({ documentId: "d" }, 'W/"cv-1"');
    }) as unknown as typeof globalThis.fetch;
    const client = createClient({ baseUrl: "http://x", key: "pk_live_x", etagCache: true, fetch });

    await client.getById("doc-0"); // caches the oldest entry
    for (let i = 1; i <= 600; i++) await client.getById(`doc-${i}`); // flood past the 500 cap
    seen.length = 0;
    await client.getById("doc-0"); // re-request the oldest
    expect(seen[0]?.ifNoneMatch).toBeUndefined(); // evicted → no conditional header sent
  });
});
