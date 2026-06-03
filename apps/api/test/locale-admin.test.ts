import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, authHeaders, login, setupApi } from "./helpers.js";

type Loc = { code: string; displayName: string; isDefault: boolean; enabled: boolean; fallbackLocaleCode: string | null };
const find = (rows: Loc[], code: string) => rows.find((l) => l.code === code);

describe("Languages admin (locale CRUD, contenttype.manage)", () => {
  let s: Suite;
  beforeAll(async () => {
    s = await setupApi();
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("rejects non-Admins (Editor 403) and missing CSRF (403)", async () => {
    const editor = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
    const denied = await s.app.inject({ method: "POST", url: "/api/v1/manage/locales", headers: authHeaders(editor), payload: { code: "de", displayName: "Deutsch" } });
    expect(denied.statusCode).toBe(403);

    const admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    const noCsrf = await s.app.inject({ method: "POST", url: "/api/v1/manage/locales", headers: { cookie: admin.cookie, origin: "http://localhost:8090" }, payload: { code: "de", displayName: "Deutsch" } });
    expect(noCsrf.statusCode).toBe(403);

    // The management list itself is gated too.
    const allDenied = await s.app.inject({ method: "GET", url: "/api/v1/manage/locales/all", headers: { cookie: editor.cookie } });
    expect(allDenied.statusCode).toBe(403);
  });

  it("Admin creates a language; it appears in the management list and the live set", async () => {
    const admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    const create = await s.app.inject({ method: "POST", url: "/api/v1/manage/locales", headers: authHeaders(admin), payload: { code: "de", displayName: "Deutsch", fallbackLocaleCode: "en" } });
    expect(create.statusCode).toBe(200);

    const all = await s.app.inject({ method: "GET", url: "/api/v1/manage/locales/all", headers: { cookie: admin.cookie } });
    const de = find(all.json() as Loc[], "de");
    expect(de).toMatchObject({ displayName: "Deutsch", enabled: true, isDefault: false, fallbackLocaleCode: "en" });

    // Visible in the live (enabled-only) list every editor consumes.
    const live = await s.app.inject({ method: "GET", url: "/api/v1/manage/locales", headers: { cookie: admin.cookie } });
    expect((live.json() as Loc[]).some((l) => l.code === "de")).toBe(true);
  });

  it("validates code, duplicates and fallbacks", async () => {
    const admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    // Too short → Zod (422); bad format but valid length → db guard (400).
    expect((await s.app.inject({ method: "POST", url: "/api/v1/manage/locales", headers: authHeaders(admin), payload: { code: "x", displayName: "X" } })).statusCode).toBe(422);
    expect((await s.app.inject({ method: "POST", url: "/api/v1/manage/locales", headers: authHeaders(admin), payload: { code: "de DE", displayName: "Bad" } })).statusCode).toBe(400);
    // Duplicate of the one we just created.
    expect((await s.app.inject({ method: "POST", url: "/api/v1/manage/locales", headers: authHeaders(admin), payload: { code: "de", displayName: "Dup" } })).statusCode).toBe(409);
    // Fallback to self / to a non-existent locale.
    expect((await s.app.inject({ method: "POST", url: "/api/v1/manage/locales", headers: authHeaders(admin), payload: { code: "fr", displayName: "Français", fallbackLocaleCode: "fr" } })).statusCode).toBe(400);
    expect((await s.app.inject({ method: "POST", url: "/api/v1/manage/locales", headers: authHeaders(admin), payload: { code: "fr", displayName: "Français", fallbackLocaleCode: "zz" } })).statusCode).toBe(400);
  });

  it("edits display name + fallback, and toggles enabled (disabled drops out of the live set)", async () => {
    const admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    const edit = await s.app.inject({ method: "PATCH", url: "/api/v1/manage/locales/de", headers: authHeaders(admin), payload: { displayName: "German", fallbackLocaleCode: null } });
    expect(edit.statusCode).toBe(200);

    const disable = await s.app.inject({ method: "PATCH", url: "/api/v1/manage/locales/de", headers: authHeaders(admin), payload: { enabled: false } });
    expect(disable.statusCode).toBe(200);

    const all = await s.app.inject({ method: "GET", url: "/api/v1/manage/locales/all", headers: { cookie: admin.cookie } });
    expect(find(all.json() as Loc[], "de")).toMatchObject({ displayName: "German", fallbackLocaleCode: null, enabled: false });
    // Disabled → absent from the live list.
    const live = await s.app.inject({ method: "GET", url: "/api/v1/manage/locales", headers: { cookie: admin.cookie } });
    expect((live.json() as Loc[]).some((l) => l.code === "de")).toBe(false);

    // Re-enable so the delete test exercises an enabled, content-free locale.
    expect((await s.app.inject({ method: "PATCH", url: "/api/v1/manage/locales/de", headers: authHeaders(admin), payload: { enabled: true } })).statusCode).toBe(200);
  });

  it("protects the default language and content-bearing languages", async () => {
    const admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    // Default ("en") can't be disabled or deleted.
    expect((await s.app.inject({ method: "PATCH", url: "/api/v1/manage/locales/en", headers: authHeaders(admin), payload: { enabled: false } })).statusCode).toBe(409);
    expect((await s.app.inject({ method: "DELETE", url: "/api/v1/manage/locales/en", headers: authHeaders(admin) })).statusCode).toBe(409);
    // "nb" is non-default but the seed home page has an nb version → blocked.
    expect((await s.app.inject({ method: "DELETE", url: "/api/v1/manage/locales/nb", headers: authHeaders(admin) })).statusCode).toBe(409);
  });

  it("deletes a content-free language and 404s on unknown", async () => {
    const admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    expect((await s.app.inject({ method: "DELETE", url: "/api/v1/manage/locales/de", headers: authHeaders(admin) })).statusCode).toBe(200);
    const all = await s.app.inject({ method: "GET", url: "/api/v1/manage/locales/all", headers: { cookie: admin.cookie } });
    expect((all.json() as Loc[]).some((l) => l.code === "de")).toBe(false);
    expect((await s.app.inject({ method: "DELETE", url: "/api/v1/manage/locales/zz", headers: authHeaders(admin) })).statusCode).toBe(404);
  });
});
