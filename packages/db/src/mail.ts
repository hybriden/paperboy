import {
  type MailAddress,
  type MailMessage,
  formatMailbox,
  mailAddress,
  parseMailbox,
  parseRecipients,
  renderDigestMail,
  renderSubmissionMail,
} from "@paperboy/shared";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import nodemailer from "nodemailer";
import type { Database, Queryable } from "./client.js";
import { formSubmission, mailDelivery, site } from "./schema.js";

/**
 * Form notification email (issue #186, part A): the transports, the queue and
 * the sender. One small seam with two dialects, like the AI provider seam:
 * `smtp` is the generic one (practically every provider offers SMTP
 * submission), `resend` is an HTTP API for hosts where outbound SMTP is blocked.
 *
 * Delivery is at-least-once: a row is queued in the submission's transaction,
 * claimed before it is sent, and retried with backoff. A crash after the
 * provider accepted a message but before the row is marked sent can repeat it.
 */

export type MailTransport = { kind: "smtp"; url: string } | { kind: "resend"; apiKey: string };

export interface MailConfig {
  transport: MailTransport;
  from: MailAddress;
  /** Where the submissions are in admin, linked from every email. */
  adminUrl: string;
  /** Submission emails per form per clock hour; the rest are summarised. */
  maxPerFormPerHour: number;
  /** Recipient domains form email may go to (Settings → Email); unset = any. */
  allowedDomains?: string[];
}

export interface MailEnv {
  MAIL_PROVIDER?: string;
  SMTP_URL?: string;
  RESEND_API_KEY?: string;
  MAIL_FROM?: string;
  MAIL_MAX_PER_FORM_PER_HOUR?: number;
}

/**
 * The instance's mail configuration from env, or null when none is set (forms
 * then behave as before: nothing is queued). A half-configured provider
 * REFUSES to boot rather than silently never sending.
 */
export function resolveMailConfig(env: MailEnv, adminUrl: string): MailConfig | null {
  const provider = env.MAIL_PROVIDER;
  if (!provider) {
    if (env.SMTP_URL || env.RESEND_API_KEY || env.MAIL_FROM) {
      throw new Error('Refusing to start: SMTP_URL, RESEND_API_KEY or MAIL_FROM is set but MAIL_PROVIDER is not. Set MAIL_PROVIDER=smtp or MAIL_PROVIDER=resend, or unset them to send no form email.');
    }
    return null;
  }
  const from = env.MAIL_FROM ? parseMailbox(env.MAIL_FROM) : null;
  if (!from) {
    throw new Error(`Refusing to start: MAIL_PROVIDER=${provider} needs MAIL_FROM, an address on a domain verified at the provider, e.g. MAIL_FROM="Paperboy <noreply@cms.example.com>".`);
  }
  const base = { from, adminUrl: `${adminUrl.replace(/\/+$/, "")}/submissions`, maxPerFormPerHour: env.MAIL_MAX_PER_FORM_PER_HOUR ?? 20 };
  if (provider === "smtp") {
    const url = env.SMTP_URL && URL.canParse(env.SMTP_URL) ? new URL(env.SMTP_URL) : null;
    if (!url || (url.protocol !== "smtp:" && url.protocol !== "smtps:") || !url.hostname) {
      throw new Error("Refusing to start: MAIL_PROVIDER=smtp needs SMTP_URL, e.g. smtps://user:password@smtp.example.com:465 (TLS) or smtp://user:password@smtp.example.com:587 (STARTTLS).");
    }
    return { ...base, transport: { kind: "smtp", url: env.SMTP_URL! } };
  }
  if (provider === "resend") {
    if (!env.RESEND_API_KEY) throw new Error("Refusing to start: MAIL_PROVIDER=resend needs RESEND_API_KEY.");
    return { ...base, transport: { kind: "resend", apiKey: env.RESEND_API_KEY } };
  }
  throw new Error(`Refusing to start: MAIL_PROVIDER must be smtp or resend (got "${provider}").`);
}

/** One send may take this long; well under the claim lease, so a slow server can't outlive it. */
export const MAIL_SEND_TIMEOUT_MS = 30_000;
const LEASE = "2 minutes";
/** Wait before attempt 2, 3, … after a failure; after the last, the row is failed. */
export const MAIL_BACKOFF_MS = [60_000, 300_000, 1_800_000, 7_200_000, 21_600_000];
const RESEND_ENDPOINT = "https://api.resend.com/emails";

const isLoopback = (host: string): boolean => host === "localhost" || host === "::1" || host === "[::1]" || host.startsWith("127.");

