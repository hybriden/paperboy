import { z } from "zod";
import { BlockDisplayOption, ContentKind } from "./content-types.js";
import { AssetSourceMeta } from "./stock.js";

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
  /** Which surface wrote the working version: "mcp"/"agent" = agents, "web" = human, null = pre-feature. */
  updatedVia: z.enum(["mcp", "agent", "web"]).nullable(),
  /** Agent-written drafts carry this until a human edits or approves (see docs/POSITIONING.md). */
  needsReview: z.boolean(),
});
export type ContentDetail = z.infer<typeof ContentDetail>;

/** A shared block in the asset pane. */
export const BlockSummary = z.object({
  documentId: z.string(),
  type: z.string(),
  name: z.string(),
  locales: z.record(z.object({ status: ContentStatus, hasUnpublishedChanges: z.boolean() })),
  // Asset-pane folder (null = root/unfiled).
  folderId: z.string().nullable(),
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
  // Stock-image imports carry provider attribution; null for normal uploads.
  sourceMeta: AssetSourceMeta.nullable(),
  createdAt: z.string(),
  // Asset-pane folder (null = root/unfiled).
  folderId: z.string().nullable(),
});
export type Asset = z.infer<typeof Asset>;

/** Which asset-pane library a folder organizes (two separate trees). */
export const FolderKind = z.enum(["media", "block"]);
export type FolderKind = z.infer<typeof FolderKind>;

/** A nested asset-pane folder (Media or Shared-blocks library). */
export const Folder = z.object({
  documentId: z.string(),
  kind: FolderKind,
  parentId: z.string().nullable(), // null = root
  name: z.string(),
  createdAt: z.string(),
});
export type Folder = z.infer<typeof Folder>;

export const CreateFolderRequest = z.object({
  kind: FolderKind,
  parentId: z.string().nullable().optional(),
  name: z.string().min(1).max(120),
});
export type CreateFolderRequest = z.infer<typeof CreateFolderRequest>;

/** Rename and/or move a folder. Omitted fields are left unchanged; `parentId: null` moves to root. */
export const UpdateFolderRequest = z.object({
  name: z.string().min(1).max(120).optional(),
  parentId: z.string().nullable().optional(),
});
export type UpdateFolderRequest = z.infer<typeof UpdateFolderRequest>;

/** Move an item (asset or block) into a folder. `folderId: null` = root/unfiled. */
export const SetFolderRequest = z.object({ folderId: z.string().nullable() });
export type SetFolderRequest = z.infer<typeof SetFolderRequest>;

/** Create-content request. */
export const CreateContentRequest = z.object({
  // Optional: under a ListPage parent, an omitted type inherits the parent's
  // listedType (the type that page actually lists).
  type: z.string().optional(),
  parentId: z.string().nullable().default(null),
  locale: z.string(),
  name: z.string().min(1),
  // Escape hatch for a deliberate off-type sub-page under a list page.
  allowTypeMismatch: z.boolean().optional(),
});
export type CreateContentRequest = z.infer<typeof CreateContentRequest>;

/** Update (save draft) request. */
export const UpdateContentRequest = z.object({
  name: z.string().min(1).optional(),
  slug: z.string().nullable().optional(),
  displayInNav: z.boolean().optional(),
  data: z.record(z.unknown()),
  /** When true, `data` is shallow-merged over the current working draft instead
   *  of replacing it — so a caller can patch one field without resending all. */
  merge: z.boolean().optional(),
  /** Escape hatch for the agent write-time language guard: when true, an agent
   *  may write text whose language differs from the locale branch (the guard
   *  otherwise refuses, so Norwegian content can't silently land on the 'en'
   *  branch). A human editor is never guarded. Mirrors publish's option. */
  allowLanguageMismatch: z.boolean().optional(),
});
export type UpdateContentRequest = z.infer<typeof UpdateContentRequest>;

/**
 * Normalized SEO + schema.org contract, computed server-side and delivered on
 * every PAGE item (null for blocks/globals). One source of truth across page
 * types AND frontends: a consumer renders the meta tags + `jsonLd` directly.
 * Origin-dependent URLs are RELATIVE (`canonicalPath`, breadcrumb `urlPath`) —
 * the frontend absolutizes them against its own public origin and adds the
 * site-identity nodes (WebSite/Organization/publisher) + the @id/url on jsonLd.
 */
export const DeliverySeo = z.object({
  /** metaTitle → field(role:title) → name. */
  title: z.string(),
  /** metaDescription → field(role:description) → null. */
  description: z.string().nullable(),
  /** canonicalUrl field (absolute, passed through) → urlPath (relative). */
  canonicalPath: z.string().nullable(),
  /** "index, follow" / "noindex, follow"; always "noindex, nofollow" in preview. */
  robots: z.string(),
  og: z.object({
    title: z.string(),
    description: z.string().nullable(),
    type: z.string(),
    image: z.object({ url: z.string(), alt: z.string() }).nullable(),
    siteName: z.string().nullable(),
  }),
  twitter: z.object({ card: z.string() }),
  /** schema.org page-entity node; @id/url/publisher are added by the frontend. */
  jsonLd: z.record(z.unknown()),
  /** Ancestor trail incl. self, root→leaf; urlPath null when not yet addressable. */
  breadcrumb: z.array(z.object({ name: z.string(), urlPath: z.string().nullable() })),
});
export type DeliverySeo = z.infer<typeof DeliverySeo>;

/** Delivery API content shape (public). References are shallow unless populated. */
export const DeliveryContent = z.object({
  documentId: z.string(),
  type: z.string(),
  /** page | block | global — lets a frontend render pages in content areas as
   *  teasers (linking to urlPath) and blocks by their blockType. */
  kind: z.enum(["page", "block", "global"]),
  locale: z.string(),
  name: z.string(),
  slug: z.string().nullable(),
  /** Hierarchical URL path (pages only, e.g. "/blog/hello") — null for blocks
   *  or when an ancestor isn't visible in the current perspective (no-leak). */
  urlPath: z.string().nullable(),
  /** cache-version: bumped on publish, used for ETag / cache busting. */
  cv: z.number(),
  data: z.record(z.unknown()),
  /** Normalized SEO/schema.org contract — present on pages, null otherwise. */
  seo: DeliverySeo.nullable(),
});
export type DeliveryContent = z.infer<typeof DeliveryContent>;

export { BlockDisplayOption };
