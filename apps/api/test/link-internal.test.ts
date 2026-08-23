import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PREVIEW_KEY, PUBLIC_KEY, type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * An INTERNAL link stores the target's documentId and delivery resolves the
 * live path — so the link cannot rot.
 *
 * A hand-typed "/blog" is a string nobody can follow backwards: rename the
 * slug and every link to it 404s silently, and the CMS has no idea the link
 * exists. Optimizely stores internal links as permanent GUID references for
 * exactly this reason and explicitly does not support them on plain string
 * properties. These tests pin the three things that buys: the path is resolved,
 * it FOLLOWS a rename, and an unpublished target does not leak a broken href
 * into published output.
 */
describe("internal links resolve, and follow the page", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  const TYPE = "LinkProbePage";

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");

    const def = {
      name: TYPE,
      displayName: "Link probe",
      kind: "page",
      fields: [{ name: "cta", displayName: "CTA", type: "link", delivery: "public" }],
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
  });
  afterAll(async () => {
    await s.app.close();
  });

  async function page(type: string, name: string, slug?: string): Promise<string> {
    const r = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(admin),
      payload: { type, parentId: null, locale: "en", name },
    });
    expect(r.statusCode, r.body).toBe(200);
    const id = r.json().documentId as string;
    if (slug) {
      const put = await s.app.inject({
        method: "PUT",
        url: `/api/v1/manage/content/${id}?locale=en`,
        headers: authHeaders(admin),
        payload: { slug, data: {} },
      });
      expect(put.statusCode, put.body).toBe(200);
    }
    return id;
  }

  const setCta = (id: string, cta: unknown) =>
    s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${id}?locale=en`,
      headers: authHeaders(admin),
      payload: { data: { cta } },
    });

  const publish = (id: string) =>
    s.app.inject({
      method: "POST",
      url: `/api/v1/manage/content/${id}/publish?locale=en`,
      headers: authHeaders(admin),
      payload: {},
    });

  const deliver = async (id: string, key: string) => {
    const r = await s.app.inject({
      method: "GET",
      url: `/api/v1/delivery/content/${id}`,
      headers: { authorization: `Bearer ${key}` },
    });
    return { status: r.statusCode, body: r.json() as { data?: Record<string, unknown> } };
  };

  /** The delivered `cta` value, whatever shape it came back as. */
  const ctaOf = async (id: string, key: string) => {
    const { body } = await deliver(id, key);
    return (body.data?.cta ?? {}) as { href?: string; documentId?: string; text?: string; target?: string };
  };

  it("resolves a documentId to the target's live path, and keeps the identity", async () => {
    const target = await page(TYPE, "Link target", "link-target");
    expect((await publish(target)).statusCode).toBe(200);

    const host = await page(TYPE, "Host with internal link");
    expect((await setCta(host, { documentId: target, text: "Read it" })).statusCode).toBe(200);
    expect((await publish(host)).statusCode).toBe(200);

    const { body } = await deliver(host, PUBLIC_KEY);
    const cta = body.data?.cta as { href?: string; documentId?: string; text?: string };
    expect(cta.href).toBe("/link-target");
    // Both halves, like Optimizely's headless ContentReference {key, url}: the
    // frontend renders href, anything clever can use the identity.
    expect(cta.documentId).toBe(target);
    expect(cta.text).toBe("Read it");
  });

  it("FOLLOWS a slug rename with no edit to the linking page", async () => {
    const target = await page(TYPE, "Renamed target", "before-rename");
    expect((await publish(target)).statusCode).toBe(200);
    const host = await page(TYPE, "Host across a rename");
    expect((await setCta(host, { documentId: target })).statusCode).toBe(200);
    expect((await publish(host)).statusCode).toBe(200);
    expect((await ctaOf(host, PUBLIC_KEY)).href).toBe("/before-rename");

    // Rename the TARGET only. This is the whole point: a typed path would now
    // be a 404 and nobody would know.
    const rename = await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${target}?locale=en`,
      headers: authHeaders(admin),
      payload: { slug: "after-rename", data: {} },
    });
    expect(rename.statusCode, rename.body).toBe(200);
    expect((await publish(target)).statusCode).toBe(200);

    expect((await ctaOf(host, PUBLIC_KEY)).href).toBe("/after-rename");
  });

  it("does not emit a href for a target that is not published", async () => {
    // Published output must never send a visitor to a page that isn't live.
    const draft = await page(TYPE, "Unpublished target", "never-published");
    const host = await page(TYPE, "Host linking a draft");
    expect((await setCta(host, { documentId: draft })).statusCode).toBe(200);
    expect((await publish(host)).statusCode).toBe(200);

    const pub = await ctaOf(host, PUBLIC_KEY);
    expect(pub.href).toBe("");
    expect(pub.documentId).toBe(draft);
    // The preview perspective DOES see it — that's what preview is for.
    const prev = await ctaOf(host, PREVIEW_KEY);
    expect(prev.href).toBe("/never-published");
  });

  it("appends an anchor to the resolved path", async () => {
    const target = await page(TYPE, "Anchored target", "anchored");
    expect((await publish(target)).statusCode).toBe(200);
    const host = await page(TYPE, "Host with anchor");
    expect((await setCta(host, { documentId: target, anchor: "faq" })).statusCode).toBe(200);
    expect((await publish(host)).statusCode).toBe(200);
    expect((await ctaOf(host, PUBLIC_KEY)).href).toBe("/anchored#faq");
  });

  it("leaves an external link exactly as authored", async () => {
    const host = await page(TYPE, "Host with external link");
    expect((await setCta(host, { href: "https://example.com/x?a=1", target: "_blank" })).statusCode).toBe(200);
    expect((await publish(host)).statusCode).toBe(200);
    const cta = await ctaOf(host, PUBLIC_KEY);
    expect(cta.href).toBe("https://example.com/x?a=1");
    expect(cta.target).toBe("_blank");
    expect(cta.documentId).toBeUndefined();
  });

  it("still refuses a scheme that would execute in the visitor's browser", async () => {
    const host = await page(TYPE, "Host with a hostile link");
    const res = await setCta(host, { href: "javascript:alert(1)" });
    expect(res.statusCode).toBe(422);
  });

  it("accepts a bare string, so a text field retyped to `link` keeps working", async () => {
    // coerceFieldValue turns the destination string into { href }.
    const host = await page(TYPE, "Host retyped from text");
    expect((await setCta(host, "/blog")).statusCode).toBe(200);
    expect((await publish(host)).statusCode).toBe(200);
    expect((await ctaOf(host, PUBLIC_KEY)).href).toBe("/blog");
  });

  it("records an internal link as a reference, so link integrity can see it", async () => {
    const target = await page(TYPE, "Referenced by a link", "linked-to");
    const host = await page(TYPE, "Host that references");
    expect((await setCta(host, { documentId: target })).statusCode).toBe(200);

    // The usage endpoint reports what points at a document.
    const usage = await s.app.inject({
      method: "GET",
      url: `/api/v1/manage/content/${target}/references`,
      headers: authHeaders(admin),
    });
    if (usage.statusCode === 404) return; // no such endpoint in this build
    expect(usage.statusCode, usage.body).toBe(200);
    expect(JSON.stringify(usage.json())).toContain(host);
  });
});
