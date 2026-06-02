import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PUBLIC_KEY, type Suite, authHeaders, login, setupApi } from "./helpers.js";

const memo = {
  name: "Memo",
  displayName: "Memo",
  kind: "page",
  fields: [
    { name: "heading", displayName: "Heading", type: "text", localized: true, required: true, delivery: "public" },
    { name: "secret", displayName: "Internal note", type: "text", delivery: "private" },
  ],
};

describe("Content-type editor (Admin-only, schema writes)", () => {
  let s: Suite;
  beforeAll(async () => {
    s = await setupApi();
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("Admin creates a content type; it appears in the list and is usable", async () => {
    const admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    const create = await s.app.inject({ method: "POST", url: "/api/v1/manage/content-types", headers: authHeaders(admin), payload: memo });
    expect(create.statusCode).toBe(200);

    const list = await s.app.inject({ method: "GET", url: "/api/v1/manage/content-types", headers: { cookie: admin.cookie } });
    expect((list.json() as Array<{ name: string }>).some((t) => t.name === "Memo")).toBe(true);

    // Usable: create a content item of the new type.
    const made = await s.app.inject({ method: "POST", url: "/api/v1/manage/content", headers: authHeaders(admin), payload: { type: "Memo", locale: "en", name: "First memo" } });
    expect(made.statusCode).toBe(200);
  });

  it("rejects non-Admins (Editor 403) and missing CSRF (403)", async () => {
    const editor = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
    const denied = await s.app.inject({ method: "POST", url: "/api/v1/manage/content-types", headers: authHeaders(editor), payload: { ...memo, name: "Nope" } });
    expect(denied.statusCode).toBe(403);

    const admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    const noCsrf = await s.app.inject({ method: "POST", url: "/api/v1/manage/content-types", headers: { cookie: admin.cookie, origin: "http://localhost:8090" }, payload: { ...memo, name: "Nope2" } });
    expect(noCsrf.statusCode).toBe(403);
  });

  it("enforces the schema server-side (bad name, duplicate fields)", async () => {
    const admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    const badName = await s.app.inject({ method: "POST", url: "/api/v1/manage/content-types", headers: authHeaders(admin), payload: { ...memo, name: "bad name!" } });
    expect(badName.statusCode).toBe(422);

    const dupFields = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content-types",
      headers: authHeaders(admin),
      payload: { name: "Dup", displayName: "Dup", kind: "block", fields: [{ name: "x", displayName: "X", type: "text" }, { name: "x", displayName: "X2", type: "text" }] },
    });
    expect(dupFields.statusCode).toBe(422);
  });

  it("enforces name/kind immutability and 404 on unknown", async () => {
    const admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    // name in body must equal the path
    const mismatch = await s.app.inject({ method: "PUT", url: "/api/v1/manage/content-types/Memo", headers: authHeaders(admin), payload: { ...memo, name: "Renamed" } });
    expect(mismatch.statusCode).toBe(400);
    // kind change rejected
    const kind = await s.app.inject({ method: "PUT", url: "/api/v1/manage/content-types/Memo", headers: authHeaders(admin), payload: { ...memo, kind: "block" } });
    expect(kind.statusCode).toBe(409);
    // unknown type → 404 (never upsert)
    const unknown = await s.app.inject({ method: "PUT", url: "/api/v1/manage/content-types/DoesNotExist", headers: authHeaders(admin), payload: { ...memo, name: "DoesNotExist" } });
    expect(unknown.statusCode).toBe(404);
  });

  it("flipping a field public/private changes Delivery output (the security crux)", async () => {
    const admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    // Make a Memo with both fields filled, publish it.
    const made = await s.app.inject({ method: "POST", url: "/api/v1/manage/content", headers: authHeaders(admin), payload: { type: "Memo", locale: "en", name: "Leak test" } });
    const id = made.json().documentId;
    await s.app.inject({ method: "PUT", url: `/api/v1/manage/content/${id}?locale=en`, headers: authHeaders(admin), payload: { slug: "leak", data: { heading: "Public heading", secret: "TOP SECRET" } } });
    await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${id}/publish?locale=en`, headers: authHeaders(admin) });

    const pub = { authorization: `Bearer ${PUBLIC_KEY}` };
    const before = await s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${id}?locale=en`, headers: pub });
    expect(before.json().data.heading).toBe("Public heading");
    expect(before.json().data).not.toHaveProperty("secret"); // private — hidden

    // Admin flips `secret` to public.
    const flipped = { ...memo, fields: [memo.fields[0], { ...memo.fields[1], delivery: "public" }] };
    const upd = await s.app.inject({ method: "PUT", url: "/api/v1/manage/content-types/Memo", headers: authHeaders(admin), payload: flipped });
    expect(upd.statusCode).toBe(200);

    // No re-publish needed — delivery re-reads the type at read time.
    const after = await s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${id}?locale=en`, headers: pub });
    expect(after.json().data.secret).toBe("TOP SECRET");
  });
});
