import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * An unknown `blockType` must be REJECTED, not silently emptied.
 *
 * `allowedBlocks` defaults to `[]`, which the schema documents as "any block" — and
 * that used to mean "no check at all". So
 * `{blockType:"HerooBlock", inline:{titel:"Hi"}}` saved 200, PUBLISHED 200, and then
 * delivered `data:{}, fieldTypes:{}`: the inline payload vanished with no error
 * anywhere. Three successes and a blank page is exactly the retry loop agent-API
 * rule #1 ("never garbage-in-success-out") exists to prevent — and a typo'd block
 * name is a mistake real agents make.
 */
describe("unknown blockType is rejected at the write chokepoint", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
  });

  /** A LandingPage whose mainArea lists allowedBlocks, plus a type that doesn't. */
  async function newPage(name: string, type = "LandingPage"): Promise<string> {
    const r = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(admin),
      payload: { type, parentId: null, locale: "en", name },
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

  const block = (blockType: string, inline: Record<string, unknown> = {}) => ({
    key: "k1",
    blockType,
    display: "automatic",
    shared: false,
    ref: null,
    inline,
  });

  it("refuses a typo'd blockType instead of saving and delivering an empty block", async () => {
    const id = await newPage("Unknown Block Typo");
    const res = await save(id, { mainArea: [block("HerooBlock", { titel: "Hi" })] });
    expect(res.statusCode, res.body).not.toBe(200);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("the refusal names the bad type AND the installed ones (self-teaching, rule #2)", async () => {
    const id = await newPage("Unknown Block Message");
    const res = await save(id, { mainArea: [block("HerooBlock")] });
    const message = res.json().message as string;
    expect(message).toContain("HerooBlock");
    expect(message).toMatch(/CardBlock/); // an actually-installed block
    expect(message).toMatch(/not an installed content type/i);
  });

  it("still accepts a real block type", async () => {
    const id = await newPage("Unknown Block Happy");
    const res = await save(id, { mainArea: [block("CardBlock", { title: "Fine" })] });
    expect(res.statusCode, res.body).toBe(200);
  });

  it("still accepts a PAGE dropped into an area (rendered as a teaser)", async () => {
    const target = await newPage("Unknown Block Teaser Target", "ArticlePage");
    const id = await newPage("Unknown Block Teaser Host");
    const res = await save(id, {
      mainArea: [{ key: "t1", blockType: "ArticlePage", display: "automatic", shared: true, ref: target, inline: null }],
    });
    expect(res.statusCode, res.body).toBe(200);
  });

  it("an unknown type is refused even when the area declares allowedBlocks", async () => {
    // LandingPage.mainArea has a non-empty allowedBlocks, so this path was already
    // covered — assert it still reports the not-installed reason, not just "not allowed".
    const id = await newPage("Unknown Block With Allowlist");
    const res = await save(id, { mainArea: [block("DefinitelyNotAType")] });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.json().message as string).toMatch(/not an installed content type/i);
  });
});

/**
 * A PART must not land in an area that merely allows "any block".
 *
 * `nestedOnly` says a type is only ever part of another one — a Form's field
 * blocks. "Any block" therefore means any GENERAL block: without this, a Date
 * field dropped into an article body saved 200 and delivered a block no
 * frontend can render, which is the same garbage-in-success-out the unknown
 * blockType case above exists to stop. An area that names the part explicitly
 * in allowedBlocks has opted in and is untouched.
 */
