import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./[...path]/route";

// The proxy rebuilt the upstream URL from the path segments only, so the
// `?w=&format=&q=` that mediaUrl()/mediaSrcset() emit (and the API honours) was
// dropped: every srcset candidate served the original bytes.
const request = (url: string) => GET(new NextRequest(url), { params: Promise.resolve({ path: ["a", "b.jpg"] }) });
const upstream = (init: ResponseInit = {}) => vi.fn(async () => new Response("img", { status: 200, ...init }));

afterEach(() => vi.unstubAllGlobals());

describe("media proxy", () => {
  it("forwards the variant query string to the API", async () => {
    const fetch = upstream({ headers: { "content-type": "image/webp" } });
    vi.stubGlobal("fetch", fetch);
    await request("http://localhost:8092/api/v1/media/a/b.jpg?w=320&format=webp");
    expect(fetch).toHaveBeenCalledWith("http://localhost:8091/api/v1/media/a/b.jpg?w=320&format=webp");
  });

  it("relays a non-OK upstream status with a matching message, not 'Not found'", async () => {
    vi.stubGlobal("fetch", upstream({ status: 502 }));
    const res = await request("http://localhost:8092/api/v1/media/a/b.jpg");
    expect(res.status).toBe(502);
    expect(await res.text()).not.toBe("Not found");
  });

  it("answers 502 with a plain body when the upstream fetch itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    const res = await request("http://localhost:8092/api/v1/media/a/b.jpg");
    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
  });

  it("forwards content-length, etag and cache-control when the API sends them", async () => {
    vi.stubGlobal(
      "fetch",
      upstream({ headers: { "content-type": "image/jpeg", "content-length": "3", etag: '"abc"', "cache-control": "public, max-age=60" } }),
    );
    const res = await request("http://localhost:8092/api/v1/media/a/b.jpg");
    expect(res.headers.get("content-length")).toBe("3");
    expect(res.headers.get("etag")).toBe('"abc"');
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
  });
});
