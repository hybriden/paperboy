import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * CONTRACT FREEZE — remaining untested admin CRUD edges. Each behavior was read
 * from the route + db layer and pins what ACTUALLY happens (not what one might
 * assume), e.g. locale deletion ORPHANS dependent fallbacks rather than blocking
 * or reassigning, and a content type in use rejects with 409.
 */

describe("Route gaps — admin CRUD edges", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  const savedPrivateFlag = process.env.PAPERBOY_WEBHOOK_ALLOW_PRIVATE;
  beforeAll(async () => {
    // This suite registers a webhook to a non-resolving example host; it isn't
    // testing the SSRF egress guard, so allow private/unresolvable targets.
    process.env.PAPERBOY_WEBHOOK_ALLOW_PRIVATE = "true";
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
    if (savedPrivateFlag === undefined) delete process.env.PAPERBOY_WEBHOOK_ALLOW_PRIVATE;
    else process.env.PAPERBOY_WEBHOOK_ALLOW_PRIVATE = savedPrivateFlag;
  });

  /* --------------------------- delivery keys ---------------------------- */
  it("delivery keys: NO destructive DELETE route exists — only revoke (DELETE → 404)", async () => {
    const create = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/delivery-keys",
      headers: authHeaders(admin),
      payload: { name: "gap key", type: "public" },
    });
    expect(create.statusCode).toBe(200);
    expect(typeof create.json().key).toBe("string");

    const list = await s.app.inject({ method: "GET", url: "/api/v1/manage/delivery-keys", headers: { cookie: admin.cookie } });
    const row = (list.json() as Array<{ id: number; name: string; revokedAt: string | null }>).find((r) => r.name === "gap key")!;
    expect(row).toBeTruthy();

    // DELETE is not a registered method on this resource.
    const del = await s.app.inject({ method: "DELETE", url: `/api/v1/manage/delivery-keys/${row.id}`, headers: authHeaders(admin) });
    expect(del.statusCode).toBe(404);

    // Revoke is the supported lifecycle terminal.
    const revoke = await s.app.inject({ method: "POST", url: `/api/v1/manage/delivery-keys/${row.id}/revoke`, headers: authHeaders(admin) });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json()).toEqual({ ok: true });

    const list2 = await s.app.inject({ method: "GET", url: "/api/v1/manage/delivery-keys", headers: { cookie: admin.cookie } });
    const row2 = (list2.json() as Array<{ id: number; revokedAt: string | null }>).find((r) => r.id === row.id)!;
    expect(row2.revokedAt).not.toBeNull();
  });

  /* ----------------------------- site config ---------------------------- */
  it("POST /site/preview-url saves a valid http(s) URL (trailing slash trimmed) and GET /site reflects it", async () => {
    const ok = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/site/preview-url",
      headers: authHeaders(admin),
      payload: { url: "https://preview.example.com/" },
    });
    expect(ok.statusCode).toBe(200);

    const site = await s.app.inject({ method: "GET", url: "/api/v1/manage/site", headers: { cookie: admin.cookie } });
    expect(site.statusCode).toBe(200);
    // Trailing slash is stripped by setPreviewBaseUrl.
    expect(site.json().previewBaseUrl).toBe("https://preview.example.com");
  });

  it("POST /site/preview-url rejects a non-http(s) URL (400)", async () => {
    const bad = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/site/preview-url",
      headers: authHeaders(admin),
      payload: { url: "not-a-url" },
    });
    expect(bad.statusCode).toBe(400);

    // Clearing with "" is allowed (resets preview base).
    const clear = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/site/preview-url",
      headers: authHeaders(admin),
      payload: { url: "" },
    });
    expect(clear.statusCode).toBe(200);
    const site = await s.app.inject({ method: "GET", url: "/api/v1/manage/site", headers: { cookie: admin.cookie } });
    expect(site.json().previewBaseUrl).toBe("");
  });

  /* ------------------------------- users -------------------------------- */
  it("GET /manage/users returns the four seeded roles; there is NO get-single-user route (404)", async () => {
    const list = await s.app.inject({ method: "GET", url: "/api/v1/manage/users", headers: { cookie: admin.cookie } });
    expect(list.statusCode).toBe(200);
    const users = list.json() as Array<{ id: string; email: string; roles: string[] }>;
    const emails = users.map((u) => u.email).sort();
    expect(emails).toEqual(
      ["admin@paperboy.test", "author@paperboy.test", "editor@paperboy.test", "viewer@paperboy.test"].sort(),
    );
    const adminUser = users.find((u) => u.email === "admin@paperboy.test")!;

    // No GET /users/:id route — the only :id routes are PUT and DELETE.
    const single = await s.app.inject({ method: "GET", url: `/api/v1/manage/users/${adminUser.id}`, headers: { cookie: admin.cookie } });
    expect(single.statusCode).toBe(404);
  });

  /* ------------------------------ webhooks ------------------------------- */
  it("webhooks: list + create + delete exist; there is NO detail/update route (GET/PUT :id → 404)", async () => {
    const create = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/webhooks",
      headers: authHeaders(admin),
      payload: { name: "gap hook", url: "https://hook.example.com/x", events: ["content.published"] },
    });
    expect(create.statusCode).toBe(200);
    const id = create.json().id as number;
    expect(typeof create.json().secret).toBe("string");

    // No per-id GET or PUT (detail/update) — only DELETE.
    const detail = await s.app.inject({ method: "GET", url: `/api/v1/manage/webhooks/${id}`, headers: { cookie: admin.cookie } });
    expect(detail.statusCode).toBe(404);
    const update = await s.app.inject({ method: "PUT", url: `/api/v1/manage/webhooks/${id}`, headers: authHeaders(admin), payload: { name: "x" } });
    expect(update.statusCode).toBe(404);

    const del = await s.app.inject({ method: "DELETE", url: `/api/v1/manage/webhooks/${id}`, headers: authHeaders(admin) });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ ok: true });
  });

  /* ------------------------------ locales ------------------------------- */
  it("DELETE /locales/:code that is ANOTHER locale's fallback ORPHANS that fallback to null (not blocked, not reassigned)", async () => {
    // Build two fresh, content-free locales: zz falls back to xx.
    const mkLocale = (code: string, displayName: string, fallback: string | null) =>
      s.app.inject({
        method: "POST",
        url: "/api/v1/manage/locales",
        headers: authHeaders(admin),
        payload: { code, displayName, fallbackLocaleCode: fallback },
      });
    expect((await mkLocale("xx", "Lang XX", null)).statusCode).toBe(200);
    expect((await mkLocale("zz", "Lang ZZ", "xx")).statusCode).toBe(200);

    // Sanity: zz really points at xx.
    const before = await s.app.inject({ method: "GET", url: "/api/v1/manage/locales/all", headers: { cookie: admin.cookie } });
    const zzBefore = (before.json() as Array<{ code: string; fallbackLocaleCode: string | null }>).find((l) => l.code === "zz")!;
    expect(zzBefore.fallbackLocaleCode).toBe("xx");

    // xx has no content → deletable. Deleting it must NOT block on zz's dependency.
    const del = await s.app.inject({ method: "DELETE", url: "/api/v1/manage/locales/xx", headers: authHeaders(admin) });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ ok: true });

    // REAL behavior: zz's dangling fallback pointer is set to NULL (orphaned).
    const after = await s.app.inject({ method: "GET", url: "/api/v1/manage/locales/all", headers: { cookie: admin.cookie } });
    const all = after.json() as Array<{ code: string; fallbackLocaleCode: string | null }>;
    expect(all.find((l) => l.code === "xx")).toBeUndefined();
    const zzAfter = all.find((l) => l.code === "zz")!;
    expect(zzAfter.fallbackLocaleCode).toBeNull();
  });

  it("DELETE /locales/:code is BLOCKED (409) when the locale holds content", async () => {
    // The seed gives 'nb' a published Home variant, so it cannot be deleted.
    const del = await s.app.inject({ method: "DELETE", url: "/api/v1/manage/locales/nb", headers: authHeaders(admin) });
    expect(del.statusCode).toBe(409);
  });

  it("DELETE /locales/:code is BLOCKED (409) for the default locale", async () => {
    const del = await s.app.inject({ method: "DELETE", url: "/api/v1/manage/locales/en", headers: authHeaders(admin) });
    expect(del.statusCode).toBe(409);
  });

  /* --------------------------- content types ---------------------------- */
  it("DELETE /content-types/:name for a type IN USE → 409 (contentTypeUsage guard)", async () => {
    // LandingPage is used by the seeded Home page.
    const del = await s.app.inject({ method: "DELETE", url: "/api/v1/manage/content-types/LandingPage", headers: authHeaders(admin) });
    expect(del.statusCode).toBe(409);
  });

  it("DELETE /content-types/:name for an UNUSED type succeeds (200)", async () => {
    // Create a brand-new, unused content type, then delete it.
    const def = {
      name: "GapWidget",
      displayName: "Gap Widget",
      kind: "block" as const,
      description: "Throwaway type for the delete-unused test.",
      icon: "square",
      fields: [
        { name: "label", displayName: "Label", type: "text" as const, localized: false, required: false, delivery: "public" as const, group: "Content" },
      ],
    };
    const create = await s.app.inject({ method: "POST", url: "/api/v1/manage/content-types", headers: authHeaders(admin), payload: def });
    expect(create.statusCode).toBe(200);

    const del = await s.app.inject({ method: "DELETE", url: "/api/v1/manage/content-types/GapWidget", headers: authHeaders(admin) });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ ok: true });
  });
});
