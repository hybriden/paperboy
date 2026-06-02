import { createHash } from "node:crypto";
import { ContentTypeDef } from "@paperboy/shared";
import { nanoid } from "nanoid";
import { createDb } from "./client.js";
import { migrate } from "./migrate.js";
import { createUser } from "./auth-store.js";
import {
  contentItem,
  contentType,
  contentVersion,
  deliveryKey,
  locale,
  siteSetting,
} from "./schema.js";
import { sql } from "drizzle-orm";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// Authored loosely; parsed through the schema so field defaults (options,
// multiple, validation, etc.) are populated to the full ContentTypeDef shape.
const TYPES: ContentTypeDef[] = ([
  {
    name: "StandardPage",
    displayName: "Standard Page",
    kind: "page",
    description: "A general content page with a hero, intro and a content area.",
    icon: "file-text",
    fields: [
      { name: "heading", displayName: "Heading", type: "text", localized: true, required: true, delivery: "public", allowedBlocks: [], allowedTypes: [], group: "Content" },
      { name: "intro", displayName: "Intro", type: "richtext", localized: true, required: false, delivery: "public", allowedBlocks: [], allowedTypes: [], group: "Content" },
      { name: "mainArea", displayName: "Main content area", type: "contentArea", localized: true, required: false, delivery: "public", allowedBlocks: ["HeroBlock", "CardBlock"], allowedTypes: [], group: "Content" },
      { name: "seoNotes", displayName: "Internal SEO notes", type: "text", localized: true, required: false, delivery: "private", allowedBlocks: [], allowedTypes: [], group: "Settings", helpText: "Never exposed by the public delivery API." },
      // --- SEO pane: search + social metadata (best-practice tags) ---
      { name: "metaTitle", displayName: "Meta title", type: "text", localized: true, delivery: "public", group: "SEO", validation: { maxLength: 70 }, helpText: "The <title> tag. Aim for ≤ 60 characters." },
      { name: "metaDescription", displayName: "Meta description", type: "text", localized: true, delivery: "public", group: "SEO", validation: { maxLength: 200 }, helpText: "Search-result snippet. Aim for ≤ 160 characters." },
      { name: "canonicalUrl", displayName: "Canonical URL", type: "text", localized: false, delivery: "public", group: "SEO", helpText: "Absolute URL of the canonical version (optional)." },
      { name: "noIndex", displayName: "Hide from search engines (noindex)", type: "boolean", localized: false, delivery: "public", group: "SEO" },
      { name: "ogTitle", displayName: "Social title (Open Graph)", type: "text", localized: true, delivery: "public", group: "SEO", helpText: "Falls back to the meta title." },
      { name: "ogDescription", displayName: "Social description (Open Graph)", type: "text", localized: true, delivery: "public", group: "SEO", helpText: "Falls back to the meta description." },
      { name: "ogImage", displayName: "Social share image", type: "image", localized: false, delivery: "public", group: "SEO", helpText: "Shown when shared. 1200×630 recommended." },
      { name: "ogType", displayName: "Open Graph type", type: "select", localized: false, delivery: "public", group: "SEO", options: [{ value: "website", label: "Website" }, { value: "article", label: "Article" }] },
      { name: "twitterCard", displayName: "Twitter card", type: "select", localized: false, delivery: "public", group: "SEO", options: [{ value: "summary", label: "Summary" }, { value: "summary_large_image", label: "Summary, large image" }] },
    ],
  },
  {
    name: "HeroBlock",
    displayName: "Hero",
    kind: "block",
    description: "A large hero banner.",
    icon: "image",
    fields: [
      { name: "title", displayName: "Title", type: "text", localized: true, required: true, delivery: "public", allowedBlocks: [], allowedTypes: [], group: "Content" },
      { name: "subtitle", displayName: "Subtitle", type: "text", localized: true, required: false, delivery: "public", allowedBlocks: [], allowedTypes: [], group: "Content" },
      { name: "ctaUrl", displayName: "CTA URL", type: "text", localized: false, required: false, delivery: "public", allowedBlocks: [], allowedTypes: [], group: "Content" },
      { name: "heroImage", displayName: "Background image", type: "image", localized: false, required: false, delivery: "public", allowedBlocks: [], allowedTypes: [], group: "Content" },
    ],
  },
  {
    name: "CardBlock",
    displayName: "Card",
    kind: "block",
    description: "A reusable card with a title and body.",
    icon: "square",
    fields: [
      { name: "title", displayName: "Title", type: "text", localized: true, required: true, delivery: "public", allowedBlocks: [], allowedTypes: [], group: "Content" },
      { name: "body", displayName: "Body", type: "richtext", localized: true, required: false, delivery: "public", allowedBlocks: [], allowedTypes: [], group: "Content" },
    ],
  },
  {
    name: "SiteSettings",
    displayName: "Site Settings",
    kind: "global",
    description: "Global site configuration.",
    icon: "settings",
    fields: [
      { name: "siteName", displayName: "Site name", type: "text", localized: false, required: true, delivery: "public", allowedBlocks: [], allowedTypes: [], group: "Content" },
      { name: "internalNote", displayName: "Internal note", type: "text", localized: false, required: false, delivery: "private", allowedBlocks: [], allowedTypes: [], group: "Settings" },
    ],
  },
] as const).map((t) => ContentTypeDef.parse(t));

