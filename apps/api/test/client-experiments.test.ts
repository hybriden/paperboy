import { type DeliveryContent, applyExperiments, assignArm as clientAssign, createClient } from "@paperboycms/client";
import { assignArm as sharedAssign } from "@paperboy/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PREVIEW_KEY, PUBLIC_KEY, type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * A/B assignment exists twice: @paperboy/shared (the CMS) and the published,
 * dependency-free @paperboycms/client (what frontends run). If they drift, the
 * admin's numbers stop describing what visitors got. Same inputs, same answers.
 */
describe("assignArm: client and shared agree", () => {
  const splits = [
    [{ key: "a", weight: 50 }, { key: "b", weight: 50 }],
    [{ key: "a", weight: 70 }, { key: "b", weight: 20 }, { key: "c", weight: 10 }],
    [{ key: "a", weight: 1 }, { key: "b", weight: 1 }, { key: "c", weight: 1 }, { key: "d", weight: 97 }],
    [{ key: "a", weight: 0 }, { key: "b", weight: 100 }],
  ];
  it("on thousands of visitors, every split, keyless included", () => {
    for (const arms of splits) {
      for (let i = 0; i < 3000; i++) {
        const key = i % 500 === 0 ? null : `visitor-${i}-ø${i * 7}`;
        expect(clientAssign(i % 17, key, arms)).toBe(sharedAssign(i % 17, key, arms));
      }
    }
  });
});

describe("applyExperiments", () => {
  const item = {
    documentId: "p1",
    data: { mainArea: [{ blockType: "CardBlock", data: { title: "A" } }], heading: "Hi" },
    experiments: [{ id: 5, area: "mainArea", goal: "form", arms: [{ key: "a", weight: 50 }, { key: "b", weight: 50, blocks: [{ blockType: "CardBlock", data: { title: "B" } }] }] }],
  } as unknown as DeliveryContent;
  const titleOf = (i: DeliveryContent) => ((i.data.mainArea as Array<{ data: { title: string } }>)[0]!.data.title);

  it("swaps in the visitor's version and returns its exposure", () => {
    const visitor = Array.from({ length: 50 }, (_, i) => `v${i}`).find((v) => clientAssign(5, v, item.experiments![0]!.arms) === "b")!;
    const out = applyExperiments(item, { visitorKey: visitor });
    expect(titleOf(out.item)).toBe("B");
    expect(out.item.data.heading).toBe("Hi");
    expect(out.exposures).toEqual([{ experimentId: 5, arm: "b" }]);
    expect(titleOf(item)).toBe("A"); // the input is not mutated
  });

  it("keyless traffic sees A and isn't counted; a forced preview isn't counted either", () => {
    expect(applyExperiments(item)).toMatchObject({ exposures: [] });
    expect(titleOf(applyExperiments(item).item)).toBe("A");
    const forced = applyExperiments(item, { visitorKey: "anyone", force: "5:b" });
    expect(titleOf(forced.item)).toBe("B");
    expect(forced.exposures).toEqual([]);
  });

  it("leaves a page without experiments alone", () => {
    const plain = { documentId: "p2", data: { x: 1 } } as unknown as DeliveryContent;
    expect(applyExperiments(plain).item).toBe(plain);
  });
});

describe("end to end: deliver, apply, report, read the result", () => {
  let s: Suite;
  let baseUrl: string;
  let pageId: string;
  let experimentId: number;
  beforeAll(async () => {
    s = await setupApi();
    baseUrl = await s.app.listen({ port: 0, host: "127.0.0.1" });
    const admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    const call = (method: "POST" | "PUT", url: string, payload?: object) => s.app.inject({ method, url: `/api/v1/manage${url}`, headers: authHeaders(admin), ...(payload ? { payload } : {}) });
    pageId = (await call("POST", "/content", { type: "ArticlePage", locale: "en", name: "SDK experiment" })).json().documentId;
    const card = (title: string) => ({ key: `k${title}`, blockType: "CardBlock", display: "automatic", inline: { title }, ref: null });
    await call("PUT", `/content/${pageId}?locale=en`, { data: { heading: "SDK", mainArea: [card("Control")] } });
    await call("POST", `/content/${pageId}/publish?locale=en`);
    experimentId = (await call("POST", "/experiments", { documentId: pageId, locale: "en", area: "mainArea", name: "SDK", goal: "event:signup", arms: [{ blocks: [card("Challenger")] }] })).json().id;
    expect((await call("POST", `/experiments/${experimentId}/start`)).statusCode).toBe(200);
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("a visitor gets a version, the frontend reports it, the CMS counts it", async () => {
    const cms = createClient({ baseUrl, key: PUBLIC_KEY });
    const page = (await cms.getById(pageId, { locale: "en", populate: 1 }))!;
    expect(page.experiments).toHaveLength(1);
    const visitors = Array.from({ length: 40 }, (_, i) => `visitor-${i}`);
    const exposures = visitors.flatMap((v) => applyExperiments(page, { visitorKey: v }).exposures);
    expect(new Set(exposures.map((e) => e.arm))).toEqual(new Set(["a", "b"]));
    await cms.reportTraffic({ exposures, conversions: [{ experimentId, arm: "b", goal: "event:signup" }] });

    const admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    const got = (await s.app.inject({ method: "GET", url: `/api/v1/manage/experiments/${experimentId}`, headers: authHeaders(admin) })).json();
    const total = (got.results as Array<{ exposures: number }>).reduce((n, r) => n + r.exposures, 0);
    expect(total).toBe(40);
    expect(got.results.find((r: { key: string }) => r.key === "b").conversions).toBe(1);
  });

  it("preview ships the draft status, and a forced version renders", async () => {
    const prev = createClient({ baseUrl, key: PREVIEW_KEY });
    const page = (await prev.getById(pageId, { locale: "en", populate: 1 }))!;
    expect(page.experiments?.[0]?.status).toBe("running");
    const forced = applyExperiments(page, { force: `${experimentId}:b` });
    expect((forced.item.data.mainArea as Array<{ data: { title: string } }>)[0]!.data.title).toBe("Challenger");
  });
});
