import { z } from "zod";

/**
 * The content model is *data-driven*: content types are defined as data in a
 * registry (the `content_type` table), not hardcoded. These Zod schemas are the
 * single source of truth for what a content type / field / block instance looks
 * like, shared by the API (validation + OpenAPI), the admin (forms) and the
 * delivery layer (serialization / sanitization).
 */

/** A piece of content is one of three kinds. */
export const ContentKind = z.enum(["page", "block", "global"]);
export type ContentKind = z.infer<typeof ContentKind>;

/** Field primitive types supported by the MVP. */
export const FieldType = z.enum([
  "text", // short single-line string
  "markdown", // multi-line Markdown source (edited as a textarea; delivered as a string)
  "richtext", // TipTap JSON document
  "boolean",
  "number",
  "datetime", // ISO date/time string
  "select", // choice from a fixed option list (single or multiple)
  "link", // structured link {href, text?, target?, title?}
  "image", // reference to an image asset (documentId); resolved to {url,alt} in delivery
  "media", // legacy: raw asset documentId string
  "reference", // reference to another content item
  "contentArea", // ordered list of block instances (a "content area")
]);
export type FieldType = z.infer<typeof FieldType>;

/** A choice option for a `select` field. */
export const FieldOption = z.object({
  value: z.string().min(1).max(120),
  label: z.string().min(1).max(120),
});
export type FieldOption = z.infer<typeof FieldOption>;

/** Per-field validation rules (per-field property validation). */
export const FieldValidation = z.object({
  minLength: z.number().int().nonnegative().optional(),
  maxLength: z.number().int().positive().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  pattern: z.string().max(300).optional(), // regex source (anchored as given)
});
export type FieldValidation = z.infer<typeof FieldValidation>;

/** A structured link value. */
export const LinkValue = z.object({
  href: z.string().max(2000),
  text: z.string().max(300).optional(),
  target: z.enum(["_self", "_blank"]).optional(),
  title: z.string().max(300).optional(),
});
export type LinkValue = z.infer<typeof LinkValue>;

/** Definition of a single field on a content type. */
export const FieldDef = z.object({
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/).max(60),
  displayName: z.string().min(1).max(80),
  type: FieldType,
  /** Whether the field has an independent value per locale (document-level i18n). */
  localized: z.boolean().default(false),
  /** Required for *publish* (relaxed for drafts). */
  required: z.boolean().default(false),
  /**
   * Delivery exposure. SECURITY: default is "private" (fail-closed) — a field is
   * only returned by the public Delivery API when explicitly marked "public".
   */
  delivery: z.enum(["public", "private"]).default("private"),
  /** For contentArea: which block content-types may be placed here ([] = any block). Editor hint (not write-enforced). */
  allowedBlocks: z.array(z.string().max(60)).default([]),
  /** For reference: which content-types may be referenced ([] = any). Write-enforced. */
  allowedTypes: z.array(z.string().max(60)).default([]),
  /** For select: the choosable options. */
  options: z.array(FieldOption).default([]),
  /**
   * For select: the value names an INSTALLED content type (e.g. a ListPage's
   * listedType). The options reflect what content types actually exist — never
   * a hardcoded fantasy list — and the value is write-enforced against the
   * installed types in the db layer (a list page can't reference a type that
   * doesn't exist; 2026-06-07 incident).
   */
  optionsFromContentTypes: z.boolean().default(false),
  /** For select: allow choosing more than one option (value is then an array). */
  multiple: z.boolean().default(false),
  /** Optional per-field validation rules (text length, number range, regex). */
  validation: FieldValidation.optional(),
  /** Tab/group in the All-Properties editor. */
  group: z.string().min(1).max(60).default("Content"),
  helpText: z.string().max(300).optional(),
  /**
   * SEO meaning of this field, for the delivered `seo`/`jsonLd` contract. Lets
   * ANY field declare its role (decoupled from field names) — delivery reads
   * the value of the field tagged "title"/"description"/"image"/etc. Explicit
   * metaTitle/metaDescription/ogImage still override the role-derived value.
   */
  seoRole: z
    .enum(["title", "description", "image", "datePublished", "dateModified", "author", "keywords"])
    .optional(),
});
export type FieldDef = z.infer<typeof FieldDef>;

