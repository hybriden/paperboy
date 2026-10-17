import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PUBLIC_KEY, type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * Structured data set up in the CMS, not hand-written in each frontend.
 *
 * Found building a real site's JSON-LD (2026-10-17): delivery only ever made
 * a node for a PAGE, and a schemaProp could only carry a scalar. So the
 * company behind the site — its legal name, org number, offices, profiles —
 * had nowhere to live in the CMS and was hardcoded in the frontend; the
 * built-in FAQ page delivered `"@type": "FAQPage"` with no questions in it;
 * and an article written by the company itself came out as a PERSON named
 * after the company.
 *
 * Now: a GLOBAL whose type declares a schemaType carries its own node (the
 * SiteSettings identity); a content area tagged with a schemaProp becomes the
 * list of nodes its blocks make (offices as `department`, questions as
 * `mainEntity`); blocks with a schemaType placed on a page come back as
 * `seo.jsonLdParts`; and an author who IS the site's organisation is that
 * organisation.
 */
describe("structured data set up in the CMS", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  const pub = { authorization: `Bearer ${PUBLIC_KEY}` };

  const call = async (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => {
    const r = await s.app.inject({ method, url: `/api/v1/manage${url}`, headers: authHeaders(admin), ...(payload === undefined ? {} : { payload: payload as object }) });
    expect(r.statusCode, `${method} ${url}: ${r.body}`).toBeLessThan(300);
    return r.json();
  };
  const deliver = async (url: string) => {
    const r = await s.app.inject({ method: "GET", url: `/api/v1/delivery${url}`, headers: pub });
    expect(r.statusCode, r.body).toBe(200);
    return r.json();
  };
  const doc = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
  const field = (name: string, type: string, extra: Record<string, unknown> = {}) => ({ name, displayName: name, type, localized: false, required: false, delivery: "public", ...extra });

  let settingsId: string;

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");

    // An office block and an organisation-typed SiteSettings, as an editor sets
    // them up in Settings → Content types.
    await call("POST", "/content-types", {
      name: "OfficeBlock", displayName: "Office", kind: "block", schemaType: "AccountingService",
      fields: [field("name", "text"), field("street", "text", { schemaProp: "address.streetAddress" }), field("city", "text", { schemaProp: "address.addressLocality" })],
    });
    const settings = await call("GET", "/content-types/SiteSettings");
    settings.schemaType = "AccountingService";
    settings.fields.push(
      field("legalName", "text", { schemaProp: "legalName" }),
      field("orgNumber", "text", { schemaProp: "taxID" }),
      field("profiles", "text", { schemaProp: "sameAs" }),
      field("offices", "contentArea", { schemaProp: "department", allowedBlocks: ["OfficeBlock"] }),
      field("bankNote", "text", { schemaProp: "description", delivery: "private" }),
    );
    await call("PUT", "/content-types/SiteSettings", settings);

    settingsId = (await deliver("/globals/SiteSettings?locale=en")).documentId;
    await call("PUT", `/content/${settingsId}?locale=en`, {
      data: {
        siteName: "Paperboy",
        legalName: "Paperboy Regnskap AS",
        orgNumber: "918097902",
        profiles: "https://www.linkedin.com/company/paperboy/\nhttps://www.facebook.com/paperboy",
        offices: [
          { key: "k1", blockType: "OfficeBlock", inline: { name: "Paperboy Tønsberg", street: "Kilengaten 2", city: "Tønsberg" } },
          { key: "k2", blockType: "OfficeBlock", inline: { name: "Paperboy Larvik", street: "Borgejordet 80", city: "Larvik" } },
        ],
        bankNote: "PRIVATE: never in JSON-LD",
      },
    });
    await call("POST", `/content/${settingsId}/publish?locale=en`);

    await call("POST", "/type-templates/FaqPage/instantiate", { withBlocks: true });
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("an organisation-typed SiteSettings delivers the site's identity, offices and profiles included", async () => {
    const g = await deliver("/globals/SiteSettings?locale=en");
    expect(g.jsonLd).toEqual({
      "@context": "https://schema.org",
      "@type": "AccountingService",
      legalName: "Paperboy Regnskap AS",
      taxID: "918097902",
      sameAs: ["https://www.linkedin.com/company/paperboy/", "https://www.facebook.com/paperboy"],
      department: [
        { "@type": "AccountingService", name: "Paperboy Tønsberg", address: { "@type": "PostalAddress", streetAddress: "Kilengaten 2", addressLocality: "Tønsberg" } },
        { "@type": "AccountingService", name: "Paperboy Larvik", address: { "@type": "PostalAddress", streetAddress: "Borgejordet 80", addressLocality: "Larvik" } },
      ],
    });
    expect(JSON.stringify(g)).not.toContain("PRIVATE");
  });

  it("a global without a schemaType has no jsonLd, and neither does a block", async () => {
    const card = await deliver(`/content/${s.ids.cardId}?locale=en`);
    expect(card.jsonLd).toBeUndefined();
  });

  it("an FAQ block on a page comes back as an FAQPage with its questions, answers as plain text", async () => {
    await call("POST", "/type-templates/FaqBlock/instantiate", { withBlocks: true });
    const article = await call("GET", "/content-types/ArticlePage");
    article.fields.find((f: { name: string }) => f.name === "mainArea").allowedBlocks.push("FaqBlock");
    await call("PUT", "/content-types/ArticlePage", article);

    const id = (await call("POST", "/content", { type: "ArticlePage", locale: "en", name: "Pricing" })).documentId as string;
    await call("PUT", `/content/${id}?locale=en`, {
      data: {
        heading: "Pricing",
        mainArea: [
          {
            key: "faq",
            blockType: "FaqBlock",
            inline: {
              heading: "Frequently asked questions",
              questions: [
                { key: "k3", blockType: "QuestionBlock", inline: { question: "What does it cost?", answer: doc("From 2 500 kr a month, everything included.") } },
                { key: "k4", blockType: "QuestionBlock", inline: { question: "Can I keep my system?", answer: doc("Yes.") } },
              ],
            },
          },
        ],
      },
    });
    await call("POST", `/content/${id}/publish?locale=en`);

    const seo = (await deliver(`/content/${id}?locale=en`)).seo;
    expect(seo.jsonLdParts).toEqual([
      {
        "@type": "FAQPage",
        name: "Frequently asked questions",
        mainEntity: [
          { "@type": "Question", name: "What does it cost?", acceptedAnswer: { "@type": "Answer", text: "From 2 500 kr a month, everything included." } },
          { "@type": "Question", name: "Can I keep my system?", acceptedAnswer: { "@type": "Answer", text: "Yes." } },
        ],
      },
    ]);
  });

  it("a page without such blocks has no jsonLdParts", async () => {
    expect((await deliver(`/content/${s.ids.homeId}?locale=en`)).seo.jsonLdParts).toBeUndefined();
  });

  it("the built-in FAQ page lists its questions as mainEntity, through its topics", async () => {
    const id = (await call("POST", "/content", { type: "FaqPage", locale: "en", name: "FAQ" })).documentId as string;
    await call("PUT", `/content/${id}?locale=en`, {
      data: {
        heading: "FAQ",
        topics: [
          { key: "k5", blockType: "FaqTopicBlock", inline: { topic: "General", questions: [{ key: "k6", blockType: "QuestionBlock", inline: { question: "Who are you?", answer: doc("An accounting firm.") } }] } },
          { key: "k7", blockType: "FaqTopicBlock", inline: { topic: "Prices", questions: [{ key: "k8", blockType: "QuestionBlock", inline: { question: "Any fees?", answer: doc("No.") } }] } },
        ],
      },
    });
    await call("POST", `/content/${id}/publish?locale=en`);

    const jsonLd = (await deliver(`/content/${id}?locale=en`)).seo.jsonLd;
    expect(jsonLd["@type"]).toBe("FAQPage");
    expect(jsonLd.mainEntity.map((q: { name: string }) => q.name)).toEqual(["Who are you?", "Any fees?"]);
  });

  // AI assistants and search engines weigh how fresh a page is, and dateModified
  // only came from a field tagged with that role — which hardly any type has.
  // The page's last publish is the honest answer, the same one sitemap.xml gives
  // as lastmod; a field tagged dateModified still wins.
  it("a page carries when it was last published as dateModified, unless a field says otherwise", async () => {
    const id = (await call("POST", "/content", { type: "BlogPost", locale: "en", name: "Fresh", parentId: s.ids.blogId })).documentId as string;
    await call("PUT", `/content/${id}?locale=en`, { data: { title: "Fresh" } });
    const before = Date.now();
    await call("POST", `/content/${id}/publish?locale=en`);
    const modified = (await deliver(`/content/${id}?locale=en`)).seo.jsonLd.dateModified as string;
    expect(Date.parse(modified)).toBeGreaterThanOrEqual(before - 60_000);
    const sitemapEntry = (await deliver("/pages")).pages.find((p: { documentId: string; locale: string }) => p.documentId === id && p.locale === "en");
    expect(modified).toBe(sitemapEntry.lastmod);

    const blog = await call("GET", "/content-types/BlogPost");
    blog.fields.push(field("updated", "datetime", { seoRole: "dateModified" }));
    await call("PUT", "/content-types/BlogPost", blog);
    await call("PUT", `/content/${id}?locale=en`, { data: { title: "Fresh", updated: "2026-01-02T03:04:05.000Z" } });
    await call("POST", `/content/${id}/publish?locale=en`);
    expect((await deliver(`/content/${id}?locale=en`)).seo.jsonLd.dateModified).toBe("2026-01-02T03:04:05.000Z");
  });

  it("an article by the organisation itself is by the organisation, not a person of that name", async () => {
    const byCompany = (await call("POST", "/content", { type: "BlogPost", locale: "en", name: "Year in review", parentId: s.ids.blogId })).documentId as string;
    await call("PUT", `/content/${byCompany}?locale=en`, { data: { title: "Year in review", author: "Paperboy Regnskap AS" } });
    await call("POST", `/content/${byCompany}/publish?locale=en`);
    expect((await deliver(`/content/${byCompany}?locale=en`)).seo.jsonLd.author).toEqual({ "@type": "AccountingService", name: "Paperboy Regnskap AS" });

    const byPerson = (await call("POST", "/content", { type: "BlogPost", locale: "en", name: "Tips", parentId: s.ids.blogId })).documentId as string;
    await call("PUT", `/content/${byPerson}?locale=en`, { data: { title: "Tips", author: "Kari Nordmann" } });
    await call("POST", `/content/${byPerson}/publish?locale=en`);
    expect((await deliver(`/content/${byPerson}?locale=en`)).seo.jsonLd.author).toEqual({ "@type": "Person", name: "Kari Nordmann" });
  });
});
