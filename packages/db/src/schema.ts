import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Drizzle schema for Paperboy. Mirrors migrations/0000_init.sql (the SQL is the
 * source of truth for partial indexes + the cv sequence; this file is the typed
 * query surface).
 */

export const contentType = pgTable("content_type", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  displayName: text("display_name").notNull(),
  kind: text("kind").notNull(), // page | block | global
  description: text("description").notNull().default(""),
  icon: text("icon").notNull().default("file"),
  definition: jsonb("definition").notNull(), // full ContentTypeDef
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const locale = pgTable("locale", {
  code: text("code").primaryKey(),
  displayName: text("display_name").notNull(),
  isDefault: boolean("is_default").notNull().default(false),
  enabled: boolean("enabled").notNull().default(true),
  fallbackLocaleCode: text("fallback_locale_code"),
  sortIndex: integer("sort_index").notNull().default(0),
});

export const contentItem = pgTable(
  "content_item",
  {
    id: serial("id").primaryKey(), // internal PK, never exposed externally
    documentId: text("document_id").notNull().unique(), // canonical, invariant
    type: text("type").notNull(),
    kind: text("kind").notNull(), // page | block | global
    parentId: text("parent_id"), // -> content_item.document_id (tree)
    sortIndex: integer("sort_index").notNull().default(0),
    /** Top-level section this item belongs to (for object-level scope/RBAC). */
    sectionId: text("section_id"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    parentIdx: index("content_item_parent_idx").on(t.parentId),
    typeIdx: index("content_item_type_idx").on(t.type),
    sectionIdx: index("content_item_section_idx").on(t.sectionId),
  }),
);

export const contentVersion = pgTable(
  "content_version",
  {
    id: serial("id").primaryKey(),
    documentId: text("document_id").notNull(),
    locale: text("locale").notNull(),
    status: text("status").notNull(), // draft | published
    isCurrentPublished: boolean("is_current_published").notNull().default(false),
    versionNumber: integer("version_number").notNull(),
    name: text("name").notNull(),
    slug: text("slug"),
    displayInNav: boolean("display_in_nav").notNull().default(true),
    data: jsonb("data").notNull(),
    cv: bigint("cv", { mode: "number" }).notNull().default(0),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    comment: text("comment"),
    // Scheduled publish: timed go-live (publish_at, on a draft) + expiry (expire_at).
    publishAt: timestamp("publish_at", { withTimezone: true }),
    expireAt: timestamp("expire_at", { withTimezone: true }),
  },
  (t) => ({
    docLocaleIdx: index("content_version_doc_locale_idx").on(t.documentId, t.locale),
    statusIdx: index("content_version_status_idx").on(t.status),
    slugIdx: index("content_version_slug_idx").on(t.slug),
  }),
);

/** Reverse-lookup / integrity: which content references which (per version). */
export const contentReference = pgTable(
  "content_reference",
  {
    id: serial("id").primaryKey(),
    fromDocumentId: text("from_document_id").notNull(),
    fromLocale: text("from_locale").notNull(),
    toDocumentId: text("to_document_id").notNull(),
    toType: text("to_type").notNull(),
    fieldName: text("field_name").notNull(),
  },
  (t) => ({
    fromIdx: index("content_reference_from_idx").on(t.fromDocumentId, t.fromLocale),
    toIdx: index("content_reference_to_idx").on(t.toDocumentId),
  }),
);

export const asset = pgTable("asset", {
  id: serial("id").primaryKey(),
  documentId: text("document_id").notNull().unique(),
  filename: text("filename").notNull(),
  mime: text("mime").notNull(),
  size: integer("size").notNull(),
  url: text("url").notNull(),
  alt: text("alt").notNull().default(""),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable("users", {
  id: text("id").primaryKey(), // nanoid
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  failedAttempts: integer("failed_attempts").notNull().default(0),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Two-factor (TOTP). Secret is AES-GCM encrypted at rest; backupCodes are sha-256 hashes.
  totpSecret: text("totp_secret"),
  totpEnabled: boolean("totp_enabled").notNull().default(false),
  backupCodes: jsonb("backup_codes"),
});

export const userRole = pgTable(
  "user_role",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    role: text("role").notNull(), // Admin | Editor | Author | Viewer
  },
  (t) => ({
    uq: uniqueIndex("user_role_uq").on(t.userId, t.role),
  }),
);

/** Section scopes for object-level authorization (empty = site-wide). */
export const userScope = pgTable(
  "user_scope",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    sectionId: text("section_id").notNull(), // a top-level content_item.document_id
  },
  (t) => ({
    uq: uniqueIndex("user_scope_uq").on(t.userId, t.sectionId),
  }),
);

export const session = pgTable("session", {
  id: text("id").primaryKey(), // sha-256 hash of the opaque cookie token
  userId: text("user_id").notNull(),
  csrfToken: text("csrf_token").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  idleExpiresAt: timestamp("idle_expires_at", { withTimezone: true }).notNull(),
});

export const deliveryKey = pgTable("delivery_key", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  keyHash: text("key_hash").notNull().unique(), // sha-256 of the key
  keyPrefix: text("key_prefix").notNull(), // pk_live_ / prv_
  type: text("type").notNull(), // public | preview
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const mcpToken = pgTable("mcp_token", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull().unique(), // sha-256 of the token
  tokenPrefix: text("token_prefix").notNull().default("mcp_"),
  userId: text("user_id").notNull(), // -> users.id; the token authenticates AS this user
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const auditLog = pgTable("audit_log", {
  id: serial("id").primaryKey(),
  ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
  actorUserId: text("actor_user_id"),
  action: text("action").notNull(),
  documentId: text("document_id"),
  locale: text("locale"),
  ip: text("ip"),
  detail: jsonb("detail"),
});

/** Outbound webhook subscriptions — HMAC-signed POST on publish/unpublish. */
export const webhook = pgTable("webhook", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  url: text("url").notNull(),
  secret: text("secret").notNull(),
  events: jsonb("events").notNull().default([]),
  active: boolean("active").notNull().default(true),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastStatus: integer("last_status"),
  lastAt: timestamp("last_at", { withTimezone: true }),
});

/** Site-wide key/value settings (e.g. the start page served at "/"). */
export const siteSetting = pgTable("site_setting", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const webhookDelivery = pgTable(
  "webhook_delivery",
  {
    id: serial("id").primaryKey(),
    webhookId: integer("webhook_id").notNull(),
    event: text("event").notNull(),
    status: integer("status"),
    error: text("error"),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    hookIdx: index("webhook_delivery_hook_idx").on(t.webhookId),
  }),
);
