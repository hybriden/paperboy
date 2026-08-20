import { z } from "zod";
import { ContentTypeDef } from "./content-types.js";

/**
 * The BUILT-IN type-template library, and the export/import envelope for
 * moving templates between instances.
 *
 * The library models the essential page and block types of a classic
 * editorial site the way mature CMS solutions structure them for flexibility,
 * adapted to Paperboy's field model:
 *
 *  - A meta/robots tab is NOT modelled per type — Paperboy's reserved SEO
 *    group covers it on every page, and the seoRole tags below reproduce the
 *    conventional fallback chains (heading → title, intro → description,
 *    main image → og image).
 *  - The teaser/promote pattern (what a page shows when listed elsewhere) is
 *    a "Teaser" field group on the page types that get listed, each field
 *    falling back to the page's own content.
 *  - Alt text lives on the media asset in Paperboy, so image fields are plain
 *    asset references with a caption field where editorially meaningful.
 *  - Repeatable structures (FAQ topics/questions, link collections) are
 *    content areas of small inline blocks — Paperboy's idiom for nested,
 *    repeatable objects.
 *
 * Built-ins are code-shipped and READ-ONLY: they ship with every instance and
 * improve with upgrades. Users duplicate one under a new name to customise the
 * recipe itself, or instantiate it (optionally tweaked in the editor first).
 */

/* ------------------------------ export format ----------------------------- */

export const TYPE_TEMPLATE_EXPORT_FORMAT = "paperboy-type-templates" as const;
export const TYPE_TEMPLATE_EXPORT_VERSION = 1 as const;

/** The document `GET /manage/type-templates/export` produces and the import
 *  endpoint accepts — versioned so a future shape change can be detected
 *  instead of silently mis-imported. */
export const TypeTemplateExport = z.object({
  format: z.literal(TYPE_TEMPLATE_EXPORT_FORMAT),
  version: z.literal(TYPE_TEMPLATE_EXPORT_VERSION),
  exportedAt: z.string(),
  templates: z.array(ContentTypeDef),
});
export type TypeTemplateExport = z.infer<typeof TypeTemplateExport>;

/* ------------------------------ the library ------------------------------- */

/** The teaser/promote group: what a page shows when listed elsewhere.
 *  Every field falls back to the page's own content. */
const TEASER_GROUP = [
  {
    name: "teaserTitle", displayName: "Teaser title", type: "text", localized: true, delivery: "public",
    group: "Teaser", helpText: "Used when this page is shown as a teaser. Falls back to the heading.",
  },
  {
    name: "teaserText", displayName: "Teaser text", type: "text", localized: true, delivery: "public",
    group: "Teaser", validation: { maxLength: 300 },
    helpText: "Text used for listings and teasers. If not set, the intro is used.",
  },
  {
    name: "teaserImage", displayName: "Teaser image", type: "image", delivery: "public",
    group: "Teaser", helpText: "Image used for listings. If not set, the main image is used.",
  },
] as const;

const EMAIL_PATTERN = "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$";
const PHONE_PATTERN = "^\\+?[0-9][0-9 ()\\-]{3,19}$";

/** Person contact fields, shared by PersonPage and PersonBlock. */
const PERSON_FIELDS = [
  { name: "image", displayName: "Portrait", type: "image", delivery: "public", helpText: "A portrait of the person." },
  { name: "firstName", displayName: "First name", type: "text", required: true, delivery: "public", helpText: "The person's first name." },
  { name: "lastName", displayName: "Last name", type: "text", required: true, delivery: "public", helpText: "The person's last name." },
  { name: "workTitle", displayName: "Work title", type: "text", localized: true, delivery: "public", helpText: "The person's work title, e.g. Press officer." },
  { name: "department", displayName: "Department", type: "text", localized: true, delivery: "public", helpText: "The person's department or area, e.g. Marketing." },
  { name: "email", displayName: "Email address", type: "text", delivery: "public", validation: { pattern: EMAIL_PATTERN }, helpText: "The person's email address." },
  { name: "phone", displayName: "Phone number", type: "text", delivery: "public", validation: { pattern: PHONE_PATTERN }, helpText: "The person's phone number." },
] as const;

