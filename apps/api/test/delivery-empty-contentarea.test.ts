import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PREVIEW_KEY, PUBLIC_KEY, type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * A content-area field DEFINED on a type must always appear in delivery output
 * (as []), in BOTH perspectives, even when the instance never set it — a
 * frontend can't tell "this type has a content area (currently empty)" from
 * "this type has none" otherwise.
 *
 * Unset editable text/richtext fields are perspective-dependent: PREVIEW
 * surfaces them (so on-page editing has a clickable target), PUBLISHED omits
 * them (lean public payloads).
 */
describe("Delivery — defined-but-unset content area + editable fields", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  const prev = { authorization: `Bearer ${PREVIEW_KEY}` };
  const pub = { authorization: `Bearer ${PUBLIC_KEY}` };

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("unset mainArea is [] in both perspectives; unset intro is present in preview, absent published", async () => {
    // LandingPage (seed type) defines `mainArea` (contentArea) + `intro` (richtext).
    // Create a draft that sets NEITHER, so both are absent from stored data.
    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(admin),
      payload: { type: "LandingPage", locale: "en", name: "Empty CA page" },
    });
    expect(created.statusCode).toBe(200);
    const id = created.json().documentId as string;

    // PREVIEW: content area present as [], AND the unset richtext field present
    // (null) so on-page editing can place a clickable marker.
    const res = await s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${id}?locale=en&populate=0`, headers: prev });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as Record<string, unknown>;
    expect(data.mainArea).toEqual([]);
    expect("intro" in data).toBe(true);
    expect(data.intro).toBeNull();

    // PUBLISHED: content area still present as []; the unset field is omitted.
    // Fill the required heading first (intro stays unset — the field under test).
    await s.app.inject({ method: "PUT", url: `/api/v1/manage/content/${id}?locale=en`, headers: authHeaders(admin), payload: { data: { heading: "Published heading" } } });
    const pubd = await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${id}/publish?locale=en`, headers: authHeaders(admin) });
    expect(pubd.statusCode, pubd.body).toBe(200);
    const pubRes = await s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${id}?locale=en&populate=0`, headers: pub });
    expect(pubRes.statusCode).toBe(200);
    const pubData = pubRes.json().data as Record<string, unknown>;
    expect(pubData.mainArea).toEqual([]);
    expect(pubData).not.toHaveProperty("intro");
  });
});