/** A content type (e.g. "StandardPage", "HeroBlock"). */
export const ContentTypeDef = z
  .object({
    name: z.string().regex(/^[A-Z][a-zA-Z0-9]*$/).max(60),
    displayName: z.string().min(1).max(80),
    kind: ContentKind,
    description: z.string().max(300).default(""),
    icon: z.string().max(40).default("file"),
    fields: z.array(FieldDef).max(60),
    /**
     * schema.org @type for the delivered JSON-LD (e.g. "Article", "BlogPosting",
     * "CollectionPage", "WebPage"). Omitted → delivery derives a sensible default
     * from the type's roles/fields (dated → Article/BlogPosting; has listedType →
     * CollectionPage; else WebPage).
     */
    schemaType: z.string().max(60).optional(),
  })
  // Field names must be unique within a type (else dataSchemaFor / delivery collide).
  .refine(
    (t) => new Set(t.fields.map((f) => f.name)).size === t.fields.length,
    { message: "Field names must be unique within a content type", path: ["fields"] },
  )
  // At most ONE field per seoRole — a second "title"/"description"/… is
  // ambiguous for the seo contract. Self-teaching message (agent-API rule 2).
  .refine(
    (t) => {
      const roles = t.fields.map((f) => f.seoRole).filter(Boolean) as string[];
      return new Set(roles).size === roles.length;
    },
    {
      message:
        "Each seoRole (title/description/image/datePublished/dateModified/author/keywords) may be used by at most one field — two fields claim the same role.",
      path: ["fields"],
    },
  );
export type ContentTypeDef = z.infer<typeof ContentTypeDef>;

/**
 * The reserved SEO field group — INTRINSIC to every page. Defined ONCE here,
 * never stored in a type's definition: injected at read time (withSeoGroup) and
 * stripped at write time (stripSeoGroup). So every page kind has it
 * automatically (incl. custom types), it can't be removed, and it can't drift.
 * These are the OUTPUT-control fields (meta/og/twitter/canonical/noindex); the
 * CONTENT fields a type author defines (heading/title/…) carry the seoRoles.
 */
export const SEO_GROUP: FieldDef[] = (
  [
    { name: "metaTitle", displayName: "Meta title", type: "text", localized: true, delivery: "public", group: "SEO", validation: { maxLength: 70 }, helpText: "The <title> tag. Aim for ≤ 60 characters." },
    { name: "metaDescription", displayName: "Meta description", type: "text", localized: true, delivery: "public", group: "SEO", validation: { maxLength: 200 }, helpText: "Search-result snippet. Aim for ≤ 160 characters." },
    { name: "canonicalUrl", displayName: "Canonical URL", type: "text", localized: false, delivery: "public", group: "SEO", helpText: "Absolute URL of the canonical version (optional)." },
    { name: "noIndex", displayName: "Hide from search engines (noindex)", type: "boolean", localized: false, delivery: "public", group: "SEO" },
    { name: "ogTitle", displayName: "Social title (Open Graph)", type: "text", localized: true, delivery: "public", group: "SEO", helpText: "Falls back to the meta title." },
    { name: "ogDescription", displayName: "Social description (Open Graph)", type: "text", localized: true, delivery: "public", group: "SEO", helpText: "Falls back to the meta description." },
    { name: "ogImage", displayName: "Social share image", type: "image", localized: false, delivery: "public", group: "SEO", helpText: "Shown when shared. 1200×630 recommended." },
    { name: "ogType", displayName: "Open Graph type", type: "select", localized: false, delivery: "public", group: "SEO", options: [{ value: "website", label: "Website" }, { value: "article", label: "Article" }] },
    { name: "twitterCard", displayName: "Twitter card", type: "select", localized: false, delivery: "public", group: "SEO", options: [{ value: "summary", label: "Summary" }, { value: "summary_large_image", label: "Summary, large image" }] },
  ] as const
).map((f) => FieldDef.parse(f));

/** The reserved SEO field names (system-managed; never stored per type). */
export const SEO_FIELD_NAMES: ReadonlySet<string> = new Set(SEO_GROUP.map((f) => f.name));

/**
 * Read-time augmentation: every PAGE kind gets the reserved SEO group. Strips
 * any stored field that collides with a reserved name first (canonical wins,
 * can't drift), then appends the group — so this is idempotent and a stale
 * stored SEO field can never shadow the canonical one.
 */
export function withSeoGroup(def: ContentTypeDef): ContentTypeDef {
  if (def.kind !== "page") return def;
  const fields = def.fields.filter((f) => !SEO_FIELD_NAMES.has(f.name)).concat(SEO_GROUP);
  return { ...def, fields };
}

/** Write-time: drop the reserved SEO fields so they're never persisted per type. */
export function stripSeoGroup(def: ContentTypeDef): ContentTypeDef {
  return { ...def, fields: def.fields.filter((f) => !SEO_FIELD_NAMES.has(f.name)) };
}

/** Display option for a block placed in a content area. */
export const BlockDisplayOption = z.enum(["automatic", "full", "wide", "narrow"]);
export type BlockDisplayOption = z.infer<typeof BlockDisplayOption>;

/**
 * A block instance inside a content area. It is either:
 *  - inline: page-local block data embedded directly, or
 *  - shared: a reference to a standalone block content item (documentId).
 */
export const BlockInstance = z
  .object({
    /** Stable key for React reconciliation / drag-drop. */
    key: z.string(),
    blockType: z.string(),
    display: BlockDisplayOption.default("automatic"),
    /** Inline block payload (page-local). Mutually exclusive with `ref`. */
    inline: z.record(z.unknown()).nullable().default(null),
    /** Shared block reference (documentId). Mutually exclusive with `inline`. */
    ref: z.string().nullable().default(null),
  })
  .refine((b) => (b.inline === null) !== (b.ref === null), {
    message: "A block instance must be either inline or a shared reference, not both/neither.",
  });
