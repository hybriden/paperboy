import { readFile } from "node:fs/promises";
import { type MailConfig, createDb, resolveMailConfig, resolveMailRuntimeConfig, sendDueMail, sendMail } from "@paperboy/db";
import { ContentTypeDef, MIN_FILL_MS, headerSafe, mailAddress, parseMailbox, parseRecipients, renderSubmissionMail, submissionsUrl } from "@paperboy/shared";
import { SMTPServer } from "smtp-server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PUBLIC_KEY, type Suite, TEST_DB, authHeaders, login, setupApi } from "./helpers.js";

/**
 * Form notification email (issue #186, part A), against a real SMTP server on
 * loopback, so the assertions read what actually went over the wire.
 */

interface Received { from: string; to: string[]; raw: string }
const inbox: Received[] = [];
let reject: string | null = null; // set → the server refuses every recipient
let delayMs = 0; // set → the server takes this long to accept a message (a slow provider)
const server = new SMTPServer({
  authOptional: true,
  disabledCommands: ["STARTTLS", "AUTH"],
  logger: false,
  onRcptTo(address, _session, cb) {
    cb(reject ? Object.assign(new Error(reject), { responseCode: 550 }) : undefined);
  },
  onData(stream, session, cb) {
    let raw = "";
    stream.on("data", (c: Buffer) => (raw += c.toString("utf8")));
    stream.on("end", () => {
      inbox.push({ from: session.envelope.mailFrom ? session.envelope.mailFrom.address : "", to: session.envelope.rcptTo.map((r) => r.address), raw });
      setTimeout(() => cb(), delayMs);
    });
  },
});
let port = 0;
let s: Suite;
let admin: Awaited<ReturnType<typeof login>>;
let cfg: MailConfig;
const raw = createDb(TEST_DB);

const header = (msg: Received, name: string): string | undefined =>
  new RegExp(`^${name}: (.*(?:\\r\\n[ \\t].*)*)`, "im").exec(msg.raw)?.[1]?.replace(/\r\n[ \t]/g, " ");
const waitFor = async (ok: () => boolean, ms = 5000): Promise<void> => {
  for (const until = Date.now() + ms; !ok(); ) {
    if (Date.now() > until) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
};
/** Let the route's fire-and-forget attempt finish. */
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));
const rows = async (formId: string) =>
  (await raw.sql`SELECT * FROM mail_delivery WHERE form_id = ${formId} ORDER BY created_at, id`) as unknown as {
    id: string; kind: string; status: string; attempts: number; last_error: string | null; submission_id: string | null;
  }[];
const makeDue = (formId: string) => raw.sql`UPDATE mail_delivery SET next_attempt_at = now() - interval '1 second' WHERE form_id = ${formId}`;

const FIELDS = [
  { key: "f1", blockType: "FormTextField", display: "automatic", ref: null, inline: { name: "fullName", label: "Your name", required: true, maxLength: 80 } },
  { key: "f2", blockType: "FormEmailField", display: "automatic", ref: null, inline: { name: "email", label: "Email", required: true } },
  { key: "f3", blockType: "FormTextareaField", display: "automatic", ref: null, inline: { name: "message", label: "Message", required: false, maxLength: 500, rows: 4 } },
];

