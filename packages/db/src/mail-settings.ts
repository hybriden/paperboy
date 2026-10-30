import { parseMailbox, submissionsUrl } from "@paperboy/shared";
import { eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { Errors } from "./errors.js";
import type { MailConfig } from "./mail.js";
import { siteSetting } from "./schema.js";
import { type AccessContext, requirePermission } from "./scope.js";
import { getSetting, putSetting } from "./site.js";
import { decryptSecret, encryptSecret } from "./totp.js";

/**
 * Form email settings stored in the CMS (Settings → Email, issue #186 part B),
 * resolved together with the env config the way the AI provider is: as a UNIT,
 * DB over env, never mixed. A stored secret is bound to the endpoint it was
 * entered for (provider + host + port + security + user); moving any of them
 * without re-entering it clears it, so a password can never be sent to a host
 * an admin typed in afterwards, and an admin-set host never gets env credentials.
 */

const CONFIG_KEY = "mailConfig";
const SECRET_KEY = "mailSecret";
const DOMAINS_KEY = "mailAllowedDomains";

export const MAIL_PROVIDERS = ["smtp", "resend"] as const;
export type MailProvider = (typeof MAIL_PROVIDERS)[number];
export const SMTP_SECURITIES = ["tls", "starttls"] as const;
export type SmtpSecurity = (typeof SMTP_SECURITIES)[number];

interface StoredConfig {
  provider: MailProvider;
  from: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecurity?: SmtpSecurity;
  smtpUser?: string;
}

/** What `secret` belongs to; a secret saved for another endpoint is unusable. */
const endpointOf = (c: StoredConfig): string =>
  c.provider === "resend" ? "resend" : `smtp:${c.smtpHost ?? ""}:${c.smtpPort ?? ""}:${c.smtpSecurity ?? ""}:${c.smtpUser ?? ""}`;

export interface StoredMailSettings {
  config: StoredConfig | null;
  secret: string | null;
  /** A secret IS stored but the current MFA_SECRET/SESSION_SECRET cannot open it. */
  undecryptable: boolean;
  allowedDomains: string[];
}

export async function getStoredMailSettings(db: Database): Promise<StoredMailSettings> {
  const config = await getSetting<StoredConfig>(db, CONFIG_KEY);
  const row = await getSetting<{ cipher: string; endpoint: string }>(db, SECRET_KEY);
  let secret: string | null = null;
  let undecryptable = false;
  if (config && row?.cipher && row.endpoint === endpointOf(config)) {
    try {
      secret = decryptSecret(row.cipher, "mail.secret");
    } catch {
      undecryptable = true;
    }
  }
  const allowedDomains = (await getSetting<{ domains: string[] }>(db, DOMAINS_KEY))?.domains ?? [];
  return { config, secret, undecryptable, allowedDomains };
}

export interface MailSettingsInput {
  /** null = remove the CMS config (back to the env one). */
  provider?: MailProvider | null;
  from?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecurity?: SmtpSecurity;
  smtpUser?: string;
  /** The SMTP password or the Resend API key. undefined = keep; null/"" = clear. */
  secret?: string | null;
  /** Recipient domains form email may go to; [] = any. */
  allowedDomains?: string[];
}

const HOST_RE = /^[a-z0-9.-]+$/i;
const DOMAIN_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/**
 * Set the CMS mail settings (every-site admins). Each field: undefined =
 * unchanged. Everything is validated BEFORE the first write, so a refused save
 * leaves nothing half-saved.
 */
export async function setMailSettings(db: Database, ctx: AccessContext, input: MailSettingsInput): Promise<void> {
  requirePermission(ctx, "user.manage");
  let domains: string[] | undefined;
  if (input.allowedDomains !== undefined) {
    domains = [...new Set(input.allowedDomains.map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean))];
    const bad = domains.filter((d) => !DOMAIN_RE.test(d));
    if (bad.length) throw Errors.badRequest(`Not a domain: ${bad.join(", ")}. Write domains like "example.com", one per entry.`);
  }

  const touched = ["provider", "from", "smtpHost", "smtpPort", "smtpSecurity", "smtpUser"].some((k) => input[k as keyof MailSettingsInput] !== undefined);
  const prev = (await getStoredMailSettings(db)).config;
  let next: StoredConfig | null = null;
  if (input.provider !== null && (touched || input.secret !== undefined)) {
    const provider = input.provider ?? prev?.provider;
    if (!provider) throw Errors.badRequest('Choose a provider first: "smtp" or "resend".');
    const from = input.from ?? prev?.from ?? "";
    if (!parseMailbox(from)) {
      throw Errors.badRequest('From must be an address on a domain verified at the provider, e.g. "Paperboy <noreply@cms.example.com>".');
    }
    next = { provider, from: from.trim() };
    if (provider === "smtp") {
      const host = (input.smtpHost ?? prev?.smtpHost ?? "").trim().toLowerCase();
      if (!HOST_RE.test(host)) throw Errors.badRequest('SMTP host must be a host name, e.g. "smtp.example.com".');
      const security = input.smtpSecurity ?? prev?.smtpSecurity ?? "starttls";
      const port = input.smtpPort ?? prev?.smtpPort ?? (security === "tls" ? 465 : 587);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw Errors.badRequest("SMTP port must be 1-65535 (465 for TLS, 587 for STARTTLS).");
      Object.assign(next, { smtpHost: host, smtpPort: port, smtpSecurity: security, smtpUser: (input.smtpUser ?? prev?.smtpUser ?? "").trim() });
    }
  }

  // Valid: write.
  if (domains !== undefined) {
    if (domains.length) await putSetting(db, DOMAINS_KEY, { domains });
    else await deleteSetting(db, DOMAINS_KEY);
  }
  if (input.provider === null) {
    await deleteSetting(db, CONFIG_KEY);
    await deleteSetting(db, SECRET_KEY);
    return;
  }
  if (!next) return;
  await putSetting(db, CONFIG_KEY, next);
  // The secret follows its endpoint: a new one is saved bound to it; an old one
  // bound elsewhere is dropped instead of being carried to a new host.
  const secret = input.secret?.trim();
  if (secret) await putSetting(db, SECRET_KEY, { cipher: encryptSecret(secret, "mail.secret"), endpoint: endpointOf(next) });
  else if (input.secret !== undefined || !prev || endpointOf(prev) !== endpointOf(next)) await deleteSetting(db, SECRET_KEY);
}

