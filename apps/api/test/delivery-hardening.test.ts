import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PUBLIC_KEY, type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * Two delivery findings from the review.
 *
 * #5 — sanitize's final `else` emitted a stored value verbatim when it didn't
 * match the field's CURRENT declared type. Retyping a contentArea field to text
 * in the type editor (no data migration) then made the next public read return
 * the raw block array — private inline fields and all.
 *
 * #6 — deliveryPages read `noIndex` from the raw locale-version row, skipping
 * fillNonLocalizedFields, so a noIndex flag set while editing one locale never
 * reached the sibling locale, and sitemap.xml/llms.txt advertised the path the
 * CMS was simultaneously telling crawlers not to index.
 */
describe("delivery hardening (P2)", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  const pub = { authorization: `Bearer ${PUBLIC_KEY}` };

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("#5: a retyped field does not leak the old structured value's private contents", async () => {
    // A block with a private field, held inline in a page's content area.
    const blockType = {
      name: "RetypeLeakBlock",
      displayName: "Retype Leak Block",
      kind: "block",
      fields: [
        { name: "label", displayName: "Label", type: "text", delivery: "public" },
        { name: "secret", displayName: "Secret", type: "text", delivery: "private" },
      ],
    };
    expect((await s.app.inject({ method: "POST", url: "/api/v1/manage/content-types", headers: authHeaders(admin), payload: blockType })).statusCode).toBe(200);

    const pageType = {
      name: "RetypeLeakPage",
      displayName: "Retype Leak Page",
      kind: "page",
      fields: [{ name: "body", displayName: "Body", type: "contentArea", delivery: "public", allowedBlocks: [] }],
    };
    expect((await s.app.inject({ method: "POST", url: "/api/v1/manage/content-types", headers: authHeaders(admin), payload: pageType })).statusCode).toBe(200);

    const created = await s.app.inject({ method: "POST", url: "/api/v1/manage/content", headers: authHeaders(admin), payload: { type: "RetypeLeakPage", locale: "en", name: "Retype victim" } });
    const id = created.json().documentId as string;
    await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${id}?locale=en`,
      headers: authHeaders(admin),
      payload: { data: { body: [{ key: "b1", blockType: "RetypeLeakBlock", display: "automatic", shared: false, ref: null, inline: { label: "visible", secret: "SENTINEL_LEAK" } }] } },
    });
    expect((await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${id}/publish?locale=en`, headers: authHeaders(admin) })).statusCode).toBe(200);

    // Baseline: nested sanitize already strips the private field from the array.
    const before = await s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${id}?locale=en`, headers: pub });
    expect(before.body).not.toContain("SENTINEL_LEAK");

    // Retype body: contentArea -> text. No data migration; the array stays stored.
    const retyped = { ...pageType, fields: [{ name: "body", displayName: "Body", type: "text", delivery: "public" }] };
    expect((await s.app.inject({ method: "PUT", url: "/api/v1/manage/content-types/RetypeLeakPage", headers: authHeaders(admin), payload: retyped })).statusCode).toBe(200);

    // The public read must not now ship the stale array with its private field.
    const after = await s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${id}?locale=en`, headers: pub });
    expect(after.statusCode).toBe(200);
    expect(after.body).not.toContain("SENTINEL_LEAK");
    // And the field certainly isn't the raw block array.
    expect(Array.isArray(after.json().data.body)).toBe(false);
  });

  it("#6: noIndex set on one locale hides the sibling locale from the inventory too", async () => {
    // Home (en) / Hjem (nb) are the same document; noIndex is localized:false.
    const homeId = s.ids.homeId;
    const get = async (locale: string) => (await s.app.inject({ method: "GET", url: `/api/v1/manage/content/${homeId}?locale=${locale}`, headers: { cookie: admin.cookie } })).json();

    // Set noIndex while editing the EN variant only, and republish both.
    const en = await get("en");
    await s.app.inject({ method: "PUT", url: `/api/v1/manage/content/${homeId}?locale=en`, headers: authHeaders(admin), payload: { data: { ...en.data, noIndex: true } } });
    await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${homeId}/publish?locale=en`, headers: authHeaders(admin) });
    await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${homeId}/publish?locale=nb`, headers: authHeaders(admin) });

    const res = await s.app.inject({ method: "GET", url: "/api/v1/delivery/pages", headers: pub });
    const pages = (res.json() as { pages: Array<{ name: string; locale: string; noIndex: boolean }> }).pages;
    const enRow = pages.find((p) => p.locale === "en" && p.name === "Home");
    const nbRow = pages.find((p) => p.locale === "nb" && p.name === "Hjem");
    expect(enRow?.noIndex).toBe(true);
    // The sibling locale never stored noIndex, but it is a shared (non-localized)
    // field, so the inventory must report it noIndex too — not advertise it.
    expect(nbRow?.noIndex).toBe(true);
  });
});