async function createForm(name: string, data: Record<string, unknown>): Promise<{ id: string; created: Record<string, unknown> }> {
  const created = await s.app.inject({ method: "POST", url: "/api/v1/manage/content", headers: authHeaders(admin), payload: { type: "Form", locale: "en", name } });
  expect(created.statusCode, created.body).toBe(200);
  const id = created.json().documentId as string;
  const draft = (await s.app.inject({ method: "GET", url: `/api/v1/manage/content/${id}?locale=en`, headers: authHeaders(admin) })).json().data as Record<string, unknown>;
  const put = await s.app.inject({ method: "PUT", url: `/api/v1/manage/content/${id}?locale=en`, headers: authHeaders(admin), payload: { data: { title: name, confirmation: "message", fields: FIELDS, ...data }, merge: true } });
  expect(put.statusCode, put.body).toBe(200);
  const pub = await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${id}/publish?locale=en`, headers: authHeaders(admin) });
  expect(pub.statusCode, pub.body).toBe(200);
  return { id, created: draft };
}
const submit = (formId: string, values: Record<string, unknown>, extra: { elapsedMs?: number; key?: string } = {}) =>
  s.app.inject({
    method: "POST",
    url: `/api/v1/delivery/forms/${formId}/submissions`,
    headers: { authorization: `Bearer ${PUBLIC_KEY}`, ...(extra.key ? { "idempotency-key": extra.key } : {}) },
    payload: { values, elapsedMs: extra.elapsedMs ?? MIN_FILL_MS + 500 },
  });

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.server.address() as { port: number }).port;
  s = await setupApi({
    MAIL_PROVIDER: "smtp",
    SMTP_URL: `smtp://127.0.0.1:${port}`,
    MAIL_FROM: "Paperboy <noreply@cms.example.com>",
    MAIL_MAX_PER_FORM_PER_HOUR: "3",
  });
  cfg = (await resolveMailRuntimeConfig(s.app.db, s.app.mailEnv)).config!;
  admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
  for (const name of ["Form", "FormTextField", "FormEmailField", "FormTextareaField"]) {
    const res = await s.app.inject({ method: "POST", url: `/api/v1/manage/type-templates/${name}/instantiate`, headers: authHeaders(admin), payload: {} });
    expect(res.statusCode, res.body).toBeLessThan(400);
  }
});
afterEach(() => {
  reject = null;
  delayMs = 0;
  inbox.length = 0;
});
afterAll(async () => {
  await s.app.close();
  await raw.sql.end();
  await new Promise<void>((r) => server.close(() => r()));
});

describe("sending", () => {
  it("a new Form starts with 'Send email from Paperboy' on", async () => {
    const { created } = await createForm("Default check", {});
    expect(created.notifyByEmail).toBe(true);
  });

  it("emails every valid recipient: From the instance, Reply-To the visitor, answers in the body", async () => {
    const { id } = await createForm("Contact us", { notifyEmail: "staff@example.com, sales@example.com; not-an-address" });
    const res = await submit(id, { fullName: "Ada <b>Lovelace</b>", email: "ada@example.org", message: "Hello\nthere" });
    expect(res.statusCode, res.body).toBe(202);
    await waitFor(() => inbox.length === 1);
    const msg = inbox[0]!;
    expect(msg.to.sort()).toEqual(["sales@example.com", "staff@example.com"]);
    expect(msg.from).toBe("noreply@cms.example.com");
    expect(header(msg, "From")).toContain("noreply@cms.example.com");
    expect(header(msg, "Reply-To")).toBe("ada@example.org");
    expect(header(msg, "Subject")).toContain("New submission: Contact us");
    expect(msg.raw).toContain("Ada &lt;b&gt;Lovelace&lt;/b&gt;"); // HTML part escaped
    // Links to this form's submissions ("=" is "=3D" in quoted-printable).
    expect(msg.raw.replace(/=\r\n/g, "")).toMatch(new RegExp(`/submissions\\?form=(3D)?${id}`));
    await settle();
    const [row] = await rows(id);
    expect(row).toMatchObject({ kind: "submission", status: "sent", attempts: 1 });
    expect(row!.last_error).toContain("not-an-address");
  });

  it("a form without the switch (an existing form), or without recipients, queues nothing", async () => {
    const { id: legacy } = await createForm("Legacy", { notifyEmail: "staff@example.com" });
    // A form from before migration 0039 holds no value at all.
    await raw.sql`UPDATE content_version SET data = data - 'notifyByEmail' WHERE document_id = ${legacy}`;
    const { id: noOne } = await createForm("No recipients", {});
    expect((await submit(legacy, { fullName: "A", email: "a@example.org" })).statusCode).toBe(202);
    expect((await submit(noOne, { fullName: "A", email: "a@example.org" })).statusCode).toBe(202);
    expect(await rows(legacy)).toEqual([]);
    expect(await rows(noOne)).toEqual([]);
  });

  it("a spam drop and an idempotent replay send nothing more", async () => {
    const { id } = await createForm("Spam check", { notifyEmail: "staff@example.com" });
    expect((await submit(id, { fullName: "Bot", email: "bot@example.org" }, { elapsedMs: 100 })).statusCode).toBe(202);
    expect(await rows(id)).toEqual([]);
    expect((await submit(id, { fullName: "A", email: "a@example.org" }, { key: "same-key" })).statusCode).toBe(202);
    expect((await submit(id, { fullName: "A", email: "a@example.org" }, { key: "same-key" })).statusCode).toBe(202);
    expect(await rows(id)).toHaveLength(1);
  });
});

