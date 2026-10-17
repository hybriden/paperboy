import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * A frontend that caches rendered pages purges on a webhook. Publish and
 * unpublish were the only events, so every other change to what delivery
 * serves ??? a page moved (new URL), a menu re-sorted, a page trashed or
 * restored, a new start page, an image's alt text, the canonical URL, a field
 * made public ??? stayed invisible in the cache until it expired. Each of these
 * now announces `delivery.changed` for the site, with the reason.
 */

interface Hit {
  event: string;
  body: { event: string; siteId: string; reason: string; documentId?: string };
}

function startStub(): Promise<{ server: Server; url: string; hits: Hit[] }> {
  const hits: Hit[] = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        hits.push({ event: String(req.headers["x-paperboy-event"] ?? ""), body: JSON.parse(body) });
        res.writeHead(200).end("ok");
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, url: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/hook`, hits });
    });
  });
}

describe("delivery.changed: every change to what a site delivers reaches its webhooks", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  let stub: Awaited<ReturnType<typeof startStub>>;
  let parentId: string;
  let pageId: string;
  const savedPrivateFlag = process.env.PAPERBOY_WEBHOOK_ALLOW_PRIVATE;

  const call = async (method: "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown) => {
    const res = await s.app.inject({ method, url: `/api/v1/manage${url}`, headers: authHeaders(admin), ...(payload === undefined ? {} : { payload: payload as object }) });
    expect(res.statusCode, `${method} ${url}: ${res.body}`).toBeLessThan(300);
    return res;
  };
  const page = async (name: string, parentDocumentId?: string) => {
    const id = (await call("POST", "/content", { type: "ArticlePage", locale: "en", name, ...(parentDocumentId ? { parentId: parentDocumentId } : {}) })).json().documentId as string;
    await call("PUT", `/content/${id}?locale=en`, { name, data: { heading: name } });
    await call("POST", `/content/${id}/publish?locale=en`);
    return id;
  };
  /** The delivery.changed event for `reason` that arrives after `from`. */
  const announced = async (from: number, reason: string) => {
    const deadline = Date.now() + 3000;
    for (;;) {
      const hit = stub.hits.slice(from).find((h) => h.event === "delivery.changed" && h.body.reason === reason);
      if (hit || Date.now() > deadline) return hit;
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  beforeAll(async () => {
    process.env.PAPERBOY_WEBHOOK_ALLOW_PRIVATE = "true";
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    stub = await startStub();
    // A catch-all hook, as the admin creates by default.
    await call("POST", "/webhooks", { name: "cache", url: stub.url });
    parentId = await page("Hook parent");
    pageId = await page("Hook child");
  });
  afterAll(async () => {
    await s.app.close();
    stub.server.close();
    if (savedPrivateFlag === undefined) delete process.env.PAPERBOY_WEBHOOK_ALLOW_PRIVATE;
    else process.env.PAPERBOY_WEBHOOK_ALLOW_PRIVATE = savedPrivateFlag;
  });

  it("moving a page (its URL changes)", async () => {
    const from = stub.hits.length;
    await call("POST", `/content/${pageId}/move`, { parentId });
    const hit = await announced(from, "moved");
    expect(hit?.body).toMatchObject({ event: "delivery.changed", siteId: "site_default", reason: "moved", documentId: pageId });
  });

  it("changing how a page's children are ordered", async () => {
    const from = stub.hits.length;
    await call("POST", `/content/${parentId}/child-sort`, { childSort: "-createdAt" });
    expect(await announced(from, "sorted")).toBeDefined();
  });

  // Restoring is not one: a restored page stays unpublished until it is
  // published again, and that publish announces itself.
  it("trashing a page", async () => {
    const from = stub.hits.length;
    await call("DELETE", `/content/${pageId}`);
    expect(await announced(from, "trashed")).toBeDefined();
  });

  it("choosing another start page", async () => {
    const from = stub.hits.length;
    await call("POST", "/site/start-page", { documentId: parentId });
    expect(await announced(from, "start-page")).toBeDefined();
  });

  it("changing the site's public-file and URL settings", async () => {
    const from = stub.hits.length;
    await call("POST", "/site/public-files", { canonicalBaseUrl: "https://www.example.com" });
    expect(await announced(from, "site-settings")).toBeDefined();
  });

  it("changing an image's alt text", async () => {
    const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
    const boundary = "----paperboyhook1234567890";
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="hook.png"\r\nContent-Type: image/png\r\n\r\n`),
      PNG,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const up = await s.app.inject({ method: "POST", url: "/api/v1/manage/assets", headers: { ...authHeaders(admin), "content-type": `multipart/form-data; boundary=${boundary}` }, payload: body });
    expect(up.statusCode, up.body).toBe(200);
    const from = stub.hits.length;
    await call("PUT", `/assets/${up.json().documentId}`, { alt: "A new description" });
    expect(await announced(from, "asset")).toBeDefined();
  });

  it("adding a redirect", async () => {
    const from = stub.hits.length;
    await call("POST", "/redirects", { source: "/old-hook", target: "/", status: 301 });
    expect(await announced(from, "redirects")).toBeDefined();
  });

  it("changing a content type (a field's delivery visibility, say) reaches every site", async () => {
    const type = (await s.app.inject({ method: "GET", url: "/api/v1/manage/content-types/ArticlePage", headers: authHeaders(admin) })).json();
    const from = stub.hits.length;
    await call("PUT", "/content-types/ArticlePage", type);
    expect(await announced(from, "content-type")).toBeDefined();
  });
});
