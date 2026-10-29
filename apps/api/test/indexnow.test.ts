import { INDEXNOW_ENDPOINT, flushIndexNow } from "@paperboy/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PUBLIC_KEY, type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * IndexNow: an opt-in key per site, served for the frontend to proxy as
 * /indexnow.txt, and every URL a publish, move, unpublish or trash touched
 * sent in one batch per site. noIndex pages are never announced.
 */
describe("IndexNow", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  const pub = { authorization: `Bearer ${PUBLIC_KEY}` };
  let blogId = "";
  let postId = "";

  const keyFile = () => s.app.inject({ method: "GET", url: "/api/v1/delivery/indexnow.txt", headers: pub });
  const setFiles = (payload: Record<string, unknown>) =>
    s.app.inject({ method: "POST", url: "/api/v1/manage/site/public-files", headers: authHeaders(admin), payload });
  const manage = (method: "PUT" | "POST", url: string, payload?: Record<string, unknown>) =>
    s.app.inject({ method, url: `/api/v1/manage/content/${url}`, headers: authHeaders(admin), payload });
  /** Flush the queue against a stubbed IndexNow and return what each request carried. */
  const sent = async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 202 }));
    await flushIndexNow(s.app.db);
    const bodies = fetchSpy.mock.calls.map(([url, init]) => {
      expect(url).toBe(INDEXNOW_ENDPOINT);
      return JSON.parse(init?.body as string) as { host: string; key: string; keyLocation: string; urlList: string[] };
    });
    fetchSpy.mockRestore();
    return bodies;
  };

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    const pages = (await s.app.inject({ method: "GET", url: "/api/v1/delivery/pages", headers: pub })).json().pages as { documentId: string; locale: string; urlPath: string }[];
    blogId = pages.find((p) => p.locale === "en" && p.urlPath === "/blog")!.documentId;
    postId = pages.find((p) => p.locale === "en" && p.urlPath === "/blog/hello-paperboy")!.documentId;
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await s.app.close();
  });

  it("is off by default: no key file, and a publish sends nothing", async () => {
    expect((await keyFile()).statusCode).toBe(404);
    expect((await keyFile()).json().message).toContain("Settings");
    expect((await manage("POST", `${postId}/unpublish?locale=en`)).statusCode).toBe(200);
    expect((await manage("POST", `${postId}/publish?locale=en`)).statusCode).toBe(200);
    expect(await sent()).toEqual([]);
  });

  it("switching on mints a key the key file serves; switching on again keeps it; off removes it", async () => {
    expect((await setFiles({ canonicalBaseUrl: "https://www.example.com", indexNow: true })).statusCode).toBe(200);
    const first = await keyFile();
    expect(first.statusCode).toBe(200);
    expect(first.body).toMatch(/^[0-9a-f]{32}$/);
    await setFiles({ indexNow: true });
    expect((await keyFile()).body).toBe(first.body);
    await setFiles({ indexNow: false });
    expect((await keyFile()).statusCode).toBe(404);
    await setFiles({ indexNow: true });
  });

  it("a moved page announces its old and new URL and its subtree's, in one request", async () => {
    await sent(); // drop anything queued before this test
    const key = (await keyFile()).body;
    expect((await manage("PUT", `${blogId}?locale=en`, { data: {}, merge: true, slug: "news" })).statusCode).toBe(200);
    expect((await manage("POST", `${blogId}/publish?locale=en`)).statusCode).toBe(200);
    const bodies = await sent();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ host: "www.example.com", key, keyLocation: "https://www.example.com/indexnow.txt" });
    expect(bodies[0]!.urlList).toEqual(
      expect.arrayContaining([
        "https://www.example.com/en/blog",
        "https://www.example.com/en/news",
        "https://www.example.com/en/blog/hello-paperboy",
        "https://www.example.com/en/news/hello-paperboy",
      ]),
    );
  });

  it("unpublish and trash announce the URLs that went away", async () => {
    expect((await manage("POST", `${postId}/unpublish?locale=en`)).statusCode).toBe(200);
    expect((await sent())[0]!.urlList).toEqual(["https://www.example.com/en/news/hello-paperboy"]);
    expect((await manage("POST", `${postId}/publish?locale=en`)).statusCode).toBe(200);
    await sent();
    const trash = await s.app.inject({ method: "DELETE", url: `/api/v1/manage/content/${postId}`, headers: authHeaders(admin) });
    expect(trash.statusCode).toBeLessThan(300);
    expect((await sent())[0]!.urlList).toContain("https://www.example.com/en/news/hello-paperboy");
  });

  it("a noIndex page is not announced", async () => {
    expect((await manage("PUT", `${blogId}?locale=en`, { data: { noIndex: true }, merge: true })).statusCode).toBe(200);
    expect((await manage("POST", `${blogId}/publish?locale=en`)).statusCode).toBe(200);
    expect(await sent()).toEqual([]);
  });
});
