import { type DeliveryContent as ClientDeliveryContent, PaperboyError, createClient, mediaSrcset, mediaUrl } from "@paperboy/client";
import type { DeliveryContent as SharedDeliveryContent } from "@paperboy/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PREVIEW_KEY, PUBLIC_KEY, type Suite, authHeaders, login, setupApi } from "./helpers.js";

// COMPILE-TIME parity: the client ships its own DeliveryContent (zero-dep npm
// package); it must stay assignable BOTH ways with the server's shared schema
// type. A drift in either direction breaks this file's typecheck/transform.
const _sharedToClient: ClientDeliveryContent = {} as SharedDeliveryContent;
const _clientToShared: SharedDeliveryContent = {} as ClientDeliveryContent;
void _sharedToClient;
void _clientToShared;

/**
 * @paperboy/client end-to-end: the SDK talks REAL HTTP to a listening api
 * (not inject), so the full contract — auth header, query building, ETag
 * replay, error mapping — is exercised exactly as a consumer would.
 */

describe("@paperboy/client against a live server", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  let baseUrl: string;
  let pub: ReturnType<typeof createClient>;
  let prev: ReturnType<typeof createClient>;

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    baseUrl = await s.app.listen({ port: 0, host: "127.0.0.1" });
    pub = createClient({ baseUrl, key: PUBLIC_KEY });
    prev = createClient({ baseUrl, key: PREVIEW_KEY });
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("getById: published item resolves; a draft-only item is null under the public key, visible under preview", async () => {
    const home = await pub.getById(s.ids.homeId);
    expect(home?.name).toBe("Home");
    expect(home?.documentId).toBe(s.ids.homeId);

    expect(await pub.getById(s.ids.secretId)).toBeNull(); // seeded secret draft
    const secret = await prev.getById(s.ids.secretId);
    expect(secret?.documentId).toBe(s.ids.secretId);
  });

  it("getBySlug / getByPath / startPage / global resolve the seeded graph", async () => {
    expect((await pub.getBySlug("blog"))?.documentId).toBe(s.ids.blogId);
    expect((await pub.getByPath("/blog"))?.documentId).toBe(s.ids.blogId);
    expect((await pub.startPage())?.documentId).toBe(s.ids.homeId);
    const settings = await pub.global("SiteSettings");
    expect(settings?.type).toBe("SiteSettings");
  });

  it("list: pagination, sorting and data filters round-trip through the query string", async () => {
    const all = await pub.list("BlogPost");
    expect(all.total).toBeGreaterThanOrEqual(2);
    expect(all.items.length).toBe(all.total);

    const page = await pub.list("BlogPost", { limit: 1, offset: 1, sort: "name" });
    expect(page.items.length).toBe(1);
    expect(page.total).toBe(all.total);

    // Filter on a data field: tag one post, then find exactly it.
    const target = all.items[0]!;
    await s.app.inject({ method: "PUT", url: `/api/v1/manage/content/${target.documentId}?locale=en`, headers: authHeaders(admin), payload: { data: { author: "SDK Fixture" }, merge: true } });
    await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${target.documentId}/publish?locale=en`, headers: authHeaders(admin) });
    const filtered = await pub.list("BlogPost", { filter: { author: "SDK Fixture" } });
    expect(filtered.total).toBe(1);
    expect(filtered.items[0]!.documentId).toBe(target.documentId);
  });

  it("search finds published text and stays draft-blind under the public key", async () => {
    const created = await s.app.inject({ method: "POST", url: "/api/v1/manage/content", headers: authHeaders(admin), payload: { type: "BlogPost", parentId: s.ids.blogId, locale: "en", name: "SDK Search Post" } });
    const id = created.json().documentId as string;
    await s.app.inject({ method: "PUT", url: `/api/v1/manage/content/${id}?locale=en`, headers: authHeaders(admin), payload: { data: { title: "SDK", body: "the okapisdktoken hides here" } } });

    // Draft only → public search is blind, preview search finds it.
    expect((await pub.search("okapisdktoken")).items.length).toBe(0);
    expect((await prev.search("okapisdktoken")).items.some((i) => i.documentId === id)).toBe(true);

    await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${id}/publish?locale=en`, headers: authHeaders(admin) });
    expect((await pub.search("okapisdktoken")).items.some((i) => i.documentId === id)).toBe(true);
  });

  it("etagCache: the second request replays If-None-Match and serves the 304 from cache", async () => {
    const statuses: number[] = [];
    const counting: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      statuses.push(res.status);
      return res;
    };
    const cached = createClient({ baseUrl, key: PUBLIC_KEY, etagCache: true, fetch: counting });
    const first = await cached.getById(s.ids.homeId);
    const second = await cached.getById(s.ids.homeId);
    expect(statuses).toEqual([200, 304]);
    expect(second).toEqual(first); // 304 → identical body from the cache
  });

  it("errors are typed: a bad key throws PaperboyError(401) with a helpful message", async () => {
    const bad = createClient({ baseUrl, key: "pk_live_wrong" });
    const err = await bad.getById(s.ids.homeId).catch((e) => e as PaperboyError);
    expect(err).toBeInstanceOf(PaperboyError);
    expect((err as PaperboyError).status).toBe(401);
    expect((err as PaperboyError).message).toContain("delivery key");
  });

  it("mediaUrl/mediaSrcset build variant URLs for CMS media and pass external URLs through", () => {
    const cms = "https://cms.example.com/api/v1/media/abc.jpg";
    expect(mediaUrl(cms, { w: 640, format: "webp" })).toBe(`${cms}?w=640&format=webp`);
    expect(mediaUrl("https://images.unsplash.com/x.jpg", { w: 640 })).toBe("https://images.unsplash.com/x.jpg");
    expect(mediaSrcset(cms)).toContain("w=320&format=webp 320w");
    expect(mediaSrcset("https://elsewhere.com/x.jpg")).toBe("");
  });
});