describe("delivery guarantees", () => {
  it("a provider error still answers 202; the row waits, is retried, and fails after the last attempt", async () => {
    const { id } = await createForm("Flaky", { notifyEmail: "staff@example.com" });
    reject = "mailbox unavailable";
    expect((await submit(id, { fullName: "A", email: "a@example.org" })).statusCode).toBe(202);
    await settle();
    let [row] = await rows(id);
    expect(row).toMatchObject({ status: "pending", attempts: 1 });
    expect(row!.last_error).toContain("mailbox unavailable");
    for (let i = 0; i < 5; i++) {
      await makeDue(id);
      await sendDueMail(s.app.db, cfg);
    }
    [row] = await rows(id);
    expect(row).toMatchObject({ status: "failed", attempts: 6 });
  });

  it("a queued row survives the immediate attempt failing (the 'crash') and the ticker delivers it", async () => {
    const { id } = await createForm("Crash", { notifyEmail: "staff@example.com" });
    reject = "down";
    await submit(id, { fullName: "A", email: "a@example.org" });
    await settle();
    reject = null;
    await makeDue(id);
    expect((await sendDueMail(s.app.db, cfg)).sent).toBe(1);
    expect(inbox).toHaveLength(1);
  });

  it("two senders at once send a row once; an expired lease is picked up again", async () => {
    const { id } = await createForm("Race", { notifyEmail: "staff@example.com" });
    reject = "down";
    await submit(id, { fullName: "A", email: "a@example.org" });
    await settle();
    reject = null;
    await makeDue(id);
    const [a, b] = await Promise.all([sendDueMail(s.app.db, cfg), sendDueMail(s.app.db, cfg)]);
    expect(a.sent + b.sent).toBe(1);
    expect(inbox).toHaveLength(1);

    const [row] = await rows(id);
    await raw.sql`UPDATE mail_delivery SET status = 'sending', lease_until = now() - interval '1 second' WHERE id = ${row!.id}`;
    expect((await sendDueMail(s.app.db, cfg)).sent).toBe(1);
  });

  it("a slow provider can't make a batch outlive its lease: each row is claimed just before it is sent (review #187)", async () => {
    const { id } = await createForm("Slow", { notifyEmail: "staff@example.com" });
    reject = "down";
    for (let i = 0; i < 2; i++) await submit(id, { fullName: `A${i}`, email: "a@example.org" });
    await settle();
    reject = null;
    await makeDue(id);
    delayMs = 600; // each send outlasts the 500 ms lease below
    const a = sendDueMail(s.app.db, cfg, { leaseMs: 500 });
    await new Promise((r) => setTimeout(r, 550)); // A is still sending its first row
    const b = sendDueMail(s.app.db, cfg, { leaseMs: 500 });
    await Promise.all([a, b]);
    expect(inbox).toHaveLength(2); // one email per submission, not three
    expect((await rows(id)).map((r) => r.status)).toEqual(["sent", "sent"]);
  });

  it("all recipients invalid: failed at once, with the reason, no retries", async () => {
    const { id } = await createForm("Bad list", { notifyEmail: "nobody, also nobody" });
    await submit(id, { fullName: "A", email: "a@example.org" });
    await settle();
    const [row] = await rows(id);
    expect(row).toMatchObject({ status: "failed", attempts: 1 });
    expect(row!.last_error).toContain("No valid recipient");
    expect(inbox).toHaveLength(0);
  });

  it("an erased submission is never sent", async () => {
    const { id } = await createForm("Erase", { notifyEmail: "staff@example.com" });
    reject = "down";
    await submit(id, { fullName: "A", email: "a@example.org" });
    await settle();
    await raw.sql`DELETE FROM form_submission WHERE form_id = ${id}`;
    expect(await rows(id)).toEqual([]);
  });

  it("past the hourly cap, rows are suppressed and one summary goes through the queue", async () => {
    const { id } = await createForm("Busy", { notifyEmail: "staff@example.com" });
    for (let i = 0; i < 5; i++) expect((await submit(id, { fullName: `A${i}`, email: "a@example.org" })).statusCode).toBe(202);
    await waitFor(() => inbox.length === 3);
    await settle();
    const all = await rows(id);
    expect(all.filter((r) => r.kind === "submission" && r.status === "suppressed")).toHaveLength(2);
    const digest = all.filter((r) => r.kind === "digest");
    expect(digest).toHaveLength(1);
    expect(digest[0]!.status).toBe("pending"); // due at the end of the hour
    await makeDue(id);
    await sendDueMail(s.app.db, cfg);
    await waitFor(() => inbox.length === 4);
    expect(header(inbox[3]!, "Subject")).toContain("2 more submissions: Busy");
  });
});

