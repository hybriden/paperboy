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

  it("built-ins: always listed and readable; writes to them self-teach (read-only)", async () => {
    const admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    const list = await s.app.inject({ method: "GET", url: "/api/v1/manage/type-templates", headers: { cookie: admin.cookie } });
    const names = (list.json() as Array<{ name: string }>).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["ArticlePage", "FaqPage", "HeroBlock", "TextBlock", "StartPage"]));

    // Read shape matches stored templates: page kinds get the reserved SEO group.
    const faq = await s.app.inject({ method: "GET", url: "/api/v1/manage/type-templates/FaqPage", headers: { cookie: admin.cookie } });
    expect(faq.statusCode).toBe(200);
    const faqDef = faq.json() as ContentTypeDef;
    expect(faqDef.fields.map((f) => f.name)).toEqual(expect.arrayContaining(["heading", "topics", "metaTitle"]));

    // Built-in names are reserved: create/update/delete all refuse with the fix spelled out.
    const create = await s.app.inject({ method: "POST", url: "/api/v1/manage/type-templates", headers: authHeaders(admin), payload: { ...caseStudy, name: "FaqPage" } });
    expect(create.statusCode).toBe(409);
    expect(create.json().message).toContain("built-in");

    const update = await s.app.inject({
      method: "PUT", url: "/api/v1/manage/type-templates/TextBlock", headers: authHeaders(admin),
      payload: { name: "TextBlock", displayName: "Text", kind: "block", fields: [] },
    });
    expect(update.statusCode).toBe(409);
    expect(update.json().message).toContain("read-only");

    const del = await s.app.inject({ method: "DELETE", url: "/api/v1/manage/type-templates/TextBlock", headers: authHeaders(admin) });
    expect(del.statusCode).toBe(409);
    expect(del.json().message).toContain("built-in");
  });

  it("instantiate withBlocks: pulls in the template's block set recursively", async () => {
    const admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    // FaqPage → topics allows FaqTopicBlock → questions allows QuestionBlock.
    const inst = await s.app.inject({ method: "POST", url: "/api/v1/manage/type-templates/FaqPage/instantiate", headers: authHeaders(admin), payload: { withBlocks: true } });
    expect(inst.statusCode).toBe(200);
    const res = inst.json() as { action: string; blocks: { created: string[]; existing: string[]; missing: string[] } };
    expect(res.action).toBe("created");
    expect(res.blocks.created).toEqual(["FaqTopicBlock", "QuestionBlock"]);
    expect(res.blocks.missing).toEqual([]);

    const types = (await s.app.inject({ method: "GET", url: "/api/v1/manage/content-types", headers: { cookie: admin.cookie } })).json() as Array<{ name: string }>;
    expect(types.map((t) => t.name)).toEqual(expect.arrayContaining(["FaqPage", "FaqTopicBlock", "QuestionBlock"]));

    // Second run: everything already exists — reported as existing (deep:
    // recursion follows EXISTING types too, so QuestionBlock is seen).
    const again = await s.app.inject({ method: "POST", url: "/api/v1/manage/type-templates/FaqPage/instantiate", headers: authHeaders(admin), payload: { withBlocks: true, updateExisting: true } });
    expect(again.statusCode).toBe(200);
    const r2 = again.json() as { action: string; blocks: { created: string[]; existing: string[] } };
    expect(r2.action).toBe("updated");
    expect(r2.blocks.created).toEqual([]);
    expect(r2.blocks.existing).toEqual(expect.arrayContaining(["FaqTopicBlock", "QuestionBlock"]));

    // Without withBlocks nothing extra is created and no blocks report is sent.
    const plain = await s.app.inject({ method: "POST", url: "/api/v1/manage/type-templates/QuoteBlock/instantiate", headers: authHeaders(admin), payload: {} });
    expect(plain.statusCode).toBe(200);
    expect(plain.json().blocks).toBeUndefined();
  });

  it("export: versioned document, optional names filter, self-teaching 404", async () => {
    const admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    const all = await s.app.inject({ method: "GET", url: "/api/v1/manage/type-templates/export", headers: { cookie: admin.cookie } });
    expect(all.statusCode).toBe(200);
    const doc = all.json() as { format: string; version: number; exportedAt: string; templates: ContentTypeDef[] };
    expect(doc.format).toBe("paperboy-type-templates");
    expect(doc.version).toBe(1);
    expect(doc.templates.map((t) => t.name)).toContain("ArticlePage");

    const picked = await s.app.inject({ method: "GET", url: "/api/v1/manage/type-templates/export?names=FaqPage,QuoteBlock", headers: { cookie: admin.cookie } });
    expect(picked.statusCode).toBe(200);
    expect((picked.json().templates as ContentTypeDef[]).map((t) => t.name)).toEqual(["FaqPage", "QuoteBlock"]);

    const unknown = await s.app.inject({ method: "GET", url: "/api/v1/manage/type-templates/export?names=Nope", headers: { cookie: admin.cookie } });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().message).toContain("available:");
  });

  it("import: creates new, skips existing (reason says how to overwrite), skips built-ins, overwrite updates", async () => {
    const admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    const importA = {
      name: "ImportA", displayName: "Import A", kind: "block", description: "", icon: "ph:cube",
      fields: [{ name: "label", displayName: "Label", type: "text", delivery: "public" }],
    };
    const builtinNamed = { ...importA, name: "FaqPage", kind: "page" };

    const first = await s.app.inject({ method: "POST", url: "/api/v1/manage/type-templates/import", headers: authHeaders(admin), payload: { templates: [importA, builtinNamed] } });
    expect(first.statusCode).toBe(200);
    const r1 = first.json() as { created: string[]; updated: string[]; skipped: Array<{ name: string; reason: string }> };
    expect(r1.created).toEqual(["ImportA"]);
    expect(r1.skipped).toHaveLength(1);
    expect(r1.skipped[0]).toMatchObject({ name: "FaqPage" });
    expect(r1.skipped[0]!.reason).toContain("built-in");

    // Same import again: existing stored template is skipped, reason teaches overwrite.
    const second = await s.app.inject({ method: "POST", url: "/api/v1/manage/type-templates/import", headers: authHeaders(admin), payload: { templates: [importA] } });
    const r2 = second.json() as { created: string[]; skipped: Array<{ name: string; reason: string }> };
    expect(r2.created).toEqual([]);
    expect(r2.skipped[0]!.reason).toContain("overwrite: true");

    // overwrite: true updates through the same chokepoint (kind stays immutable).
    const renamed = { ...importA, displayName: "Import A v2" };
    const third = await s.app.inject({ method: "POST", url: "/api/v1/manage/type-templates/import", headers: authHeaders(admin), payload: { templates: [renamed], overwrite: true } });
    expect((third.json() as { updated: string[] }).updated).toEqual(["ImportA"]);
    const after = (await s.app.inject({ method: "GET", url: "/api/v1/manage/type-templates/ImportA", headers: { cookie: admin.cookie } })).json() as ContentTypeDef;
    expect(after.displayName).toBe("Import A v2");

    const kindFlip = await s.app.inject({ method: "POST", url: "/api/v1/manage/type-templates/import", headers: authHeaders(admin), payload: { templates: [{ ...renamed, kind: "page" }], overwrite: true } });
    const r4 = kindFlip.json() as { skipped: Array<{ name: string; reason: string }> };
    expect(r4.skipped[0]!.reason).toContain("kind");
  });

  it("import: round-trips an export document verbatim, rejects wrong versions and invalid templates", async () => {
    const admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    const doc = (await s.app.inject({ method: "GET", url: "/api/v1/manage/type-templates/export?names=ImportA", headers: { cookie: admin.cookie } })).json() as Record<string, unknown>;
    await s.app.inject({ method: "DELETE", url: "/api/v1/manage/type-templates/ImportA", headers: authHeaders(admin) });

    // The export document IS a valid import body — no editing required.
    const back = await s.app.inject({ method: "POST", url: "/api/v1/manage/type-templates/import", headers: authHeaders(admin), payload: doc });
    expect(back.statusCode).toBe(200);
    expect((back.json() as { created: string[] }).created).toEqual(["ImportA"]);

    const badVersion = await s.app.inject({ method: "POST", url: "/api/v1/manage/type-templates/import", headers: authHeaders(admin), payload: { ...doc, version: 2 } });
    expect(badVersion.statusCode).toBe(400);
    expect(badVersion.json().message).toContain("version");

    const invalid = await s.app.inject({ method: "POST", url: "/api/v1/manage/type-templates/import", headers: authHeaders(admin), payload: { templates: [{ name: "not pascal", displayName: "X", kind: "block", fields: [] }] } });
    expect(invalid.statusCode).toBe(422);

    // Non-admins can't import (same permission as every template write).
    const editor = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
    const denied = await s.app.inject({ method: "POST", url: "/api/v1/manage/type-templates/import", headers: authHeaders(editor), payload: doc });
    expect(denied.statusCode).toBe(403);
  });

  it("logs every template mutation to the audit log", async () => {
    const admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    const audit = await s.app.inject({ method: "GET", url: "/api/v1/manage/audit?limit=100&action=type_template", headers: { cookie: admin.cookie } });
    expect(audit.statusCode).toBe(200);
    const rows = audit.json() as Array<{ action: string; detail: Record<string, unknown> }>;
    const actions = rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["type_template.create", "type_template.update", "type_template.delete", "type_template.instantiate", "type_template.import"]));
    const inst = rows.filter((r) => r.action === "type_template.instantiate");
    expect(inst.some((r) => r.detail.template === "CaseStudy")).toBe(true);
  });
});
