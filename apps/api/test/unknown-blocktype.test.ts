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