describe("header safety", () => {
  it("a stored answer with CR/LF never becomes Reply-To or a recipient; a recipient list can't smuggle a Bcc", async () => {
    const { id } = await createForm("Injection", { notifyEmail: "staff@example.com\r\nBcc: evil@example.net" });
    reject = "down";
    await submit(id, { fullName: "A", email: "a@example.org" });
    await settle();
    reject = null;
    // Validation keeps CR/LF out of a submitted email; prove the chokepoint holds
    // even for a stored value that got past it.
    await raw.sql`UPDATE form_submission SET values = jsonb_set(values, '{email}', ${JSON.stringify("v@example.org\r\nBcc: evil@example.net")}::jsonb) WHERE form_id = ${id}`;
    await makeDue(id);
    await sendDueMail(s.app.db, cfg);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.to).toEqual(["staff@example.com"]);
    expect(header(inbox[0]!, "Reply-To")).toBeUndefined();
    const headers = inbox[0]!.raw.split("\r\n\r\n")[0]!;
    expect(headers).not.toMatch(/^Bcc:/im);
    expect(headers).not.toContain("evil@example.net");
  });

  it("the chokepoint and address checks", () => {
    expect(headerSafe("Contact\r\nBcc: evil@x.no")).toBe("Contact Bcc: evil@x.no");
    expect(mailAddress("a@b.no\r\nBcc: evil@x.no")).toBeNull();
    expect(mailAddress("Ada <a@b.no>")).toBeNull();
    expect(mailAddress(" a@b.no ")).toBe("a@b.no");
    expect(parseRecipients("a@b.no, A@B.no; x\nc@d.no")).toEqual({ valid: ["a@b.no", "c@d.no"], invalid: ["x"] });
    expect(parseMailbox('  "Paper Boy" <noreply@x.no> ')).toEqual({ name: "Paper Boy", address: "noreply@x.no" });
    expect(parseMailbox("noreply@x.no")).toEqual({ address: "noreply@x.no" });
    expect(parseMailbox("Name <a@x.no> trailing")).toBeNull();
    expect(parseMailbox("Name <a@x.no>>")).toBeNull();
    // The shape CodeQL flagged: a long run of spaces must answer at once.
    const t0 = Date.now();
    expect(parseMailbox(`;${" ".repeat(50_000)}x`)).toBeNull();
    expect(submissionsUrl(`https://cms.example.com${"/".repeat(50_000)}`)).toBe("https://cms.example.com/submissions");
    expect(Date.now() - t0).toBeLessThan(200);
    const m = renderSubmissionMail({ formName: "Form\r\nBcc: x@y.no", siteName: "Site", at: new Date(0), fields: [{ name: "q", label: "Q", kind: "text" }], values: { q: "<script>" }, adminUrl: "https://cms/submissions" });
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(m.html).toContain("&lt;script&gt;");
    expect(m.html).not.toContain("<script>");
  });
});

