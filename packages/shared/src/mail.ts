import { scalarToString } from "./content-types.js";

/**
 * Form notification email, the pure half: header safety, addresses and the
 * message itself. The transports (SMTP, Resend) live in @paperboy/db, which is
 * server-only. Issue #186.
 */

export interface MailAddress {
  name?: string;
  address: string;
}

export interface MailMessage {
  from: MailAddress;
  replyTo?: MailAddress;
  to: MailAddress[];
  subject: string;
  text: string;
  html: string;
}

/**
 * THE header chokepoint: every value that reaches a mail header (subject,
 * display names, addresses) passes through here. Line breaks and other control
 * characters become a space, so no value can start a header of its own
 * ("x@y.z\r\nBcc: …"). The display name is as injectable as the address.
 */
export function headerSafe(value: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what this strips
  return value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
}

// One plain addr-spec: no spaces, brackets, quotes, commas or semicolons, so a
// value that passed can never smuggle a second address or a display name.
const ADDRESS_RE = /^[^\s@<>()[\]",;:\\]+@[^\s@<>()[\]",;:\\]+\.[^\s@<>()[\]",;:\\]{2,}$/;

/** Exactly one valid address after the header chokepoint, or null. */
export function mailAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const a = headerSafe(value);
  return a.length <= 254 && ADDRESS_RE.test(a) ? a : null;
}

/** A recipient list ("a@x.no, b@y.no"): the valid addresses (deduplicated) and what was not one. */
export function parseRecipients(list: string): { valid: string[]; invalid: string[] } {
  const valid: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const part of list.split(/[,;\n]/)) {
    const raw = part.trim();
    if (!raw) continue;
    const a = mailAddress(raw);
    if (!a) invalid.push(headerSafe(raw).slice(0, 100));
    else if (!seen.has(a.toLowerCase())) {
      seen.add(a.toLowerCase());
      valid.push(a);
    }
  }
  return { valid, invalid };
}

/** `noreply@x.no` or `Name <noreply@x.no>` (MAIL_FROM), or null when it is neither. */
export function parseMailbox(value: string): MailAddress | null {
  const m = /^\s*(?:"?([^"<]*?)"?\s*<([^<>]+)>|([^<>]+))\s*$/.exec(value);
  if (!m) return null;
  const address = mailAddress(m[2] ?? m[3]);
  if (!address) return null;
  const name = headerSafe(m[1] ?? "").replace(/["\\]/g, "");
  return name ? { name, address } : { address };
}

/** RFC 5322 mailbox text for an HTTP API that takes strings: `"Name" <addr>`. */
export function formatMailbox(a: MailAddress): string {
  const address = headerSafe(a.address);
  const name = a.name ? headerSafe(a.name).replace(/["\\]/g, "") : "";
  return name ? `"${name}" <${address}>` : address;
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** An answer as text: lists joined, yes/no for checkboxes, never "[object Object]". */
function answerText(v: unknown): string {
  if (Array.isArray(v)) return v.map(answerText).filter(Boolean).join(", ");
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return scalarToString(v);
}

const when = (at: Date): string => `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;

export interface SubmissionMailInput {
  formName: string;
  siteName: string;
  at: Date;
  /** The fields as answered (form_submission.field_snapshot), in form order. */
  fields: { name: string; label: string; kind: string }[];
  values: Record<string, unknown>;
  /** Where the submissions are in admin. */
  adminUrl: string;
}

/**
 * The notification for one submission. The subject is built from the form and
 * site names only, never from what the visitor typed; every answer is
 * HTML-escaped here and nowhere else.
 */
export function renderSubmissionMail(m: SubmissionMailInput): { subject: string; text: string; html: string } {
  const rows = m.fields
    .filter((f) => m.values[f.name] !== undefined && m.values[f.name] !== null && m.values[f.name] !== "")
    .map((f) => ({ label: f.label || f.name, value: answerText(m.values[f.name]) }));
  const subject = headerSafe(`New submission: ${m.formName} (${m.siteName})`).slice(0, 200);
  const text = [
    `New submission to "${m.formName}" on ${m.siteName}, ${when(m.at)}.`,
    "",
    ...rows.map((r) => `${r.label}:\n${r.value}\n`),
    `All submissions: ${m.adminUrl}`,
  ].join("\n");
  const html =
    `<p>New submission to <strong>${escapeHtml(m.formName)}</strong> on ${escapeHtml(m.siteName)}, ${escapeHtml(when(m.at))}.</p>` +
    `<table cellpadding="6" style="border-collapse:collapse">` +
    rows
      .map((r) => `<tr><th align="left" valign="top">${escapeHtml(r.label)}</th><td style="white-space:pre-wrap">${escapeHtml(r.value)}</td></tr>`)
      .join("") +
    `</table><p><a href="${escapeHtml(m.adminUrl)}">All submissions</a></p>`;
  return { subject, text, html };
}

/** The hourly summary once a form passed its email cap: a count and a link, no answers. */
export function renderDigestMail(m: { formName: string; siteName: string; count: number; hourStart: Date; adminUrl: string }): { subject: string; text: string; html: string } {
  const subject = headerSafe(`${m.count} more submissions: ${m.formName} (${m.siteName})`).slice(0, 200);
  const line = `"${m.formName}" on ${m.siteName} got ${m.count} more submissions in the hour from ${when(m.hourStart)} than are emailed one by one.`;
  return {
    subject,
    text: `${line}\n\nRead them in admin: ${m.adminUrl}`,
    html: `<p>${escapeHtml(line)}</p><p><a href="${escapeHtml(m.adminUrl)}">Read them in admin</a></p>`,
  };
}
