import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ContentTypeDef } from "@paperboy/shared";
import { type Suite, authHeaders, login, setupApi } from "./helpers.js";

const caseStudy: ContentTypeDef = {
  name: "CaseStudy",
  displayName: "Case study",
  kind: "page",
  description: "A customer story page",
  fields: [
    { name: "client", displayName: "Client", type: "text", localized: true, required: true, delivery: "public" },
    { name: "outcome", displayName: "Outcome", type: "markdown", delivery: "public" },
  ],
};

describe("Content type template collection (Admin CRUD + instantiate)", () => {
  let s: Suite;
  beforeAll(async () => {
    s = await setupApi();
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("Admin creates a template; it is listed, readable, and unknown names self-teach", async () => {
    const admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    const create = await s.app.inject({ method: "POST", url: "/api/v1/manage/type-templates", headers: authHeaders(admin), payload: caseStudy });
    expect(create.statusCode).toBe(200);
    const created = create.json() as ContentTypeDef;
    expect(created.name).toBe("CaseStudy");
    expect(created.kind).toBe("page");
    expect(created.fields.map((f) => f.name)).toContain("client");

    const list = await s.app.inject({ method: "GET", url: "/api/v1/manage/type-templates", headers: { cookie: admin.cookie } });
    expect(list.statusCode).toBe(200);
    expect((list.json() as Array<{ name: string }>).map((t) => t.name)).toContain("CaseStudy");

    const get = await s.app.inject({ method: "GET", url: "/api/v1/manage/type-templates/CaseStudy", headers: { cookie: admin.cookie } });
    expect(get.statusCode).toBe(200);
    const got = get.json() as ContentTypeDef;
    // kind "page" → the reserved SEO group is injected on read; assert the
    // declared fields, not the total length.
    const names = got.fields.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(["client", "outcome"]));

    const missing = await s.app.inject({ method: "GET", url: "/api/v1/manage/type-templates/NopeType", headers: { cookie: admin.cookie } });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().message).toContain("CaseStudy");
    expect(missing.json().message).toContain("available:");
  });

  it("rejects non-Admins (Editor 403) and missing CSRF (403)", async () => {
    const editor = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
    const denied = await s.app.inject({ method: "POST", url: "/api/v1/manage/type-templates", headers: authHeaders(editor), payload: { ...caseStudy, name: "Denied" } });
    expect(denied.statusCode).toBe(403);

    const admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    const noCsrf = await s.app.inject({ method: "POST", url: "/api/v1/manage/type-templates", headers: { cookie: admin.cookie, origin: "http://localhost:8090" }, payload: { ...caseStudy, name: "Denied2" } });
    expect(noCsrf.statusCode).toBe(403);
  });

  it("enforces the ContentTypeDef schema server-side (bad name, duplicate fields)", async () => {
    const admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    const badName = await s.app.inject({ method: "POST", url: "/api/v1/manage/type-templates", headers: authHeaders(admin), payload: { ...caseStudy, name: "not pascal" } });
    expect(badName.statusCode).toBe(422);

    const dupFields = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/type-templates",
      headers: authHeaders(admin),
      payload: { name: "DupTpl", displayName: "Dup", kind: "block", fields: [{ name: "x", displayName: "X", type: "text" }, { name: "x", displayName: "X2", type: "text" }] },
    });
    expect(dupFields.statusCode).toBe(422);

    // duplicate name is a conflict, not a 500
    const dup = await s.app.inject({ method: "POST", url: "/api/v1/manage/type-templates", headers: authHeaders(admin), payload: caseStudy });
    expect(dup.statusCode).toBe(409);
  });

  it("enforces name/kind immutability and 404 on unknown update", async () => {
    const admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    const mismatch = await s.app.inject({ method: "PUT", url: "/api/v1/manage/type-templates/CaseStudy", headers: authHeaders(admin), payload: { ...caseStudy, name: "Renamed" } });
    expect(mismatch.statusCode).toBe(400);

    const kind = await s.app.inject({ method: "PUT", url: "/api/v1/manage/type-templates/CaseStudy", headers: authHeaders(admin), payload: { ...caseStudy, kind: "block" } });
    expect(kind.statusCode).toBe(409);

    const unknown = await s.app.inject({ method: "PUT", url: "/api/v1/manage/type-templates/DoesNotExist", headers: authHeaders(admin), payload: { ...caseStudy, name: "DoesNotExist" } });
    expect(unknown.statusCode).toBe(404);

    // a real update: change the display name + add a field (round-trip the stored shape, SEO group included)
    const current = (await s.app.inject({ method: "GET", url: "/api/v1/manage/type-templates/CaseStudy", headers: { cookie: admin.cookie } })).json() as ContentTypeDef;
    const updated = await s.app.inject({
      method: "PUT",
      url: "/api/v1/manage/type-templates/CaseStudy",
      headers: authHeaders(admin),
      payload: { ...current, displayName: "Case study (edited)", fields: [...current.fields, { name: "testimonial", displayName: "Testimonial", type: "richtext", delivery: "public" }] },
    });
    expect(updated.statusCode).toBe(200);
    const after = updated.json() as ContentTypeDef;
    expect(after.displayName).toBe("Case study (edited)");
    expect(after.fields.map((f) => f.name)).toContain("testimonial");
  });

  it("instantiate: materialises a type, refuses implicit overwrite, honours updateExisting/asName", async () => {
    const admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    const inst = await s.app.inject({ method: "POST", url: "/api/v1/manage/type-templates/CaseStudy/instantiate", headers: authHeaders(admin), payload: {} });
    expect(inst.statusCode).toBe(200);
    const res = inst.json() as { type: ContentTypeDef; name: string; action: string };
    expect(res.name).toBe("CaseStudy");
    expect(res.action).toBe("created");
    expect(res.type.fields.map((f) => f.name)).toContain("testimonial");

    const types = await s.app.inject({ method: "GET", url: "/api/v1/manage/content-types", headers: { cookie: admin.cookie } });
    expect((types.json() as Array<{ name: string }>).map((t) => t.name)).toContain("CaseStudy");

    // the instantiated type is usable: create and publish content of it
    const made = await s.app.inject({ method: "POST", url: "/api/v1/manage/content", headers: authHeaders(admin), payload: { type: "CaseStudy", locale: "en", name: "First case study" } });
    expect(made.statusCode).toBe(200);

    // implicit overwrite is refused, and the error says exactly how to do it
    const dup = await s.app.inject({ method: "POST", url: "/api/v1/manage/type-templates/CaseStudy/instantiate", headers: authHeaders(admin), payload: {} });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().message).toContain("updateExisting: true");

    // explicit overwrite runs through the normal update chokepoint
    const current = (await s.app.inject({ method: "GET", url: "/api/v1/manage/type-templates/CaseStudy", headers: { cookie: admin.cookie } })).json() as ContentTypeDef;
    await s.app.inject({
      method: "PUT",
      url: "/api/v1/manage/type-templates/CaseStudy",
      headers: authHeaders(admin),
      payload: { ...current, fields: [...current.fields, { name: "award", displayName: "Award", type: "text", delivery: "public" }] },
    });
    const again = await s.app.inject({ method: "POST", url: "/api/v1/manage/type-templates/CaseStudy/instantiate", headers: authHeaders(admin), payload: { updateExisting: true } });
    expect(again.statusCode).toBe(200);
    expect(again.json().action).toBe("updated");
    const type = (await s.app.inject({ method: "GET", url: "/api/v1/manage/content-types/CaseStudy", headers: { cookie: admin.cookie } })).json() as ContentTypeDef;
    expect(type.fields.map((f) => f.name)).toContain("award");

    // asName: one recipe, many variants
    const variant = await s.app.inject({ method: "POST", url: "/api/v1/manage/type-templates/CaseStudy/instantiate", headers: authHeaders(admin), payload: { asName: "PartnerCaseStudy" } });
    expect(variant.statusCode).toBe(200);
    expect(variant.json().name).toBe("PartnerCaseStudy");
    expect(variant.json().action).toBe("created");

    // invalid asName: rejected with the naming rule spelled out
    const badAsName = await s.app.inject({ method: "POST", url: "/api/v1/manage/type-templates/CaseStudy/instantiate", headers: authHeaders(admin), payload: { asName: "partner-case" } });
    expect(badAsName.statusCode).toBe(400);
    expect(badAsName.json().message).toContain("^[A-Z][a-zA-Z0-9]*$");

    // asName onto an existing name needs the same explicit consent
    const variantDup = await s.app.inject({ method: "POST", url: "/api/v1/manage/type-templates/CaseStudy/instantiate", headers: authHeaders(admin), payload: { asName: "PartnerCaseStudy" } });
    expect(variantDup.statusCode).toBe(409);
    const variantOver = await s.app.inject({ method: "POST", url: "/api/v1/manage/type-templates/CaseStudy/instantiate", headers: authHeaders(admin), payload: { asName: "PartnerCaseStudy", updateExisting: true } });
    expect(variantOver.statusCode).toBe(200);
    expect(variantOver.json().action).toBe("updated");

    // unknown template: self-teaching 404 with the real names
    const missing = await s.app.inject({ method: "POST", url: "/api/v1/manage/type-templates/Ghost/instantiate", headers: authHeaders(admin), payload: {} });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().message).toContain("CaseStudy");
  });

  it("instantiate: a kind mismatch on overwrite 409s via the content-type chokepoint", async () => {
    const admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    // a page TYPE named ConflictType exists first…
    const asPage: ContentTypeDef = { name: "ConflictType", displayName: "Conflict", kind: "page", fields: [{ name: "body", displayName: "Body", type: "text", delivery: "public" }] };
    const asType = await s.app.inject({ method: "POST", url: "/api/v1/manage/content-types", headers: authHeaders(admin), payload: asPage });
    expect(asType.statusCode).toBe(200);
    // …and a BLOCK template with the same name.
    const asBlock: ContentTypeDef = { name: "ConflictType", displayName: "Conflict block", kind: "block", fields: [{ name: "label", displayName: "Label", type: "text", delivery: "public" }] };
    const asTpl = await s.app.inject({ method: "POST", url: "/api/v1/manage/type-templates", headers: authHeaders(admin), payload: asBlock });
    expect(asTpl.statusCode).toBe(200);

    const refused = await s.app.inject({ method: "POST", url: "/api/v1/manage/type-templates/ConflictType/instantiate", headers: authHeaders(admin), payload: {} });
    expect(refused.statusCode).toBe(409);
    const force = await s.app.inject({ method: "POST", url: "/api/v1/manage/type-templates/ConflictType/instantiate", headers: authHeaders(admin), payload: { updateExisting: true } });
    expect(force.statusCode).toBe(409);
    expect(force.json().message).toContain("kind");
  });

  it("deleting a template never touches the types instantiated from it", async () => {
    const admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    const del = await s.app.inject({ method: "DELETE", url: "/api/v1/manage/type-templates/CaseStudy", headers: authHeaders(admin) });
    expect(del.json()).toEqual({ ok: true });

    const types = await s.app.inject({ method: "GET", url: "/api/v1/manage/content-types/CaseStudy", headers: { cookie: admin.cookie } });
    expect(types.statusCode).toBe(200);

    const gone = await s.app.inject({ method: "DELETE", url: "/api/v1/manage/type-templates/CaseStudy", headers: authHeaders(admin) });
    expect(gone.statusCode).toBe(404);
  });

  it("logs every template mutation to the audit log", async () => {
    const admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    const audit = await s.app.inject({ method: "GET", url: "/api/v1/manage/audit?limit=100&action=type_template", headers: { cookie: admin.cookie } });
    expect(audit.statusCode).toBe(200);
    const rows = audit.json() as Array<{ action: string; detail: Record<string, unknown> }>;
    const actions = rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["type_template.create", "type_template.update", "type_template.delete", "type_template.instantiate"]));
    const inst = rows.find((r) => r.action === "type_template.instantiate")!;
    expect(inst.detail).toMatchObject({ template: "CaseStudy" });
  });
});
