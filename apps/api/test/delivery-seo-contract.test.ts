import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PREVIEW_KEY, PUBLIC_KEY, type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * The delivered SEO + schema.org contract (2026-06-08). Every PAGE item carries
 * a normalized `seo` block computed server-side from the SEO fields + field
 * `seoRole`s + the content type's `schemaType` — one source of truth a frontend
 * renders directly. Pins: fallback precedence, robots, schema @type, the
 * preview-noindex rule, and the no-leak guarantee (a PRIVATE role-tagged field
 * never feeds the seo block).
 */
describe("delivery seo contract", () => {
  let s: Suite;
  let ed: Awaited<ReturnType<typeof login>>;
  let admin: Awaited<ReturnType<typeof login>>;
  const pub = { authorization: `Bearer ${PUBLIC_KEY}` };
  const prev = { authorization: `Bearer ${PREVIEW_KEY}` };

  beforeAll(async () => {
    s = await setupApi();
    ed = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
  });

  async function create(type: string, name: string, parentId?: string) {
    const r = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(ed),
      payload: { type, locale: "en", name, ...(parentId ? { parentId } : {}) },
    });
    expect(r.statusCode, r.body).toBe(200);
    return r.json().documentId as string;
  }
  async function put(id: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    const r = await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${id}?locale=en`,
      headers: authHeaders(ed),
      payload: { data, ...extra },
    });
    expect(r.statusCode, r.body).toBe(200);
  }
  async function publish(id: string) {
    const r = await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${id}/publish?locale=en`, headers: authHeaders(ed) });
    expect(r.statusCode, r.body).toBe(200);
  }
  async function deliver(id: string, headers = pub) {
    const r = await s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${id}?locale=en`, headers });
    return r;
  }

  it("a page with only a name yields a valid seo block (title=name, indexable, WebPage-ish jsonLd)", async () => {
    const id = await create("ArticlePage", "Just A Name");
    await put(id, { heading: "Just A Name" });
    await publish(id);
    const seo = (await deliver(id)).json().seo;
    expect(seo).toBeTruthy();
    expect(seo.title).toBe("Just A Name");
    expect(seo.robots).toBe("index, follow");
    expect(seo.jsonLd["@context"]).toBe("https://schema.org");
    expect(typeof seo.jsonLd["@type"]).toBe("string");
    expect(seo.jsonLd.inLanguage).toBe("en");
  });

  it("metaTitle/metaDescription/ogImage override the role-derived values", async () => {
    const id = await create("ArticlePage", "Fallback Name");
    await put(id, {
      heading: "Heading Wins Only If No metaTitle",
      metaTitle: "Explicit Meta Title",
      metaDescription: "Explicit meta description.",
    });
    await publish(id);
    const seo = (await deliver(id)).json().seo;
    expect(seo.title).toBe("Explicit Meta Title"); // metaTitle wins over name + role:title
    expect(seo.description).toBe("Explicit meta description.");
    expect(seo.og.title).toBe("Explicit Meta Title"); // og falls back to title
  });

  it("title falls back to the role:title field when metaTitle is absent (ArticlePage heading)", async () => {
    const id = await create("ArticlePage", "Doc Name");
    await put(id, { heading: "The Heading" });
    await publish(id);
    const seo = (await deliver(id)).json().seo;
    // heading carries seoRole:title (set in seed) → wins over the document name.
    expect(seo.title).toBe("The Heading");
  });

  it("noIndex sets robots to noindex, follow", async () => {
    const id = await create("ArticlePage", "Hidden");
    await put(id, { heading: "Hidden", noIndex: true });
    await publish(id);
    const seo = (await deliver(id)).json().seo;
    expect(seo.robots).toBe("noindex, follow");
  });

  it("the preview perspective is ALWAYS noindex, nofollow (a leaked preview URL must never be indexed)", async () => {
    const id = await create("ArticlePage", "Preview Only");
    await put(id, { heading: "Preview Only" }); // draft, not published
    const seo = (await deliver(id, prev)).json().seo;
    expect(seo.robots).toBe("noindex, nofollow");
  });

  it("schemaType drives the jsonLd @type: BlogPost→BlogPosting, ListPage→CollectionPage", async () => {
    const blog = await create("BlogPost", "A Post", s.ids.blogId);
    await put(blog, { title: "A Post", body: "Hello" });
    await publish(blog);
    expect((await deliver(blog)).json().seo.jsonLd["@type"]).toBe("BlogPosting");

    const list = await create("ListPage", "A List");
    await put(list, { heading: "A List", listedType: "BlogPost" });
    await publish(list);
    expect((await deliver(list)).json().seo.jsonLd["@type"]).toBe("CollectionPage");
  });

  it("blocks/globals get no seo block (null)", async () => {
    // The seeded shared card is a block.
    const r = await deliver(s.ids.cardId);
    expect(r.json().seo).toBeNull();
  });

  it("NO-LEAK: a PRIVATE field tagged seoRole:description never feeds seo.description", async () => {
    // A custom type whose description-role field is private — delivery computes
    // seo from sanitized (public-only) data, so the secret must never surface.
    const typeName = `SeoLeak${Date.now().toString().slice(-6)}`;
    const ct = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content-types",
      headers: authHeaders(admin),
      payload: {
        name: typeName,
        displayName: "SEO Leak Probe",
        kind: "page",
        fields: [
          { name: "heading", displayName: "Heading", type: "text", localized: true, required: true, delivery: "public", group: "Content", seoRole: "title" },
          { name: "secretDesc", displayName: "Secret", type: "text", localized: true, delivery: "private", group: "Content", seoRole: "description" },
        ],
      },
    });
    expect(ct.statusCode, ct.body).toBe(200);
    const id = await create(typeName, "Leak Probe");
    await put(id, { heading: "Leak Probe", secretDesc: "TOP-SECRET-NEVER-DELIVER" });
    await publish(id);
    const body = (await deliver(id)).json();
    expect(JSON.stringify(body)).not.toContain("TOP-SECRET-NEVER-DELIVER");
    expect(body.seo.description).toBeNull(); // private role:description is absent, not used
  });
});