/** Hand one message to the provider. Throws with the provider's own words on failure. */
export async function sendMail(transport: MailTransport, msg: MailMessage, timeoutMs = MAIL_SEND_TIMEOUT_MS): Promise<{ id?: string }> {
  if (transport.kind === "resend") {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${transport.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: formatMailbox(msg.from),
        to: msg.to.map(formatMailbox),
        ...(msg.replyTo ? { reply_to: formatMailbox(msg.replyTo) } : {}),
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`Resend answered ${res.status}: ${body.slice(0, 300)}`);
    const id: unknown = (JSON.parse(body || "{}") as { id?: unknown }).id;
    return typeof id === "string" ? { id } : {};
  }

  const url = new URL(transport.url);
  const secure = url.protocol === "smtps:";
  const smtp = nodemailer.createTransport({
    host: url.hostname,
    port: url.port ? Number(url.port) : secure ? 465 : 587,
    secure,
    // Credentials never cross the network in clear: without implicit TLS the
    // server must offer STARTTLS (a local relay on loopback is exempt).
    requireTLS: !secure && !isLoopback(url.hostname),
    auth: url.username ? { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: timeoutMs,
  });
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    const info = await Promise.race([
      smtp.sendMail({ from: msg.from, to: msg.to, replyTo: msg.replyTo, subject: msg.subject, text: msg.text, html: msg.html }),
      new Promise<never>((_, reject) => {
        timeout.addEventListener("abort", () => reject(new Error(`SMTP send timed out after ${timeoutMs / 1000} s`)), { once: true });
      }),
    ]);
    return info.messageId ? { id: info.messageId } : {};
  } finally {
    smtp.close();
  }
}

/**
 * Queue the notification for a just-stored submission, inside the submission's
 * own transaction. Past the form's hourly cap the row is `suppressed` and the
 * hour's summary row is queued instead (one per form per hour).
 */
export async function queueFormMail(
  tx: Queryable,
  row: { submissionId: string; siteId: string; formId: string; formName: string; recipients: string },
  maxPerFormPerHour: number,
): Promise<void> {
  const sentThisHour = (await tx.execute(sql`
    SELECT count(*)::int AS n FROM mail_delivery
    WHERE form_id = ${row.formId} AND kind = 'submission' AND status <> 'suppressed'
      AND created_at >= date_trunc('hour', now())
  `)) as unknown as { n: number }[];
  const overCap = (sentThisHour[0]?.n ?? 0) >= maxPerFormPerHour;
  await tx.insert(mailDelivery).values({ id: `mail_${nanoid(18)}`, kind: "submission", ...row, status: overCap ? "suppressed" : "pending" });
  if (overCap) {
    await tx.execute(sql`
      INSERT INTO mail_delivery (id, kind, site_id, form_id, form_name, recipients, digest_hour, next_attempt_at)
      VALUES (${`mail_${nanoid(18)}`}, 'digest', ${row.siteId}, ${row.formId}, ${row.formName}, ${row.recipients},
              date_trunc('hour', now()), date_trunc('hour', now()) + interval '1 hour')
      ON CONFLICT DO NOTHING
    `);
  }
}

type Claimed = typeof mailDelivery.$inferSelect;

/**
 * Send what is due: pending rows whose time has come, and sends whose lease ran
 * out (the process died mid-send). Each row is CLAIMED first, so two senders
 * (the submit route's immediate attempt, the ticker, a second API process)
 * never send the same row. `submissionId` narrows it to one submission's row.
 */
export async function sendDueMail(
  db: Database,
  cfg: MailConfig,
  opts: { submissionId?: string; limit?: number } = {},
): Promise<{ sent: number; failed: number; retrying: number }> {
  const claimed = (await db.execute(sql`
    UPDATE mail_delivery SET status = 'sending', lease_until = now() + ${LEASE}::interval, attempts = attempts + 1
    WHERE id IN (
      SELECT id FROM mail_delivery
      WHERE ((status = 'pending' AND next_attempt_at <= now()) OR (status = 'sending' AND lease_until < now()))
        ${opts.submissionId ? sql`AND submission_id = ${opts.submissionId}` : sql``}
      ORDER BY next_attempt_at
      LIMIT ${opts.limit ?? 50}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, kind, submission_id AS "submissionId", site_id AS "siteId", form_id AS "formId", form_name AS "formName",
              recipients, attempts, digest_hour AS "digestHour"
  `)) as unknown as Pick<Claimed, "id" | "kind" | "submissionId" | "siteId" | "formId" | "formName" | "recipients" | "attempts" | "digestHour">[];

  const out = { sent: 0, failed: 0, retrying: 0 };
  for (const row of claimed) {
    const done = (set: Partial<Claimed>) =>
      db.update(mailDelivery).set({ leaseUntil: null, ...set }).where(and(eq(mailDelivery.id, row.id), eq(mailDelivery.status, "sending")));
    const { valid, invalid } = recipientsFor(row.recipients, cfg.allowedDomains);
    if (valid.length === 0) {
      // Retrying cannot fix the address list; say exactly what was wrong.
      await done({ status: "failed", lastError: `No valid recipient in notifyEmail: "${invalid.join(", ") || row.recipients}"` });
      out.failed++;
      continue;
    }
    try {
      const msg = await composeMessage(db, cfg, row);
      if (!msg) {
        await done({ status: "suppressed", lastError: null }); // a digest with nothing left to report
        continue;
      }
      const { id } = await sendMail(cfg.transport, { ...msg, to: valid.map((address) => ({ address })) });
      const partial = invalid.length ? `Skipped invalid recipients: ${invalid.join(", ")}` : null;
      await done({ status: "sent", sentAt: new Date(), providerId: id ?? null, lastError: partial });
      out.sent++;
    } catch (err) {
      const error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      const wait = MAIL_BACKOFF_MS[row.attempts - 1];
      if (wait === undefined) {
        await done({ status: "failed", lastError: error });
        out.failed++;
      } else {
        await done({ status: "pending", lastError: error, nextAttemptAt: new Date(Date.now() + wait) });
        out.retrying++;
      }
      console.error(`[paperboy] form email ${row.id} (form ${row.formId}) failed, attempt ${row.attempts}: ${error}`);
    }
  }
  return out;
}

