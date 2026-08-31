import { createDb, loadPublishedForm, submissionsToCsv } from "@paperboy/db";
import { MIN_FILL_MS } from "@paperboy/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PREVIEW_KEY, PUBLIC_KEY, type Suite, TEST_DB, authHeaders, login, setupApi } from "./helpers.js";

/**
 * The public form-submission endpoint — Paperboy's ONLY anonymous write path.
 *
 * This file is the security contract for it. Each test below stands in for a
 * specific way a public write endpoint gets abused, so a future refactor that
 * reopens one of these holes fails here rather than in production:
 *
 *  - it must not be authenticated by a cookie (that is what makes "no CSRF
 *    token needed" true rather than merely convenient);
 *  - a delivery key must not reach another site's form;
 *  - answers must be validated against the CURRENT PUBLISHED definition, and
 *    unknown fields rejected instead of silently stored;
 *  - spam heuristics must be indistinguishable from success on the wire;
 *  - a retried submission must not create a second row;
 *  - submissions must never appear in any delivery READ.
 */

let s: Suite;
let admin: { cookie: string; csrf: string };
let formId: string;
const raw = createDb(TEST_DB);

const FORM_FIELDS = [
  {
    key: "f1",
    blockType: "FormTextField",
    display: "automatic",
    ref: null,
    inline: { name: "fullName", label: "Your name", required: true, maxLength: 80 },
  },
  {
    key: "f2",
    blockType: "FormEmailField",
    display: "automatic",
    ref: null,
    inline: { name: "email", label: "Email", required: true },
  },
  {
    key: "f3",
    blockType: "FormTextareaField",
    display: "automatic",
    ref: null,
    inline: { name: "message", label: "Message", required: false, maxLength: 500, rows: 6 },
  },
  {
    key: "f4",
    blockType: "FormSelectField",
    display: "automatic",
    ref: null,
    inline: { name: "topic", label: "Topic", required: false, choices: "support|I need help\nsales|Buying" },
  },
  {
    key: "f5",
    blockType: "FormConsentField",
    display: "automatic",
    ref: null,
    inline: { name: "consent", label: "I agree that my message may be stored so you can reply." },
  },
  {
    key: "f6",
    blockType: "FormStaticText",
    display: "automatic",
    ref: null,
    inline: { heading: "About your enquiry", text: null },
  },
];

/** A submission body that passes the invisible heuristics. */
const good = (values: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  values,
  elapsedMs: MIN_FILL_MS + 500,
  ...extra,
});

const submit = (
  payload: unknown,
  opts: { key?: string; headers?: Record<string, string>; id?: string } = {},
) =>
  s.app.inject({
    method: "POST",
    url: `/api/v1/delivery/forms/${opts.id ?? formId}/submissions`,
    headers: { authorization: `Bearer ${opts.key ?? PUBLIC_KEY}`, ...opts.headers },
    payload,
  });

beforeAll(async () => {
  s = await setupApi();
  admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");

  // Install the built-in Form types, then author a form as content.
  for (const name of [
    "Form", "FormTextField", "FormEmailField", "FormTextareaField",
    "FormSelectField", "FormConsentField", "FormStaticText",
  ]) {
    const res = await s.app.inject({
      method: "POST",
      url: `/api/v1/manage/type-templates/${name}/instantiate`,
      headers: authHeaders(admin),
      payload: {},
    });
    if (res.statusCode >= 400) throw new Error(`instantiate ${name}: ${res.statusCode} ${res.body}`);
  }

  const created = await s.app.inject({
    method: "POST",
    url: "/api/v1/manage/content",
    headers: authHeaders(admin),
    payload: { type: "Form", locale: "en", name: "Contact us" },
  });
  if (created.statusCode >= 400) throw new Error(`create form: ${created.statusCode} ${created.body}`);
  formId = (created.json() as { documentId: string }).documentId;

  const updated = await s.app.inject({
    method: "PUT",
    url: `/api/v1/manage/content/${formId}?locale=en`,
    headers: authHeaders(admin),
    payload: {
      data: {
        title: "Contact us",
        submitLabel: "Send message",
        confirmation: "message",
        fields: FORM_FIELDS,
        retentionDays: 30,
      },
    },
  });
  if (updated.statusCode >= 400) throw new Error(`update form: ${updated.statusCode} ${updated.body}`);

  const published = await s.app.inject({
    method: "POST",
    url: `/api/v1/manage/content/${formId}/publish?locale=en`,
    headers: authHeaders(admin),
  });
  if (published.statusCode >= 400) throw new Error(`publish form: ${published.statusCode} ${published.body}`);
});

