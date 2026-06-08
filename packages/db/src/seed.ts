import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { ContentTypeDef } from "@paperboy/shared";
import { nanoid } from "nanoid";
import { createDb } from "./client.js";
import { migrate } from "./migrate.js";
import { createUser } from "./auth-store.js";
import {
  DEFAULT_SITE_ID,
  contentItem,
  contentType,
  contentVersion,
  deliveryKey,
  locale,
  site,
} from "./schema.js";
import { eq, sql } from "drizzle-orm";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// --- SEO pane: search + social metadata, shared by every page type ---------

// The out-of-the-box page model: LandingPage (block canvas), ArticlePage
// (long-form content), ListPage (children index) and BlogPost (dated item).
// Authored loosely; parsed through the schema so field defaults (options,
// multiple, validation, etc.) are populated to the full ContentTypeDef shape.
const TYPES: ContentTypeDef[] = ([
  {
    name: "LandingPage",
    displayName: "Landing Page",
    kind: "page",
    description: "A block-composed canvas: hero, cards and other blocks. Start pages, campaigns.",
    icon: "layout-template",
    schemaType: "WebPage",
    fields: [
      { name: "heading", displayName: "Heading", type: "text", localized: true, required: true, delivery: "public", allowedBlocks: [], allowedTypes: [], group: "Content", seoRole: "title" },
      { name: "intro", displayName: "Intro", type: "richtext", localized: true, required: false, delivery: "public", allowedBlocks: [], allowedTypes: [], group: "Content" },
      { name: "mainArea", displayName: "Main content area", type: "contentArea", localized: true, required: false, delivery: "public", allowedBlocks: ["HeroBlock", "CardBlock", "ListBlock"], allowedTypes: [], group: "Content" },
    ],
  },
  {
    name: "ArticlePage",
    displayName: "Article Page",
    kind: "page",
    description: "A general article: heading, intro, body and an optional content area.",
    icon: "file-text",
    schemaType: "Article",
    fields: [
      { name: "heading", displayName: "Heading", type: "text", localized: true, required: true, delivery: "public", allowedBlocks: [], allowedTypes: [], group: "Content", seoRole: "title" },
      { name: "intro", displayName: "Intro", type: "richtext", localized: true, required: false, delivery: "public", allowedBlocks: [], allowedTypes: [], group: "Content" },
      { name: "mainArea", displayName: "Main content area", type: "contentArea", localized: true, required: false, delivery: "public", allowedBlocks: ["HeroBlock", "CardBlock", "ListBlock"], allowedTypes: [], group: "Content" },
      { name: "seoNotes", displayName: "Internal SEO notes", type: "text", localized: true, required: false, delivery: "private", allowedBlocks: [], allowedTypes: [], group: "Settings", helpText: "Never exposed by the public delivery API." },
    ],
  },
  {
    name: "ListPage",
    displayName: "List Page",
    kind: "page",
    description: "Lists its child pages of a chosen type — a blog index, news archive, etc.",
    icon: "layout-list",
    schemaType: "CollectionPage",
    fields: [
      { name: "heading", displayName: "Heading", type: "text", localized: true, required: true, delivery: "public", allowedBlocks: [], allowedTypes: [], group: "Content", seoRole: "title" },
      { name: "intro", displayName: "Intro", type: "richtext", localized: true, required: false, delivery: "public", allowedBlocks: [], allowedTypes: [], group: "Content" },
      { name: "listedType", displayName: "Listed content type", type: "select", localized: false, required: true, delivery: "public", group: "Content", optionsFromContentTypes: true, options: [{ value: "BlogPost", label: "Blog Post" }, { value: "ArticlePage", label: "Article Page" }], helpText: "Children of this page with this type are listed (newest first). Must be an installed content type." },
      { name: "pageSize", displayName: "Max items", type: "number", localized: false, required: false, delivery: "public", group: "Content", helpText: "Maximum number of items to show (default 20)." },
    ],
  },
  {
    name: "BlogPost",
    displayName: "Blog Post",
    kind: "page",
    description: "A dated blog/news item, listed by its parent List Page.",
    icon: "newspaper",
    schemaType: "BlogPosting",
    fields: [
      { name: "title", displayName: "Title", type: "text", localized: true, required: true, delivery: "public", allowedBlocks: [], allowedTypes: [], group: "Content", seoRole: "title" },
      { name: "publishDate", displayName: "Publish date", type: "datetime", localized: false, required: false, delivery: "public", allowedBlocks: [], allowedTypes: [], group: "Content", seoRole: "datePublished" },
      { name: "summary", displayName: "Summary", type: "text", localized: true, required: false, delivery: "public", allowedBlocks: [], allowedTypes: [], group: "Content", validation: { maxLength: 400 }, helpText: "Shown in list pages and as the lead paragraph.", seoRole: "description" },
      { name: "author", displayName: "Author", type: "text", localized: false, required: false, delivery: "public", allowedBlocks: [], allowedTypes: [], group: "Content", seoRole: "author" },
      { name: "body", displayName: "Body", type: "markdown", localized: true, required: false, delivery: "public", allowedBlocks: [], allowedTypes: [], group: "Content" },
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
    name: "ListBlock",
    displayName: "List",
    kind: "block",
    description: "A teaser list: shows the newest children of a chosen page (e.g. latest blog posts).",
    icon: "layout-list",
    fields: [
      { name: "heading", displayName: "Heading", type: "text", localized: true, required: true, delivery: "public", allowedBlocks: [], allowedTypes: [], group: "Content" },
      { name: "source", displayName: "List children of", type: "reference", localized: false, required: true, delivery: "public", allowedBlocks: [], allowedTypes: [], group: "Content", helpText: "The page whose children are listed (newest first)." },
      { name: "count", displayName: "Max items", type: "number", localized: false, required: false, delivery: "public", allowedBlocks: [], allowedTypes: [], group: "Content", helpText: "Maximum teasers to show (default 3)." },
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
  blogId: string;
  postIds: string[];
}

export async function seed(connectionString?: string): Promise<SeedResult> {
  const url = connectionString ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  await migrate(url);
  const { db, sql: pg } = createDb(url);

  // Clean slate (MVP seed). Webhooks included: stale subscriptions surviving a
  // reseed would fire at long-dead URLs (and pile up across test runs).
  await db.execute(
    sql`TRUNCATE site, content_item, content_version, content_reference, content_type, locale, users, user_role, user_scope, session, delivery_key, audit_log, asset, site_setting, webhook, webhook_delivery RESTART IDENTITY CASCADE`,
  );

  // Locales: English (default), Norwegian (falls back to English).
  await db.insert(locale).values([
    { code: "en", displayName: "English", isDefault: true, enabled: true, fallbackLocaleCode: null, sortIndex: 0 },
    { code: "nb", displayName: "Norsk bokmål", isDefault: false, enabled: true, fallbackLocaleCode: "en", sortIndex: 1 },
  ]);

  // The Default site (multisite). All seeded content/keys/assets/scopes belong
  // to it via the column DEFAULT; the FK needs this row to exist first.
  await db.insert(site).values({ id: DEFAULT_SITE_ID, slug: "default", name: "Default site", defaultLocale: "en", active: true });

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

  // --- Home page (LandingPage) — EN + NB published -----------------------
  const homeId = nanoid(24);
  const blogId = nanoid(24); // the Blog ListPage (created below) — Home's teaser block points at it
  await db.insert(contentItem).values({ documentId: homeId, type: "LandingPage", kind: "page", parentId: null, sortIndex: 0, sectionId: homeId });
  const homeArea = [
    { key: "h1", blockType: "HeroBlock", display: "full", ref: null, inline: { title: "Deliver content anywhere", subtitle: "Headless. Multi-language. Preview-ready.", ctaUrl: "/docs" } },
    { key: "h2", blockType: "CardBlock", display: "narrow", ref: cardId, inline: null },
    // Teaser list: the newest children of the Blog page, right on the frontpage.
    { key: "h3", blockType: "ListBlock", display: "narrow", ref: null, inline: { heading: "Latest from the blog", source: { documentId: blogId, type: "ListPage" }, count: 2 } },
  ];
  await db.insert(contentVersion).values({
    documentId: homeId, locale: "en", status: "published", isCurrentPublished: true, versionNumber: 1,
    name: "Home", slug: "home", displayInNav: true,
    data: { heading: "Welcome to Paperboy", intro: para("A headless CMS with a fast, visual editor."), mainArea: homeArea },
    cv: await nextCv(),
  });
  await db.insert(contentVersion).values({
    documentId: homeId, locale: "nb", status: "published", isCurrentPublished: true, versionNumber: 2,
    name: "Hjem", slug: "hjem", displayInNav: true,
    data: { heading: "Velkommen til Paperboy", intro: para("Et hodeløst CMS med en rask, visuell editor."), mainArea: homeArea },
    cv: await nextCv(),
  });

  // --- Blog (ListPage) + two sample posts under it ------------------------
  await db.insert(contentItem).values({ documentId: blogId, type: "ListPage", kind: "page", parentId: null, sortIndex: 1, sectionId: blogId });
  await db.insert(contentVersion).values({
    documentId: blogId, locale: "en", status: "published", isCurrentPublished: true, versionNumber: 1,
    name: "Blog", slug: "blog", displayInNav: true,
    data: { heading: "Blog", intro: para("Notes from the Paperboy newsroom."), listedType: "BlogPost", pageSize: 20 },
    cv: await nextCv(),
  });
  const POSTS: Array<{ title: string; slug: string; date: string; summary: string; body: string }> = [
    {
      title: "Hello, Paperboy",
      slug: "hello-paperboy",
      date: "2026-01-15T09:00:00.000Z",
      summary: "Why we built another headless CMS — and what makes this one different.",
      body: "## Why another CMS?\n\nBecause **content modelling should be data**, not code. Paperboy stores types in the database and serves them over a typed delivery API.\n\n- Pages, blocks and globals\n- Draft → preview → publish\n- Multi-language with fallbacks",
    },
    {
      title: "Modelling listings with ListPage",
      slug: "modelling-listings",
      date: "2026-02-02T09:00:00.000Z",
      summary: "A ListPage lists its child pages of a chosen type — no hardcoded URLs in the frontend.",
      body: "## Listing is a semantic\n\nA blog index is not a *standard page that happens to list things* — it is a **ListPage** with `listedType: BlogPost`. The frontend keys off the type, never the URL.",
    },
  ];
  const postIds: string[] = [];
  for (const [i, p] of POSTS.entries()) {
    const postId = nanoid(24);
    postIds.push(postId);
    await db.insert(contentItem).values({ documentId: postId, type: "BlogPost", kind: "page", parentId: blogId, sortIndex: i, sectionId: blogId });
    await db.insert(contentVersion).values({
      documentId: postId, locale: "en", status: "published", isCurrentPublished: true, versionNumber: 1,
      name: p.title, slug: p.slug, displayInNav: false,
      data: { title: p.title, publishDate: p.date, summary: p.summary, author: "Paperboy Team", body: p.body },
      cv: await nextCv(),
    });
  }

  // --- Author Zone (a section the Author role is scoped to) -------------
  const authorZoneId = nanoid(24);
  await db.insert(contentItem).values({ documentId: authorZoneId, type: "ArticlePage", kind: "page", parentId: null, sortIndex: 2, sectionId: authorZoneId });
  await db.insert(contentVersion).values({
    documentId: authorZoneId, locale: "en", status: "published", isCurrentPublished: true, versionNumber: 1,
    name: "Author Zone", slug: "author-zone", displayInNav: true,
    data: { heading: "Author Zone", intro: para("Authors are scoped to this section."), mainArea: [], seoNotes: "" }, cv: await nextCv(),
  });

  // --- Secret Draft (draft only — proves no-leak) -----------------------
  const secretId = nanoid(24);
  await db.insert(contentItem).values({ documentId: secretId, type: "ArticlePage", kind: "page", parentId: null, sortIndex: 3, sectionId: secretId });
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

  // Default start page (served at "/") = Home. Per-site, on the site entity.
  await db.update(site).set({ startPageId: homeId }).where(eq(site.id, DEFAULT_SITE_ID));

  console.log("Seed complete:");
  console.log(`  Home (EN+NB)   documentId=${homeId}`);
  console.log(`  Blog (ListPage) documentId=${blogId} (${postIds.length} posts)`);
  console.log(`  Author Zone    documentId=${authorZoneId}`);
  console.log(`  Secret draft   documentId=${secretId}`);
  console.log(`  Shared card    documentId=${cardId}`);
  console.log(`  Admin login    ${adminEmail} / ${adminPassword}`);
  await pg.end();
  return { homeId, authorZoneId, secretId, cardId, blogId, postIds };
}

// Run directly: `tsx src/seed.ts` (the compose `init` service).
// GUARDED: a populated database is never wiped unless FORCE_SEED=1 — a plain
// `docker compose up` pulling in the init service has destroyed real data
// before. The skip still applies migrations, so a normal compose up keeps the
// schema current. Tests import seed() directly and stay unguarded.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  (async () => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    if (process.env.FORCE_SEED !== "1") {
      const { sql: pg } = createDb(url);
      let items = 0;
      try {
        const rows = await pg`SELECT count(*)::int AS n FROM content_item`;
        items = (rows[0]?.n as number) ?? 0;
      } catch {
        items = 0; // table doesn't exist yet → fresh database → safe to seed
      }
      await pg.end();
      if (items > 0) {
        console.log(`Seed SKIPPED: this database already holds ${items} content items.`);
        console.log("A reseed TRUNCATES everything and regenerates IDs. If that is really");
        console.log("what you want: FORCE_SEED=1 docker compose run --rm init");
        await migrate(url); // keep forward-only migrations flowing
        process.exit(0);
      }
    }
    await seed();
    process.exit(0);
  })().catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  });
}
