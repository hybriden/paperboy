import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PUBLIC_KEY, type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * Pages that tease each other must all come back resolved.
 *
 * Found building a real site (2026-10-22): three articles, each with a
 * "related reading" list of the other two. Only the FIRST teaser of every list
 * was delivered; the rest came back as bare {documentId, type} stubs, so the
 * frontend drew empty cards. The structured-data walk resolved every page stub
 * it met in a content area (to learn whether it was a block), and each of those
 * resolves walked ITS related list again, A → B → A → … until the per-request
 * resolve budget was spent.
 */
describe("delivery: pages teasing each other", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  const pub = { authorization: `Bearer ${PUBLIC_KEY}` };

  const call = async (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => {
    const r = await s.app.inject({ method, url: `/api/v1/manage${url}`, headers: authHeaders(admin), ...(payload === undefined ? {} : { payload: payload as object }) });
    expect(r.statusCode, `${method} ${url}: ${r.body}`).toBeLessThan(300);
    return r.json();
  };
  const field = (name: string, type: string, extra: Record<string, unknown> = {}) => ({ name, displayName: name, type, localized: false, required: false, delivery: "public", ...extra });
  const teaser = (key: string, documentId: string) => ({ key, blockType: "CyclePage", display: "automatic", ref: documentId, inline: null });

  const ids: string[] = [];

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    await call("POST", "/content-types", {
      name: "CyclePage", displayName: "Cycle page", kind: "page", schemaType: "Article",
      fields: [field("heading", "text", { seoRole: "title" }), field("related", "contentArea")],
    });
    for (const name of ["Liquidity", "Board", "Accounting"]) {
      ids.push((await call("POST", "/content", { type: "CyclePage", locale: "en", name, data: { heading: name } })).documentId as string);
    }
    for (const [i, id] of ids.entries()) {
      const others = ids.filter((_, j) => j !== i);
      await call("PUT", `/content/${id}?locale=en`, { data: { heading: ["Liquidity", "Board", "Accounting"][i], related: others.map((o, k) => teaser(`r${k}`, o)) } });
    }
    for (const id of ids) await call("POST", `/content/${id}/publish?locale=en`);
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("resolves every related teaser, not only the first", async () => {
    for (const id of ids) {
      const r = await s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${id}?locale=en&populate=2`, headers: pub });
      expect(r.statusCode, r.body).toBe(200);
      const related = r.json().data.related as Array<{ content: { documentId: string; name?: string } }>;
      expect(related).toHaveLength(2);
      for (const t of related) expect(t.content.name, `teaser ${t.content.documentId} on ${id}`).toBeTruthy();
    }
  });
});