export type BlockInstance = z.infer<typeof BlockInstance>;

/** A content area value is an ordered list of block instances. */
export const ContentArea = z.array(BlockInstance);
export type ContentArea = z.infer<typeof ContentArea>;

/** A reference field value. `type` is a denormalised hint — delivery resolves
 *  the real type at read time, so it's optional on write. */
export const ReferenceValue = z.object({
  documentId: z.string(),
  type: z.string().optional(),
});
export type ReferenceValue = z.infer<typeof ReferenceValue>;

/**
 * A TipTap richtext document. The coercion chokepoint guarantees this exact
 * top-level shape for EVERY richtext write — a plain string is parsed into a doc
 * (markdownToTiptapDoc) and any doc-ish value is normalized to the editor schema
 * (sanitizeRichTextDoc), both of which return `{type:"doc", content:[…]}`. So a
 * value that arrives here NOT shaped like a doc never went through that path: it
 * is a foreign richtext dialect (Editor.js/Slate/ProseMirror-state) or scalar
 * garbage that the TipTap editor renders BLANK. Validating it as `z.record`
 * (any object) is what let the 2026-06-08 "malformed body" class persist
 * silently; require the real doc shape so it is REJECTED with the format hint
 * instead. Node-level validity is the sanitizer's job (and is test-pinned); this
 * only fences the top-level contract. */
export const RichTextDoc = z
  .object({ type: z.literal("doc"), content: z.array(z.record(z.unknown())) })
  .passthrough();
export type RichTextDoc = z.infer<typeof RichTextDoc>;

/**
 * Build a Zod object schema for a content type's `data` payload from its field
 * defs. `strict` = enforce required fields (used at publish time); when false,
 * required fields may be missing (draft save).
 */
export function dataSchemaFor(type: ContentTypeDef, strict: boolean): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const f of type.fields) {
    let s: z.ZodTypeAny;
    switch (f.type) {
      case "text":
        s = applyStringValidation(z.string(), f, strict);
        break;
      case "markdown":
        s = applyStringValidation(z.string(), f, strict);
        break;
      case "richtext":
        s = RichTextDoc; // a real TipTap doc, not just any object — see RichTextDoc
        break;
      case "boolean":
        s = z.boolean();
        break;
      case "number":
        s = applyNumberValidation(z.number(), f, strict);
        break;
      case "datetime":
        s = z.string(); // ISO 8601 (datetime-local or full offset)
        break;
      case "select": {
        const values = f.options.map((o) => o.value);
        // optionsFromContentTypes: the valid values are the INSTALLED content
        // types (validated in the db layer against reality), so don't pin to a
        // static option list here — a stale option must never gate.
        const one: z.ZodTypeAny =
          strict && values.length && !f.optionsFromContentTypes
            ? z.string().refine((v) => values.includes(v), "Invalid option")
            : z.string();
        s = f.multiple ? z.array(one) : one;
        break;
      }
      case "link":
        s = LinkValue;
        break;
      case "image":
        s = z.string(); // image asset documentId (resolved to {url,alt} in delivery)
        break;
      case "media":
        s = z.string(); // asset documentId
        break;
      case "reference":
        s = ReferenceValue;
        break;
      case "contentArea":
        s = ContentArea;
        break;
    }
    // Required only enforced in strict (publish) mode.
    shape[f.name] = strict && f.required ? s : s.optional().nullable();
  }
  return z.object(shape).passthrough();
}

/**
 * Human/agent-readable description of the JSON shape a field's value must take —
 * the inverse documentation of `dataSchemaFor`. Surfaced in the MCP content-type
 * output and in validation error messages so an agent (or a person) knows
 * exactly what to send for each field type, with a copyable example.
 */
export function fieldFormatHint(f: FieldDef): { format: string; example: unknown } {
  switch (f.type) {
    case "text":
      return { format: "a plain string", example: "Some text" };
    case "markdown":
      return { format: "a plain string containing Markdown", example: "## Heading\n\nA paragraph with **bold** text." };
    case "richtext":
      return {
        format: "a TipTap document (JSON object, not a string)",
        example: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }] },
      };
    case "boolean":
      return { format: "a boolean", example: true };
    case "number":
      return { format: "a number", example: 3 };
    case "datetime":
      return { format: "an ISO-8601 datetime string", example: "2026-01-15T09:00:00.000Z" };
    case "select":
      return f.multiple
        ? { format: "an array of option-value strings", example: f.options.slice(0, 1).map((o) => o.value) }
        : { format: "one option-value string", example: f.options[0]?.value ?? "option-value" };
    case "link":
      return { format: "an object { href, text?, target? }", example: { href: "https://example.com", text: "Example" } };
    case "image":
    case "media":
      return { format: "an asset documentId string", example: "asset_documentId" };
    case "reference":
      return { format: "an object { documentId, type? }", example: { documentId: "page_documentId", type: "ArticlePage" } };
    case "contentArea":
      return {
        format: "an ARRAY of block instances",
        example: [{ key: "b1", blockType: "HeroBlock", display: "full", ref: null, inline: { title: "…" } }],
      };
  }
}

