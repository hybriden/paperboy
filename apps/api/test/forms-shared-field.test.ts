import { MIN_FILL_MS } from "@paperboy/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PUBLIC_KEY, type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * A form field placed as a SHARED block (a consent box reused across every
 * form of a site) must bind the form exactly like an inline one.
 *
 * `formSpecFrom` read the stored `{ref}` only when handed a resolver, and its
 * two production callers passed none: delivery computed `content.form` without
 * the shared field, and the submit endpoint compiled its validator without it —
 * so a form whose consent checkbox was shared accepted submissions with no
 * consent at all. Pinned here at both surfaces, and at populate 0 (the
 * default), where the shared entry is delivered shallow.
 */
describe("a shared form field block binds the form", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  let formId: string;
  let consentId: string;
  const pub = { authorization: `Bearer ${PUBLIC_KEY}` };

  const create = async (type: string, name: string): Promise<string> => {
    const r = await s.app.inject({ method: "POST", url: "/api/v1/manage/content", headers: authHeaders(admin), payload: { type, locale: "en", name } });
    expect(r.statusCode, r.body).toBe(200);
    return r.json().documentId as string;
  };
  const save = async (id: string, data: Record<string, unknown>) => {
    const r = await s.app.inject({ method: "PUT", url: `/api/v1/manage/content/${id}?locale=en`, headers: authHeaders(admin), payload: { data } });
    expect(r.statusCode, r.body).toBe(200);
  };
  const publish = async (id: string) => {
    const r = await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${id}/publish?locale=en`, headers: authHeaders(admin) });
    expect(r.statusCode, r.body).toBe(200);
  };
  const deliveredFields = async (query = "") => {
    const r = await s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${formId}${query}`, headers: pub });
    expect(r.statusCode, r.body).toBe(200);
    return (r.json() as { form: { fields: Array<{ name: string; kind: string; required: boolean }> } }).form.fields;
  };
  const submit = (values: Record<string, unknown>) =>
    s.app.inject({
      method: "POST",
      url: `/api/v1/delivery/forms/${formId}/submissions`,
      headers: pub,
      payload: { values, elapsedMs: MIN_FILL_MS + 500 },
    });

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    for (const name of ["Form", "FormTextField", "FormConsentField"]) {
      const r = await s.app.inject({ method: "POST", url: `/api/v1/manage/type-templates/${name}/instantiate`, headers: authHeaders(admin), payload: { updateExisting: true } });
      expect(r.statusCode, r.body).toBe(200);
    }

    consentId = await create("FormConsentField", "Shared consent");
    await save(consentId, { name: "consent", label: "I agree that my message may be stored.", required: true });
    await publish(consentId);

    formId = await create("Form", "Contact (shared consent)");
    await save(formId, {
      title: "Contact",
      submitLabel: "Send",
      confirmation: "message",
      fields: [
        { key: "f1", blockType: "FormTextField", display: "automatic", ref: null, inline: { name: "fullName", label: "Your name", required: true } },
        { key: "f2", blockType: "FormConsentField", display: "automatic", ref: consentId, inline: null },
      ],
    });
    await publish(formId);
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("delivers the shared field in content.form at the default populate (0)", async () => {
    const fields = await deliveredFields();
    expect(fields.map((f) => f.name)).toEqual(["fullName", "consent"]);
    expect(fields[1]).toMatchObject({ kind: "consent", required: true });
  });

  it("…and at populate=0 / populate=2 alike", async () => {
    expect((await deliveredFields("?populate=0")).map((f) => f.name)).toEqual(["fullName", "consent"]);
    expect((await deliveredFields("?populate=2")).map((f) => f.name)).toEqual(["fullName", "consent"]);
  });

  it("the submit endpoint enforces the shared consent field", async () => {
    const without = await submit({ fullName: "Ada" });
    expect(without.statusCode, without.body).toBe(422);
    expect((without.json() as { fields: Record<string, string> }).fields.consent).toBeTruthy();

    const withConsent = await submit({ fullName: "Ada", consent: true });
    expect(withConsent.statusCode, withConsent.body).toBe(202);
  });

  it("an UNPUBLISHED shared field disappears from the spec and stops binding (only published definitions bind)", async () => {
    const unpub = await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${consentId}/unpublish?locale=en`, headers: authHeaders(admin) });
    expect(unpub.statusCode, unpub.body).toBe(200);

    expect((await deliveredFields()).map((f) => f.name)).toEqual(["fullName"]);
    expect((await deliveredFields("?populate=2")).map((f) => f.name)).toEqual(["fullName"]);
    // The consent key is now UNKNOWN to the form: sending it is rejected, and
    // omitting it is accepted — the enforced definition is the published one.
    expect((await submit({ fullName: "Ada", consent: true })).statusCode).toBe(422);
    expect((await submit({ fullName: "Ada" })).statusCode).toBe(202);
  });
});
