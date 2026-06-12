import { z } from "zod";
import { FieldType, type FieldDef } from "./content-types.js";

/**
 * schema.org knowledge for the SEO/JSON-LD contract: which @types are
 * CreativeWorks (and may carry headline/author/keywords/datePublished), and
 * which wrapper properties expect a typed object. Shared by delivery (correct
 * emission) and the admin type editor (field suggestions), so the two can't
 * drift.
 */

/**
 * Known CreativeWork descendants. Delivery emits the full CreativeWork prop
 * set (headline, inLanguage, author, keywords, datePublished/Modified) only
 * for these; every OTHER @type — Product, Event, custom — gets the universally
 * valid Thing subset (name, description, image) plus its explicit schemaProps.
 * Unknown custom types land in the safe subset on purpose: a lossy-but-valid
 * jsonLd beats invalid properties on a type we can't classify.
 */
export const CREATIVE_WORK_TYPES: ReadonlySet<string> = new Set([
  "WebPage",
  "WebSite",
  "Article",
  "BlogPosting",
  "NewsArticle",
  "TechArticle",
  "ScholarlyArticle",
  "Report",
  "Blog",
  "CollectionPage",
  "AboutPage",
  "ContactPage",
  "ItemPage",
  "ProfilePage",
  "SearchResultsPage",
  "FAQPage",
  "QAPage",
  "MediaGallery",
  "Recipe",
  "HowTo",
  "Review",
]);

export function isCreativeWorkType(schemaType: string): boolean {
  return CREATIVE_WORK_TYPES.has(schemaType);
}

/**
 * Wrapper properties whose value schema.org models as a typed object. A flat
 * string mapped to one of these is lifted to `{"@type": X, name: value}`, and
 * a dot-path head (e.g. "offers.price") gets the @type injected on the built
 * object.
 */
export const SCHEMA_WRAPPER_TYPES: Record<string, string> = {
  offers: "Offer",
  brand: "Brand",
  location: "Place",
  address: "PostalAddress",
  organizer: "Organization",
  performer: "Person",
  hiringOrganization: "Organization",
  aggregateRating: "AggregateRating",
};

/**
 * Conventional field names per SEO role — the safety net delivery uses when a
 * type hasn't tagged a field with an explicit seoRole. Lives here (not in the
 * delivery layer) so the editor's coverage check and delivery's emission can
 * never disagree about what "already covered" means.
 */
export const SEO_CONVENTION: Record<string, string[]> = {
  title: ["title", "heading", "headline", "name"],
  description: ["summary", "excerpt", "description", "lead", "subtitle", "intro"],
  image: ["image", "heroimage", "leadimage", "coverimage", "featuredimage", "thumbnail"],
  datePublished: ["publishdate", "publisheddate", "publishedat", "datepublished", "date"],
  author: ["author", "byline", "writtenby"],
  keywords: ["tags", "keywords", "topics"],
};

export type SeoRole = NonNullable<FieldDef["seoRole"]>;

/** Field types that can sensibly fill each SEO role (keeps pickers + coverage focused). */
export function seoRoleEligible(role: SeoRole, t: FieldType): boolean {
  if (role === "image") return t === "image";
  if (role === "datePublished" || role === "dateModified") return t === "datetime";
  return t === "text" || t === "markdown" || t === "richtext" || t === "select";
}

/**
 * A field the catalog (or the AI assistant) proposes so a content type can
 * actually produce the rich result its schema.org @type promises. `required`
 * mirrors Google's rich-result requirements, not schema.org validity.
 */
export interface SchemaFieldSuggestion {
  /** The schema.org property (or universal role) this satisfies — the label shown. */
  prop: string;
  required: boolean;
  field: {
    name: string;
    displayName: string;
    type: FieldType;
    localized?: boolean;
    seoRole?: SeoRole;
    schemaProp?: string;
    helpText?: string;
  };
}

const TITLE: SchemaFieldSuggestion = {
  prop: "name / headline",
  required: true,
  field: { name: "title", displayName: "Title", type: "text", localized: true, seoRole: "title" },
};
const DESCRIPTION: SchemaFieldSuggestion = {
  prop: "description",
  required: false,
  field: { name: "summary", displayName: "Summary", type: "text", localized: true, seoRole: "description", helpText: "Shown in list pages and search snippets." },
};
const IMAGE = (required: boolean): SchemaFieldSuggestion => ({
  prop: "image",
  required,
  field: { name: "image", displayName: "Image", type: "image", seoRole: "image" },
});

const ARTICLE_LIKE: SchemaFieldSuggestion[] = [
  TITLE,
  DESCRIPTION,
  IMAGE(true),
  { prop: "datePublished", required: true, field: { name: "publishDate", displayName: "Publish date", type: "datetime", seoRole: "datePublished" } },
  { prop: "author", required: true, field: { name: "author", displayName: "Author", type: "text", seoRole: "author" } },
];
const PAGE_BASICS: SchemaFieldSuggestion[] = [
  { ...TITLE, field: { ...TITLE.field, name: "heading", displayName: "Heading" } },
  DESCRIPTION,
  IMAGE(false),
];

/**
 * Suggested fields per known @type — what a type needs so its JSON-LD earns
 * the rich result. Data, not code: the editor renders it as a checklist and
 * the AI path mimics this exact shape for @types not listed here.
 */
