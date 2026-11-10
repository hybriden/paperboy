import { z } from "zod";
import { AI_PROVIDERS, AI_REASONING_EFFORTS } from "./ai.js";
import { RoleName } from "./auth.js";
import { MAIL_PROVIDERS, SMTP_SECURITIES } from "./mail.js";
import { SeoFilesConfig } from "./public-files.js";
import { LocalePrefix } from "./redirects.js";
import { STOCK_PROVIDERS } from "./stock.js";

/**
 * Response shapes of the Management API that the admin reads. The routes
 * validate and serialize with these schemas and the admin types its calls
 * with `z.infer` of the same ones, so the two can't drift (they had: the
 * admin's copy of the stock-key status lacked "undecryptable").
 */

export const DeliveryKeyRow = z.object({
  id: z.number(),
  name: z.string(),
  keyPrefix: z.string(),
  type: z.enum(["public", "preview"]),
  createdAt: z.string(),
  revokedAt: z.string().nullable(),
});
export type DeliveryKeyRow = z.infer<typeof DeliveryKeyRow>;

export const McpTokenRow = z.object({
  id: z.number(),
  name: z.string(),
  userId: z.string(),
  siteId: z.string().nullable(),
  email: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});
export type McpTokenRow = z.infer<typeof McpTokenRow>;

/** Write-only AI provider config status (the key itself is never returned). */
export const AiConfigStatus = z.object({
  configured: z.boolean(),
  // "undecryptable": a key IS stored but the current MFA_SECRET/SESSION_SECRET
  // can't open it (rotated) — distinct from "none", or the admin re-enters a
  // key that then silently overwrites one nobody knew was there.
  source: z.enum(["db", "env", "none", "undecryptable"]),
  provider: z.enum(AI_PROVIDERS),
  last4: z.string().nullable(),
  model: z.string().nullable(),
  baseUrl: z.string().nullable(),
  reasoningEffort: z.enum(AI_REASONING_EFFORTS).nullable(),
});
export type AiConfigStatus = z.infer<typeof AiConfigStatus>;

/** Form email settings (Settings → Email). The password / API key is never returned. */
export const MailStatus = z.object({
  source: z.enum(["db", "env", "none"]),
  /** Why the saved CMS config isn't in use, if it isn't. */
  problem: z.string().nullable(),
  provider: z.enum(MAIL_PROVIDERS).nullable(),
  from: z.string().nullable(),
  smtpHost: z.string().nullable(),
  smtpPort: z.number().nullable(),
  smtpSecurity: z.enum(SMTP_SECURITIES).nullable(),
  smtpUser: z.string().nullable(),
  secretSet: z.boolean(),
  allowedDomains: z.array(z.string()),
  env: z.object({ provider: z.enum(MAIL_PROVIDERS).nullable(), from: z.string().nullable(), smtpHost: z.string().nullable() }),
  maxPerFormPerHour: z.number(),
});
export type MailStatus = z.infer<typeof MailStatus>;

/** Write-only stock image provider config status (the key itself is never returned). */
export const StockConfigStatus = z.object({
  configured: z.boolean(),
  provider: z.enum(STOCK_PROVIDERS),
  source: z.enum(["db", "env", "none", "undecryptable"]),
  last4: z.string().nullable(),
});
export type StockConfigStatus = z.infer<typeof StockConfigStatus>;

export const WebhookRow = z.object({
  id: z.number(),
  name: z.string(),
  url: z.string(),
  events: z.array(z.string()),
  active: z.boolean(),
  lastStatus: z.number().nullable(),
  lastAt: z.string().nullable(),
  createdAt: z.string(),
});
export type WebhookRow = z.infer<typeof WebhookRow>;

/** A Form document in the active site, with how much it has collected and who hears about it. */
export const FormListRow = z.object({
  formId: z.string(),
  name: z.string(),
  submissions: z.number(),
  lastAt: z.string().nullable(),
  notify: z.object({
    published: z.boolean(),
    /** "no-provider" = the instance has no mail configured. */
    email: z.enum(["on", "off", "no-recipients", "no-provider"]),
    recipients: z.string(),
    webhooks: z.boolean(),
    lastEmail: z.object({ status: z.string(), at: z.string(), error: z.string().nullable(), nextAttemptAt: z.string().nullable() }).nullable(),
  }),
});
export type FormListRow = z.infer<typeof FormListRow>;