/* --------------------- tolerant input coercion (agents) ------------------- */
// TipTap doc → Markdown / plain text. Agents reliably send rich docs for
// markdown/text fields; the conversion must PRESERVE STRUCTURE. (The previous
// flattener concatenated text nodes with no separators — "HeadingBody text…" —
// destroying the content while reporting success, which sent a real agent into
// a stuck retry loop.)
type TtNode = { type?: string; text?: string; content?: TtNode[]; attrs?: Record<string, unknown>; marks?: { type: string; attrs?: Record<string, unknown> }[] };

function ttInline(nodes: TtNode[] | undefined, md: boolean): string {
  return (nodes ?? [])
    .map((n) => {
      if (n.type === "hardBreak") return md ? "  \n" : "\n";
      if (n.type === "image") return md ? `![${String(n.attrs?.alt ?? "")}](${String(n.attrs?.src ?? "")})` : String(n.attrs?.alt ?? "");
      let t = typeof n.text === "string" ? n.text : ttInline(n.content, md);
      if (md) {
        for (const m of n.marks ?? []) {
          if (m.type === "bold" || m.type === "strong") t = `**${t}**`;
          else if (m.type === "italic" || m.type === "em") t = `*${t}*`;
          else if (m.type === "code") t = `\`${t}\``;
          else if (m.type === "strike") t = `~~${t}~~`;
          else if (m.type === "link") t = `[${t}](${String(m.attrs?.href ?? "#")})`;
        }
      }
      return t;
    })
    .join("");
}

function ttBlocks(nodes: TtNode[] | undefined, md: boolean): string[] {
  const out: string[] = [];
  for (const n of nodes ?? []) {
    switch (n.type) {
      case "heading": {
        const lvl = Math.min(Math.max(Number(n.attrs?.level ?? 2), 1), 6);
        out.push(md ? `${"#".repeat(lvl)} ${ttInline(n.content, md)}` : ttInline(n.content, md));
        break;
      }
      case "paragraph":
        out.push(ttInline(n.content, md));
        break;
      case "bulletList":
      case "orderedList": {
        const lines = (n.content ?? []).map((li, i) => {
          const inner = ttBlocks(li.content, md).join(md ? "\n  " : "\n");
          return n.type === "orderedList" ? `${i + 1}. ${inner}` : md ? `- ${inner}` : `• ${inner}`;
        });
        out.push(lines.join("\n"));
        break;
      }
      case "blockquote":
        out.push(ttBlocks(n.content, md).join("\n\n").split("\n").map((l) => (md ? `> ${l}` : l)).join("\n"));
        break;
      case "codeBlock":
        out.push(md ? `\`\`\`\n${ttInline(n.content, false)}\n\`\`\`` : ttInline(n.content, false));
        break;
      case "horizontalRule":
        if (md) out.push("---");
        break;
      case "image":
        out.push(md ? `![${String(n.attrs?.alt ?? "")}](${String(n.attrs?.src ?? "")})` : String(n.attrs?.alt ?? ""));
        break;
      default:
        // Unknown wrapper: descend; bare inline content becomes its own block.
        if (Array.isArray(n.content)) out.push(...ttBlocks(n.content, md));
        else if (typeof n.text === "string" && n.text) out.push(n.text);
    }
  }
  return out.filter((b) => b.trim() !== "");
}

/** TipTap doc → Markdown (structure preserved: headings, lists, marks, links). */
function tiptapToMarkdown(doc: unknown): string {
  const d = doc as TtNode;
  return ttBlocks(Array.isArray(d?.content) ? d.content : [d as TtNode], true).join("\n\n").trim();
}

/** TipTap doc → plain text, blocks separated (single-line `text` fields). */
export function tiptapToPlainText(doc: unknown): string {
  const d = doc as TtNode;
  return ttBlocks(Array.isArray(d?.content) ? d.content : [d as TtNode], false).join("\n").trim();
}
// Wrap a plain (possibly multi-paragraph) string into a TipTap doc.
/**
 * Parse inline Markdown (code, links, bold, italic) into TipTap text nodes
 * with marks. Pragmatic, single-level: unmatched/over-nested markers fall
 * through as literal text. Precedence: code span → link → bold → italic.
 */
