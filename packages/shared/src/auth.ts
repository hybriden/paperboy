import { z } from "zod";

/** The four built-in roles, in descending privilege. */
export const RoleName = z.enum(["Admin", "Editor", "Author", "Viewer"]);
export type RoleName = z.infer<typeof RoleName>;

/**
 * Permissions are verbs the system checks (deny-by-default). The effective
 * decision is: (role grants verb) AND (scope matches). Scope checks live in the
 * data layer.
 */
export const Permission = z.enum([
  "content.read",
  "content.create",
  "content.update",
  "content.delete",
  "content.publish",
  "contenttype.manage",
  "user.manage",
  "deliverykey.manage",
  "webhook.manage",
  "audit.read",
  // Form submissions are visitor PERSONAL DATA, not content — reading and
  // erasing them is a separate decision from editing pages, so they get their
  // own verbs rather than riding on content.read/content.delete.
  "submission.read",
  "submission.manage",
  // Site → General (preview URL, canonical URL, public files): Admin only.
  "site.manage",
  // Add users to the ACTIVE site and set their roles there — what a one-site
  // Admin gets in place of user.manage (#130).
  "siteuser.manage",
]);
export type Permission = z.infer<typeof Permission>;

/** Default role → permission grants. */
export const ROLE_PERMISSIONS: Record<RoleName, Permission[]> = {
  Admin: [
    "content.read",
    "content.create",
    "content.update",
    "content.delete",
    "content.publish",
    "contenttype.manage",
    "user.manage",
    "deliverykey.manage",
    "webhook.manage",
    "audit.read",
    "submission.read",
    "submission.manage",
    "site.manage",
    "siteuser.manage",
  ],
  Editor: [
    "content.read",
    "content.create",
    "content.update",
    "content.delete",
    "content.publish",
    // An Editor answers the enquiries, so they can read and clear them.
    "submission.read",
    "submission.manage",
  ],
  // Author and Viewer deliberately get NEITHER: a section-scoped writer has no
  // reason to read every visitor's message, and a Viewer reviews content, not PII.
  Author: ["content.read", "content.create", "content.update"],
  Viewer: ["content.read"],
};

/**
 * Verbs over what EVERY site shares: users and their every-site roles, sites,
 * the content model, the AI/stock keys, MCP tokens. A role held in one site
 * (`user_role.site_id`) never grants these, or a one-site Admin could change
 * every other site. audit.read is NOT here: a one-site Admin reads their own
 * site's log (listAudit narrows it).
 */
export const INSTANCE_PERMISSIONS: Permission[] = ["user.manage", "contenttype.manage"];

/** One role grant: `siteId` null = every site. */
export const RoleGrant = z.object({ role: RoleName, siteId: z.string().nullable() });
export type RoleGrant = z.infer<typeof RoleGrant>;

export const LoginRequest = z.object({
  email: z.string().email(),
  // Optional: a 2FA-enabled account logs in passwordless (email → TOTP). Accounts
  // without 2FA must supply a password (the server replies { passwordRequired }).
  password: z.string().min(1).max(200).optional(),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const SessionUser = z.object({
  id: z.string(),
  email: z.string().email(),
  name: z.string(),
  roles: z.array(RoleName),
  permissions: z.array(Permission),
  mfaEnabled: z.boolean().default(false),
});
export type SessionUser = z.infer<typeof SessionUser>;
