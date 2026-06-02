import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PUBLIC_KEY, type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * Proves the new property types (datetime, select, link) and per-field
 * validation (length / regex / option membership) — enforced at publish,
 * relaxed for drafts — and that the new types pass through delivery.
 */
describe("Field types + per-field validation", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  const pub = { authorization: `Bearer ${PUBLIC_KEY}` };

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    const def = {
      name: "ValidatedPage",
      displayName: "Validated Page",
      kind: "page",
      fields: [
        { name: "heading", displayName: "Heading", type: "text", delivery: "public", required: true, validation: { minLength: 3 } },
        { name: "code", displayName: "Code", type: "text", delivery: "public", validation: { pattern: "^[A-Z]+$" } },
        { name: "category", displayName: "Category", type: "select", delivery: "public", required: true, options: [{ value: "news", label: "News" }, { value: "blog", label: "Blog" }] },
        { name: "publishDate", displayName: "Publish date", type: "datetime", delivery: "public" },
        { name: "cta", displayName: "CTA", type: "link", delivery: "public" },
      ],
    };
    const create = await s.app.inject({ method: "POST", url: "/api/v1/manage/content-types", headers: authHeaders(admin), payload: def });
    expect(create.statusCode).toBe(200);
  });
  afterAll(async () => {
    await s.app.close();
  });

  async function mk(): Promise<string> {
    const r = await s.app.inject({ method: "POST", url: "/api/v1/manage/content", headers: authHeaders(admin), payload: { type: "ValidatedPage", locale: "en", name: "VP" } });
    return r.json().documentId;
  }
  const save = (id: string, data: Record<string, unknown>, slug = "vp") =>
    s.app.inject({ method: "PUT", url: `/api/v1/manage/content/${id}?locale=en`, headers: authHeaders(admin), payload: { name: "VP", slug, data } });
  const publish = (id: string) => s.app.inject({ method: "POST", url: `/api/v1/manage/content/${id}/publish?locale=en`, headers: authHeaders(admin) });

  it("accepts an invalid draft but blocks publish on minLength", async () => {
    const id = await mk();
    const draft = await save(id, { heading: "ab", category: "news" }, "vp1");
    expect(draft.statusCode).toBe(200); // drafts relaxed
    expect((await publish(id)).statusCode).toBe(422); // heading too short
  });

  it("blocks publish on an invalid select option", async () => {
    const id = await mk();
    await save(id, { heading: "Hello", category: "invalid" }, "vp2");
    expect((await publish(id)).statusCode).toBe(422);
  });

  it("blocks publish on a regex pattern mismatch", async () => {
    const id = await mk();
    await save(id, { heading: "Hello", category: "news", code: "abc" }, "vp3");
    expect((await publish(id)).statusCode).toBe(422);
  });

  it("publishes valid data and delivers datetime/select/link verbatim", async () => {
    const id = await mk();
    await save(id, { heading: "Hello world", category: "blog", code: "ABC", publishDate: "2026-05-31T09:00", cta: { href: "/docs", text: "Read", target: "_blank" } }, "vp4");
    expect((await publish(id)).statusCode).toBe(200);
    const out = await s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${id}?locale=en`, headers: pub });
    expect(out.statusCode).toBe(200);
    const data = out.json().data;
    expect(data.category).toBe("blog");
    expect(data.publishDate).toBe("2026-05-31T09:00");
    expect(data.cta.href).toBe("/docs");
    expect(data.cta.target).toBe("_blank");
  });
});