function mdInline(text: string): Array<Record<string, unknown>> {
  const nodes: Array<Record<string, unknown>> = [];
  const pushText = (t: string, marks?: Array<Record<string, unknown>>) => {
    if (!t) return;
    nodes.push(marks && marks.length ? { type: "text", text: t, marks } : { type: "text", text: t });
  };
  const re = /(`[^`]+`)|(\[[^\]]+\]\([^)\s]+\))|(\*\*[^*]+\*\*|__[^_]+__)|(\*[^*\n]+\*|_[^_\n]+_)/;
  let rest = text;
  while (rest.length) {
    const m = re.exec(rest);
    if (!m) {
      pushText(rest);
      break;
    }
    if (m.index > 0) pushText(rest.slice(0, m.index));
    const tok = m[0];
    if (m[1]) {
      pushText(tok.slice(1, -1), [{ type: "code" }]);
    } else if (m[2]) {
      const lm = /\[([^\]]+)\]\(([^)\s]+)\)/.exec(tok)!;
      pushText(lm[1]!, [{ type: "link", attrs: { href: lm[2] } }]);
    } else if (m[3]) {
      pushText(tok.replace(/^(\*\*|__)/, "").replace(/(\*\*|__)$/, ""), [{ type: "bold" }]);
    } else if (m[4]) {
      pushText(tok.replace(/^[*_]/, "").replace(/[*_]$/, ""), [{ type: "italic" }]);
    }
    rest = rest.slice(m.index + tok.length);
  }
  return nodes;
}

const MD_BLOCK_START = /^(#{1,6}\s|```|>\s?|\s*[-*+]\s+|\s*\d+\.\s+)/;
const MD_HR = /^(\s*[-*_]\s*){3,}$/;

/**
 * Markdown → TipTap doc, constrained to the richtext editor schema (StarterKit
 * heading 2/3 + lists/quote/code + Link). Agents send Markdown to richtext
 * fields (set_field is a plain string); wrapping it as literal plaintext
 * rendered "#", "**", "-" verbatim (2026-06-07). Pragmatic — common Markdown,
 * not full CommonMark — and the sanitizer normalises whatever this produces.
 */
function markdownToTiptapDoc(src: string): unknown {
  const lines = String(src).replace(/\r\n?/g, "\n").split("\n");
  const out: Array<Record<string, unknown>> = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      i++;
      continue;
    }
    if (/^```/.test(line.trim())) {
      i++;
      const buf: string[] = [];
      while (i < lines.length && !/^```/.test(lines[i]!.trim())) buf.push(lines[i++]!);
      i++; // closing fence
      out.push({ type: "codeBlock", content: buf.length ? [{ type: "text", text: buf.join("\n") }] : [] });
      continue;
    }
    if (MD_HR.test(line)) {
      out.push({ type: "horizontalRule" });
      i++;
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = Math.min(Math.max(h[1]!.length, 2), 3); // editor schema: heading 2/3
      out.push({ type: "heading", attrs: { level }, content: mdInline(h[2]!.trim()) });
      i++;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) buf.push(lines[i++]!.replace(/^>\s?/, ""));
      out.push({ type: "blockquote", content: [{ type: "paragraph", content: mdInline(buf.join("\n")) }] });
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: Array<Record<string, unknown>> = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i]!)) {
        items.push({ type: "listItem", content: [{ type: "paragraph", content: mdInline(lines[i++]!.replace(/^\s*[-*+]\s+/, "")) }] });
      }
      out.push({ type: "bulletList", content: items });
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: Array<Record<string, unknown>> = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i]!)) {
        items.push({ type: "listItem", content: [{ type: "paragraph", content: mdInline(lines[i++]!.replace(/^\s*\d+\.\s+/, "")) }] });
      }
      out.push({ type: "orderedList", content: items });
      continue;
    }
    // Paragraph: gather consecutive lines until a blank line or a block start.
    const buf = [line];
    i++;
    while (i < lines.length && lines[i]!.trim() !== "" && !MD_BLOCK_START.test(lines[i]!) && !MD_HR.test(lines[i]!)) {
      buf.push(lines[i++]!);
    }
    out.push({ type: "paragraph", content: mdInline(buf.join("\n")) });
  }
  return { type: "doc", content: out.length ? out : [{ type: "paragraph", content: [] }] };
}
function looksLikeTiptapDoc(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return o.type === "doc" || Array.isArray(o.content);
}
/* ---------------------- richtext (TipTap) sanitization -------------------- */
// The admin RichTextEditor is StarterKit (heading 2/3) + Link. ProseMirror
// hard-rejects ANY doc containing a node/mark type outside that schema, an
// empty text node, or content violating a node's content model — and TipTap
// then falls back to an EMPTY editor: one bad node blanks the whole document
// in the admin while delivery still renders it (and the next save from that
// editor would wipe the field). Agent-written docs reliably contain such nodes
// ({type:"separator"}, {text:""}, snake_case PM names), so every richtext
// write is normalized to the editor's schema here. Real incidents: an MCP
// write with `{"text":""}` and another with `{"type":"separator"}` each
// blanked the editor for the whole page.
const RICHTEXT_NODES = new Set([
  "doc", "paragraph", "text", "heading", "blockquote", "bulletList",
  "orderedList", "listItem", "codeBlock", "horizontalRule", "hardBreak",
  "image", // block-level <img> (drag a media asset into the editor)
]);
const RICHTEXT_MARKS = new Set(["bold", "italic", "strike", "code", "underline", "link"]);
// Unknown-but-unambiguous spellings agents produce → the canonical type.
const NODE_ALIASES: Record<string, string> = {
  separator: "horizontalRule", divider: "horizontalRule", hr: "horizontalRule",
  horizontal_rule: "horizontalRule", bullet_list: "bulletList", ordered_list: "orderedList",
  list_item: "listItem", code_block: "codeBlock", hard_break: "hardBreak", break: "hardBreak",
  img: "image", picture: "image",
};
const MARK_ALIASES: Record<string, string> = {
  strong: "bold", b: "bold", em: "italic", i: "italic",
  strikethrough: "strike", s: "strike", u: "underline", a: "link", hyperlink: "link",
};
const INLINE_NODES = new Set(["text", "hardBreak"]);
const VOID_NODES = new Set(["horizontalRule", "hardBreak", "image"]);
/** Parents whose content model is inline-only / block-only / listItem-only. */
const INLINE_PARENTS = new Set(["paragraph", "heading"]);
const BLOCK_PARENTS = new Set(["doc", "blockquote", "listItem"]);
const LIST_PARENTS = new Set(["bulletList", "orderedList"]);

