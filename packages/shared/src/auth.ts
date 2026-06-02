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
  ],
  Editor: [
    "content.read",
    "content.create",
    "content.update",
    "content.delete",
    "content.publish",
  ],
  Author: ["content.read", "content.create", "content.update"],
  Viewer: ["content.read"],
};

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
