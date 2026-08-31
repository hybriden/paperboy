import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, authHeaders, login, setupApi } from "./helpers.js";

describe('"Used on" — reverse references', () => {
  let s: Suite;
  let ed: Awaited<ReturnType<typeof login>>;
  beforeAll(async () => {
    s = await setupApi();
    ed = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("lists the documents that embed a shared block, and how", async () => {
    // A page whose contentArea pulls in the seeded shared Card block.
    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(ed),
      payload: { type: "ArticlePage", locale: "en", name: "Uses The Card" },
    });
    const pageId = created.json().documentId;
    await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${pageId}?locale=en`,
      headers: authHeaders(ed),
      payload: {
        data: {
          heading: "Uses the card",
          mainArea: [{ key: "c", blockType: "CardBlock", display: "narrow", ref: s.ids.cardId, inline: null }],
        },
      },
    });

    const refs = await s.app.inject({
      method: "GET",
      url: `/api/v1/manage/content/${s.ids.cardId}/references`,
      headers: authHeaders(ed),
    });
    expect(refs.statusCode).toBe(200);
    const list = refs.json() as Array<{ documentId: string; name: string; kind: string; fields: string[] }>;
    const hit = list.find((r) => r.documentId === pageId);
    expect(hit).toBeTruthy();
    expect(hit!.name).toBe("Uses The Card");
    expect(hit!.fields).toContain("mainArea");
  });

  /**
   * Links and references INSIDE inline blocks are references too — the front
   * page's hero CTA is an inline block. Extraction walks the same MAX_INLINE_DEPTH
   * as coercion, schema validation and the placement guard; it used to stop at
   * 4 while claiming to match them, so a link nested five deep was untracked.
   */
  describe("nested inside inline blocks", () => {
    let admin: Awaited<ReturnType<typeof login>>;
    let targetId: string;

    /** A block that can nest in itself and carries an internal link. */
    const chain = (depth: number, cta: unknown): Record<string, unknown> => {
      let inner: Record<string, unknown> = { cta };
      for (let i = 0; i < depth; i++) {
        inner = { area: [{ key: `n${i}`, blockType: "LinkNestBlock", display: "automatic", ref: null, inline: inner }] };
      }
      return inner;
    };

    beforeAll(async () => {
      admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
      for (const def of [
        {
          name: "LinkNestBlock",
          displayName: "Link nest",
          kind: "block",
          fields: [
            { name: "cta", displayName: "CTA", type: "link", delivery: "public" },
            { name: "area", displayName: "Area", type: "contentArea", delivery: "public", allowedBlocks: [] },
          ],
        },
        {
          name: "LinkNestPage",
          displayName: "Link nest page",
          kind: "page",
          fields: [{ name: "area", displayName: "Area", type: "contentArea", delivery: "public", allowedBlocks: [] }],
        },
      ]) {
        const r = await s.app.inject({ method: "POST", url: "/api/v1/manage/content-types", headers: authHeaders(admin), payload: def });
        expect(r.statusCode, r.body).toBe(200);
      }
      const t = await s.app.inject({ method: "POST", url: "/api/v1/manage/content", headers: authHeaders(ed), payload: { type: "ArticlePage", locale: "en", name: "Link Target" } });
      targetId = t.json().documentId as string;
    });

    async function pageLinkingAtDepth(name: string, depth: number): Promise<string> {
      const created = await s.app.inject({ method: "POST", url: "/api/v1/manage/content", headers: authHeaders(ed), payload: { type: "LinkNestPage", locale: "en", name } });
      const id = created.json().documentId as string;
      const saved = await s.app.inject({
        method: "PUT",
        url: `/api/v1/manage/content/${id}?locale=en`,
        headers: authHeaders(ed),
        payload: { data: chain(depth, { documentId: targetId, text: "Go" }) },
      });
      expect(saved.statusCode, saved.body).toBe(200);
      return id;
    }

    const referrers = async () => {
      const refs = await s.app.inject({ method: "GET", url: `/api/v1/manage/content/${targetId}/references`, headers: authHeaders(ed) });
      expect(refs.statusCode).toBe(200);
      return refs.json() as Array<{ documentId: string; fields: string[] }>;
    };

    it("lists a page whose INLINE block links here, with the nested field path", async () => {
      const pageId = await pageLinkingAtDepth("Links From Inline Block", 1);
      const hit = (await referrers()).find((r) => r.documentId === pageId);
      expect(hit).toBeTruthy();
      expect(hit!.fields).toContain("area.cta");
    });

    it("still finds a link five inline levels down", async () => {
      const pageId = await pageLinkingAtDepth("Links From Deep Block", 5);
      const hit = (await referrers()).find((r) => r.documentId === pageId);
      expect(hit, "a link nested past the old depth-4 cap went untracked").toBeTruthy();
      expect(hit!.fields).toContain("area.area.area.area.area.cta");
    });
  });

  it("returns an empty list for a document nothing references", async () => {
    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(ed),
      payload: { type: "ArticlePage", locale: "en", name: "Lonely Page" },
    });
    const lonelyId = created.json().documentId;
    const refs = await s.app.inject({
      method: "GET",
      url: `/api/v1/manage/content/${lonelyId}/references`,
      headers: authHeaders(ed),
    });
    expect(refs.statusCode).toBe(200);
    expect(refs.json()).toEqual([]);
  });
});
