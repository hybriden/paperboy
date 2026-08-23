import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * A constraint a content type DECLARES must be one the API actually enforces.
 *
 * Every entry here is the server half of an admin control that offers a
 * restricted set of options. When the two disagree the failure is silent in one
 * direction (the editor picks something the write rejects, and finds out later)
 * or invisible in the other (a value the write accepts that no editor can
 * choose, so it only ever arrives over REST/MCP). The reference-picker bug was
 * the second kind: it listed pages only, so a reference constrained to a block
 * type could not be set from the admin at all.
 *
 * `allowedBlocks` and unknown/nested-only block types are covered by
 * unknown-blocktype.test.ts; image-field documentIds by update-ergonomics.
 */
describe("declared field constraints are enforced by the API", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  let articleId: string;

  const TYPE = "ConstraintProbePage";

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");

    const def = {
      name: TYPE,
      displayName: "Constraint probe",
      kind: "page",
      fields: [
        { name: "related", displayName: "Related", type: "reference", delivery: "public", allowedTypes: ["ArticlePage"] },
        {
          name: "priority",
          displayName: "Priority",
          type: "select",
          delivery: "public",
          options: [
            { value: "low", label: "Low" },
            { value: "high", label: "High" },
          ],
        },
      ],
    };
    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content-types",
      headers: authHeaders(admin),
      payload: def,
    });
    if (created.statusCode === 409) {
      const put = await s.app.inject({
        method: "PUT",
        url: `/api/v1/manage/content-types/${TYPE}`,
        headers: authHeaders(admin),
        payload: def,
      });
      expect(put.statusCode, put.body).toBe(200);
    } else {
      expect(created.statusCode, created.body).toBe(200);
    }

    // An ArticlePage (allowed) to point at.
    const article = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(admin),
      payload: { type: "ArticlePage", parentId: null, locale: "en", name: "Constraint target article" },
    });
    expect(article.statusCode, article.body).toBe(200);
    articleId = article.json().documentId as string;
  });
  afterAll(async () => {
    await s.app.close();
  });

  async function probePage(name: string): Promise<string> {
    const r = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(admin),
      payload: { type: TYPE, parentId: null, locale: "en", name },
    });
    expect(r.statusCode, r.body).toBe(200);
    return r.json().documentId as string;
  }

  const save = (documentId: string, data: Record<string, unknown>) =>
    s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${documentId}?locale=en`,
      headers: authHeaders(admin),
      payload: { data },
    });

  const publish = (documentId: string) =>
    s.app.inject({
      method: "POST",
      url: `/api/v1/manage/content/${documentId}/publish?locale=en`,
      headers: authHeaders(admin),
      payload: {},
    });

  describe("reference.allowedTypes", () => {
    it("accepts a reference to an allowed type", async () => {
      const id = await probePage("Ref allowed");
      const res = await save(id, { related: { documentId: articleId, type: "ArticlePage" } });
      expect(res.statusCode, res.body).toBe(200);
    });

    it("refuses a reference to a type the field does not allow", async () => {
      // The admin picker now offers only allowed types; this is the half that
      // holds for REST and MCP, where there is no picker.
      const id = await probePage("Ref disallowed");
      const other = await s.app.inject({
        method: "POST",
        url: "/api/v1/manage/content",
        headers: authHeaders(admin),
        payload: { type: "LandingPage", parentId: null, locale: "en", name: "Wrong-typed target" },
      });
      expect(other.statusCode, other.body).toBe(200);
      const res = await save(id, {
        related: { documentId: other.json().documentId as string, type: "LandingPage" },
      });
      expect(res.statusCode, res.body).toBe(422);
      expect(res.body).toContain("LandingPage");
    });
  });

  describe("select options", () => {
    it("accepts and publishes a declared option", async () => {
      const id = await probePage("Select ok");
      expect((await save(id, { priority: "high" })).statusCode).toBe(200);
      const pub = await publish(id);
      expect(pub.statusCode, pub.body).toBe(200);
    });

    it("refuses to PUBLISH a value that is not one of the options", async () => {
      // Drafts are deliberately relaxed (work in progress saves), so the gate is
      // at publish — same split as required fields.
      const id = await probePage("Select bogus");
      expect((await save(id, { priority: "urgent" })).statusCode).toBe(200);
      const pub = await publish(id);
      expect(pub.statusCode, pub.body).toBe(422);
      expect(pub.body).toMatch(/priority/i);
    });
  });
});
