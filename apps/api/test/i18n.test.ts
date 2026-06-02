import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PUBLIC_KEY, type Suite, authHeaders, login, setupApi } from "./helpers.js";

describe("Multi-language (document-level i18n, per-locale publish, fallback chain)", () => {
  let s: Suite;
  beforeAll(async () => {
    s = await setupApi();
  });
  afterAll(async () => {
    await s.app.close();
  });

  const pub = { authorization: `Bearer ${PUBLIC_KEY}` };

  it("returns locale-specific values for the same canonical document", async () => {
    const en = await s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${s.ids.homeId}?locale=en`, headers: pub });
    const nb = await s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${s.ids.homeId}?locale=nb`, headers: pub });
    expect(en.json().data.heading).toBe("Welcome to Paperboy");
    expect(nb.json().data.heading).toBe("Velkommen til Paperboy");
    // Same documentId across locales (canonical identity).
    expect(en.json().documentId).toBe(nb.json().documentId);
    expect(en.json().locale).toBe("en");
    expect(nb.json().locale).toBe("nb");
  });

  it("falls back along the chain (nb -> en) when a locale variant is missing", async () => {
    // Author Zone is published only in English. Requesting nb returns the en variant.
    const nb = await s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${s.ids.authorZoneId}?locale=nb`, headers: pub });
    expect(nb.statusCode).toBe(200);
    expect(nb.json().locale).toBe("en"); // resolved via fallback
    expect(nb.json().data.heading).toBe("Author Zone");
  });

  it("supports independent per-locale publishing", async () => {
    const ed = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
    // Create an English page and publish only EN.
    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(ed),
      payload: { type: "StandardPage", locale: "en", name: "Per-locale" },
    });
    const id = created.json().documentId;
    await s.app.inject({ method: "PUT", url: `/api/v1/manage/content/${id}?locale=en`, headers: authHeaders(ed), payload: { slug: "per-locale-en", data: { heading: "English only" } } });
    await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${id}/publish?locale=en`, headers: authHeaders(ed) });

    // Add a Norwegian draft variant but DON'T publish it.
    await s.app.inject({ method: "PUT", url: `/api/v1/manage/content/${id}?locale=nb`, headers: authHeaders(ed), payload: { slug: "per-locale-nb", data: { heading: "Bare norsk (kladd)" } } });

    // Public nb request falls back to the published EN (nb is still a draft).
    const nb = await s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${id}?locale=nb`, headers: pub });
    expect(nb.statusCode).toBe(200);
    expect(nb.json().locale).toBe("en");
    expect(nb.json().data.heading).toBe("English only");

    // Now publish nb explicitly.
    await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${id}/publish?locale=nb`, headers: authHeaders(ed) });
    const nb2 = await s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${id}?locale=nb`, headers: pub });
    expect(nb2.json().locale).toBe("nb");
    expect(nb2.json().data.heading).toBe("Bare norsk (kladd)");
  });

  it("exposes configured locales with their fallback chain via the Management API", async () => {
    const ed = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
    const res = await s.app.inject({ method: "GET", url: "/api/v1/manage/locales", headers: { cookie: ed.cookie } });
    const locales = res.json() as Array<{ code: string; isDefault: boolean; fallbackLocaleCode: string | null }>;
    expect(locales.find((l) => l.code === "en")?.isDefault).toBe(true);
    expect(locales.find((l) => l.code === "nb")?.fallbackLocaleCode).toBe("en");
  });
});