/** One form submission — visitor PERSONAL DATA. `fieldSnapshot` is the form's
 *  fields AS ANSWERED, so a row stays readable (and a consent stays evidence)
 *  after the form itself is edited. */
export const SubmissionRow = z.object({
  submissionId: z.string(),
  formId: z.string(),
  locale: z.string(),
  values: z.record(z.string(), z.unknown()),
  fieldSnapshot: z.array(z.object({ name: z.string(), label: z.string(), kind: z.string() })),
  meta: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  /** When the retention sweep deletes this row; null = kept until removed by hand. */
  expiresAt: z.string().nullable(),
});
export type SubmissionRow = z.infer<typeof SubmissionRow>;

export const RoleGrantInSite = z.object({ siteId: z.string(), role: RoleName });

export const ManagedUserRow = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  /** Roles in every site. */
  roles: z.array(RoleName),
  /** Roles in one site each (#130). A site Admin sees only their site's. */
  siteRoles: z.array(RoleGrantInSite),
  sections: z.array(z.string()),
  locked: z.boolean(),
  createdAt: z.string(),
});
export type ManagedUserRow = z.infer<typeof ManagedUserRow>;

/** "What needs my attention" (GET /manage/dashboard). */
export const DashboardOut = z.object({
  wip: z.array(
    z.object({
      documentId: z.string(),
      name: z.string(),
      type: z.string(),
      kind: z.string(),
      locale: z.string(),
      change: z.enum(["new", "updated"]),
      at: z.string(),
    }),
  ),
  wipTotal: z.number(),
  scheduled: z.array(
    z.object({ documentId: z.string(), name: z.string(), locale: z.string(), action: z.enum(["publish", "unpublish"]), at: z.string() }),
  ),
  translation: z.array(
    z.object({
      locale: z.string(),
      displayName: z.string(),
      missing: z.number(),
      pages: z.array(z.object({ documentId: z.string(), name: z.string() })),
    }),
  ),
  housekeeping: z.object({
    trash: z.number(),
    unusedBlocks: z.number(),
    emptyTypes: z.number(),
    missingAlt: z.number(),
    failingWebhooks: z.number().nullable(),
  }),
  imagesMissingAlt: z.array(z.object({ documentId: z.string(), url: z.string(), filename: z.string() })),
  unusedBlocksList: z.array(z.object({ documentId: z.string(), name: z.string(), type: z.string() })),
  emptyTypesList: z.array(z.object({ name: z.string(), displayName: z.string(), kind: z.string() })),
});
export type DashboardOut = z.infer<typeof DashboardOut>;

export const SiteOut = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  defaultLocale: z.string(),
  active: z.boolean(),
  createdAt: z.string(),
  previewBaseUrl: z.string().nullable(),
  startPageId: z.string().nullable(),
  canonicalBaseUrl: z.string().nullable(),
  localePrefix: LocalePrefix,
  seoFiles: SeoFilesConfig,
});
export type SiteOut = z.infer<typeof SiteOut>;

const RedirectProblem = z.object({ code: z.enum(["target-missing", "target-unpublished", "shadowed", "chain", "loop"]), message: z.string() });
export const RedirectTargetOut = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("page"), documentId: z.string(), locale: z.string(), name: z.string().nullable(), url: z.string().nullable() }),
  z.object({ kind: z.literal("path"), path: z.string() }),
  z.object({ kind: z.literal("url"), url: z.string() }),
  z.object({ kind: z.literal("gone") }),
]);
export type RedirectTargetOut = z.infer<typeof RedirectTargetOut>;
export const RedirectOut = z.object({
  id: z.number(),
  source: z.string(),
  sourcePath: z.string(),
  match: z.enum(["exact", "prefix"]),
  target: RedirectTargetOut,
  status: z.union([z.literal(301), z.literal(302), z.literal(307), z.literal(308), z.literal(410)]),
  keepQuery: z.boolean(),
  origin: z.enum(["manual", "auto", "import"]),
  note: z.string().nullable(),
  hits: z.number(),
  lastHitAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  problems: z.array(RedirectProblem),
});
export type RedirectOut = z.infer<typeof RedirectOut>;