type RtNode = Record<string, unknown>;

/** Collect the inline (text/hardBreak) descendants of arbitrarily-nested nodes. */
function inlineDescendants(nodes: RtNode[]): RtNode[] {
  const out: RtNode[] = [];
  for (const n of nodes) {
    if (INLINE_NODES.has(n.type as string)) out.push(n);
    else if (Array.isArray(n.content)) out.push(...inlineDescendants(n.content as RtNode[]));
  }
  return out;
}

/** True when an image node carries a usable src (PM requires the attribute). */
function validImage(n: RtNode): boolean {
  const src = (n.attrs as RtNode | undefined)?.src;
  return typeof src === "string" && src !== "";
}

/** Collect valid image descendants of RAW (pre-sanitize) nodes, aliased. */
function collectImages(children: unknown): RtNode[] {
  if (!Array.isArray(children)) return [];
  const out: RtNode[] = [];
  for (const raw of children) {
    if (!raw || typeof raw !== "object") continue;
    const n = raw as RtNode;
    const t = NODE_ALIASES[(n.type as string) ?? ""] ?? n.type;
    if (t === "image") {
      if (validImage(n)) {
        const img: RtNode = { ...n, type: "image" };
        delete img.content;
        // Same mark treatment as the per-node pass — a hoisted image must be
        // byte-identical to what re-sanitizing would produce (fixpoint).
        if (Array.isArray(img.marks)) {
          img.marks = (img.marks as RtNode[])
            .filter((m) => m && typeof m === "object")
            .map((m) => ({ ...m, type: MARK_ALIASES[m.type as string] ?? m.type }))
            .filter((m) => RICHTEXT_MARKS.has(m.type as string));
          if (!(img.marks as RtNode[]).length) delete img.marks;
        }
        out.push(img);
      }
    } else {
      out.push(...collectImages(n.content));
    }
  }
  return out;
}

