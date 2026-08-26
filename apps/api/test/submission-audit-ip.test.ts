import { createDb } from "@paperboy/db";
import { MIN_FILL_MS } from "@paperboy/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PUBLIC_KEY, TEST_DB, type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * The visitor's IP must reach audit_log ONLY when the form opted in.
 *
 * submit.ts wrote `ip: req.ip` on both the accepted and the spam-drop audit,
 * unconditionally, while `form_submission.meta` was gated on the form's
 * captureMetadata setting. So a form with "store IP" OFF — the default — still
 * left `{ip, ts, documentId}` in audit_log forever, and after a data-subject
 * erasure (which clears form_submission only) the IP plus "submitted at T"
 * remained. CLAUDE.md: "IP/user-agent are stored only when the form opts in."
 */
describe("submission audit records IP only on opt-in (P2)", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  const raw = createDb(TEST_DB);

  const FIELDS = [{ key: "f1", blockType: "FormTextField", display: "automatic", ref: null, inline: { name: "msg", label: "Message", required: true } }];
  const good = (values: Record<string, unknown>) => ({ values, elapsedMs: MIN_FILL_MS + 500 });

  async function makeForm(captureMetadata: boolean): Promise<string> {
    const created = await s.app.inject({ method: "POST", url: "/api/v1/manage/content", headers: authHeaders(admin), payload: { type: "Form", locale: "en", name: `Form capture=${captureMetadata}` } });
    const id = created.json().documentId as string;
    await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${id}?locale=en`,
      headers: authHeaders(admin),
      payload: { data: { title: "T", submitLabel: "Send", fields: FIELDS, captureMetadata } },
    });
    await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${id}/publish?locale=en`, headers: authHeaders(admin) });
    return id;
  }

  const submit = (id: string, payload: unknown) =>
    s.app.inject({ method: "POST", url: `/api/v1/delivery/forms/${id}/submissions`, headers: { authorization: `Bearer ${PUBLIC_KEY}` }, payload });

  const auditIps = async (documentId: string) =>
    (await raw.sql`SELECT ip FROM audit_log WHERE document_id=${documentId} AND action='form.submitted'`) as Array<{ ip: string | null }>;

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    for (const name of ["Form", "FormTextField"]) {
      await s.app.inject({ method: "POST", url: `/api/v1/manage/type-templates/${name}/instantiate`, headers: authHeaders(admin), payload: {} });
    }
  });
  afterAll(async () => {
    await s.app.close();
    await raw.sql.end();
  });

  it("does NOT store the IP when captureMetadata is off (the default)", async () => {
    const id = await makeForm(false);
    expect((await submit(id, good({ msg: "hello" }))).statusCode).toBe(202);
    const rows = await auditIps(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ip).toBeNull();
  });

  it("DOES store the IP when the form opted in", async () => {
    const id = await makeForm(true);
    expect((await submit(id, good({ msg: "hello" }))).statusCode).toBe(202);
    const rows = await auditIps(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ip).toBeTruthy();
  });

  it("a spam drop never records an IP (no opt-in signal, and no DB touch to find one)", async () => {
    const id = await makeForm(false);
    // Too fast → dropped as spam, 202 like a success.
    const res = await submit(id, { values: { msg: "x" }, elapsedMs: 50 });
    expect(res.statusCode).toBe(202);
    const rows = (await raw.sql`SELECT ip FROM audit_log WHERE document_id=${id} AND action='form.submission_rejected'`) as Array<{ ip: string | null }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.ip === null)).toBe(true);
  });
});