/**
 * The addresses a row may go to: valid ones, inside the allowlist when one is
 * set (an agent that points notifyEmail outside it gets nothing delivered).
 */
function recipientsFor(list: string, allowedDomains: string[] | undefined): { valid: string[]; invalid: string[] } {
  const { valid, invalid } = parseRecipients(list);
  if (!allowedDomains?.length) return { valid, invalid };
  const allowed = (a: string) => allowedDomains.includes(a.slice(a.lastIndexOf("@") + 1).toLowerCase());
  return { valid: valid.filter(allowed), invalid: [...invalid, ...valid.filter((a) => !allowed(a)).map((a) => `${a} (domain not allowed)`)] };
}

/** "Send test email": one message straight through the transport, to the admin who asked. */
export async function sendTestMail(cfg: MailConfig, to: string): Promise<{ id?: string }> {
  return sendMail(cfg.transport, {
    from: cfg.from,
    to: [{ address: to }],
    subject: "Paperboy test email",
    text: `This is a test from Paperboy. Form notification email works.\n\nSubmissions: ${cfg.adminUrl}`,
    html: `<p>This is a test from Paperboy. Form notification email works.</p>`,
  });
}

/** The form's submissions in admin (the Forms view opens it from ?form=). */
const formLink = (cfg: MailConfig, formId: string): string => `${cfg.adminUrl}?form=${encodeURIComponent(formId)}`;

/** The message for a claimed row, rendered from what is stored now; null = nothing to send. */
async function composeMessage(
  db: Database,
  cfg: MailConfig,
  row: Pick<Claimed, "kind" | "submissionId" | "siteId" | "formId" | "formName" | "digestHour">,
): Promise<Omit<MailMessage, "to"> | null> {
  const siteName = (await db.select({ name: site.name }).from(site).where(eq(site.id, row.siteId)).limit(1))[0]?.name ?? row.siteId;
  if (row.kind === "digest") {
    const hourStart = new Date(row.digestHour!); // a raw RETURNING gives the timestamp as text
    const counted = await db.execute(sql`
      SELECT count(*)::int AS n FROM mail_delivery
      WHERE form_id = ${row.formId} AND kind = 'submission' AND status = 'suppressed'
        AND created_at >= ${hourStart.toISOString()}::timestamptz AND created_at < ${hourStart.toISOString()}::timestamptz + interval '1 hour'
    `) as unknown as { n: number }[];
    const count = counted[0]?.n ?? 0;
    if (count === 0) return null; // all erased since
    return { from: cfg.from, ...renderDigestMail({ formName: row.formName, siteName, count, hourStart, adminUrl: formLink(cfg, row.formId) }) };
  }
  const sub = (await db.select().from(formSubmission).where(eq(formSubmission.submissionId, row.submissionId!)).limit(1))[0];
  if (!sub) throw new Error("The submission is gone."); // unreachable: the row cascades with it
  const fields = (sub.fieldSnapshot ?? []) as { name: string; label: string; kind: string }[];
  const values = (sub.values ?? {}) as Record<string, unknown>;
  // Reply-To is visitor input: only exactly one valid address, else none.
  const emailField = fields.find((f) => f.kind === "email");
  const replyTo = emailField ? mailAddress(values[emailField.name]) : null;
  return {
    from: cfg.from,
    ...(replyTo ? { replyTo: { address: replyTo } } : {}),
    ...renderSubmissionMail({ formName: row.formName, siteName, at: sub.createdAt, fields, values, adminUrl: formLink(cfg, row.formId) }),
  };
}

/** Prune finished delivery rows (submission rows also go with their submission). */
export async function runMailDeliveryRetention(db: Database, days = 90): Promise<{ deleted: number }> {
  const rows = await db
    .delete(mailDelivery)
    .where(and(inArray(mailDelivery.status, ["sent", "failed", "suppressed"]), lt(mailDelivery.createdAt, new Date(Date.now() - days * 86_400_000))))
    .returning({ id: mailDelivery.id });
  return { deleted: rows.length };
}