describe("configuration and dialects", () => {
  it("resolves from env, and refuses a half-configured provider", () => {
    expect(resolveMailConfig({}, "https://cms.example.com")).toBeNull();
    expect(() => resolveMailConfig({ SMTP_URL: "smtp://x" }, "https://cms.example.com")).toThrow(/MAIL_PROVIDER/);
    expect(() => resolveMailConfig({ MAIL_PROVIDER: "smtp", SMTP_URL: "smtp://x" }, "https://cms.example.com")).toThrow(/MAIL_FROM/);
    expect(() => resolveMailConfig({ MAIL_PROVIDER: "smtp", MAIL_FROM: "a@b.no" }, "https://cms.example.com")).toThrow(/SMTP_URL/);
    expect(() => resolveMailConfig({ MAIL_PROVIDER: "resend", MAIL_FROM: "a@b.no" }, "https://cms.example.com")).toThrow(/RESEND_API_KEY/);
    expect(() => resolveMailConfig({ MAIL_PROVIDER: "sendgrid", MAIL_FROM: "a@b.no" }, "https://cms.example.com")).toThrow(/smtp or resend/);
    expect(resolveMailConfig({ MAIL_PROVIDER: "resend", RESEND_API_KEY: "re_x", MAIL_FROM: "CMS <a@b.no>" }, "https://cms.example.com/")).toMatchObject({
      transport: { kind: "resend" },
      from: { name: "CMS", address: "a@b.no" },
      adminUrl: "https://cms.example.com/submissions",
      maxPerFormPerHour: 20,
    });
  });

  it("resend: posts the message to the HTTP API and surfaces its error", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response('{"id":"re_123"}', { status: 200 }));
    const msg = { from: { name: "CMS", address: "a@b.no" }, replyTo: { address: "v@x.no" }, to: [{ address: "s@x.no" }], subject: "S", text: "T", html: "<p>T</p>" };
    expect(await sendMail({ kind: "resend", apiKey: "re_key" }, msg, 30_000, "mail_row1")).toEqual({ id: "re_123" });
    const [url, init] = spy.mock.calls[0]!;
    // A retry of the same row is deduplicated by Resend.
    expect((init!.headers as Record<string, string>)["idempotency-key"]).toBe("mail_row1");
    expect(url).toBe("https://api.resend.com/emails");
    expect((init!.headers as Record<string, string>).authorization).toBe("Bearer re_key");
    expect(JSON.parse(init!.body as string)).toMatchObject({ from: '"CMS" <a@b.no>', to: ["s@x.no"], reply_to: "v@x.no", subject: "S" });
    spy.mockResolvedValueOnce(new Response('{"message":"domain not verified"}', { status: 403 }));
    await expect(sendMail({ kind: "resend", apiKey: "re_key" }, msg)).rejects.toThrow(/403.*domain not verified/);
    spy.mockRestore();
  });

  it("migration 0039 adds the switch to an existing Form type, once, and leaves its forms off", async () => {
    const def = async () =>
      ((await raw.sql`SELECT definition FROM content_type WHERE name = 'Form'`) as unknown as { definition: { fields: { name: string; helpText?: string; defaultValue?: boolean }[] } }[])[0]!.definition.fields;
    // An instance that installed Form before 0039: no switch, the old help text.
    await raw.sql`UPDATE content_type SET definition = jsonb_set(definition, '{fields}',
      (SELECT jsonb_agg(CASE WHEN f->>'name' = 'notifyEmail' THEN f || '{"helpText":"old"}' ELSE f END) FROM jsonb_array_elements(definition->'fields') f WHERE f->>'name' <> 'notifyByEmail'))
      WHERE name = 'Form'`;
    expect((await def()).some((f) => f.name === "notifyByEmail")).toBe(false);
    const sqlText = await readFile(new URL("../../../packages/db/migrations/0039_form_email.sql", import.meta.url), "utf8");
    await raw.sql.unsafe(sqlText);
    await raw.sql.unsafe(sqlText);
    const fields = await def();
    expect(fields.filter((f) => f.name === "notifyByEmail")).toEqual([expect.objectContaining({ defaultValue: true })]);
    expect(fields.find((f) => f.name === "notifyEmail")!.helpText).toContain("Send email from Paperboy");
  });

  it("defaultValue is only accepted on boolean fields", () => {
    const base = { name: "T", displayName: "T", kind: "block" };
    expect(ContentTypeDef.safeParse({ ...base, fields: [{ name: "on", displayName: "On", type: "boolean", defaultValue: true }] }).success).toBe(true);
    const bad = ContentTypeDef.safeParse({ ...base, fields: [{ name: "t", displayName: "T", type: "text", defaultValue: true }] });
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error)).toContain("only supported on boolean");
  });
});