const RAW_TEMPLATES = [
  /* -------------------------------- pages -------------------------------- */
  {
    name: "StartPage",
    displayName: "Start page",
    kind: "page",
    description: "The site's front page, composed of blocks.",
    icon: "ph:house",
    schemaType: "WebPage",
    fields: [
      {
        name: "heading", displayName: "Heading", type: "text", localized: true, delivery: "public", seoRole: "title",
        helpText: "Optional visible heading. Many start pages are composed of blocks only.",
      },
      {
        name: "mainArea", displayName: "Main content area", type: "contentArea", localized: true, delivery: "public",
        helpText: "The start page is composed of blocks: hero, featured content, teaser lists…",
      },
    ],
  },
  {
    name: "SectionPage",
    displayName: "Section page",
    kind: "page",
    description: "A page that introduces a new section or area of the site.",
    icon: "ph:squares-four",
    schemaType: "WebPage",
    fields: [
      { name: "heading", displayName: "Heading", type: "text", localized: true, required: true, delivery: "public", seoRole: "title", helpText: "The visible page heading." },
      {
        name: "intro", displayName: "Intro", type: "text", localized: true, delivery: "public", seoRole: "description",
        validation: { maxLength: 300 }, helpText: "Should contain the most important elements of the page — but not the whole story.",
      },
      { name: "body", displayName: "Body", type: "richtext", localized: true, delivery: "public", helpText: "Body text is the main content of the page." },
      {
        name: "mainArea", displayName: "Main content area", type: "contentArea", localized: true, delivery: "public",
        helpText: "The section's composed content — heroes, teaser lists, link lists…",
      },
      ...TEASER_GROUP,
    ],
  },
  {
    name: "ArticlePage",
    displayName: "Article page",
    kind: "page",
    description: "A page for an article.",
    icon: "ph:article",
    schemaType: "Article",
    fields: [
      { name: "heading", displayName: "Heading", type: "text", localized: true, required: true, delivery: "public", seoRole: "title", helpText: "The article heading." },
      {
        name: "intro", displayName: "Intro", type: "text", localized: true, delivery: "public", seoRole: "description",
        validation: { maxLength: 300 }, helpText: "Should contain the most important elements of the story — but not the whole story.",
      },
      { name: "mainImage", displayName: "Main image", type: "image", delivery: "public", seoRole: "image", helpText: "The main image for the article." },
      { name: "imageCaption", displayName: "Image caption", type: "text", localized: true, delivery: "public", helpText: "Optional caption shown with the main image." },
      {
        name: "publishDate", displayName: "Publish date", type: "datetime", delivery: "public", seoRole: "datePublished",
        helpText: "Shown on the page, used for sorting lists and for structured data.",
      },
      { name: "author", displayName: "Author", type: "text", delivery: "public", seoRole: "author", helpText: "The author's name, shown on the page and in structured data." },
      { name: "body", displayName: "Body", type: "richtext", localized: true, delivery: "public", helpText: "Body text is the main content of the article." },
      {
        name: "mainArea", displayName: "Content area", type: "contentArea", localized: true, delivery: "public",
        helpText: "Blocks below the body — quotes, images, accordions, video…",
      },
      ...TEASER_GROUP,
    ],
  },
  {
    name: "ArticleListPage",
    displayName: "Article list page",
    kind: "page",
    description: "A page which lists its child articles.",
    icon: "ph:list-dashes",
    schemaType: "CollectionPage",
    fields: [
      { name: "heading", displayName: "Heading", type: "text", localized: true, required: true, delivery: "public", seoRole: "title", helpText: "The visible page heading." },
      {
        name: "intro", displayName: "Intro", type: "text", localized: true, delivery: "public", seoRole: "description",
        validation: { maxLength: 300 }, helpText: "Optional introduction shown above the list.",
      },
      {
        name: "listedType", displayName: "Listed content type", type: "select", required: true, delivery: "public",
        optionsFromContentTypes: true, options: [{ value: "ArticlePage", label: "Article page" }],
        helpText: "Children of this page with this type are listed (newest first). Must be an installed content type.",
      },
      {
        name: "pageSize", displayName: "Items per page", type: "number", delivery: "public",
        validation: { min: 1, max: 500 }, helpText: "The maximum number of items to show on each page (default 15).",
      },
      ...TEASER_GROUP,
    ],
  },
  {
    name: "FaqPage",
    displayName: "FAQ page",
    kind: "page",
    description: "A page with a list of frequently asked questions, grouped by topic.",
    icon: "ph:question",
    schemaType: "FAQPage",
    fields: [
      { name: "heading", displayName: "Heading", type: "text", localized: true, required: true, delivery: "public", seoRole: "title", helpText: "The visible page heading." },
      {
        name: "intro", displayName: "Intro", type: "text", localized: true, delivery: "public", seoRole: "description",
        validation: { maxLength: 300 }, helpText: "Optional introduction shown above the questions.",
      },
      {
        name: "topics", displayName: "FAQ topics", type: "contentArea", localized: true, delivery: "public",
        allowedBlocks: ["FaqTopicBlock"],
        helpText: "A tip is to split your FAQ into several topics. Many FAQs start off with a “general” topic.",
      },
      ...TEASER_GROUP,
    ],
  },
  {
    name: "PersonPage",
    displayName: "Person page",
    kind: "page",
    description: "A page with person description and contact details.",
    icon: "ph:user",
    schemaType: "ProfilePage",
    fields: [
      ...PERSON_FIELDS,
      { name: "bio", displayName: "Biography", type: "richtext", localized: true, delivery: "public", helpText: "Body text about the person." },
    ],
  },

  /* -------------------------------- blocks ------------------------------- */
  {
    name: "HeroBlock",
    displayName: "Hero",
    kind: "block",
    description: "Block with a large image, heading, text and links.",
    icon: "ph:presentation",
    fields: [
      { name: "heading", displayName: "Heading", type: "text", localized: true, required: true, delivery: "public", helpText: "The heading should be short and descriptive." },
      { name: "subtitle", displayName: "Subtitle", type: "text", localized: true, delivery: "public", helpText: "Whenever you would like a subtitle, enter it here." },
      { name: "image", displayName: "Main image", type: "image", delivery: "public", helpText: "The main image for the hero." },
      { name: "primaryLink", displayName: "Primary link", type: "link", localized: true, delivery: "public", helpText: "The hero's main call to action." },
      { name: "secondaryLink", displayName: "Secondary link", type: "link", localized: true, delivery: "public", helpText: "Optional second link." },
    ],
  },
  {
    name: "ImageBlock",
    displayName: "Image",
    kind: "block",
    description: "An image with a caption.",
    icon: "ph:image",
    fields: [
      { name: "image", displayName: "Image", type: "image", required: true, delivery: "public", helpText: "The image to display." },
      {
        name: "caption", displayName: "Caption", type: "text", localized: true, delivery: "public",
        helpText: "Caption shown with the image. Not the alt text — alt text is set on the asset in the media library.",
      },
    ],
  },
  {
    name: "TextBlock",
    displayName: "Text",
    kind: "block",
    description: "Block with rich text.",
    icon: "ph:text-align-left",
    fields: [
      { name: "body", displayName: "Body", type: "richtext", localized: true, required: true, delivery: "public", helpText: "Body text is the main content of the block." },
    ],
  },
  {
    name: "QuoteBlock",
    displayName: "Quote",
    kind: "block",
    description: "Block to display a quote and its source.",
    icon: "ph:quotes",
    fields: [
      { name: "quote", displayName: "Quote", type: "text", localized: true, required: true, delivery: "public", validation: { maxLength: 500 }, helpText: "Quote text." },
      { name: "source", displayName: "Source", type: "text", localized: true, required: true, delivery: "public", helpText: "Quote source, e.g. a person, character, or an organization." },
      { name: "image", displayName: "Image", type: "image", delivery: "public", helpText: "Image related to the quote source." },
    ],
  },
  {
    name: "AccordionBlock",
    displayName: "Accordion list",
    kind: "block",
    description: "Block with heading, text and a list of expandable items.",
    icon: "ph:rows",
    fields: [
      { name: "heading", displayName: "Heading", type: "text", localized: true, delivery: "public", helpText: "The heading should be short and descriptive." },
      { name: "text", displayName: "Text", type: "richtext", localized: true, delivery: "public", helpText: "Optional text area with information about the content." },
      {
        name: "items", displayName: "Items", type: "contentArea", localized: true, delivery: "public",
        allowedBlocks: ["AccordionItemBlock"], helpText: "The expandable items.",
      },
    ],
  },
  {
    name: "AccordionItemBlock",
    displayName: "Accordion item",
    kind: "block",
    description: "Heading and expandable content to use in an accordion list.",
    icon: "ph:caret-circle-down",
    fields: [
      { name: "heading", displayName: "Heading", type: "text", localized: true, required: true, delivery: "public", helpText: "Heading of the item — what the visitor clicks." },
      { name: "body", displayName: "Expandable content", type: "richtext", localized: true, required: true, delivery: "public", helpText: "Content that folds out when clicking the heading." },
      { name: "expanded", displayName: "Show as expanded", type: "boolean", delivery: "public", helpText: "Show this item as expanded by default." },
    ],
  },
  {
    name: "FaqTopicBlock",
    displayName: "FAQ topic",
    kind: "block",
    description: "A topic grouping questions that address the same subject.",
    icon: "ph:folder",
    fields: [
      {
        name: "topic", displayName: "Topic", type: "text", localized: true, delivery: "public",
        helpText: "It is considered good practice to divide a FAQ into topics. Many FAQs start off with a “general” topic.",
      },
      {
        name: "questions", displayName: "Questions and answers", type: "contentArea", localized: true, delivery: "public",
        allowedBlocks: ["QuestionBlock"], helpText: "All questions and answers for the topic. Sorting can be changed afterwards.",
      },
    ],
  },
  {
    name: "QuestionBlock",
    displayName: "Question with answer",
    kind: "block",
    description: "The question should be short, but the answer can be longer and more descriptive.",
    icon: "ph:chat-circle-text",
    fields: [
      { name: "question", displayName: "Question", type: "text", localized: true, required: true, delivery: "public", helpText: "The question, as a visitor would ask it." },
      { name: "answer", displayName: "Answer", type: "richtext", localized: true, required: true, delivery: "public", helpText: "The answer to the question." },
    ],
  },
  {
    name: "PersonBlock",
    displayName: "Person",
    kind: "block",
    description: "Block with person description and contact details.",
    icon: "ph:identification-card",
    fields: [...PERSON_FIELDS],
  },
  {
    name: "BannerBlock",
    displayName: "Banner",
    kind: "block",
    description: "Block with optional heading, text, link and background image.",
    icon: "ph:flag",
    fields: [
      { name: "heading", displayName: "Heading", type: "text", localized: true, delivery: "public", helpText: "The heading should be short and descriptive." },
      { name: "text", displayName: "Text", type: "text", localized: true, delivery: "public", validation: { maxLength: 300 }, helpText: "Text for the banner." },
      { name: "link", displayName: "Link", type: "link", localized: true, delivery: "public", helpText: "Where the banner leads. The whole banner is clickable." },
      { name: "backgroundImage", displayName: "Background image", type: "image", delivery: "public", helpText: "An image displayed as background." },
    ],
  },
  {
    name: "LinkListBlock",
    displayName: "Link list",
    kind: "block",
    description: "Block with links and an optional heading.",
    icon: "ph:link",
    fields: [
      { name: "heading", displayName: "Heading", type: "text", localized: true, delivery: "public", helpText: "The heading should be short and descriptive." },
      {
        name: "links", displayName: "Links", type: "contentArea", localized: true, required: true, delivery: "public",
        allowedBlocks: ["LinkItemBlock"], helpText: "The links to show.",
      },
    ],
  },
  {
    name: "LinkItemBlock",
    displayName: "Link item",
    kind: "block",
    description: "A single link — used in link lists and menus.",
    icon: "ph:arrow-square-out",
    fields: [
      { name: "link", displayName: "Link", type: "link", localized: true, required: true, delivery: "public", helpText: "The link, with its visible text." },
    ],
  },
  {
    name: "TeaserListBlock",
    displayName: "Teaser list",
    kind: "block",
    description: "Block that lists hand-picked pages as teasers, with an optional heading and intro.",
    icon: "ph:cards",
    fields: [
      { name: "heading", displayName: "Heading", type: "text", localized: true, delivery: "public", helpText: "The heading should be short and descriptive." },
      {
        name: "intro", displayName: "Intro", type: "text", localized: true, delivery: "public",
        validation: { maxLength: 300 }, helpText: "Optional summary introduction of the teaser list.",
      },
      {
        // Pages dropped into a content area are the platform's native teaser
        // mechanism: each renders as a compact card from the page's Teaser
        // fields (falling back to heading/intro/main image) linking to it.
        name: "teasers", displayName: "Teasers", type: "contentArea", localized: true, delivery: "public",
        helpText: "Select or drag pages here (from the content tree) — each is shown as a teaser linking to that page.",
      },
      { name: "moreLink", displayName: "Link", type: "link", localized: true, delivery: "public", helpText: "Link to a page with more content related to the teaser list." },
    ],
  },
  {
    name: "VideoBlock",
    displayName: "Video (embed)",
    kind: "block",
    description: "Block for presentation of hosted video such as YouTube or Vimeo.",
    icon: "ph:video-camera",
    fields: [
      { name: "heading", displayName: "Heading", type: "text", localized: true, delivery: "public", helpText: "The heading should be short and descriptive." },
      {
        name: "embedUrl", displayName: "Embed URL", type: "text", required: true, delivery: "public",
        validation: { pattern: "^https://" },
        helpText: "e.g. https://www.youtube.com/embed/EdTpqkEjYWE or https://player.vimeo.com/video/639017749",
      },
      { name: "poster", displayName: "Poster", type: "image", delivery: "public", helpText: "Optional poster image shown before playback." },
    ],
  },

  /* ------------------------------- globals ------------------------------- */
  {
    name: "HeaderSettings",
    displayName: "Header settings",
    kind: "global",
    description: "Site-wide header content: logo and main menu.",
    icon: "ph:layout",
    fields: [
      { name: "logo", displayName: "Logo", type: "image", delivery: "public", helpText: "The site logo." },
      {
        name: "menuLinks", displayName: "Menu", type: "contentArea", localized: true, delivery: "public",
        allowedBlocks: ["LinkItemBlock"], helpText: "The main menu links.",
      },
    ],
  },
  {
    name: "FooterSettings",
    displayName: "Footer settings",
    kind: "global",
    description: "Site-wide footer content: links and text.",
    icon: "ph:layout",
    fields: [
      {
        name: "links", displayName: "Links", type: "contentArea", localized: true, delivery: "public",
        allowedBlocks: ["LinkItemBlock"],
        helpText: "A collection of links that might be relevant to users who have scrolled to the bottom of the page.",
      },
      { name: "footerText", displayName: "Footer text", type: "richtext", localized: true, delivery: "public", helpText: "Rich text area for additional information in the footer." },
    ],
  },
] as const;

/** The built-in library, schema-validated at module load (an invalid entry
 *  fails fast at boot, and shared-builtin-templates.test.ts pins the rest). */
export const BUILTIN_TYPE_TEMPLATES: readonly ContentTypeDef[] = RAW_TEMPLATES.map((t) => ContentTypeDef.parse(t));

/** Reserved names: built-ins are read-only, so no stored template may claim one. */
export const BUILTIN_TYPE_TEMPLATE_NAMES: ReadonlySet<string> = new Set(BUILTIN_TYPE_TEMPLATES.map((t) => t.name));