export const SCHEMA_FIELD_CATALOG: Record<string, SchemaFieldSuggestion[]> = {
  WebPage: PAGE_BASICS,
  CollectionPage: PAGE_BASICS,
  AboutPage: PAGE_BASICS,
  ContactPage: PAGE_BASICS,
  // FAQPage rich results additionally need Question/Answer pairs (mainEntity),
  // which have no flat-field representation yet — basics only.
  FAQPage: PAGE_BASICS,
  Article: ARTICLE_LIKE,
  BlogPosting: ARTICLE_LIKE,
  NewsArticle: ARTICLE_LIKE,
  Product: [
    TITLE,
    DESCRIPTION,
    IMAGE(true),
    { prop: "brand", required: false, field: { name: "brand", displayName: "Brand", type: "text", schemaProp: "brand" } },
    { prop: "sku", required: false, field: { name: "sku", displayName: "SKU", type: "text", schemaProp: "sku" } },
    { prop: "offers.price", required: true, field: { name: "price", displayName: "Price", type: "number", schemaProp: "offers.price" } },
    { prop: "offers.priceCurrency", required: true, field: { name: "priceCurrency", displayName: "Price currency", type: "text", schemaProp: "offers.priceCurrency", helpText: "ISO 4217, e.g. NOK" } },
  ],
  Event: [
    TITLE,
    DESCRIPTION,
    IMAGE(false),
    { prop: "startDate", required: true, field: { name: "startDate", displayName: "Start date", type: "datetime", schemaProp: "startDate" } },
    { prop: "endDate", required: false, field: { name: "endDate", displayName: "End date", type: "datetime", schemaProp: "endDate" } },
    { prop: "location", required: true, field: { name: "location", displayName: "Location", type: "text", schemaProp: "location" } },
  ],
};

/** One catalog row resolved against a type's current fields. */
export interface SchemaFieldGap {
  suggestion: SchemaFieldSuggestion;
  /** Name of the field already covering this prop (role, schemaProp or convention), or null. */
  coveredBy: string | null;
  /** An existing same-named-but-untagged field the apply step should TAG instead of duplicating. */
  tagField: string | null;
}

/**
 * Resolve suggestions (from the catalog OR the AI assistant) against a field
 * list: what's covered (by an explicit seoRole/schemaProp, or by delivery's
 * name convention), what's missing, and where tagging an existing field beats
 * adding a new one.
 */
export function resolveSchemaSuggestions(
  suggestions: SchemaFieldSuggestion[],
  fields: Pick<FieldDef, "name" | "type" | "seoRole" | "schemaProp">[],
): SchemaFieldGap[] {
  return suggestions.map((suggestion) => {
    const want = suggestion.field;
    let coveredBy: string | null = null;
    if (want.seoRole) {
      const role = want.seoRole;
      const tagged = fields.find((f) => f.seoRole === role);
      const conventional = fields.find(
        (f) => (SEO_CONVENTION[role] ?? []).includes(f.name.toLowerCase()) && seoRoleEligible(role, f.type),
      );
      coveredBy = tagged?.name ?? conventional?.name ?? null;
    } else if (want.schemaProp) {
      coveredBy = fields.find((f) => f.schemaProp === want.schemaProp)?.name ?? null;
    }
    // Same-named existing field without the tag → tag it, don't duplicate it.
    const tagField = coveredBy
      ? null
      : (fields.find(
          (f) =>
            f.name.toLowerCase() === want.name.toLowerCase() &&
            (want.seoRole ? seoRoleEligible(want.seoRole, f.type) : f.type === want.type),
        )?.name ?? null);
    return { suggestion, coveredBy, tagField };
  });
}

/**
 * Resolve the catalog for a @type against a field list. Returns null for
 * @types the catalog doesn't know (custom types — the AI suggestion path
 * takes over there).
 */
export function schemaFieldGaps(
  schemaType: string,
  fields: Pick<FieldDef, "name" | "type" | "seoRole" | "schemaProp">[],
): SchemaFieldGap[] | null {
  const catalog = SCHEMA_FIELD_CATALOG[schemaType];
  return catalog ? resolveSchemaSuggestions(catalog, fields) : null;
}

/**
 * The JSON contract the `schema_fields` AI task must return — the same shape
 * as the static catalog, so the editor renders both through one code path.
 * Validated with Zod before anything reaches the UI: a malformed model reply
 * becomes an error, never a half-applied field list (rule #1).
 */
export const AiSchemaFieldSuggestions = z
  .array(
    z.object({
      prop: z.string().min(1).max(80),
      required: z.boolean().default(false),
      field: z.object({
        name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/).max(60),
        displayName: z.string().min(1).max(80),
        type: FieldType,
        localized: z.boolean().optional(),
        seoRole: z.enum(["title", "description", "image", "datePublished", "dateModified", "author", "keywords"]).optional(),
        schemaProp: z
          .string()
          .regex(/^[a-zA-Z][a-zA-Z0-9]*(\.[a-zA-Z][a-zA-Z0-9]*)?$/)
          .max(80)
          .optional(),
        helpText: z.string().max(300).optional(),
      }),
    }),
  )
  .min(1)
  .max(12);
