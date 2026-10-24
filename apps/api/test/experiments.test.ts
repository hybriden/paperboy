import { createExperiment, getAccessContext, recordFormConversions, runExperimentTicker, setAgentReviewRequired, startExperiment } from "@paperboy/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PREVIEW_KEY, PUBLIC_KEY, type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * A/B experiments (#125): REST, delivery, counting, the ticker and the rules
 * from docs/plans/2026-10-22-ab-testing.md.
 */
describe("A/B experiments", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  let editor: Awaited<ReturnType<typeof login>>;
  let viewer: Awaited<ReturnType<typeof login>>;
  let author: Awaited<ReturnType<typeof login>>;

  const manage = (who: Awaited<ReturnType<typeof login>>, method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: unknown) =>
    s.app.inject({ method, url: `/api/v1/manage${url}`, headers: authHeaders(who), ...(payload === undefined ? {} : { payload: payload as object }) });
  const deliver = (documentId: string, key = PUBLIC_KEY, etag?: string) =>
    s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${documentId}?locale=en&populate=1`, headers: { authorization: `Bearer ${key}`, ...(etag ? { "if-none-match": etag } : {}) } });
  const traffic = (payload: object, key = PUBLIC_KEY) => s.app.inject({ method: "POST", url: "/api/v1/delivery/traffic", headers: { authorization: `Bearer ${key}` }, payload });
  const card = (title: string, extra: Record<string, unknown> = {}) => ({ key: `k_${title.replace(/\W/g, "")}`, blockType: "CardBlock", display: "automatic", inline: { title, ...extra }, ref: null });

  /** A published ArticlePage of our own, so experiments don't share an area. */
  const page = async (name: string) => {
    const id = (await manage(admin, "POST", "/content", { type: "ArticlePage", locale: "en", name })).json().documentId as string;
    await manage(admin, "PUT", `/content/${id}?locale=en`, { name, data: { heading: name, mainArea: [card("Control card")] } });
    expect((await manage(admin, "POST", `/content/${id}/publish?locale=en`)).statusCode).toBe(200);
    return id;
  };
  const create = (who: Awaited<ReturnType<typeof login>>, documentId: string, over: Record<string, unknown> = {}) =>
    manage(who, "POST", "/experiments", { documentId, locale: "en", area: "mainArea", name: "Card headline", goal: "form", baselineRate: 0.1, mde: 0.3, arms: [{ label: "Shorter", blocks: [card("Version B card")] }], ...over });

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    editor = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
    viewer = await login(s.app, "viewer@paperboy.test", "Viewer!Passw0rd");
    author = await login(s.app, "author@paperboy.test", "Author!Passw0rd");
    // A private field on the card: it must never reach delivery through a version.
    const type = (await manage(admin, "GET", "/content-types/CardBlock")).json();
    type.fields.push({ name: "internalNote", displayName: "Internal note", type: "text", localized: true, required: false, delivery: "private", allowedBlocks: [], allowedTypes: [], group: "Content" });
    expect((await manage(admin, "PUT", "/content-types/CardBlock", type)).statusCode).toBe(200);
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("permissions: a Viewer can't create, an out-of-scope Author can't, an Editor can", async () => {
    const id = await page("Perm page");
    expect((await create(viewer, id)).statusCode).toBe(403);
    expect((await create(author, id)).statusCode).toBe(403);
    const ok = await create(editor, id);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ status: "draft", area: "mainArea", needsReview: false, arms: [{ key: "a", blocks: null }, { key: "b", label: "Shorter" }] });
    expect((await manage(viewer, "GET", `/experiments/${ok.json().id}`)).statusCode).toBe(200);
    expect((await manage(viewer, "POST", `/experiments/${ok.json().id}/start`)).statusCode).toBe(403);
  });

  it("a version's blocks get the area's own validation, with the version named", async () => {
    const id = await page("Validation page");
    const bad = await create(editor, id, { arms: [{ blocks: [{ key: "x", blockType: "TextBlockThatDoesNotExist", display: "automatic", inline: {}, ref: null }] }] });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().message).toMatch(/^Version B: /);
    const notAllowed = await create(editor, id, { arms: [{ blocks: [{ key: "y", blockType: "FormTextField", display: "automatic", inline: { name: "x", label: "X" }, ref: null }] }] });
    expect(notAllowed.statusCode, notAllowed.body).toBe(422);
    const area = await create(editor, id, { area: "heading" });
    expect(area.statusCode).toBe(422);
    expect(area.json().message).toMatch(/not a content area of ArticlePage.*mainArea/);
    const goal = await create(editor, id, { goal: "clicks" });
    expect(goal.json().message).toMatch(/"form".*"event:<name>"/);
  });

  it("delivery: nothing before start; then the versions, sanitized, with a new ETag; preview sees the draft", async () => {
    const id = await page("Delivery page");
    const exp = (await create(editor, id, { arms: [{ blocks: [card("Version B card", { internalNote: "top secret" })] }] })).json();
    const before = await deliver(id);
    expect(before.json().experiments).toBeUndefined();
    expect((await deliver(id, PREVIEW_KEY)).json().experiments).toMatchObject([{ id: exp.id, status: "draft" }]);

    expect((await manage(editor, "POST", `/experiments/${exp.id}/start`)).statusCode).toBe(200);
    const after = await deliver(id);
    expect(after.headers.etag).not.toBe(before.headers.etag);
    expect((await deliver(id, PUBLIC_KEY, String(before.headers.etag))).statusCode).toBe(200); // the old ETag no longer 304s
    const shipped = after.json();
    expect(shipped.data.mainArea[0].data.title).toBe("Control card"); // the area stays the control
    expect(shipped.experiments).toEqual([
      {
        id: exp.id,
        area: "mainArea",
        goal: "form",
        arms: [
          { key: "a", weight: 50 },
          { key: "b", weight: 50, blocks: [{ blockType: "CardBlock", display: "automatic", shared: false, data: { title: "Version B card" }, fieldTypes: expect.any(Object) }] },
        ],
      },
    ]);
    expect(after.body).not.toContain("top secret");
    expect(shipped.seo).toEqual(before.json().seo);
  });

  it("a running experiment can't change or double up; pause first", async () => {
    const id = await page("Running page");
    const exp = (await create(editor, id)).json();
    await manage(editor, "POST", `/experiments/${exp.id}/start`);
    const edit = await manage(editor, "PATCH", `/experiments/${exp.id}`, { name: "Renamed" });
    expect(edit.statusCode).toBe(409);
    expect(edit.json().message).toMatch(/Pause it first/);
    const second = (await create(editor, id)).json();
    const clash = await manage(editor, "POST", `/experiments/${second.id}/start`);
    expect(clash.statusCode).toBe(409);
    expect(clash.json().message).toMatch(/already has a live experiment/);
    await manage(editor, "POST", `/experiments/${exp.id}/pause`);
    expect((await deliver(id)).json().experiments).toBeUndefined(); // paused → visitors see A
    expect((await manage(editor, "PATCH", `/experiments/${exp.id}`, { name: "Renamed" })).json().name).toBe("Renamed");
  });

  it("an unpublished page can't start an experiment", async () => {
    const id = (await manage(admin, "POST", "/content", { type: "ArticlePage", locale: "en", name: "Never published" })).json().documentId;
    const exp = (await create(editor, id)).json();
    const res = await manage(editor, "POST", `/experiments/${exp.id}/start`);
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/Publish the page first/);
  });

  it("counting: public key only, unknown and mismatched events ignored, results and verdict reported", async () => {
    const id = await page("Counting page");
    const exp = (await create(editor, id)).json();
    await manage(editor, "POST", `/experiments/${exp.id}/start`);
    expect((await traffic({ exposures: [{ experimentId: exp.id, arm: "a" }] }, PREVIEW_KEY)).statusCode).toBe(403);
    const res = await traffic({
      exposures: [
        { experimentId: exp.id, arm: "a" },
        { experimentId: exp.id, arm: "a" },
        { experimentId: exp.id, arm: "b" },
        { experimentId: exp.id, arm: "c" }, // no such version
        { experimentId: 999_999, arm: "a" }, // no such experiment
      ],
      conversions: [
        { experimentId: exp.id, arm: "b", goal: "form" },
        { experimentId: exp.id, arm: "b", goal: "event:other" }, // not this experiment's goal
      ],
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().experiments).toEqual({ exposures: 3, conversions: 1, ignored: 3 });
    const db = s.app.db;
    await recordFormConversions(db, "site_default", [{ id: exp.id, arm: "a" }]);
    const got = (await manage(viewer, "GET", `/experiments/${exp.id}`)).json();
    expect(got.results).toMatchObject([
      { key: "a", exposures: 2, conversions: 1 },
      { key: "b", exposures: 1, conversions: 1 },
    ]);
    expect(got.verdict).toMatchObject({ complete: false, leader: null, needed: 1600 });
    expect(got.verdict.summary).toBe("Not conclusive yet: 1 of 1600 visitors per version.");
    expect(got.daily).toHaveLength(2);
  });

  it("ending with a winner writes it as a draft, or publishes it; losers are kept", async () => {
    const id = await page("Winner page");
    const exp = (await create(editor, id)).json();
    await manage(editor, "POST", `/experiments/${exp.id}/start`);
    const ended = await manage(editor, "POST", `/experiments/${exp.id}/end`, { winner: "b", apply: "draft" });
    expect(ended.statusCode, ended.body).toBe(200);
    expect(ended.json()).toMatchObject({ applied: "draft", experiment: { status: "ended", winner: "b", endReason: "manual" } });
    const draft = (await manage(editor, "GET", `/content/${id}?locale=en`)).json();
    expect(draft.data.mainArea[0].inline.title).toBe("Version B card");
    expect((await deliver(id)).json().data.mainArea[0].data.title).toBe("Control card"); // not published yet
    expect((await manage(editor, "GET", `/experiments/${exp.id}`)).json().arms).toHaveLength(2);
    expect((await manage(editor, "POST", `/experiments/${exp.id}/end`, {})).statusCode).toBe(409);

    const id2 = await page("Publish winner page");
    const exp2 = (await create(editor, id2)).json();
    await manage(editor, "POST", `/experiments/${exp2.id}/start`);
    expect((await manage(editor, "POST", `/experiments/${exp2.id}/end`, { winner: "b", apply: "publish" })).json().applied).toBe("publish");
    const live = (await deliver(id2)).json();
    expect(live.data.mainArea[0].data.title).toBe("Version B card");
    expect(live.experiments).toBeUndefined();
  });

  it("the ticker ends experiments past ends_at and on unpublished pages", async () => {
    const id = await page("Ticker page");
    const exp = (await create(editor, id, { endsAt: new Date(Date.now() + 60_000).toISOString() })).json();
    await manage(editor, "POST", `/experiments/${exp.id}/start`);
    const id2 = await page("Ticker unpublish page");
    const exp2 = (await create(editor, id2)).json();
    await manage(editor, "POST", `/experiments/${exp2.id}/start`);
    expect((await manage(admin, "POST", `/content/${id2}/unpublish?locale=en`)).statusCode).toBe(200);
    const { ended } = await runExperimentTicker(s.app.db, new Date(Date.now() + 120_000));
    expect(ended).toEqual(expect.arrayContaining([expect.objectContaining({ id: exp.id, reason: "ends-at" }), expect.objectContaining({ id: exp2.id, reason: "page-unpublished" })]));
    expect((await manage(editor, "GET", `/experiments/${exp.id}`)).json()).toMatchObject({ status: "ended", endReason: "ends-at", winner: null });
    expect((await deliver(id)).json().experiments).toBeUndefined();
  });

  it("an agent's experiment waits for a human when agent review is on", async () => {
    const id = await page("Agent page");
    const users = (await manage(admin, "GET", "/users")).json() as Array<{ id: string; email: string }>;
    const adminCtx = await getAccessContext(s.app.db, users.find((u) => u.email === "admin@paperboy.test")!.id);
    await setAgentReviewRequired(s.app.db, adminCtx, true);
    try {
      const agent = { ...adminCtx, via: "mcp" as const };
      const exp = await createExperiment(s.app.db, agent, { documentId: id, locale: "en", area: "mainArea", name: "Agent test", arms: [{ blocks: [card("Agent B")] }] });
      expect(exp.needsReview).toBe(true);
      await expect(startExperiment(s.app.db, agent, exp.id)).rejects.toThrow(/waiting for approval/);
      // A human starting it is the review.
      expect((await startExperiment(s.app.db, adminCtx, exp.id)).status).toBe("running");
    } finally {
      await setAgentReviewRequired(s.app.db, adminCtx, false);
    }
  });

  it("experiments are confined to their site", async () => {
    const id = await page("Site page");
    const exp = (await create(editor, id)).json();
    const sites = await manage(admin, "POST", "/sites", { name: "Other brand", slug: `other-${Date.now().toString(36)}`, defaultLocale: "en" });
    expect(sites.statusCode, sites.body).toBeLessThan(300);
    const otherSite = sites.json().id as string;
    const other = await s.app.inject({ method: "GET", url: `/api/v1/manage/experiments/${exp.id}`, headers: { ...authHeaders(admin), "x-paperboy-site": otherSite } });
    expect(other.statusCode).toBe(404);
    const list = await s.app.inject({ method: "GET", url: "/api/v1/manage/experiments", headers: { ...authHeaders(admin), "x-paperboy-site": otherSite } });
    expect(list.json()).toEqual([]);
  });

  it("settings: cookieless by default; site.manage to change", async () => {
    expect((await manage(viewer, "GET", "/experiments/settings")).json()).toMatchObject({ mode: "cookieless", warnDays: 30 });
    expect((await manage(editor, "PUT", "/experiments/settings", { mode: "consent" })).statusCode).toBe(403);
    expect((await manage(admin, "PUT", "/experiments/settings", { mode: "consent", warnDays: 14 })).json()).toMatchObject({ mode: "consent", warnDays: 14 });
    expect((await manage(admin, "PUT", "/experiments/settings", { warnDays: 0 })).statusCode).toBe(422);
  });
});