/** Sanitize a node list against the parent's content model. Returns a clean list. */
function sanitizeRichTextNodes(children: unknown, parentType: string): RtNode[] {
  if (!Array.isArray(children)) return [];
  // Pass 1 — per node: alias types, drop unknown marks, strip empty text nodes,
  // recurse, and salvage the children of unknown node types (drop the husk;
  // ONE unknown husk would otherwise blank the entire document in the editor).
  let nodes: RtNode[] = [];
  for (const raw of children) {
    if (!raw || typeof raw !== "object") continue;
    const node: RtNode = { ...(raw as RtNode) };
    const rawType = typeof node.type === "string" ? node.type : "";
    const type = NODE_ALIASES[rawType] ?? rawType;
    node.type = type;
    if (Array.isArray(node.marks)) {
      node.marks = (node.marks as RtNode[])
        .filter((m) => m && typeof m === "object")
        .map((m) => ({ ...m, type: MARK_ALIASES[m.type as string] ?? m.type }))
        .filter((m) => RICHTEXT_MARKS.has(m.type as string));
    }
    if (type === "text") {
      // PM forbids empty text nodes; a text node never has content.
      if (typeof node.text !== "string" || node.text === "") continue;
      delete node.content;
      nodes.push(node);
      continue;
    }
    if (type === "image") {
      // PM requires the src attribute; a srcless image invalidates the doc.
      if (!validImage(node)) continue;
      delete node.content;
      nodes.push(node);
      continue;
    }
    if (VOID_NODES.has(type)) delete node.content;
    else node.content = sanitizeRichTextNodes(node.content, type);
    if (RICHTEXT_NODES.has(type)) {
      nodes.push(node);
      // Images can't live inside inline-only parents (paragraph/heading) and
      // would be silently dropped by the content-model pass — hoist them out
      // as block-level siblings instead.
      if (INLINE_PARENTS.has(type)) nodes.push(...collectImages((raw as RtNode).content));
    } else {
      // Unknown type: hoist its (already-sanitized) children into this position.
      const inner = (node.content as RtNode[] | undefined) ?? [];
      if (typeof node.text === "string" && node.text !== "") {
        nodes.push({ type: "text", text: node.text, ...(node.marks ? { marks: node.marks } : {}) });
      } else if (inner.length && inner.every((c) => INLINE_NODES.has(c.type as string))) {
        nodes.push({ type: "paragraph", content: inner });
      } else {
        nodes.push(...inner);
      }
    }
  }
  // Pass 2 — shape to the parent's content model (a structure violation also
  // makes PM reject the whole doc, e.g. a paragraph inside a paragraph).
  if (parentType === "codeBlock") {
    // code blocks allow text only, without marks
    return inlineDescendants(nodes)
      .filter((n) => n.type === "text")
      .map((n) => ({ type: "text", text: n.text }));
  }
  if (INLINE_PARENTS.has(parentType)) {
    // inline content only: flatten any block child to its inline descendants
    return nodes.flatMap((n) => (INLINE_NODES.has(n.type as string) ? [n] : inlineDescendants([n])));
  }
  if (LIST_PARENTS.has(parentType)) {
    // listItem children only: wrap loose blocks / inline runs. Empty containers
    // are dropped BEFORE wrapping (a listItem holding only an empty blockquote
    // is PM-invalid — found by the property suite's fixpoint check).
    const items: RtNode[] = [];
    for (const n of nodes) {
      if (isEmptyContainer(n)) continue;
      if (n.type === "listItem") items.push(n);
      else if (INLINE_NODES.has(n.type as string)) items.push({ type: "listItem", content: [{ type: "paragraph", content: [n] }] });
      else items.push({ type: "listItem", content: [n] });
    }
    return items.filter((i) => (i.content as RtNode[]).length > 0);
  }
  if (BLOCK_PARENTS.has(parentType)) {
    // block content only: group consecutive loose inline nodes into paragraphs,
    // drop block containers that ended up empty (PM requires block+), and wrap
    // loose listItems in a list (a bare listItem under doc/blockquote is
    // PM-invalid — found by the property suite's fixpoint check). Consecutive
    // loose items merge into one bulletList.
    const out: RtNode[] = [];
    let run: RtNode[] = [];
    const flush = () => {
      if (run.length) out.push({ type: "paragraph", content: run });
      run = [];
    };
    for (const n of nodes) {
      if (INLINE_NODES.has(n.type as string)) run.push(n);
      else {
        flush();
        if (isEmptyContainer(n)) continue;
        if (n.type === "listItem") {
          const prev = out[out.length - 1];
          if (prev && prev.type === "bulletList") (prev.content as RtNode[]).push(n);
          else out.push({ type: "bulletList", content: [n] });
        } else {
          out.push(n);
        }
      }
    }
    flush();
    return out;
  }
  return nodes;
}

/** A block container PM rejects when empty (block+ content model). */
function isEmptyContainer(n: RtNode): boolean {
  return (
    (n.type === "blockquote" || n.type === "listItem" || LIST_PARENTS.has(n.type as string)) &&
    !(n.content as RtNode[] | undefined)?.length
  );
}

/** Normalize a TipTap doc to the shape the admin editor can actually load. */
function sanitizeRichTextDoc(doc: unknown): unknown {
  const o = doc as RtNode;
  const content = sanitizeRichTextNodes(o.content, "doc");
  // The fallback paragraph carries content: [] like every sanitized paragraph,
  // so sanitize(sanitize(x)) === sanitize(x) exactly (single-pass fixpoint).
  return { ...o, type: "doc", content: content.length ? content : [{ type: "paragraph", content: [] }] };
}

/** Looks like a BCP-47-ish locale code ("en", "nb", "en-US", "nb-NO"). */
const LOCALE_KEY = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;
/**
 * Short keys that MATCH the locale regex but are payload vocabulary, never
 * locales. Without this, {url: "/x.png"} on an image field was locale-unwrapped
 * into a bare string that persisted as a (bogus) documentId — found by the
 * property suite; real garbage-in-success-out.
 */
const NOT_LOCALE_KEYS = new Set(["url", "uri", "src", "alt", "ref", "rel", "img", "tag", "val", "raw"]);

/**
 * Single-key wrapper objects agents invent around a plain string. Observed
 * verbatim in a 2026-06-04 production run (three rejects in a row):
 * {type:'text', text:'X'} → {text:'X'} → {raw:'X'}. The inner string is
 * unambiguous — unwrap it. Only an optional `type` tag (string) may accompany
 * the single carrier key; anything else is NOT meaning-preserving and falls
 * through to the validation error.
 */
const TEXT_CARRIER_KEYS = new Set(["text", "value", "raw", "content", "markdown"]);
function unwrapTextCarrier(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const obj = value as Record<string, unknown>;
  if ("type" in obj && typeof obj.type !== "string") return value;
  const carriers = Object.keys(obj).filter((k) => k !== "type");
  if (carriers.length !== 1) return value;
  const k = carriers[0]!;
  return TEXT_CARRIER_KEYS.has(k) && typeof obj[k] === "string" ? obj[k] : value;
}

