import { runRedirectRetention, schemaTables } from "@paperboy/db";
import { matchRedirect } from "@paperboy/shared";
import { createClient, matchRedirect as clientMatch } from "@paperboycms/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PREVIEW_KEY, PUBLIC_KEY, type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * Redirects (Settings → Redirects): rules stored per site, served as one
 * manifest, applied by the frontend only where no page answers. These pin the
 * link-equity rules — page targets never chain, a slug change or move leaves a
 * 301 behind, loops are refused — plus the traffic endpoint, import/export and
 * the site URL scheme.
 */

type Rule = {
  id: number;
  source: string;
  sourcePath: string;
  match: "exact" | "prefix";
  target: { kind: string; documentId?: string; url?: string | null; path?: string };
  status: number;
  origin: string;
  hits: number;
  lastHitAt: string | null;
  problems: { code: string }[];
};
type Manifest = { version: 1; rules: { id: number; from: string; match: "exact" | "prefix"; to: string | null; status: 301 | 302 | 307 | 308 | 410; keepQuery: boolean }[] };

describe("redirects", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  const pub = { authorization: `Bearer ${PUBLIC_KEY}` };
  let blogId = "";
  let postId = "";

  const manifest = async () => (await s.app.inject({ method: "GET", url: "/api/v1/delivery/redirects", headers: pub })).json() as Manifest;
  const rules = async () => (await s.app.inject({ method: "GET", url: "/api/v1/manage/redirects", headers: { cookie: admin.cookie } })).json() as Rule[];
  const create = (payload: Record<string, unknown>) => s.app.inject({ method: "POST", url: "/api/v1/manage/redirects", headers: authHeaders(admin), payload });
  const test = async (url: string) =>
    (await s.app.inject({ method: "GET", url: `/api/v1/manage/redirects/test?url=${encodeURIComponent(url)}`, headers: { cookie: admin.cookie } })).json() as {
      hops: number;
      steps: { path: string; result: string; location?: string | null }[];
    };
  const publishSlug = async (id: string, slug: string) => {
    const put = await s.app.inject({ method: "PUT", url: `/api/v1/manage/content/${id}?locale=en`, headers: authHeaders(admin), payload: { data: {}, merge: true, slug } });
    expect(put.statusCode).toBe(200);
    const pubRes = await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${id}/publish?locale=en`, headers: authHeaders(admin) });
    expect(pubRes.statusCode).toBe(200);
  };

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    const pages = (await s.app.inject({ method: "GET", url: "/api/v1/delivery/pages", headers: pub })).json().pages as { documentId: string; locale: string; urlPath: string }[];
    blogId = pages.find((p) => p.locale === "en" && p.urlPath === "/blog")!.documentId;
    postId = pages.find((p) => p.locale === "en" && p.urlPath === "/blog/hello-paperboy")!.documentId;
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("serves an empty manifest per key, and refuses without one", async () => {
    expect(await manifest()).toEqual({ version: 1, rules: [] });
    expect((await s.app.inject({ method: "GET", url: "/api/v1/delivery/redirects" })).statusCode).toBe(401);
  });

  it("a path that names a live page is stored as that page; sources are normalized", async () => {
    const res = await create({ source: "https://www.old-site.no/Old-Post/", target: "/en/blog/hello-paperboy" });
    expect(res.statusCode).toBe(200);
    const r = res.json().redirect as Rule;
    expect(r.sourcePath).toBe("/old-post");
    expect(r.target).toMatchObject({ kind: "page", documentId: postId, url: "/en/blog/hello-paperboy" });
    expect(r.status).toBe(301);
    expect((await manifest()).rules).toContainEqual(expect.objectContaining({ from: "/old-post", to: "/en/blog/hello-paperboy", status: 301 }));
  });

  it("refuses duplicates, self-redirects, loops and 410s with a target — each with a self-teaching message", async () => {
    const dup = await create({ source: "/old-post", target: "/x" });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().message).toContain("already exists");

    const self = await create({ source: "/same", target: "/same/" });
    expect(self.statusCode).toBe(422);
    expect(self.json().message).toContain("itself");

    expect((await create({ source: "/loop-a", target: "/loop-b" })).statusCode).toBe(200);
    const loop = await create({ source: "/loop-b", target: "/loop-a" });
    expect(loop.statusCode).toBe(422);
    expect(loop.json().message).toContain("loop");

    const goneWithTarget = await create({ source: "/gone", target: "/x", status: 410 });
    expect(goneWithTarget.statusCode).toBe(422);
    const gone = await create({ source: "/gone", status: 410 });
    expect(gone.statusCode).toBe(200);
    expect((await manifest()).rules).toContainEqual(expect.objectContaining({ from: "/gone", to: null, status: 410 }));

    const query = await create({ source: "/q?x=1", target: "/x" });
    expect(query.statusCode).toBe(422);
    expect(query.json().message).toContain("query");
  });

  it("collapses a chain at write, and re-points rules that pointed at a new rule's source", async () => {
    // /via → /old-post, which is itself redirected to the post: stored as the post.
    const via = await create({ source: "/via", target: "/old-post" });
    expect(via.json().collapsed).toBe(true);
    expect(via.json().redirect.target).toMatchObject({ kind: "page", documentId: postId });

    // /c → /d (nothing there yet), then /d → the blog: /c is re-pointed to the blog.
    expect((await create({ source: "/c", target: "/d" })).statusCode).toBe(200);
    const d = await create({ source: "/d", target: "/en/blog" });
    expect(d.json().repointed).toBe(1);
    const c = (await rules()).find((r) => r.sourcePath === "/c")!;
    expect(c.target).toMatchObject({ kind: "page", documentId: blogId });
    expect((await test("/c")).hops).toBe(1);
  });

  it("prefix rules carry the rest of the path; the test endpoint follows a URL hop by hop", async () => {
    expect((await create({ source: "/gammel-blogg/*", target: "/en/blog" })).statusCode).toBe(200);
    const t = await test("/gammel-blogg/hello-paperboy?utm=x");
    expect(t.steps[0]).toMatchObject({ result: "redirect", location: "/en/blog/hello-paperboy?utm=x" });
    expect(t.steps.at(-1)).toMatchObject({ result: "page" });
    expect((await test("/nothing-here")).steps).toEqual([{ path: "/nothing-here", result: "not-found" }]);

    const m = await manifest();
    expect(matchRedirect(m, "/Gammel-Blogg/a/")?.location).toBe("/en/blog/a");
    expect(matchRedirect(m, "/gammel-bloggen")).toBeNull();
  });

  it("flags a rule whose source is a live page as shadowed (it would never fire)", async () => {
    await create({ source: "/en/blog", target: "/x" });
    const r = (await rules()).find((x) => x.sourcePath === "/en/blog")!;
    expect(r.problems.map((p) => p.code)).toContain("shadowed");
    await s.app.inject({ method: "POST", url: "/api/v1/manage/redirects/delete", headers: authHeaders(admin), payload: { ids: [r.id] } });
  });

  it("publishing a new slug leaves a 301 for the page AND its subtree; page-target rules follow without a chain", async () => {
    await publishSlug(blogId, "news");
    const all = await rules();
    const auto = all.filter((r) => r.origin === "auto");
    expect(auto).toContainEqual(expect.objectContaining({ sourcePath: "/en/blog", target: expect.objectContaining({ documentId: blogId, url: "/en/news" }) }));
    expect(auto).toContainEqual(expect.objectContaining({ sourcePath: "/en/blog/hello-paperboy", target: expect.objectContaining({ documentId: postId, url: "/en/news/hello-paperboy" }) }));
    // The editor's rule to the post now resolves to the post's NEW url: one hop, not two.
    expect((await manifest()).rules).toContainEqual(expect.objectContaining({ from: "/old-post", to: "/en/news/hello-paperboy" }));
    const t = await test("/en/blog/hello-paperboy");
    expect(t.hops).toBe(1);
    expect(t.steps.at(-1)).toMatchObject({ path: "/en/news/hello-paperboy", result: "page" });

    // Renamed back: the old automatic rule (from the url it has again) is removed, a new one covers /en/news.
    await publishSlug(blogId, "blog");
    const after = await rules();
    expect(after.some((r) => r.sourcePath === "/en/blog" && r.origin === "auto")).toBe(false);
    expect(after).toContainEqual(expect.objectContaining({ sourcePath: "/en/news", origin: "auto" }));
    expect((await test("/en/news/hello-paperboy")).steps.at(-1)).toMatchObject({ path: "/en/blog/hello-paperboy", result: "page" });
  });

  it("moving a published page leaves a 301 from its old URL", async () => {
    const moved = await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${postId}/move`, headers: authHeaders(admin), payload: { parentId: null } });
    expect(moved.statusCode).toBe(200);
    const t = await test("/en/blog/hello-paperboy");
    expect(t.steps.at(-1)).toMatchObject({ path: "/en/hello-paperboy", result: "page" });
    expect(t.hops).toBe(1);
    await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${postId}/move`, headers: authHeaders(admin), payload: { parentId: blogId } });
  });

  it("traffic: counts rule hits and logs 404 paths without query strings or scanner noise; public key only, never a cookie", async () => {
    const id = (await rules()).find((r) => r.sourcePath === "/old-post")!.id;
    const res = await s.app.inject({
      method: "POST",
      url: "/api/v1/delivery/traffic",
      headers: pub,
      payload: { redirectHits: [id, id], notFound: ["/missing-page/?email=a@b.no", "/wp-login.php", "/Missing-Page"] },
    });
    expect(res.statusCode).toBe(202);
    const rule = (await rules()).find((r) => r.id === id)!;
    expect(rule.hits).toBe(2);
    expect(rule.lastHitAt).not.toBeNull();

    const nf = (await s.app.inject({ method: "GET", url: "/api/v1/manage/redirects/not-found", headers: { cookie: admin.cookie } })).json() as { path: string; hits: number; coveredBy: number | null }[];
    expect(nf).toEqual([expect.objectContaining({ path: "/missing-page", hits: 2, coveredBy: null })]);

    // Once a rule answers the path, the 404 entry says so.
    await create({ source: "/missing-page", target: "/en/blog" });
    const covered = (await s.app.inject({ method: "GET", url: "/api/v1/manage/redirects/not-found", headers: { cookie: admin.cookie } })).json() as { coveredBy: number | null }[];
    expect(covered[0]!.coveredBy).not.toBeNull();

    expect((await s.app.inject({ method: "POST", url: "/api/v1/delivery/traffic", headers: { authorization: `Bearer ${PREVIEW_KEY}` }, payload: { notFound: ["/x"] } })).statusCode).toBe(403);
    // A session cookie is not a credential here.
    expect((await s.app.inject({ method: "POST", url: "/api/v1/delivery/traffic", headers: { cookie: admin.cookie }, payload: { notFound: ["/x"] } })).statusCode).toBe(401);
  });

  it("the hourly sweep drops 404 entries logged before the noise filter knew them", async () => {
    await s.app.db.insert(schemaTables.notFoundPath).values([
      { siteId: "site_default", path: "/wp-json/wp/v2/users/me", hits: 272 },
      { siteId: "site_default", path: "/.aws/credentials", hits: 28 },
      { siteId: "site_default", path: "/karriere", hits: 3 },
    ]);
    const { notFoundSwept } = await runRedirectRetention(s.app.db);
    expect(notFoundSwept).toBe(2);
    const nf = (await s.app.inject({ method: "GET", url: "/api/v1/manage/redirects/not-found", headers: { cookie: admin.cookie } })).json() as { path: string }[];
    expect(nf.map((r) => r.path)).toContain("/karriere");
    expect(nf.map((r) => r.path)).not.toContain("/wp-json/wp/v2/users/me");
    expect(nf.map((r) => r.path)).not.toContain("/.aws/credentials");
  });

  it("imports CSV with a dry-run preview and per-row errors, and exports what it imported", async () => {
    const csv = [
      "source;target;status;note",
      "/wp/om-oss/;/en/blog;301;old about",
      "/wp/borte/;;410;",
      "/wp/broken;not-a-path;301;",
      "/old-post;/en/blog;301;", // updates the existing rule
    ].join("\n");
    const dry = await s.app.inject({ method: "POST", url: "/api/v1/manage/redirects/import", headers: authHeaders(admin), payload: { csv, dryRun: true } });
    expect(dry.statusCode).toBe(200);
    expect(dry.json()).toMatchObject({ created: 2, updated: 1, errors: 1 });
    expect(dry.json().rows).toContainEqual(expect.objectContaining({ line: 4, action: "error", message: expect.stringContaining("must be a path") }));
    expect((await rules()).some((r) => r.sourcePath === "/wp/om-oss")).toBe(false); // dry run wrote nothing

    const real = await s.app.inject({ method: "POST", url: "/api/v1/manage/redirects/import", headers: authHeaders(admin), payload: { csv, dryRun: false } });
    expect(real.json()).toMatchObject({ created: 2, updated: 1, errors: 1 });
    const imported = (await rules()).find((r) => r.sourcePath === "/wp/om-oss")!;
    expect(imported).toMatchObject({ origin: "import", target: { kind: "page", documentId: blogId } });

    const exported = await s.app.inject({ method: "GET", url: "/api/v1/manage/redirects.csv", headers: { cookie: admin.cookie } });
    expect(exported.headers["content-type"]).toContain("text/csv");
    expect(exported.body).toContain("/wp/om-oss,/en/blog,301");
    expect(exported.body).toContain("/wp/borte,,410");
  });

  it("follows the site's locale prefix setting: default locale unprefixed in redirect targets and the sitemap", async () => {
    const cfg = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/site/public-files",
      headers: authHeaders(admin),
      payload: { localePrefix: "except-default", canonicalBaseUrl: "https://www.example.com" },
    });
    expect(cfg.statusCode).toBe(200);
    expect((await manifest()).rules).toContainEqual(expect.objectContaining({ from: "/old-post", to: "/blog" }));
    const sitemap = await s.app.inject({ method: "GET", url: "/api/v1/delivery/sitemap.xml", headers: pub });
    expect(sitemap.body).toContain("<loc>https://www.example.com/blog/hello-paperboy</loc>");
    expect(sitemap.body).toContain("https://www.example.com/nb/");
    await s.app.inject({ method: "POST", url: "/api/v1/manage/site/public-files", headers: authHeaders(admin), payload: { localePrefix: "always" } });
  });

  it("@paperboycms/client: redirects() + matchRedirect + reportTraffic against the live server", async () => {
    const base = await s.app.listen({ port: 0, host: "127.0.0.1" });
    const cms = createClient({ baseUrl: base, key: PUBLIC_KEY });
    const m = await cms.redirects();
    const hit = clientMatch(m, "/old-post?utm_source=x");
    expect(hit).toMatchObject({ status: 301, location: "/en/blog?utm_source=x" });
    await cms.reportTraffic({ redirectHits: [hit!.rule.id], notFound: ["/from-the-client"] });
    const nf = (await s.app.inject({ method: "GET", url: "/api/v1/manage/redirects/not-found", headers: { cookie: admin.cookie } })).json() as { path: string }[];
    expect(nf.map((n) => n.path)).toContain("/from-the-client");
    await expect(createClient({ baseUrl: base, key: PREVIEW_KEY }).reportTraffic({ notFound: ["/x"] })).rejects.toMatchObject({ status: 403 });
  });

  it("RBAC: a Viewer reads, an Author cannot write", async () => {
    const viewer = await login(s.app, "viewer@paperboy.test", "Viewer!Passw0rd");
    expect((await s.app.inject({ method: "GET", url: "/api/v1/manage/redirects", headers: { cookie: viewer.cookie } })).statusCode).toBe(200);
    const author = await login(s.app, "author@paperboy.test", "Author!Passw0rd");
    expect((await s.app.inject({ method: "POST", url: "/api/v1/manage/redirects", headers: authHeaders(author), payload: { source: "/a", target: "/b" } })).statusCode).toBe(403);
  });
});
