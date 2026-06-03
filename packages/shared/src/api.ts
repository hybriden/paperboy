import { z } from "zod";
import { BlockDisplayOption, ContentKind } from "./content-types.js";

/** Publication status of a content version. */
export const ContentStatus = z.enum(["draft", "published"]);
export type ContentStatus = z.infer<typeof ContentStatus>;

/** Locale config row. */
export const Locale = z.object({
  code: z.string(), // e.g. "en", "nb"
  displayName: z.string(),
  isDefault: z.boolean(),
  enabled: z.boolean(),
  fallbackLocaleCode: z.string().nullable(),
});
export type Locale = z.infer<typeof Locale>;

/** A node in the content tree (management). */
export const TreeNode = z.object({
  documentId: z.string(),
  type: z.string(),
  kind: ContentKind,
  parentId: z.string().nullable(),
  sortIndex: z.number(),
  name: z.string(),
  /** Per-locale status summary for the badges in the tree. */
  locales: z.record(
    z.object({
      status: ContentStatus,
      hasUnpublishedChanges: z.boolean(),
    }),
  ),
  hasChildren: z.boolean(),
});
export type TreeNode = z.infer<typeof TreeNode>;

/** Full content item for the editor (management). */
export const ContentDetail = z.object({
  documentId: z.string(),
  type: z.string(),
  kind: ContentKind,
  parentId: z.string().nullable(),
  sortIndex: z.number(),
  locale: z.string(),
  status: ContentStatus,
  hasUnpublishedChanges: z.boolean(),
  versionNumber: z.number(),
  name: z.string(),
  slug: z.string().nullable(),
  /** Full hierarchical URL built from the ancestor chain of slugs (pages only). */
  urlPath: z.string().nullable(),
  displayInNav: z.boolean(),
  data: z.record(z.unknown()),
  /** Scheduled go-live (on a pending draft) / expiry — ISO strings, null when unset. */
  publishAt: z.string().nullable(),
  expireAt: z.string().nullable(),
  updatedAt: z.string(),
  updatedBy: z.string().nullable(),
});
export type ContentDetail = z.infer<typeof ContentDetail>;

/** A shared block in the asset pane. */
export const BlockSummary = z.object({
  documentId: z.string(),
  type: z.string(),
  name: z.string(),
  locales: z.record(z.object({ status: ContentStatus, hasUnpublishedChanges: z.boolean() })),
});
export type BlockSummary = z.infer<typeof BlockSummary>;

/** A media asset (image) in the asset pane. */
export const Asset = z.object({
  documentId: z.string(),
  filename: z.string(),
  mime: z.string(),
  size: z.number(),
  url: z.string(),
  alt: z.string(),
  createdAt: z.string(),
});
export type Asset = z.infer<typeof Asset>;

/** Create-content request. */
export const CreateContentRequest = z.object({
  type: z.string(),
  parentId: z.string().nullable().default(null),
  locale: z.string(),
  name: z.string().min(1),
});
export type CreateContentRequest = z.infer<typeof CreateContentRequest>;

/** Update (save draft) request. */
export const UpdateContentRequest = z.object({
  name: z.string().min(1).optional(),
  slug: z.string().nullable().optional(),
  displayInNav: z.boolean().optional(),
  data: z.record(z.unknown()),
});
export type UpdateContentRequest = z.infer<typeof UpdateContentRequest>;

/** Delivery API content shape (public). References are shallow unless populated. */
export const DeliveryContent = z.object({
  documentId: z.string(),
  type: z.string(),
  locale: z.string(),
  name: z.string(),
  slug: z.string().nullable(),
  /** cache-version: bumped on publish, used for ETag / cache busting. */
  cv: z.number(),
  data: z.record(z.unknown()),
});
export type DeliveryContent = z.infer<typeof DeliveryContent>;

export { BlockDisplayOption };
