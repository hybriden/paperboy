import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * GET /manage/dashboard — the editor's "what needs my attention" aggregate:
 * work-in-progress drafts, the scheduled publish queue, translation coverage
 * and housekeeping counts. Site-partitioned and RBAC'd like every other scan.
 */
describe("dashboard aggregate", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  let ed: Awaited<ReturnType<typeof login>>;

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    ed = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
  });

  const dash = (headers: Record<string, string>) => s.app.inject({ method: "GET", url: "/api/v1/manage/dashboard", headers });

  it("requires authentication", async () => {
    const r = await s.app.inject({ method: "GET", url: "/api/v1/manage/dashboard" });
    expect(r.statusCode).toBe(401);
  });

  it("lists work-in-progress drafts: brand-new docs as 'new', edited published docs as 'updated'", async () => {
    // A fresh page is a draft with no published sibling → "new".
    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(ed),
      payload: { type: "ArticlePage", locale: "en", name: "WIP Article" },
    });
    expect(created.statusCode, created.body).toBe(200);
    const freshId = created.json().documentId as string;

    // Editing a PUBLISHED page (seeded Home) forks a draft → "updated".
    const home = (await s.app.inject({ method: "GET", url: "/api/v1/manage/content/tree", headers: authHeaders(ed) }))
      .json()
      .find((n: { name: string }) => n.name === "Home");
    expect(home).toBeTruthy();
    const put = await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${home.documentId}?locale=en`,
      headers: authHeaders(ed),
      payload: { data: { heading: "Welcome (edited)" } },
    });
    expect(put.statusCode, put.body).toBe(200);

    const r = await dash(authHeaders(ed));
    expect(r.statusCode, r.body).toBe(200);
    const wip = r.json().wip as Array<{ documentId: string; name: string; locale: string; change: string }>;
    const fresh = wip.find((w) => w.documentId === freshId);
    expect(fresh).toMatchObject({ name: "WIP Article", locale: "en", change: "new" });
    const homeWip = wip.find((w) => w.documentId === home.documentId);
    expect(homeWip).toMatchObject({ change: "updated" });
  });

  it("lists the scheduled publish queue (timed go-live and expiry)", async () => {
    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(ed),
      payload: { type: "ArticlePage", locale: "en", name: "Scheduled Article" },
    });
    expect(created.statusCode, created.body).toBe(200);
    const docId = created.json().documentId as string;
    // Scheduling validates the draft strictly — fill the required field first.
    const filled = await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${docId}?locale=en`,
      headers: authHeaders(ed),
      payload: { data: { heading: "Scheduled Article" } },
    });
    expect(filled.statusCode, filled.body).toBe(200);
    const publishAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const sched = await s.app.inject({
      method: "POST",
      url: `/api/v1/manage/content/${docId}/schedule?locale=en`,
      headers: authHeaders(ed),
      payload: { publishAt, expireAt: null },
    });
    expect(sched.statusCode, sched.body).toBe(200);

    const r = await dash(authHeaders(ed));
    expect(r.statusCode, r.body).toBe(200);
    const scheduled = r.json().scheduled as Array<{ documentId: string; action: string; at: string }>;
    const entry = scheduled.find((x) => x.documentId === docId && x.action === "publish");
    expect(entry).toBeTruthy();
    expect(new Date(entry!.at).getTime()).toBe(new Date(publishAt).getTime());
  });

  it("reports translation coverage per enabled locale, with the missing pages listed (actionable)", async () => {
    const r = await dash(authHeaders(ed));
    expect(r.statusCode, r.body).toBe(200);
    const translation = r.json().translation as Array<{
      locale: string;
      displayName: string;
      missing: number;
      pages: { documentId: string; name: string }[];
    }>;
    const nb = translation.find((t) => t.locale === "nb");
    expect(nb).toBeTruthy();
    expect(nb!.missing).toBeGreaterThan(0); // seed only translates Home to nb
    // The gap is actionable: the missing pages come back with names so the
    // dashboard can deep-link each one into the editor at that locale.
    expect(nb!.pages.length).toBeGreaterThan(0);
    expect(nb!.pages.length).toBeLessThanOrEqual(10);
    expect(nb!.pages.some((p) => p.name === "Blog")).toBe(true); // seeded, en-only
    const en = translation.find((t) => t.locale === "en");
    expect(en?.missing ?? 0).toBe(0); // every seeded page has an EN variant
    expect(en?.pages).toEqual([]);
  });

  it("housekeeping: trash count moves with deletes; unused shared blocks are counted; webhook health is admin-only", async () => {
    // A block referenced by nothing → unused.
    const blk = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(ed),
      payload: { type: "CardBlock", kind: "block", locale: "en", name: "Orphan Block" },
    });
    expect(blk.statusCode, blk.body).toBe(200);

    // Trash one page.
    const doc = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(ed),
      payload: { type: "ArticlePage", locale: "en", name: "Trashed Article" },
    });
    const del = await s.app.inject({ method: "DELETE", url: `/api/v1/manage/content/${doc.json().documentId}`, headers: authHeaders(ed) });
    expect(del.statusCode, del.body).toBe(200);

    const r = await dash(authHeaders(ed));
    expect(r.statusCode, r.body).toBe(200);
    const hk = r.json().housekeeping as {
      trash: number;
      unusedBlocks: number;
      emptyTypes: number;
      missingAlt: number;
      failingWebhooks: number | null;
    };
    expect(hk.missingAlt).toBeGreaterThanOrEqual(0); // counted per site (raster images with empty alt)
    expect(hk.trash).toBeGreaterThanOrEqual(1);
    // EXACTLY the Orphan Block: the seeded Featured Card is embedded by Home's
    // content area, and usage must be detected from the version data itself —
    // content_reference rows don't exist for seeded (never-saved) documents.
    expect(hk.unusedBlocks).toBe(1);
    expect(hk.emptyTypes).toBeGreaterThanOrEqual(0);
    // Editor lacks webhook.manage → webhook health is withheld, not zeroed.
    expect(hk.failingWebhooks).toBeNull();

    const ra = await dash(authHeaders(admin));
    expect((ra.json().housekeeping as { failingWebhooks: number | null }).failingWebhooks).toBe(0);
  });

  it("is partitioned by the active site — a fresh site sees an empty dashboard", async () => {
    const site = (
      await s.app.inject({ method: "POST", url: "/api/v1/manage/sites", headers: authHeaders(admin), payload: { slug: "dash-x", name: "Dash X", defaultLocale: "en" } })
    ).json();
    const r = await dash({ ...authHeaders(admin), "x-paperboy-site": site.id });
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json();
    expect(body.wip).toEqual([]);
    expect(body.scheduled).toEqual([]);
    expect(body.housekeeping.trash).toBe(0);
    expect(body.housekeeping.unusedBlocks).toBe(0);
  });
});