describe("Settings → Email (part B)", () => {
  const mail = (method: "GET" | "POST", url: string, payload?: Record<string, unknown>, who = admin) =>
    s.app.inject({ method, url: `/api/v1/manage/site/mail${url}`, headers: authHeaders(who), ...(payload ? { payload } : {}) });
  const resolved = async () => resolveMailRuntimeConfig(s.app.db, s.app.mailEnv);
  afterEach(async () => {
    await mail("POST", "", { provider: null, allowedDomains: [] }); // back to the env config
  });

  it("with env-only mail, saving just the allowed domains succeeds; a refused save writes nothing (review #187)", async () => {
    const ok = await mail("POST", "", { allowedDomains: ["example.com"] });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ source: "env", provider: null, allowedDomains: ["example.com"] });
    // A provider without From is refused, and the domains sent with it are not half-saved.
    const bad = await mail("POST", "", { provider: "smtp", smtpHost: "smtp.example.com", allowedDomains: ["other.org"] });
    expect(bad.statusCode).toBe(400);
    expect((await mail("GET", "")).json().allowedDomains).toEqual(["example.com"]);
  });

  it("is for every-site admins only", async () => {
    const ed = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
    expect((await mail("GET", "", undefined, ed)).statusCode).toBe(403);
    expect((await mail("POST", "", { provider: "resend" }, ed)).statusCode).toBe(403);
    expect((await mail("POST", "/test", {}, ed)).statusCode).toBe(403);
  });

  it("shows the env config without its secret, and never returns or audits a saved one", async () => {
    const before = (await mail("GET", "")).json();
    expect(before).toMatchObject({ source: "env", provider: null, env: { provider: "smtp", smtpHost: "127.0.0.1", from: "Paperboy <noreply@cms.example.com>" } });
    const saved = await mail("POST", "", { provider: "smtp", from: "CMS <cms@example.com>", smtpHost: "smtp.example.com", smtpUser: "u", secret: "hunter2-secret" });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({ source: "db", provider: "smtp", smtpHost: "smtp.example.com", smtpPort: 587, smtpSecurity: "starttls", secretSet: true });
    expect(saved.body).not.toContain("hunter2");
    expect((await mail("GET", "")).body).not.toContain("hunter2");
    const audit = (await raw.sql`SELECT detail::text AS d FROM audit_log WHERE action = 'site.mail_config' ORDER BY id DESC LIMIT 1`) as unknown as { d: string }[];
    expect(audit[0]!.d).not.toContain("hunter2");
    expect(audit[0]!.d).toContain('"secretSet": true');
  });

  it("a saved secret follows its endpoint: a new host or provider without it drops it, and env credentials are never borrowed", async () => {
    await mail("POST", "", { provider: "smtp", from: "cms@example.com", smtpHost: "smtp.example.com", smtpUser: "u", secret: "pw-A" });
    expect((await resolved()).config!.transport).toEqual({ kind: "smtp", url: "smtp://u:pw-A@smtp.example.com:587" });

    // Move the host without re-entering the password: it must not travel along.
    const moved = (await mail("POST", "", { smtpHost: "attacker.example.net" })).json();
    expect(moved).toMatchObject({ secretSet: false, source: "env" });
    expect(moved.problem).toContain("No SMTP password");
    const r = await resolved();
    expect(r.source).toBe("env"); // the env unit as a whole, never env credentials on the new host
    expect(JSON.stringify(r.config)).not.toContain("attacker.example.net");

    await mail("POST", "", { smtpHost: "smtp.example.com", secret: "pw-B" });
    const toResend = (await mail("POST", "", { provider: "resend" })).json();
    expect(toResend).toMatchObject({ provider: "resend", secretSet: false, source: "env" });
    expect(toResend.problem).toContain("Resend API key");
  });

  it("validates what it stores, with self-teaching errors", async () => {
    const noFrom = await mail("POST", "", { provider: "smtp", smtpHost: "smtp.example.com" });
    expect(noFrom.statusCode).toBe(400);
    expect(noFrom.json().message).toContain("verified at the provider");
    expect((await mail("POST", "", { provider: "smtp", from: "a@example.com", smtpHost: "bad host!" })).json().message).toContain("SMTP host");
    expect((await mail("POST", "", { allowedDomains: ["not a domain"] })).json().message).toContain("Not a domain");
  });

  it("Send test email does a real round trip to the admin, and reports the provider's words on failure", async () => {
    await mail("POST", "", { provider: "smtp", from: "Test <cms@example.com>", smtpHost: "127.0.0.1", smtpPort: port });
    const ok = (await mail("POST", "/test", {})).json();
    expect(ok).toMatchObject({ ok: true, to: "admin@paperboy.test", source: "db" });
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.to).toEqual(["admin@paperboy.test"]);
    expect(header(inbox[0]!, "Subject")).toBe("Paperboy test email");
    reject = "relay access denied";
    const bad = (await mail("POST", "/test", {})).json();
    expect(bad.ok).toBe(false);
    expect(bad.message).toContain("relay access denied");
  });

  it("form email uses the saved settings at once, and the allowlist keeps it inside the allowed domains", async () => {
    await mail("POST", "", { provider: "smtp", from: "Saved <saved@example.com>", smtpHost: "127.0.0.1", smtpPort: port, allowedDomains: ["example.com"] });
    const { id } = await createForm("Allowlisted", { notifyEmail: "staff@example.com, outside@other.org" });
    await submit(id, { fullName: "A", email: "a@example.org" });
    await waitFor(() => inbox.length === 1);
    expect(inbox[0]!.from).toBe("saved@example.com");
    expect(inbox[0]!.to).toEqual(["staff@example.com"]);
    await settle();
    expect((await rows(id))[0]!.last_error).toContain("outside@other.org (domain not allowed)");
  });

  it("the Forms list says who hears about each form and how the last email went", async () => {
    const { id: on } = await createForm("Listed on", { notifyEmail: "staff@example.com", notifyWebhooks: true });
    const { id: off } = await createForm("Listed off", { notifyEmail: "staff@example.com", notifyByEmail: false });
    await submit(on, { fullName: "A", email: "a@example.org" });
    await waitFor(() => inbox.length === 1);
    await settle();
    const list = (await s.app.inject({ method: "GET", url: "/api/v1/manage/forms", headers: authHeaders(admin) })).json() as { formId: string; notify: Record<string, unknown> }[];
    expect(list.find((f) => f.formId === on)!.notify).toMatchObject({ published: true, email: "on", recipients: "staff@example.com", webhooks: true, lastEmail: { status: "sent" } });
    expect(list.find((f) => f.formId === off)!.notify).toMatchObject({ email: "off", webhooks: false, lastEmail: null });
  });
});
