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
  /** For select: allow choosing more than one option (value is then an array). */
  multiple: z.boolean().default(false),
  /** Optional per-field validation rules (text length, number range, regex). */
  validation: FieldValidation.optional(),
  /** Tab/group in the All-Properties editor. */
  group: z.string().min(1).max(60).default("Content"),
  helpText: z.string().max(300).optional(),
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
  })
  // Field names must be unique within a type (else dataSchemaFor / delivery collide).
  .refine(
    (t) => new Set(t.fields.map((f) => f.name)).size === t.fields.length,
    { message: "Field names must be unique within a content type", path: ["fields"] },
  );
export type ContentTypeDef = z.infer<typeof ContentTypeDef>;

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
        s = z.record(z.unknown()); // TipTap JSON document
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
        const one: z.ZodTypeAny =
          strict && values.length ? z.string().refine((v) => values.includes(v), "Invalid option") : z.string();
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
// Flatten a TipTap doc (or any nested {text,content}) to plain text.
function tiptapToPlainText(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(tiptapToPlainText).join("");
  const o = node as { text?: string; content?: unknown };
  let s = typeof o.text === "string" ? o.text : "";
  if (o.content != null) s += tiptapToPlainText(o.content);
  return s;
}
// Wrap a plain (possibly multi-paragraph) string into a TipTap doc.
function stringToTiptapDoc(s: string): unknown {
  const paras = s.split(/\n{2,}/).map((para) => ({
    type: "paragraph",
    content: para ? [{ type: "text", text: para }] : [],
  }));
  return { type: "doc", content: paras.length ? paras : [{ type: "paragraph" }] };
}
function looksLikeTiptapDoc(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return o.type === "doc" || Array.isArray(o.content);
}

/**
 * Be liberal in what we accept (Postel's law) for the field-shape mistakes an
 * LLM agent reliably makes — coerced BEFORE validation. Conservative: only
 * unambiguous fixes; genuinely broken input still falls through to the helpful
 * validation error rather than being silently mangled.
 *  - any field wrapped as { <fieldName>: inner }  → inner  (self-keyed wrap)
 *  - text/markdown given a TipTap doc             → flattened to plain text
 *  - richtext given a plain string                → wrapped into a doc
 *  - contentArea given a single block object      → wrapped in an array
 */
export function coerceFieldValue(f: FieldDef, value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value as object);
    if (keys.length === 1 && keys[0] === f.name) value = (value as Record<string, unknown>)[f.name];
  }
  switch (f.type) {
    case "text":
    case "markdown":
      return looksLikeTiptapDoc(value) ? tiptapToPlainText(value) : value;
    case "richtext":
      return typeof value === "string" ? stringToTiptapDoc(value) : value;
    case "contentArea":
      return value && typeof value === "object" && !Array.isArray(value) && "blockType" in (value as object) ? [value] : value;
    default:
      return value;
  }
}

export function coerceData(type: ContentTypeDef, data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...data };
  for (const f of type.fields) if (f.name in out) out[f.name] = coerceFieldValue(f, out[f.name]);
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