afterAll(async () => {
  await s.app.close();
  await raw.sql.end();
});

describe("the form definition reaches the frontend as a schema", () => {
  it("delivers a normalized form spec, never markup", async () => {
    const res = await s.app.inject({
      method: "GET",
      url: `/api/v1/delivery/content/${formId}`,
      headers: { authorization: `Bearer ${PUBLIC_KEY}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { form?: { fields: { name: string; kind: string; required: boolean }[]; submitLabel: string; honeypotField: string } };
    expect(body.form).toBeTruthy();
    expect(body.form!.submitLabel).toBe("Send message");
    // The honeypot's NAME is public on purpose: the frontend has to render it.
    expect(body.form!.honeypotField).toBeTruthy();
    const byName = Object.fromEntries(body.form!.fields.map((f) => [f.name, f]));
    expect(byName.fullName!.kind).toBe("text");
    expect(byName.email!.kind).toBe("email");
    expect(byName.consent!.required).toBe(true); // consent is required whatever the editor ticked
    // Static text is delivered as a field with no name — it collects nothing.
    expect(body.form!.fields.some((f) => f.kind === "static" && f.name === "")).toBe(true);
  });

  it("never exposes the form's private operational settings", async () => {
    const res = await s.app.inject({
      method: "GET",
      url: `/api/v1/delivery/content/${formId}`,
      headers: { authorization: `Bearer ${PUBLIC_KEY}` },
    });
    const body = res.json() as { data: Record<string, unknown>; fieldTypes: Record<string, string> };
    for (const secret of ["retentionDays", "captureMetadata", "notifyWebhooks", "notifyEmail"]) {
      expect(body.data[secret], secret).toBeUndefined();
      expect(body.fieldTypes[secret], secret).toBeUndefined();
    }
  });
});

describe("accepting a submission", () => {
  it("stores a valid submission and returns the confirmation", async () => {
    const res = await submit(
      good({ fullName: "Ada Lovelace", email: "ada@example.com", message: "Hello", topic: "support", consent: true }),
    );
    expect(res.statusCode).toBe(202);
    const body = res.json() as { ok: boolean; submissionId: string; confirmation: { type: string } };
    expect(body.ok).toBe(true);
    expect(body.submissionId).toMatch(/^sub_/);
    expect(body.confirmation.type).toBe("message");
  });

  it("coerces what HTML forms actually send (strings, 'on')", async () => {
    const res = await submit(good({ fullName: " Grace ", email: "grace@example.com", consent: "on" }));
    expect(res.statusCode).toBe(202);
    const list = await s.app.inject({
      method: "GET",
      url: `/api/v1/manage/forms/submissions?formId=${formId}`,
      headers: { cookie: admin.cookie },
    });
    const items = (list.json() as { items: { values: Record<string, unknown> }[] }).items;
    const stored = items.find((i) => i.values.email === "grace@example.com");
    expect(stored?.values.fullName).toBe("Grace"); // trimmed
    expect(stored?.values.consent).toBe(true); // "on" → true
  });

  it("stores a snapshot of the fields as answered", async () => {
    const list = await s.app.inject({
      method: "GET",
      url: `/api/v1/manage/forms/submissions?formId=${formId}`,
      headers: { cookie: admin.cookie },
    });
    const first = (list.json() as { items: { fieldSnapshot: { name: string; label: string }[] }[] }).items[0]!;
    const consent = first.fieldSnapshot.find((f) => f.name === "consent");
    // The consent WORDING is the evidence — it must survive a later edit.
    expect(consent?.label).toContain("stored so you can reply");
  });

  it("applies the form's retention window", async () => {
    const list = await s.app.inject({
      method: "GET",
      url: `/api/v1/manage/forms/submissions?formId=${formId}`,
      headers: { cookie: admin.cookie },
    });
    const first = (list.json() as { items: { createdAt: string; expiresAt: string | null }[] }).items[0]!;
    expect(first.expiresAt).toBeTruthy();
    const days = (Date.parse(first.expiresAt!) - Date.parse(first.createdAt)) / 86_400_000;
    expect(Math.round(days)).toBe(30);
  });

  it("does not store IP or user-agent unless the form asks for it", async () => {
    const list = await s.app.inject({
      method: "GET",
      url: `/api/v1/manage/forms/submissions?formId=${formId}`,
      headers: { cookie: admin.cookie },
    });
    for (const row of (list.json() as { items: { meta: Record<string, unknown> }[] }).items) {
      expect(row.meta).toEqual({});
    }
  });
});

describe("rejecting a submission", () => {
  it("returns 422 with a message PER FIELD, not one flat string", async () => {
    const res = await submit(good({ fullName: "", email: "not-an-email", consent: true }));
    expect(res.statusCode).toBe(422);
    const body = res.json() as { ok: boolean; error: string; fields: Record<string, string> };
    expect(body.ok).toBe(false);
    expect(body.fields.fullName).toBeTruthy();
    expect(body.fields.email).toMatch(/valid email/i);
  });

  it("refuses an unticked consent box", async () => {
    const res = await submit(good({ fullName: "Ada", email: "ada@example.com", consent: false }));
    expect(res.statusCode).toBe(422);
    expect((res.json() as { fields: Record<string, string> }).fields.consent).toBeTruthy();
  });

  it("refuses an option that isn't in the editor's list", async () => {
    const res = await submit(
      good({ fullName: "Ada", email: "ada@example.com", consent: true, topic: "invoices" }),
    );
    expect(res.statusCode).toBe(422);
    expect((res.json() as { fields: Record<string, string> }).fields.topic).toBeTruthy();
  });

  it("REJECTS an unknown field instead of silently dropping it", async () => {
    // Silently storing (or discarding) a field the form doesn't have is the
    // garbage-in-success-out failure rule #1 exists to prevent.
    const res = await submit(
      good({ fullName: "Ada", email: "ada@example.com", consent: true, isAdmin: true, extra: "x" }),
    );
    expect(res.statusCode).toBe(422);
  });

  it("enforces the editor's length limits", async () => {
    const res = await submit(
      good({ fullName: "A".repeat(200), email: "ada@example.com", consent: true }),
    );
    expect(res.statusCode).toBe(422);
    expect((res.json() as { fields: Record<string, string> }).fields.fullName).toMatch(/too long/i);
  });
});

describe("spam heuristics", () => {
  it("drops a submission with the honeypot filled — and looks like a success", async () => {
    const before = await countSubmissions();
    const res = await submit(
      good({ fullName: "Bot", email: "bot@example.com", consent: true }, { honeypot: "http://spam.example" }),
    );
    // Indistinguishable from success on the wire: a bot learns nothing.
    expect(res.statusCode).toBe(202);
    expect((res.json() as { ok: boolean }).ok).toBe(true);
    expect(await countSubmissions()).toBe(before); // but nothing was stored

    // Including the id: a constant "sub_discarded" was a bot-readable tell. Real
    // ids are sub_<nanoid(18)>, and no two drops may share one.
    const again = await submit(
      good({ fullName: "Bot", email: "bot@example.com", consent: true }, { honeypot: "http://spam.example" }),
    );
    const id1 = (res.json() as { submissionId: string }).submissionId;
    const id2 = (again.json() as { submissionId: string }).submissionId;
    expect(id1).toMatch(/^sub_[A-Za-z0-9_-]{18}$/);
    expect(id2).toMatch(/^sub_[A-Za-z0-9_-]{18}$/);
    expect(id1).not.toBe(id2);
  });

  it("drops an implausibly fast submission", async () => {
    const before = await countSubmissions();
    const res = await s.app.inject({
      method: "POST",
      url: `/api/v1/delivery/forms/${formId}/submissions`,
      headers: { authorization: `Bearer ${PUBLIC_KEY}` },
      payload: { values: { fullName: "Bot", email: "bot2@example.com", consent: true }, elapsedMs: 100 },
    });
    expect(res.statusCode).toBe(202);
    expect(await countSubmissions()).toBe(before);
  });

  it("accepts a submission with no timer at all (JS-disabled visitor)", async () => {
    const before = await countSubmissions();
    const res = await s.app.inject({
      method: "POST",
      url: `/api/v1/delivery/forms/${formId}/submissions`,
      headers: { authorization: `Bearer ${PUBLIC_KEY}` },
      payload: { values: { fullName: "No JS", email: "nojs@example.com", consent: true } },
    });
    expect(res.statusCode).toBe(202);
    expect(await countSubmissions()).toBe(before + 1);
  });
});

describe("the trust boundary", () => {
  it("rejects a submission with no delivery key", async () => {
    const res = await s.app.inject({
      method: "POST",
      url: `/api/v1/delivery/forms/${formId}/submissions`,
      payload: good({ fullName: "Ada", email: "ada@example.com", consent: true }),
    });
    expect(res.statusCode).toBe(401);
  });

  it("treats a COOKIE-bearing request exactly like an anonymous one", async () => {
    // The reason this endpoint needs no anti-CSRF token is that it has no
    // ambient authority to steal. If a session cookie ever starts granting
    // anything here, that reasoning collapses — so assert it never does.
    const res = await s.app.inject({
      method: "POST",
      url: `/api/v1/delivery/forms/${formId}/submissions`,
      headers: { cookie: admin.cookie, "x-csrf-token": admin.csrf },
      payload: good({ fullName: "Ada", email: "ada@example.com", consent: true }),
    });
    expect(res.statusCode).toBe(401); // the cookie bought exactly nothing
  });

  it("accepts a preview key too (previewing a form must work)", async () => {
    const res = await submit(
      good({ fullName: "Preview", email: "preview@example.com", consent: true }),
      { key: PREVIEW_KEY },
    );
    expect(res.statusCode).toBe(202);
  });

  it("404s an unknown or non-Form document", async () => {
    const res = await submit(good({ fullName: "Ada", email: "a@b.co", consent: true }), { id: "does_not_exist" });
    expect(res.statusCode).toBe(404);
  });

  it("404s a form that is not published", async () => {
    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(admin),
      payload: { type: "Form", locale: "en", name: "Draft only" },
    });
    const draftId = (created.json() as { documentId: string }).documentId;
    const res = await submit(good({}), { id: draftId });
    expect(res.statusCode).toBe(404);
  });

  it("404s a form whose publish window has closed (expire_at in the past)", async () => {
    // Delivery stops serving an expired row the instant its window closes; the
    // submit path read `is_current_published` alone and kept accepting.
    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(admin),
      payload: { type: "Form", locale: "en", name: "Expired form" },
    });
    const expiredId = (created.json() as { documentId: string }).documentId;
    await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${expiredId}?locale=en`,
      headers: authHeaders(admin),
      payload: { data: { title: "Expired", submitLabel: "Send", confirmation: "message", fields: [FORM_FIELDS[0]] } },
    });
    const published = await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${expiredId}/publish?locale=en`, headers: authHeaders(admin) });
    expect(published.statusCode, published.body).toBe(200);
    expect((await submit(good({ fullName: "Still open" }), { id: expiredId })).statusCode).toBe(202);

    await raw.sql`UPDATE content_version SET expire_at = now() - interval '1 day' WHERE document_id = ${expiredId} AND is_current_published`;
    expect((await submit(good({ fullName: "Too late" }), { id: expiredId })).statusCode).toBe(404);
  });

  it("never exposes submissions through a delivery read", async () => {
    const res = await s.app.inject({
      method: "GET",
      url: `/api/v1/delivery/content/${formId}?populate=3`,
      headers: { authorization: `Bearer ${PREVIEW_KEY}` },
    });
    expect(res.statusCode).toBe(200);
    const raw = res.body.toLowerCase();
    expect(raw).not.toContain("ada@example.com");
    expect(raw).not.toContain("submission");
  });
});

describe("two fields, one key", () => {
  /** A form authored over the API/MCP the way an agent would build one. */
  async function formWithKeys(name: string, keys: string[]) {
    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(admin),
      payload: { type: "Form", locale: "en", name },
    });
    const id = (created.json() as { documentId: string }).documentId;
    const saved = await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${id}?locale=en`,
      headers: authHeaders(admin),
      payload: {
        data: {
          title: name,
          submitLabel: "Send",
          confirmation: "message",
          fields: keys.map((key, i) => ({
            key: `b${i}`,
            blockType: "FormTextField",
            display: "automatic",
            ref: null,
            inline: { name: key, label: `Question ${i + 1}`, required: true },
          })),
        },
      },
    });
    const published = await s.app.inject({
      method: "POST",
      url: `/api/v1/manage/content/${id}/publish?locale=en`,
      headers: authHeaders(admin),
      payload: {},
    });
    return { id, saved, published };
  }

  it("cannot be PUBLISHED — the second field would silently never reach visitors", async () => {
    // The admin warns while editing, but an agent writing over MCP/REST sees no
    // admin. Without this gate the publish succeeded and the form served ONE
    // question: filled in, published, absent — rule #1, at the write path.
    const { saved, published } = await formWithKeys("Clashing keys", ["email", "email"]);
    // A draft still saves: drafts are deliberately relaxed (work in progress).
    expect(saved.statusCode).toBe(200);
    expect(published.statusCode).toBe(422);
    const body = published.body;
    // Self-teaching: name the key, say what breaks, show the shape of a fix.
    expect(body).toContain("email");
    expect(body).toMatch(/two fields|same key|one answer per key/i);
  });

  it("publishes once each field has its own key", async () => {
    const { published } = await formWithKeys("Distinct keys", ["email", "workEmail"]);
    expect(published.statusCode, published.body).toBe(200);
  });

  it("does not begrudge two static-text blocks, which hold no key", async () => {
    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(admin),
      payload: { type: "Form", locale: "en", name: "Static twice" },
    });
    const id = (created.json() as { documentId: string }).documentId;
    await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${id}?locale=en`,
      headers: authHeaders(admin),
      payload: {
        data: {
          title: "Static twice",
          submitLabel: "Send",
          confirmation: "message",
          fields: [
            { key: "s1", blockType: "FormStaticText", display: "automatic", ref: null, inline: { heading: "About you" } },
            { key: "s2", blockType: "FormStaticText", display: "automatic", ref: null, inline: { heading: "About the work" } },
            { key: "t1", blockType: "FormTextField", display: "automatic", ref: null, inline: { name: "note", label: "Note", required: true } },
          ],
        },
      },
    });
    const published = await s.app.inject({
      method: "POST",
      url: `/api/v1/manage/content/${id}/publish?locale=en`,
      headers: authHeaders(admin),
      payload: {},
    });
    expect(published.statusCode, published.body).toBe(200);
  });
});

describe("idempotency", () => {
  it("returns the same submission for a repeated Idempotency-Key", async () => {
    const before = await countSubmissions();
    const payload = good({ fullName: "Retry", email: "retry@example.com", consent: true });
    const key = "idem-test-key-1";
    const first = await submit(payload, { headers: { "idempotency-key": key } });
    const second = await submit(payload, { headers: { "idempotency-key": key } });
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect((second.json() as { submissionId: string }).submissionId).toBe(
      (first.json() as { submissionId: string }).submissionId,
    );
    expect(await countSubmissions()).toBe(before + 1); // one row, not two
  });
});

describe("management access", () => {
  it("requires submission.read — an Author cannot read visitor messages", async () => {
    const author = await login(s.app, "author@paperboy.test", "Author!Passw0rd");
    const res = await s.app.inject({
      method: "GET",
      url: "/api/v1/manage/forms/submissions",
      headers: { cookie: author.cookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it("exports CSV with the answers under their labels", async () => {
    const res = await s.app.inject({
      method: "GET",
      url: `/api/v1/manage/forms/submissions.csv?formId=${formId}`,
      headers: { cookie: admin.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.body).toContain("Your name");
    expect(res.body).toContain("ada@example.com");
  });

  it("erases every submission containing an address (data-subject erasure)", async () => {
    await submit(good({ fullName: "Erase Me", email: "erase@example.com", consent: true }));
    // "contain" means contain: the address given in passing, inside another
    // answer, is the same person's data. An exact-match erase left this row.
    const mention = await submit(
      good({ fullName: "Mentioned", email: "other@example.com", message: "reach me at ERASE@example.com please", consent: true }),
    );
    expect(mention.statusCode, mention.body).toBe(202);
    const res = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/forms/submissions/erase",
      headers: authHeaders(admin),
      payload: { email: "ERASE@example.com" }, // case-insensitive
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { deleted: number }).deleted).toBeGreaterThanOrEqual(2);
    const after = await s.app.inject({
      method: "GET",
      url: `/api/v1/manage/forms/submissions?formId=${formId}&limit=200`,
      headers: { cookie: admin.cookie },
    });
    expect(after.body).not.toContain("erase@example.com");
    expect(after.body).not.toContain("reach me at");
  });

  it("lists the site's forms with counts", async () => {
    const res = await s.app.inject({
      method: "GET",
      url: "/api/v1/manage/forms",
      headers: { cookie: admin.cookie },
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as { formId: string; submissions: number }[];
    expect(rows.find((r) => r.formId === formId)?.submissions).toBeGreaterThan(0);
  });
});

describe("CSV escaping", () => {
  it("neutralises a formula so a spreadsheet can't execute an answer", () => {
    const csv = submissionsToCsv([
      {
        submissionId: "sub_1",
        formId: "f",
        locale: "en",
        values: { note: "=cmd|' /c calc'!A1" },
        fieldSnapshot: [{ name: "note", label: "Note", kind: "text" }],
        meta: {},
        createdAt: "2026-08-22T10:00:00.000Z",
        expiresAt: null,
      },
    ]);
    expect(csv).toContain("\"'=cmd"); // prefixed, so Excel treats it as text
  });
});

async function countSubmissions(): Promise<number> {
  const res = await s.app.inject({
    method: "GET",
    url: `/api/v1/manage/forms/submissions?formId=${formId}&limit=1`,
    headers: { cookie: admin.cookie },
  });
  return (res.json() as { total: number }).total;
}

describe("the enforced definition cannot be chosen by the caller", () => {
  /**
   * The Form's operational settings (spam protection, retention, metadata
   * capture, notification targets) are NOT localized: conceptually one value
   * shared across language branches. But values are stored per locale-version,
   * and a translated branch starts empty — so reading a single row picked by the
   * caller's `locale` let a bot select a weaker policy. Delivery already fills
   * non-localized fields from sibling variants; the submit path must not be
   * laxer than the form the visitor was shown.
   */
  let hardenedId: string;

  beforeAll(async () => {
    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(admin),
      payload: { type: "Form", locale: "en", name: "Locale hardening" },
    });
    hardenedId = (created.json() as { documentId: string }).documentId;

    // en: the real policy — a Turnstile challenge and a 5-day retention.
    await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${hardenedId}?locale=en`,
      headers: authHeaders(admin),
      payload: {
        data: {
          title: "Guarded", submitLabel: "Send", confirmation: "message",
          spamProtection: "heuristics+turnstile", retentionDays: 5,
          fields: [{ key: "x", blockType: "FormTextField", display: "automatic", ref: null, inline: { name: "note", label: "Note", required: true } }],
        },
      },
    });
    await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${hardenedId}/publish?locale=en`, headers: authHeaders(admin) });

    // nb: a translator fills the labels only. The settings are absent here,
    // exactly as the admin's translate flow leaves them.
    await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${hardenedId}?locale=nb`,
      headers: authHeaders(admin),
      payload: {
        data: {
          title: "Beskyttet", submitLabel: "Send",
          fields: [{ key: "x", blockType: "FormTextField", display: "automatic", ref: null, inline: { name: "note", label: "Notat", required: true } }],
        },
      },
    });
    await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${hardenedId}/publish?locale=nb`, headers: authHeaders(admin) });
  });

  const postTo = (payload: unknown) =>
    s.app.inject({
      method: "POST",
      url: `/api/v1/delivery/forms/${hardenedId}/submissions`,
      headers: { authorization: `Bearer ${PUBLIC_KEY}` },
      payload,
    });

  it("cannot skip a Turnstile challenge by submitting under another locale", async () => {
    // No test secret is configured, so a form that requires a challenge must
    // refuse — under EVERY locale, not just the one that stored the setting.
    const en = await postTo(good({ note: "hi" }, { locale: "en" }));
    expect(en.statusCode).toBe(422);
    const nb = await postTo(good({ note: "hei" }, { locale: "nb" }));
    expect(nb.statusCode).toBe(422);
  });

  it("cannot weaken the policy with a locale that doesn't exist", async () => {
    const res = await postTo(good({ note: "hi" }, { locale: "zz-ZZ" }));
    expect(res.statusCode).toBe(422);
  });

  it("applies the retention the editor set, whichever locale is used", async () => {
    // Same reasoning for privacy: a branch missing retentionDays must not fall
    // back to the instance default and keep personal data far longer.
    const form = await loadPublishedForm(s.app.db, "site_default", hardenedId, "nb");
    expect(form?.settings.retentionDays).toBe(5);
  });
});

/**
 * The payload a browser actually sends.
 *
 * The reference renderer submits every control it renders — `data.get(name) ?? ""`
 * — so a visitor who skips an optional field posts "" for it, not `undefined`.
 * That is the shape this endpoint has to accept, and it did not: the optional
 * branch of the compiled validator took undefined and null but not "", so a form
 * carrying an optional select, email or number field answered 422 to every
 * visitor who left it blank.
 */
describe("blank optional answers", () => {
  const browserShaped = {
    fullName: "Hans",
    email: "hans@example.com",
    message: "",
    topic: "",
    consent: true,
  };

  it("accepts a submission whose optional fields are blank", async () => {
    const res = await submit(good(browserShaped));
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json().ok).toBe(true);
  });

  it("does not store the blank answers as empty strings", async () => {
    const res = await submit(good({ ...browserShaped, fullName: "Blank Optionals" }));
    expect(res.statusCode, res.body).toBe(202);
    const list = await s.app.inject({
      method: "GET",
      url: `/api/v1/manage/forms/submissions?formId=${formId}`,
      headers: { cookie: admin.cookie },
    });
    const items = (list.json() as { items: { values: Record<string, unknown> }[] }).items;
    const stored = items.find((i) => i.values.fullName === "Blank Optionals")?.values;
    expect(stored, "the submission should have been stored").toBeTruthy();
    // A skipped optional field is unanswered, not answered with "": an empty
    // string in a number or select slot is a type lie in the stored record.
    expect("topic" in stored!).toBe(false);
    expect("message" in stored!).toBe(false);
  });

  it("still refuses a blank REQUIRED answer, keyed to the field", async () => {
    const res = await submit(good({ ...browserShaped, fullName: "" }));
    expect(res.statusCode).toBe(422);
    expect(Object.keys(res.json().fields as Record<string, string>)).toContain("fullName");
  });

  it("still refuses an unknown key that happens to be blank", async () => {
    const res = await submit(good({ ...browserShaped, surpriseKey: "" }));
    expect(res.statusCode).toBe(422);
  });
});

/**
 * A static frontend on its own origin can only POST if its PREFLIGHT succeeds,
 * and a browser preflight carries no Authorization header — so the OPTIONS
 * route must answer from the form's own site (the delivery key pins the site on
 * the POST, not before). @fastify/cors answers every OPTIONS with the ADMIN
 * origin in onRequest, so the route-level CORS below has to opt out of it.
 */
describe("CORS for a frontend on the site's own origin", () => {
  const SITE_ORIGIN = "https://site.example";
  const preflight = (origin: string, id = formId) =>
    s.app.inject({
      method: "OPTIONS",
      url: `/api/v1/delivery/forms/${id}/submissions`,
      headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type, idempotency-key" },
    });

  beforeAll(async () => {
    const set = await s.app.inject({ method: "POST", url: "/api/v1/manage/site/preview-url", headers: authHeaders(admin), payload: { url: `${SITE_ORIGIN}/` } });
    expect(set.statusCode, set.body).toBe(200);
  });

  it("a preflight from the site's origin is answered by the route: 204, that origin, idempotency-key allowed", async () => {
    const res = await preflight(SITE_ORIGIN);
    expect(res.statusCode, res.body).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(SITE_ORIGIN);
    expect(String(res.headers["access-control-allow-headers"]).toLowerCase()).toContain("idempotency-key");
    expect(String(res.headers["access-control-allow-methods"])).toContain("POST");
  });

  it("a preflight from an unknown origin grants nothing (no ACAO at all — not the admin origin either)", async () => {
    const res = await preflight("https://evil.example");
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("a preflight for an unknown form grants nothing", async () => {
    const res = await preflight(SITE_ORIGIN, "no-such-form");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("the POST echoes the site origin, never the admin origin", async () => {
    const res = await submit(good({ fullName: "Cors Test", email: "c@example.com", consent: true }), { headers: { origin: SITE_ORIGIN, "idempotency-key": "cors-post-1" } });
    expect(res.statusCode, res.body).toBe(202);
    expect(res.headers["access-control-allow-origin"]).toBe(SITE_ORIGIN);
    const foreign = await submit(good({ fullName: "Cors Test", email: "c@example.com", consent: true }), { headers: { origin: "https://evil.example", "idempotency-key": "cors-post-2" } });
    expect(foreign.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("array answers count toward the total-size guard (413), not only strings", async () => {
    const res = await submit(good({ fullName: "Big", email: "b@example.com", consent: true, topic: Array.from({ length: 300 }, () => "x".repeat(400)) }));
    expect(res.statusCode, res.body).toBe(413);
  });
});
