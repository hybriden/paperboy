import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PREVIEW_KEY, type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * A content-area field DEFINED on a type must always appear in delivery output
 * (as []), even when the instance never set it — otherwise a frontend can't tell
 * "this type has a content area (currently empty)" from "this type has none"
 * (both look like an absent key), which made the on-page-editing placeholder
 * render on pages that have no content area at all. Other unset fields stay
 * absent — only content areas are force-materialised.
 */
describe("Delivery — a defined-but-unset content area delivers as []", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  const prev = { authorization: `Bearer ${PREVIEW_KEY}` };

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("LandingPage created without touching mainArea → delivery data.mainArea === []", async () => {
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

    const res = await s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${id}?locale=en&populate=0`, headers: prev });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as Record<string, unknown>;

    // The content area is present and empty…
    expect(data.mainArea).toEqual([]);
    // …but an unset NON-content-area field is still omitted (we don't force-emit everything).
    expect(data).not.toHaveProperty("intro");
  });
});
