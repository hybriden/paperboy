import { describe, expect, it } from "vitest";
import { createClient, PaperboyError, renderRichText } from "./index.js";

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

describe("client SDK fixes (0.4.1)", () => {
  it("keeps fetchInit.headers given as a Headers instance or an entries array, alongside the auth header", async () => {
    // `{ ...(headers as Record) }` spread a Headers instance / a [k, v][] to {}.
    const seen: HeadersInit[] = [];
    const fetch = (async (_url: string, init: { headers: HeadersInit }) => {
      seen.push(init.headers);
      return ok({ documentId: "d" });
    }) as unknown as typeof globalThis.fetch;
    for (const headers of [new Headers({ "x-custom": "1" }), [["x-custom", "1"]] as [string, string][]]) {
      const client = createClient({ baseUrl: "http://x", key: "pk_live_x", fetch, fetchInit: { headers } });
      await client.getById("doc");
      await client.submitForm("f", { values: {} });
    }
    expect(seen).toHaveLength(4);
    for (const h of seen.map((h) => new Headers(h))) {
      expect(h.get("x-custom")).toBe("1");
      expect(h.get("authorization")).toBe("Bearer pk_live_x");
    }
  });

  it("refuses protocol-relative link hrefs and image srcs in richtext (//host is off-site)", () => {
    const html = renderRichText({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "link", attrs: { href: "//evil.example/x" } }] }] },
        { type: "image", attrs: { src: "//evil.example/i.png", alt: "" } },
      ],
    });
    expect(html).not.toContain("evil.example");
    expect(html).toContain('href="#"');
    expect(html).not.toContain("<img");
    const relative = renderRichText({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "link", attrs: { href: "/about" } }] }] },
        { type: "image", attrs: { src: "/api/v1/media/a.png", alt: "" } },
      ],
    });
    expect(relative).toContain('href="/about"');
    expect(relative).toContain('src="/api/v1/media/a.png"');
  });

  it("turns a 422 with a non-JSON body into a PaperboyError, not a SyntaxError", async () => {
    const fetch = (async () => ({
      status: 422,
      ok: false,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
      headers: { get: () => null },
    })) as unknown as typeof globalThis.fetch;
    const client = createClient({ baseUrl: "http://x", key: "pk_live_x", fetch });
    const err = await client.submitForm("f", { values: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaperboyError);
    expect((err as PaperboyError).status).toBe(422);
  });
});