/**
 * Be liberal in what we accept (Postel's law) for the field-shape mistakes an
 * LLM agent reliably makes — coerced BEFORE validation. Conservative: only
 * unambiguous fixes; genuinely broken input still falls through to the helpful
 * validation error rather than being silently mangled.
 *  - any field wrapped as { <fieldName>: inner }  → inner  (self-keyed wrap)
 *  - any field wrapped as { <locale>: inner }     → inner  (locale-map wrap —
 *    the locale is selected by the request's locale param, never by the value;
 *    a real MCP agent burned 12 attempts on this one)
 *  - text/markdown/select/datetime/image given a single-key carrier → the
 *    inner string ({text}, {type:'text',text}, {value}, {type:'select',value},
 *    {raw}, {content}, {markdown})
 *  - text given a TipTap doc                      → plain text (blocks separated)
 *  - markdown given a TipTap doc                  → real Markdown (structure kept)
 *  - richtext given a plain string                → wrapped into a doc
 *  - richtext docs outside the editor schema      → normalized (see sanitizeRichTextDoc)
 *  - contentArea given a single block object      → wrapped in an array
 *  - image/media given a resolved asset object    → its documentId string
 */
export function coerceFieldValue(f: FieldDef, value: unknown, locale?: string): unknown {
  if (value == null) return value;
  if (typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 1 && keys[0] === f.name) value = obj[f.name];
  }
  // Locale-map unwrap: {en: "..."} (agents copy the localized mental model into
  // the value). Unambiguous when the requested locale is a key, or when every
  // key is locale-shaped — no field type has locale-shaped object keys.
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length > 0 && keys.every((k) => LOCALE_KEY.test(k) && !NOT_LOCALE_KEYS.has(k))) {
      const picked = locale && locale in obj ? obj[locale] : keys.length === 1 ? obj[keys[0]!] : undefined;
      if (picked !== undefined) value = picked;
    }
  }
  switch (f.type) {
    case "text": {
      const v = unwrapTextCarrier(value);
      return looksLikeTiptapDoc(v) ? tiptapToPlainText(v) : v;
    }
    case "markdown": {
      const v = unwrapTextCarrier(value);
      // Structure-preserving: headings/lists/marks become Markdown syntax.
      return looksLikeTiptapDoc(v) ? tiptapToMarkdown(v) : v;
    }
    case "richtext": {
      // A string is Markdown (agents send set_field strings) — parse its
      // structure into TipTap, don't wrap it as literal plaintext.
      const doc = typeof value === "string" ? markdownToTiptapDoc(value) : value;
      return looksLikeTiptapDoc(doc) ? sanitizeRichTextDoc(doc) : doc;
    }
    case "contentArea":
      return value && typeof value === "object" && !Array.isArray(value) && "blockType" in (value as object) ? [value] : value;
    case "select":
    case "datetime":
      // Same carrier family on scalar fields — a real agent sent
      // {type:'select', value:'article'} / {type:'datetime', value:'…Z'} and
      // looped 8× on the reject (2026-06-07 13:0x run).
      return unwrapTextCarrier(value);
    case "image":
    case "media": {
      // {type:'image', value:'<assetId>'} — same run, same carrier family.
      const unwrapped = unwrapTextCarrier(value);
      // Agents also copy the RESOLVED read shape ({documentId, url, alt}) back
      // into a write — the write format is the asset documentId string.
      const id =
        unwrapped && typeof unwrapped === "object" ? (unwrapped as { documentId?: unknown }).documentId : undefined;
      return typeof id === "string" && id ? id : unwrapped;
    }
    default:
      return value;
  }
}

export function coerceData(type: ContentTypeDef, data: Record<string, unknown>, locale?: string): Record<string, unknown> {
  const out: Record<string, unknown> = { ...data };
  for (const f of type.fields) if (f.name in out) out[f.name] = coerceFieldValue(f, out[f.name], locale);
  return out;
}

function applyStringValidation(base: z.ZodString, f: FieldDef, strict: boolean): z.ZodTypeAny {
  if (!strict || !f.validation) return base;
  let s = base;
  if (f.validation.minLength != null) s = s.min(f.validation.minLength);
  if (f.validation.maxLength != null) s = s.max(f.validation.maxLength);
  if (f.validation.pattern) {
    try {
      s = s.regex(new RegExp(f.validation.pattern));
    } catch {
      /* an invalid stored pattern must not crash validation */
    }
  }
  return s;
}

function applyNumberValidation(base: z.ZodNumber, f: FieldDef, strict: boolean): z.ZodTypeAny {
  if (!strict || !f.validation) return base;
  let s = base;
  if (f.validation.min != null) s = s.min(f.validation.min);
  if (f.validation.max != null) s = s.max(f.validation.max);
  return s;
}

export const LOCALE_FALLBACK_MARKER = "__fallback__" as const;
