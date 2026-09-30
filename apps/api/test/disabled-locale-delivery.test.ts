import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PREVIEW_KEY, PUBLIC_KEY, type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * Audit 2026-09-30: disabling a locale dropped it from sitemap/llms.txt and the
 * editor's live set, but the delivery fallback chain never checked `enabled` —
 * `?locale=de` kept serving the published German text under the PUBLIC key
 * after an editor disabled `de` to withdraw an unfinished translation. The
 * published perspective now skips disabled locales (falling back as for an
 * untranslated one); preview still sees them, so a locale can be prepared
 * before it is switched on.
 */
describe("a disabled locale is not served publicly", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  let id: string;

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    const create = await s.app.inject({ method: "POST", url: "/api/v1/manage/locales", headers: authHeaders(admin), payload: { code: "de", displayName: "Deutsch", fallbackLocaleCode: "en" } });
    expect(create.statusCode, create.body).toBe(200);

    const page = await s.app.inject({ method: "POST", url: "/api/v1/manage/content", headers: authHeaders(admin), payload: { type: "ArticlePage", locale: "en", name: "Locale Withdraw", data: { heading: "English heading" } } });
    id = page.json().documentId as string;
    expect((await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${id}/publish?locale=en`, headers: authHeaders(admin) })).statusCode).toBe(200);
    const de = await s.app.inject({ method: "PUT", url: `/api/v1/manage/content/${id}?locale=de`, headers: authHeaders(admin), payload: { name: "Sprache zurückziehen", data: { heading: "Unfertige Übersetzung" }, merge: true } });
    expect(de.statusCode, de.body).toBe(200);
    expect((await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${id}/publish?locale=de`, headers: authHeaders(admin) })).statusCode).toBe(200);

    const disable = await s.app.inject({ method: "PATCH", url: "/api/v1/manage/locales/de", headers: authHeaders(admin), payload: { enabled: false } });
    expect(disable.statusCode).toBe(200);
  });
  afterAll(async () => {
    await s.app.close();
  });

  const get = (key: string) =>
    s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${id}?locale=de`, headers: { authorization: `Bearer ${key}` } });

  it("the public key falls back past the disabled locale", async () => {
    const res = await get(PUBLIC_KEY);
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json())).not.toContain("Unfertige");
    expect(res.json().data.heading).toBe("English heading");
  });

  it("preview still sees the disabled locale (it can be prepared before switching on)", async () => {
    const res = await get(PREVIEW_KEY);
    expect(res.json().data.heading).toBe("Unfertige Übersetzung");
  });
});