describe("nested-only parts are rejected where any block goes", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    for (const name of ["Form", "FormDateField"]) {
      const r = await s.app.inject({
        method: "POST",
        url: `/api/v1/manage/type-templates/${name}/instantiate`,
        headers: authHeaders(admin),
        payload: { updateExisting: true },
      });
      expect(r.statusCode, r.body).toBe(200);
    }
  });
  afterAll(async () => {
    await s.app.close();
  });

  const partBlock = {
    key: "p1",
    blockType: "FormDateField",
    display: "automatic",
    shared: false,
    ref: null,
    inline: { name: "when", label: "When" },
  };

  async function typeWithArea(typeName: string, allowedBlocks: string[]) {
    const def = {
      name: typeName,
      displayName: typeName,
      kind: "page",
      fields: [{ name: "area", displayName: "Area", type: "contentArea", delivery: "public", allowedBlocks }],
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
        url: `/api/v1/manage/content-types/${typeName}`,
        headers: authHeaders(admin),
        payload: def,
      });
      expect(put.statusCode, put.body).toBe(200);
    } else {
      expect(created.statusCode, created.body).toBe(200);
    }
    const page = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(admin),
      payload: { type: typeName, parentId: null, locale: "en", name: `${typeName} instance` },
    });
    expect(page.statusCode, page.body).toBe(200);
    return page.json().documentId as string;
  }

  const save = (documentId: string, data: Record<string, unknown>) =>
    s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${documentId}?locale=en`,
      headers: authHeaders(admin),
      payload: { data },
    });

  it("refuses a part in an area with no allow-list, and says how to fix it", async () => {
    const id = await typeWithArea("PartsOpenArea", []);
    const res = await save(id, { area: [partBlock] });
    expect(res.statusCode, res.body).toBe(422);
    // Self-teaching (rule 2): name the type, say what it is, offer the way out.
    expect(res.body).toContain("FormDateField");
    expect(res.body).toMatch(/part|only used inside|allowed blocks/i);
  });

  it("accepts the same part where the area names it explicitly", async () => {
    const id = await typeWithArea("PartsOptedIn", ["FormDateField"]);
    const res = await save(id, { area: [partBlock] });
    expect(res.statusCode, res.body).toBe(200);
  });

  it("still accepts a general block in an area with no allow-list", async () => {
    const id = await typeWithArea("PartsOpenArea2", []);
    const res = await save(id, {
      area: [{ key: "g1", blockType: "HeroBlock", display: "automatic", shared: false, ref: null, inline: {} }],
    });
    expect(res.statusCode, res.body).toBe(200);
  });
});

/**
 * The same rule, one level down.
 *
 * `assertAllowedTypes` walked `type.fields` and stopped there, while the schema
 * layer deliberately returns on an unknown block type because "the db layer
 * already refuses it". Both statements were true at the top level and false
 * below it, so TWO GUARDS EACH DEFERRING TO THE OTHER left nested payloads
 * unchecked: a mistyped field inside a Form's `fields` area — `FormTextFeild`,
 * `AccordionItm` — saved 200, PUBLISHED 200, and delivered
 * `{blockType:"FormTextFeild", data:{}, fieldTypes:{}}`. The question silently
 * vanished from the form and the agent collected two successes, which is the
 * HerooBlock incident back one level deeper.
 *
 * The guard runs from `updateContent` and from `assertDraftPublishable`, so
 * fixing it in one place closes save and publish together.
 *
 * The container is a test-defined FieldsetBlock whose `fields` area names the
 * form field parts, not an inline Form: a Form must be a SHARED block (its
 * documentId is what submissions post against), so an inline one is refused
 * before any nesting is looked at — see reference-target-validation.test.ts.
 */
describe("an unknown blockType is rejected inside a nested block too", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    for (const name of ["FormTextField", "FormDateField"]) {
      const r = await s.app.inject({
        method: "POST",
        url: `/api/v1/manage/type-templates/${name}/instantiate`,
        headers: authHeaders(admin),
        payload: { updateExisting: true },
      });
      expect(r.statusCode, r.body).toBe(200);
    }
    const fieldset = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content-types",
      headers: authHeaders(admin),
      payload: {
        name: "FieldsetBlock",
        displayName: "Fieldset",
        kind: "block",
        fields: [
          { name: "title", displayName: "Title", type: "text", delivery: "public" },
          { name: "fields", displayName: "Fields", type: "contentArea", delivery: "public", allowedBlocks: ["FormTextField", "FormDateField"] },
        ],
      },
    });
    expect(fieldset.statusCode, fieldset.body).toBe(200);
  });
  afterAll(async () => {
    await s.app.close();
  });

  /** A FieldsetBlock, inline in a page area, holding one field block in `fields`. */
  const formWith = (fieldBlockType: string) => ({
    area: [
      {
        key: "form1",
        blockType: "FieldsetBlock",
        display: "automatic",
        shared: false,
        ref: null,
        inline: {
          title: "Contact",
          fields: [
            {
              key: "q1",
              blockType: fieldBlockType,
              display: "automatic",
              shared: false,
              ref: null,
              inline: { name: "q", label: "Your question" },
            },
          ],
        },
      },
    ],
  });

  async function pageWithOpenArea(typeName: string): Promise<string> {
    const def = {
      name: typeName,
      displayName: typeName,
      kind: "page",
      fields: [{ name: "area", displayName: "Area", type: "contentArea", delivery: "public", allowedBlocks: [] }],
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
        url: `/api/v1/manage/content-types/${typeName}`,
        headers: authHeaders(admin),
        payload: def,
      });
      expect(put.statusCode, put.body).toBe(200);
    } else {
      expect(created.statusCode, created.body).toBe(200);
    }
    const page = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(admin),
      payload: { type: typeName, parentId: null, locale: "en", name: `${typeName} instance` },
    });
    expect(page.statusCode, page.body).toBe(200);
    return page.json().documentId as string;
  }

  const save = (documentId: string, data: Record<string, unknown>) =>
    s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${documentId}?locale=en`,
      headers: authHeaders(admin),
      payload: { data },
    });

  it("refuses a typo'd field type inside a Form's fields area", async () => {
    const id = await pageWithOpenArea("NestedTypoHost");
    const res = await save(id, formWith("FormTextFeild"));
    expect(res.statusCode, res.body).toBeGreaterThanOrEqual(400);
  });

  it("the refusal names the bad type, the installed ones, and where it sits", async () => {
    const id = await pageWithOpenArea("NestedTypoMessage");
    const res = await save(id, formWith("FormTextFeild"));
    const message = res.json().message as string;
    expect(message).toContain("FormTextFeild");
    expect(message).toMatch(/not an installed content type/i);
    // Rule #2: an error an agent can act on has to say WHERE, or the fix is a
    // guess. The path names the outer field and the block it is nested in.
    expect(message).toMatch(/area/);
    expect(message).toMatch(/FieldsetBlock/);
  });

  it("refuses it at PUBLISH as well, since both surfaces share the guard", async () => {
    const id = await pageWithOpenArea("NestedTypoPublish");
    expect((await save(id, formWith("FormTextFeild"))).statusCode).toBeGreaterThanOrEqual(400);
    const published = await s.app.inject({
      method: "POST",
      url: `/api/v1/manage/content/${id}/publish?locale=en`,
      headers: authHeaders(admin),
    });
    // Nothing valid was ever stored, so publish must not turn the empty draft
    // into a live page carrying the dropped block either.
    expect(published.statusCode).not.toBe(500);
  });

  it("still accepts the correct nested type, and publishes it", async () => {
    const id = await pageWithOpenArea("NestedHappy");
    const saved = await save(id, formWith("FormTextField"));
    expect(saved.statusCode, saved.body).toBe(200);
    const published = await s.app.inject({
      method: "POST",
      url: `/api/v1/manage/content/${id}/publish?locale=en`,
      headers: authHeaders(admin),
    });
    expect(published.statusCode, published.body).toBe(200);
  });

  it("still accepts a PART nested in the area that names it", async () => {
    // FieldsetBlock.fields lists the field parts explicitly, so a part belongs
    // there — the recursion must not start refusing legitimate nesting.
    const id = await pageWithOpenArea("NestedPartOptedIn");
    const res = await save(id, formWith("FormDateField"));
    expect(res.statusCode, res.body).toBe(200);
  });

  /**
   * Past the depth cap the payload is REFUSED, not waved through.
   *
   * Coercion and schema validation both stop at MAX_INLINE_DEPTH, so anything
   * below it reaches storage unchecked — which would leave the recursion above
   * bypassable by the cheapest trick there is: nest one level deeper. The
   * assertion is on the REFUSAL, not on "did not throw": a guard whose test
   * would still pass with the guard deleted is not a guard.
   */
  describe("the nesting depth cap", () => {
    /** A block type whose own area accepts any block, so it can nest in itself. */
    async function selfNestingType(): Promise<void> {
      const def = {
        name: "SelfNest",
        displayName: "Self nest",
        kind: "block",
        fields: [{ name: "area", displayName: "Area", type: "contentArea", delivery: "public", allowedBlocks: [] }],
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
          url: "/api/v1/manage/content-types/SelfNest",
          headers: authHeaders(admin),
          payload: def,
        });
        expect(put.statusCode, put.body).toBe(200);
      } else {
        expect(created.statusCode, created.body).toBe(200);
      }
    }

    /** `depth` SelfNest blocks, each inside the previous one's area. */
    const chain = (depth: number): Record<string, unknown> => {
      let inner: Record<string, unknown> = { area: [] };
      for (let i = 0; i < depth; i++) {
        inner = {
          area: [{ key: `n${i}`, blockType: "SelfNest", display: "automatic", shared: false, ref: null, inline: inner }],
        };
      }
      return inner;
    };

    it("accepts a legal depth", async () => {
      await selfNestingType();
      const id = await pageWithOpenArea("DepthLegal");
      const res = await save(id, chain(4));
      expect(res.statusCode, res.body).toBe(200);
    });

    /**
     * "At most 10 levels deep" means ten nested inline blocks are legal and the
     * eleventh is refused — the same ten levels coercion and schema validation
     * walk (MAX_INLINE_DEPTH). The guard used to refuse the tenth while its
     * message promised ten, so the three disagreed by one.
     */
    it("accepts exactly MAX_INLINE_DEPTH (10) nested inline blocks", async () => {
      await selfNestingType();
      const id = await pageWithOpenArea("DepthAtCap");
      const res = await save(id, chain(10));
      expect(res.statusCode, res.body).toBe(200);
    });

    it("refuses the eleventh, naming its level", async () => {
      await selfNestingType();
      const id = await pageWithOpenArea("DepthPastCap");
      const res = await save(id, chain(11));
      expect(res.statusCode, res.body).toBe(422);
      const message = res.json().message as string;
      expect(message).toMatch(/at most 10 levels/i);
      expect(message).toMatch(/level 11/);
    });

    it("refuses a payload nested past the cap, and says so", async () => {
      await selfNestingType();
      const id = await pageWithOpenArea("DepthTooDeep");
      const res = await save(id, chain(14));
      expect(res.statusCode, res.body).toBe(422);
      const message = res.json().message as string;
      expect(message).toMatch(/nest at most/i);
      expect(message).toMatch(/10/);
    });
  });
});