const para = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

export interface SeedResult {
  homeId: string;
  authorZoneId: string;
  secretId: string;
  cardId: string;
}

export async function seed(connectionString?: string): Promise<SeedResult> {
  const url = connectionString ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  await migrate(url);
  const { db, sql: pg } = createDb(url);

  // Clean slate (MVP seed).
  await db.execute(
    sql`TRUNCATE content_item, content_version, content_reference, content_type, locale, users, user_role, user_scope, session, delivery_key, audit_log, asset, site_setting RESTART IDENTITY CASCADE`,
  );

  // Locales: English (default), Norwegian (falls back to English).
  await db.insert(locale).values([
    { code: "en", displayName: "English", isDefault: true, enabled: true, fallbackLocaleCode: null, sortIndex: 0 },
    { code: "nb", displayName: "Norsk bokmål", isDefault: false, enabled: true, fallbackLocaleCode: "en", sortIndex: 1 },
  ]);

  // Content types.
  for (const t of TYPES) {
    await db.insert(contentType).values({
      name: t.name,
      displayName: t.displayName,
      kind: t.kind,
      description: t.description,
      icon: t.icon,
      definition: t,
    });
  }

  const nextCv = async () => {
    const r = await db.execute(sql`SELECT nextval('cv_seq') AS v`);
    return Number((r as unknown as Array<{ v: string }>)[0]?.v ?? 0);
  };

  // --- Shared CardBlock (published) -------------------------------------
  const cardId = nanoid(24);
  await db.insert(contentItem).values({ documentId: cardId, type: "CardBlock", kind: "block", parentId: null, sortIndex: 0, sectionId: cardId });
  await db.insert(contentVersion).values({
    documentId: cardId, locale: "en", status: "published", isCurrentPublished: true, versionNumber: 1,
    name: "Featured Card", slug: null, displayInNav: false,
    data: { title: "Built for developers", body: para("Fetch content over a typed REST API.") }, cv: await nextCv(),
  });

  // --- Home page (StandardPage) — EN + NB published ---------------------
  const homeId = nanoid(24);
  await db.insert(contentItem).values({ documentId: homeId, type: "StandardPage", kind: "page", parentId: null, sortIndex: 0, sectionId: homeId });
  const homeArea = [
    { key: "h1", blockType: "HeroBlock", display: "full", ref: null, inline: { title: "Deliver content anywhere", subtitle: "Headless. Multi-language. Preview-ready.", ctaUrl: "/docs" } },
    { key: "h2", blockType: "CardBlock", display: "narrow", ref: cardId, inline: null },
  ];
  await db.insert(contentVersion).values({
    documentId: homeId, locale: "en", status: "published", isCurrentPublished: true, versionNumber: 1,
    name: "Home", slug: "home", displayInNav: true,
    data: { heading: "Welcome to Paperboy", intro: para("A headless CMS with a fast, visual editor."), mainArea: homeArea, seoNotes: "INTERNAL: target keyword 'headless cms'. Do not expose." },
    cv: await nextCv(),
  });
  await db.insert(contentVersion).values({
    documentId: homeId, locale: "nb", status: "published", isCurrentPublished: true, versionNumber: 2,
    name: "Hjem", slug: "hjem", displayInNav: true,
    data: { heading: "Velkommen til Paperboy", intro: para("Et hodeløst CMS med en rask, visuell editor."), mainArea: homeArea, seoNotes: "INTERN: ikke eksponer." },
    cv: await nextCv(),
  });

  // --- Author Zone (a section the Author role is scoped to) -------------
  const authorZoneId = nanoid(24);
  await db.insert(contentItem).values({ documentId: authorZoneId, type: "StandardPage", kind: "page", parentId: null, sortIndex: 1, sectionId: authorZoneId });
  await db.insert(contentVersion).values({
    documentId: authorZoneId, locale: "en", status: "published", isCurrentPublished: true, versionNumber: 1,
    name: "Author Zone", slug: "author-zone", displayInNav: true,
    data: { heading: "Author Zone", intro: para("Authors are scoped to this section."), mainArea: [], seoNotes: "" }, cv: await nextCv(),
  });

  // --- Secret Draft (draft only — proves no-leak) -----------------------
  const secretId = nanoid(24);
  await db.insert(contentItem).values({ documentId: secretId, type: "StandardPage", kind: "page", parentId: null, sortIndex: 2, sectionId: secretId });
  await db.insert(contentVersion).values({
    documentId: secretId, locale: "en", status: "draft", isCurrentPublished: false, versionNumber: 1,
    name: "Top Secret (draft)", slug: "secret", displayInNav: false,
    data: { heading: "Unpublished — should never appear publicly", intro: para("draft"), mainArea: [], seoNotes: "" }, cv: 0,
  });

  // --- SiteSettings global (a kind=global singleton, delivered via /globals) --
  const settingsId = nanoid(24);
  await db.insert(contentItem).values({ documentId: settingsId, type: "SiteSettings", kind: "global", parentId: null, sortIndex: 0, sectionId: settingsId });
  await db.insert(contentVersion).values({
    documentId: settingsId, locale: "en", status: "published", isCurrentPublished: true, versionNumber: 1,
    name: "Site Settings", slug: null, displayInNav: false,
    data: { siteName: "Paperboy", internalNote: "INTERNAL: ops contact — not exposed publicly." }, cv: await nextCv(),
  });

  // --- Users (all four roles) -------------------------------------------
  const adminEmail = process.env.SEED_ADMIN_EMAIL ?? "admin@paperboy.test";
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? "Admin!Passw0rd";
  await createUser(db, { email: adminEmail, name: "Site Admin", password: adminPassword, roles: ["Admin"] });
  await createUser(db, { email: "editor@paperboy.test", name: "Ed Editor", password: "Editor!Passw0rd", roles: ["Editor"] });
  await createUser(db, { email: "author@paperboy.test", name: "Andy Author", password: "Author!Passw0rd", roles: ["Author"], sections: [authorZoneId] });
  await createUser(db, { email: "viewer@paperboy.test", name: "Val Viewer", password: "Viewer!Passw0rd", roles: ["Viewer"] });

  // --- Delivery keys (deterministic from env so the web app can use them) -
  const publicKey = process.env.PAPERBOY_PUBLIC_KEY ?? "pk_live_seed_public_key_value";
  const previewKey = process.env.PAPERBOY_PREVIEW_KEY ?? "prv_seed_preview_key_value";
  await db.insert(deliveryKey).values([
    { name: "Default public key", keyHash: sha256(publicKey), keyPrefix: "pk_live_", type: "public" },
    { name: "Default preview key", keyHash: sha256(previewKey), keyPrefix: "prv_", type: "preview" },
  ]);

  // Default start page (served at "/") = Home.
  await db.insert(siteSetting).values({ key: "startPage", value: { documentId: homeId } });

  console.log("Seed complete:");
  console.log(`  Home (EN+NB)   documentId=${homeId}`);
  console.log(`  Author Zone    documentId=${authorZoneId}`);
  console.log(`  Secret draft   documentId=${secretId}`);
  console.log(`  Shared card    documentId=${cardId}`);
  console.log(`  Admin login    ${adminEmail} / ${adminPassword}`);
  await pg.end();
  return { homeId, authorZoneId, secretId, cardId };
}

// Run directly: `tsx src/seed.ts`
if (import.meta.url === `file://${process.argv[1]}`) {
  seed()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Seed failed:", err);
      process.exit(1);
    });
}
