import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PUBLIC_KEY, type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * Site search: words are stemmed per locale (nb "bil" finds "bilene", en "run"
 * finds "running"), the last word also matches as a prefix (search as you type),
 * and without `type` only pages come back (a shared block or a global has no URL).
 * Neither stemming nor the prefix may match on private field text.
 */
describe("delivery search: stemming, prefix, pages only", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  const pub = { authorization: `Bearer ${PUBLIC_KEY}` };
  let enPage = "";
  let nbPage = "";
  let card = "";

  const publish = async (id: string, locale: string, data: Record<string, unknown>) => {
    const put = await s.app.inject({ method: "PUT", url: `/api/v1/manage/content/${id}?locale=${locale}`, headers: authHeaders(admin), payload: { data, merge: true } });
    expect(put.statusCode, put.body).toBe(200);
    const res = await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${id}/publish?locale=${locale}`, headers: authHeaders(admin) });
    expect(res.statusCode, res.body).toBe(200);
  };
  const create = async (type: string, locale: string, name: string) => {
    const res = await s.app.inject({ method: "POST", url: "/api/v1/manage/content", headers: authHeaders(admin), payload: { type, parentId: null, locale, name } });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().documentId as string;
  };
  const search = async (q: string, extra = "") => {
    const res = await s.app.inject({ method: "GET", url: `/api/v1/delivery/search?q=${encodeURIComponent(q)}${extra}`, headers: pub });
    expect(res.statusCode, res.body).toBe(200);
    return (res.json().items as { documentId: string }[]).map((i) => i.documentId);
  };

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    enPage = await create("ArticlePage", "en", "Footwear");
    // heading is public; seoNotes is delivery:"private" (see the seed).
    await publish(enPage, "en", { heading: "Running shoes for wetlands", seoNotes: "codename marmosets" });
    nbPage = await create("ArticlePage", "nb", "Kjøretøy");
    await publish(nbPage, "nb", { heading: "Bilene kjørte gjennom fjellovergangene" });
    card = await create("CardBlock", "en", "Wetland card");
    await publish(card, "en", { title: "Tundrawetland card" });
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("stems per locale", async () => {
    expect(await search("run", "&locale=en")).toContain(enPage);
    expect(await search("shoe", "&locale=en")).toContain(enPage);
    expect(await search("bil", "&locale=nb")).toContain(nbPage);
    expect(await search("fjellovergang", "&locale=nb")).toContain(nbPage);
  });

  it("matches the last word as a prefix, stemmed or not", async () => {
    expect(await search("runni", "&locale=en")).toContain(enPage);
    expect(await search("shoes wetl", "&locale=en")).toContain(enPage);
    expect(await search("fjellover", "&locale=nb")).toContain(nbPage);
    // Earlier words are whole words: "wetl" alone is a prefix, but not mid-query.
    expect(await search("wetl shoes", "&locale=en")).not.toContain(enPage);
  });

  it("returns only pages unless a type is asked for", async () => {
    expect(await search("tundrawetland")).not.toContain(card);
    expect(await search("tundrawetland", "&type=CardBlock")).toContain(card);
  });

  it("never matches private text, whole word, stem or prefix", async () => {
    expect(await search("marmosets", "&locale=en")).not.toContain(enPage);
    expect(await search("marmoset", "&locale=en")).not.toContain(enPage);
    expect(await search("marmo", "&locale=en")).not.toContain(enPage);
    expect(await search("running -marmoset", "&locale=en")).toContain(enPage);
  });
});
