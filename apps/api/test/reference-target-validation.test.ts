import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * What a reference or a content-area `ref` POINTS AT is validated at write.
 *
 * Before this, `reference.allowedTypes` was checked only against the `type`
 * string the client chose to send (omit it, or lie, and anything passed), and a
 * content-area `ref` was never resolved at all: `{blockType:"HeroBlock", ref}`
 * saved and published pointing at a Form, a trashed block, a document in
 * another site, or nothing. Delivery hid all of those (they resolve to null),
 * which is exactly the success-then-blank outcome agent-API rule #1 forbids.
 * This is also what closes the documented "cross-site references aren't
 * blocked at write" gap.
 */
describe("reference targets are validated at write", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  const TYPE = "RefTargetProbePage";
  let articleId: string; // allowed reference target
  let landingId: string; // disallowed reference target
  let cardId: string; // a valid shared block
  let formId: string; // a shared block of the WRONG type
  let trashedId: string; // a shared block in the trash
  let otherSiteId: string; // a shared block in another site
  let settingsId: string; // a global

  const create = async (type: string, name: string, headers = authHeaders(admin)): Promise<string> => {
    const r = await s.app.inject({ method: "POST", url: "/api/v1/manage/content", headers, payload: { type, parentId: null, locale: "en", name } });
    expect(r.statusCode, r.body).toBe(200);
    return r.json().documentId as string;
  };
  const save = (documentId: string, data: Record<string, unknown>) =>
    s.app.inject({ method: "PUT", url: `/api/v1/manage/content/${documentId}?locale=en`, headers: authHeaders(admin), payload: { data } });
  const publish = (documentId: string) =>
    s.app.inject({ method: "POST", url: `/api/v1/manage/content/${documentId}/publish?locale=en`, headers: authHeaders(admin) });

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    for (const name of ["Form", "FormTextField"]) {
      const r = await s.app.inject({ method: "POST", url: `/api/v1/manage/type-templates/${name}/instantiate`, headers: authHeaders(admin), payload: { updateExisting: true } });
      expect(r.statusCode, r.body).toBe(200);
    }
    const def = {
      name: TYPE,
      displayName: "Ref target probe",
      kind: "page",
      fields: [
        { name: "related", displayName: "Related", type: "reference", delivery: "public", allowedTypes: ["ArticlePage"] },
        { name: "area", displayName: "Area", type: "contentArea", delivery: "public", allowedBlocks: [] },
      ],
    };
    const created = await s.app.inject({ method: "POST", url: "/api/v1/manage/content-types", headers: authHeaders(admin), payload: def });
    expect(created.statusCode, created.body).toBe(200);

    articleId = await create("ArticlePage", "Ref target article");
    landingId = await create("LandingPage", "Ref target landing");
    cardId = await create("CardBlock", "Ref target card");
    formId = await create("Form", "Ref target form");
    trashedId = await create("CardBlock", "Ref target trashed");
    const trashed = await s.app.inject({ method: "DELETE", url: `/api/v1/manage/content/${trashedId}`, headers: authHeaders(admin) });
    expect(trashed.statusCode, trashed.body).toBe(200);

    const site = await s.app.inject({ method: "POST", url: "/api/v1/manage/sites", headers: authHeaders(admin), payload: { slug: "brand-ref", name: "Brand Ref", defaultLocale: "en" } });
    expect(site.statusCode, site.body).toBe(200);
    otherSiteId = await create("CardBlock", "Other site card", { ...authHeaders(admin), "x-paperboy-site": site.json().id as string });

    const settings = await s.app.inject({ method: "GET", url: "/api/v1/delivery/globals/SiteSettings?locale=en", headers: { authorization: "Bearer prv_test_preview" } });
    expect(settings.statusCode, settings.body).toBe(200);
    settingsId = settings.json().documentId as string;
  });
  afterAll(async () => {
    await s.app.close();
  });

  describe("reference fields", () => {
    it("enforces allowedTypes on the target's REAL type when the client omits `type`", async () => {
      const id = await create(TYPE, "Ref omit type");
      const res = await save(id, { related: { documentId: landingId } });
      expect(res.statusCode, res.body).toBe(422);
      expect(res.body).toContain("related");
      expect(res.body).toContain("LandingPage");
    });

    it("enforces allowedTypes on the REAL type when the client's `type` lies", async () => {
      const id = await create(TYPE, "Ref lying type");
      const res = await save(id, { related: { documentId: landingId, type: "ArticlePage" } });
      expect(res.statusCode, res.body).toBe(422);
      expect(res.body).toContain("LandingPage");
    });

    it("accepts an allowed target, with or without the type hint", async () => {
      const id = await create(TYPE, "Ref ok");
      expect((await save(id, { related: { documentId: articleId } })).statusCode).toBe(200);
      expect((await save(id, { related: { documentId: articleId, type: "ArticlePage" } })).statusCode).toBe(200);
    });

    it("refuses a target that does not exist, naming the field", async () => {
      const id = await create(TYPE, "Ref missing");
      const res = await save(id, { related: { documentId: "doc_does_not_exist" } });
      expect(res.statusCode, res.body).toBe(422);
      expect(res.body).toContain("related");
      expect(res.body).toMatch(/does not exist/i);
    });
  });

  describe("content-area refs", () => {
    const entry = (blockType: string, ref: string) => ({ key: "r1", blockType, display: "automatic", ref, inline: null });

    it("still allows a PAGE as a teaser", async () => {
      const id = await create(TYPE, "Area page teaser");
      const res = await save(id, { area: [entry("ArticlePage", articleId)] });
      expect(res.statusCode, res.body).toBe(200);
    });

    it("refuses a ref whose real type differs from blockType, and says what it really is", async () => {
      const id = await create(TYPE, "Area wrong type");
      const res = await save(id, { area: [entry("HeroBlock", formId)] });
      expect(res.statusCode, res.body).toBe(422);
      const message = res.json().message as string;
      expect(message).toContain('blockType "HeroBlock"');
      expect(message).toContain('is a "Form"');
    });

    it("refuses a ref to a trashed document", async () => {
      const id = await create(TYPE, "Area trashed");
      const res = await save(id, { area: [entry("CardBlock", trashedId)] });
      expect(res.statusCode, res.body).toBe(422);
      expect(res.body).toMatch(/trash/i);
    });

    it("refuses a ref to a document in another site (reads as not existing here)", async () => {
      const id = await create(TYPE, "Area cross-site");
      const res = await save(id, { area: [entry("CardBlock", otherSiteId)] });
      expect(res.statusCode, res.body).toBe(422);
      expect(res.body).toMatch(/does not exist in this site/i);
    });

    it("refuses a ref to a document that does not exist", async () => {
      const id = await create(TYPE, "Area missing");
      const res = await save(id, { area: [entry("CardBlock", "doc_does_not_exist")] });
      expect(res.statusCode, res.body).toBe(422);
      expect(res.body).toMatch(/does not exist/i);
    });

    it("refuses a ref to a GLOBAL — only blocks and pages belong in an area", async () => {
      const id = await create(TYPE, "Area global");
      const res = await save(id, { area: [entry("SiteSettings", settingsId)] });
      expect(res.statusCode, res.body).toBe(422);
      expect(res.body).toMatch(/global/i);
    });

    it("a valid shared-block ref still saves and publishes", async () => {
      const id = await create(TYPE, "Area valid");
      expect((await save(id, { area: [entry("CardBlock", cardId)] })).statusCode).toBe(200);
      const pub = await publish(id);
      expect(pub.statusCode, pub.body).toBe(200);
    });
  });

  describe("an inline Form", () => {
    it("is refused: a Form must be a SHARED block (submissions post against its documentId)", async () => {
      const id = await create(TYPE, "Inline form");
      const res = await save(id, { area: [{ key: "f1", blockType: "Form", inline: { title: "x" }, ref: null, display: "automatic" }] });
      expect(res.statusCode, res.body).toBe(422);
      expect(res.body).toMatch(/shared/i);
    });

    it("a ref to a Form is fine", async () => {
      const id = await create(TYPE, "Shared form");
      const res = await save(id, { area: [{ key: "f1", blockType: "Form", ref: formId, inline: null, display: "automatic" }] });
      expect(res.statusCode, res.body).toBe(200);
    });
  });
});