const deleteSetting = (db: Database, key: string) => db.delete(siteSetting).where(eq(siteSetting.key, key));

/** The env side, resolved and validated at boot (resolveMailConfig), plus the instance-wide knobs. */
export interface MailEnvConfig {
  env: MailConfig | null;
  /** Base of the admin; emails link to {adminUrl}/submissions. */
  adminUrl: string;
  maxPerFormPerHour: number;
}

export interface ResolvedMailConfig {
  config: MailConfig | null;
  source: "db" | "env" | "none";
  /** Why the CMS config isn't used, when one is stored (the status UI shows it). */
  problem: string | null;
}

/**
 * The ONE place the CMS settings and the env config combine. A complete CMS
 * config wins as a whole; otherwise the env config applies as a whole. They
 * never mix, so an env password can't reach a CMS-set host. The recipient
 * allowlist is a CMS setting and applies to either.
 */
export async function resolveMailRuntimeConfig(db: Database, base: MailEnvConfig): Promise<ResolvedMailConfig> {
  const stored = await getStoredMailSettings(db);
  const allowedDomains = stored.allowedDomains.length ? stored.allowedDomains : undefined;
  const adminUrl = submissionsUrl(base.adminUrl);
  let problem: string | null = null;
  const c = stored.config;
  const from = c ? parseMailbox(c.from) : null;
  if (c && from) {
    if (stored.undecryptable) problem = "The stored secret can't be decrypted (MFA_SECRET or SESSION_SECRET changed). Enter it again.";
    else if (c.provider === "resend") {
      if (stored.secret) return { source: "db", problem: null, config: { transport: { kind: "resend", apiKey: stored.secret }, from, adminUrl, maxPerFormPerHour: base.maxPerFormPerHour, allowedDomains } };
      problem = "No Resend API key saved for this configuration.";
    } else if (c.smtpUser && !stored.secret) {
      problem = "No SMTP password saved for this host and user.";
    } else {
      const auth = c.smtpUser ? `${encodeURIComponent(c.smtpUser)}:${encodeURIComponent(stored.secret ?? "")}@` : "";
      const url = `${c.smtpSecurity === "tls" ? "smtps" : "smtp"}://${auth}${c.smtpHost}:${c.smtpPort}`;
      return { source: "db", problem: null, config: { transport: { kind: "smtp", url }, from, adminUrl, maxPerFormPerHour: base.maxPerFormPerHour, allowedDomains } };
    }
  }
  if (base.env) return { source: "env", problem, config: { ...base.env, allowedDomains } };
  return { source: "none", problem, config: null };
}
