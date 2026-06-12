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

  it("a non-CreativeWork @type (Event) gets name — not headline — and no CreativeWork-only props", async () => {
    // schema.org: Product/Event/etc. are NOT CreativeWorks — headline, author,
    // keywords and datePublished are invalid there. The generic emitter used to
    // stamp them on every @type; non-CreativeWork types must get the universally
    // valid Thing subset (name/description/image) plus explicit schemaProps.
    const ct = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content-types",
      headers: authHeaders(admin),
      payload: {
        name: "SeoEventPage",
        displayName: "SEO Event",
        kind: "page",
        schemaType: "Event",
        fields: [
          { name: "title", displayName: "Title", type: "text", localized: true, delivery: "public", group: "Content", seoRole: "title" },
          { name: "summary", displayName: "Summary", type: "text", localized: true, delivery: "public", group: "Content", seoRole: "description" },
          { name: "startDate", displayName: "Starts", type: "datetime", localized: false, delivery: "public", group: "Content", schemaProp: "startDate" },
          { name: "venue", displayName: "Venue", type: "text", localized: false, delivery: "public", group: "Content", schemaProp: "location" },
          { name: "author", displayName: "Author", type: "text", localized: false, delivery: "public", group: "Content", seoRole: "author" },
          { name: "tags", displayName: "Tags", type: "text", localized: false, delivery: "public", group: "Content" },
        ],
      },
    });
    expect(ct.statusCode, ct.body).toBe(200);
    const id = await create("SeoEventPage", "Launch Party");
    await put(id, { title: "Launch Party", summary: "Doors at six.", startDate: "2026-09-01T18:00", venue: "Oslo Spektrum", author: "Hans", tags: "party,launch" });
    await publish(id);
    const ld = (await deliver(id)).json().seo.jsonLd;
    expect(ld["@type"]).toBe("Event");
    expect(ld.name).toBe("Launch Party");
    expect(ld.description).toBe("Doors at six.");
    expect(ld.headline).toBeUndefined(); // CreativeWork-only
    expect(ld.author).toBeUndefined(); // CreativeWork-only, even with the role assigned
    expect(ld.keywords).toBeUndefined(); // 'tags' convention must not fire here
    expect(ld.inLanguage).toBeUndefined(); // not a Thing-level property
    expect(ld.startDate).toBe("2026-09-01T18:00");
    // A known wrapper prop given a plain string is lifted into its typed object.
    expect(ld.location).toEqual({ "@type": "Place", name: "Oslo Spektrum" });
  });

  it("Product: schemaProp dot-paths build nested objects with known wrapper @types", async () => {
    const ct = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content-types",
      headers: authHeaders(admin),
      payload: {
        name: "SeoProductPage",
        displayName: "SEO Product",
        kind: "page",
        schemaType: "Product",
        fields: [
          { name: "title", displayName: "Title", type: "text", localized: true, delivery: "public", group: "Content", seoRole: "title" },
          { name: "sku", displayName: "SKU", type: "text", localized: false, delivery: "public", group: "Content", schemaProp: "sku" },
          { name: "brandName", displayName: "Brand", type: "text", localized: false, delivery: "public", group: "Content", schemaProp: "brand" },
          { name: "price", displayName: "Price", type: "number", localized: false, delivery: "public", group: "Content", schemaProp: "offers.price" },
          { name: "currency", displayName: "Currency", type: "text", localized: false, delivery: "public", group: "Content", schemaProp: "offers.priceCurrency" },
          { name: "hiddenCost", displayName: "Cost price", type: "number", localized: false, delivery: "private", group: "Content", schemaProp: "offers.cost" },
        ],
      },
    });
    expect(ct.statusCode, ct.body).toBe(200);
    const id = await create("SeoProductPage", "Walnut Desk");
    await put(id, { title: "Walnut Desk", sku: "WD-100", brandName: "Acme", price: 4990, currency: "NOK", hiddenCost: 1200 });
    await publish(id);
    const ld = (await deliver(id)).json().seo.jsonLd;
    expect(ld["@type"]).toBe("Product");
    expect(ld.name).toBe("Walnut Desk");
    expect(ld.sku).toBe("WD-100");
    expect(ld.brand).toEqual({ "@type": "Brand", name: "Acme" });
    expect(ld.offers).toEqual({ "@type": "Offer", price: 4990, priceCurrency: "NOK" });
    // NO-LEAK: a private field's schemaProp never reaches the jsonLd.
    expect(JSON.stringify(ld)).not.toContain("1200");
  });

  it("a CreativeWork @type keeps the full prop set and schemaProp augments it", async () => {
    const ct = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content-types",
      headers: authHeaders(admin),
      payload: {
        name: "SeoTechArticle",
        displayName: "SEO Tech Article",
        kind: "page",
        schemaType: "Article",
        fields: [
          { name: "title", displayName: "Title", type: "text", localized: true, delivery: "public", group: "Content", seoRole: "title" },
          { name: "author", displayName: "Author", type: "text", localized: false, delivery: "public", group: "Content", seoRole: "author" },
          { name: "wordCount", displayName: "Word count", type: "number", localized: false, delivery: "public", group: "Content", schemaProp: "wordCount" },
        ],
      },
    });
    expect(ct.statusCode, ct.body).toBe(200);
    const id = await create("SeoTechArticle", "How It Works");
    await put(id, { title: "How It Works", author: "Hans", wordCount: 740 });
    await publish(id);
    const ld = (await deliver(id)).json().seo.jsonLd;
    expect(ld["@type"]).toBe("Article");
    expect(ld.headline).toBe("How It Works"); // CreativeWork keeps today's contract
    expect(ld.inLanguage).toBe("en");
    expect(ld.author).toEqual({ "@type": "Person", name: "Hans" });
    expect(ld.wordCount).toBe(740); // schemaProp augments
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
