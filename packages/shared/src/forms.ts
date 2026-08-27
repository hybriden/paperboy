import { z } from "zod";
import safe from "safe-regex";
import type { BlockTypeResolver } from "./content-types.js";

/**
 * Forms: the normalized spec, the submission validator, and the invisible spam
 * heuristics. ONE authority, used by three surfaces:
 *
 *  - delivery attaches the spec to a delivered Form block, so a frontend
 *    renders from a flat contract instead of interpreting block payloads
 *    (Optimizely's first headless forms API shipped pre-rendered HTML in its
 *    JSON and frontends could never restyle it — deliver the schema, never
 *    markup);
 *  - the public submit endpoint recomputes the spec from the CURRENT published
 *    definition and validates against it, so the declaration that renders the
 *    form is the thing the server enforces. Payload's form builder trusts the
 *    frontend instead and closed that gap "not planned"; Storyblok's tutorials
 *    make CMS-declared validation a suggestion the client re-implements. Both
 *    are the same bug: a contract nobody enforces.
 *  - the admin reads it to preview what visitors will see.
 */

/* ------------------------------- the spec -------------------------------- */

export const FORM_FIELD_KINDS = [
  "text", "email", "textarea", "number", "date",
  "select", "radio", "checkbox", "consent", "static",
] as const;
export type FormFieldKind = (typeof FORM_FIELD_KINDS)[number];

/** Which block type provides which kind of field. */
const BLOCK_KIND: Record<string, FormFieldKind> = {
  FormTextField: "text",
  FormEmailField: "email",
  FormTextareaField: "textarea",
  FormNumberField: "number",
  FormDateField: "date",
  FormSelectField: "select",
  FormRadioField: "radio",
  FormCheckboxField: "checkbox",
  FormConsentField: "consent",
  FormStaticText: "static",
};

export interface FormChoice {
  value: string;
  label: string;
}

/** One rendered field. `name` is "" for `static`, which collects no answer. */
export interface FormFieldSpec {
  kind: FormFieldKind;
  name: string;
  label: string;
  required: boolean;
  helpText?: string;
  placeholder?: string;
  errorMessage?: string;
  rows?: number;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  choices?: FormChoice[];
  /** static only: optional small heading and its rich-text body. */
  heading?: string;
  text?: unknown;
}

export interface FormSpec {
  title: string;
  intro?: unknown;
  fields: FormFieldSpec[];
  submitLabel: string;
  confirmation: "message" | "redirect";
  confirmationText?: unknown;
  redirectTo?: { href: string; text?: string } | null;
  /** Whether the visitor must pass a Turnstile challenge. */
  turnstile: boolean;
  /** The hidden field a bot fills in and a human never sees. */
  honeypotField: string;
  /** Minimum milliseconds between render and submit for a human. */
  minFillMs: number;
}

/* ---------------------------- spam heuristics -----------------------------
 * Free, invisible, and accessible — a honeypot input hidden from assistive
 * technology plus a minimum fill time. Neither Optimizely Forms nor Umbraco
 * Forms ships a honeypot, and both major CAPTCHA vendors are documented as
 * failing WCAG 1.1.1 in practice, so this is the default and a challenge is
 * the opt-in escalation.
 */

/** Name of the hidden input. Deliberately plausible: bots fill what looks real. */
export const HONEYPOT_FIELD = "pb_contact_reason";

/** Below this, the "visitor" typed a whole form in under two and a half
 *  seconds. Generous enough for a one-field form with autofill. */
export const MIN_FILL_MS = 2500;

/** A submission older than this had its page open for hours — usually a stale
 *  tab, occasionally a replay. Accepted, but the timing check can't vouch for it. */
export const MAX_FILL_MS = 12 * 60 * 60 * 1000;

export type SpamVerdict = { ok: true } | { ok: false; reason: "honeypot" | "too_fast" };

/** The invisible checks. Runs before validation: a bot's payload should cost
 *  us nothing. Returns a reason for the audit trail, never for the visitor —
 *  telling a bot which check caught it just helps it try again. */
export function checkSpamHeuristics(input: { honeypot?: unknown; elapsedMs?: unknown }): SpamVerdict {
  const hp = input.honeypot;
  if (typeof hp === "string" && hp.trim() !== "") return { ok: false, reason: "honeypot" };
  const elapsed = typeof input.elapsedMs === "number" ? input.elapsedMs : Number(input.elapsedMs);
  // A missing/garbled timer is not evidence of a bot (JS-disabled, cached
  // page); only a present-and-implausibly-fast one is.
  if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < MIN_FILL_MS) return { ok: false, reason: "too_fast" };
  return { ok: true };
}

/* --------------------------- building the spec ---------------------------- */

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
};
const bool = (v: unknown): boolean => v === true || v === "true" || v === "on" || v === 1;

/**
 * Parse the editor's option list. One per line; `value|Label` splits the stored
 * value from the shown label, a bare line is used as both. A markdown field is
 * the one multi-line text input Paperboy has, which is why options are authored
 * this way rather than as a nested block per option — one textarea beats ten
 * blocks for a ten-item dropdown.
 */
export function parseChoices(raw: unknown): FormChoice[] {
  return str(raw)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => {
      const bar = line.indexOf("|");
      if (bar === -1) return { value: line, label: line };
      const value = line.slice(0, bar).trim();
      const label = line.slice(bar + 1).trim();
      return { value: value || label, label: label || value };
    })
    .filter((c) => c.value !== "");
}

/** One block → one field spec, or null when the block isn't a form field. */
export function fieldSpecFromBlock(blockType: string, inline: Record<string, unknown>): FormFieldSpec | null {
  const kind = BLOCK_KIND[blockType];
  if (!kind) return null;

  if (kind === "static") {
    return { kind, name: "", label: "", required: false, heading: str(inline.heading) || undefined, text: inline.text ?? undefined };
  }

  const name = str(inline.name).trim();
  if (!name) return null; // a field with no key can't store an answer — drop it rather than deliver a broken input

  const base: FormFieldSpec = {
    kind,
    name,
    label: str(inline.label),
    // Consent is meaningless if it can be skipped; the checkbox is always required.
    required: kind === "consent" ? true : bool(inline.required),
    helpText: str(inline.helpText) || undefined,
    placeholder: str(inline.placeholder) || undefined,
    errorMessage: str(inline.errorMessage) || undefined,
  };

  if (kind === "text" || kind === "textarea") {
    base.minLength = num(inline.minLength);
    base.maxLength = num(inline.maxLength);
    base.pattern = str(inline.pattern) || undefined;
    if (kind === "textarea") base.rows = num(inline.rows) ?? 5;
  }
  if (kind === "number") {
    base.min = num(inline.min);
    base.max = num(inline.max);
  }
  if (kind === "select" || kind === "radio") base.choices = parseChoices(inline.choices);
  return base;
}

/**
 * Build the spec from a Form block's own data. `resolveBlock` is only needed
 * for shared (referenced) field blocks; inline fields carry their own payload.
 */
export function formSpecFrom(
  data: Record<string, unknown>,
  opts: { sharedBlock?: (documentId: string) => { blockType: string; data: Record<string, unknown> } | undefined } = {},
): FormSpec {
  const area = Array.isArray(data.fields) ? data.fields : [];
  const fields: FormFieldSpec[] = [];
  const seen = new Set<string>();
  for (const raw of area) {
    if (!raw || typeof raw !== "object") continue;
    const b = raw as { blockType?: unknown; inline?: unknown; data?: unknown; ref?: unknown };
    let blockType = typeof b.blockType === "string" ? b.blockType : "";
    // `inline` is the STORED shape; `data` is the DELIVERED shape (delivery
    // serializes an inline block as { blockType, data, fieldTypes }). The spec
    // is computed on both sides of that boundary, so accept either.
    const payload = b.inline ?? b.data;
    let inline = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
    if (!inline && typeof b.ref === "string" && opts.sharedBlock) {
      const shared = opts.sharedBlock(b.ref);
      if (shared) {
        blockType = shared.blockType;
        inline = shared.data;
      }
    }
    if (!inline) continue;
    const spec = fieldSpecFromBlock(blockType, inline);
    if (!spec) continue;
    // Two fields with one key would silently overwrite each other's answer.
    if (spec.name && seen.has(spec.name)) continue;
    if (spec.name) seen.add(spec.name);
    fields.push(spec);
  }

  const confirmation = str(data.confirmation) === "redirect" ? "redirect" : "message";
  const link = data.redirectTo && typeof data.redirectTo === "object" ? (data.redirectTo as { href?: unknown; text?: unknown }) : null;
  return {
    title: str(data.title),
    intro: data.intro ?? undefined,
    fields,
    submitLabel: str(data.submitLabel) || "Send",
    confirmation,
    confirmationText: data.confirmationText ?? undefined,
    redirectTo: link && typeof link.href === "string" ? { href: link.href, text: typeof link.text === "string" ? link.text : undefined } : null,
    turnstile: str(data.spamProtection) === "heuristics+turnstile",
    honeypotField: HONEYPOT_FIELD,
    minFillMs: MIN_FILL_MS,
  };
}

/* ------------------------- validating a submission ------------------------ */

/** Hard ceiling per answer, so a form without a maxLength can't be used to
 *  store megabytes. Generous for a long message, cheap to store. */
export const MAX_ANSWER_LENGTH = 5000;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Coerce raw submitted values before validation — HTML forms are all strings,
 * and a checkbox arrives as "on". Meaning-preserving only, per rule #3: a
 * number-shaped string becomes a number, everything ambiguous is left alone to
 * be REJECTED by the validator rather than guessed at.
 */
export function coerceSubmissionValues(spec: FormSpec, raw: Record<string, unknown>): Record<string, unknown> {
  // Start from what was sent — including keys this form has never heard of, so
  // the strict schema can reject them. Silently dropping an answer here would
  // be exactly the garbage-in-success-out failure rule #1 forbids.
  const out: Record<string, unknown> = { ...raw };
  for (const f of spec.fields) {
    if (f.kind === "static" || !(f.name in raw)) continue;
    const v = raw[f.name];
    switch (f.kind) {
      case "number": {
        const n = num(v);
        out[f.name] = n ?? v;
        break;
      }
      case "checkbox":
      case "consent":
        out[f.name] = v === "" || v == null ? false : bool(v);
        break;
      default:
        out[f.name] = typeof v === "string" ? v.trim() : v;
    }
    // A blank answer to an OPTIONAL field means "not answered", so the key is
    // dropped rather than run through that field's type check.
    //
    // Every real browser form submits each control it renders — apps/web sends
    // `data.get(name) ?? ""` for every non-checkbox field, and a select's
    // placeholder option is value="" — so "" is the shape a SKIPPED field
    // actually arrives in. The compiled validator's optional branch accepts
    // undefined and null but not "", so an optional email, number, select or
    // pattern field answered 422 to every visitor who left it blank, with a
    // message that never said the field was optional.
    //
    // Required fields KEEP their blank: the presence refine is what speaks the
    // editor's own "is required" copy. And only DECLARED fields are dropped —
    // an unknown key stays, blank or not, for the strict schema to reject.
    if (!f.required && out[f.name] === "") delete out[f.name];
  }
  return out;
}

/**
 * Compile the validator from the spec. Unknown keys are REJECTED, not stripped:
 * a frontend sending a field this form doesn't have is either stale or hostile,
 * and silently dropping the answer is the "success with data loss" outcome
 * rule #1 exists to prevent.
 */
export function submissionSchemaFor(spec: FormSpec): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const f of spec.fields) {
    if (f.kind === "static") continue;
    const message = f.errorMessage;
    /**
     * The message for "no answer at all".
     *
     * A missing key fails the base TYPE check ("expected string, received
     * undefined") before any refine runs, so the presence refine below could
     * never speak for it — a visitor who forgot a field got Zod's wording
     * instead of the editor's, in the one case where the message matters most.
     * Passing it to the base type covers that path; the refine still covers a
     * present-but-empty answer. Only for REQUIRED fields: on an optional one,
     * "is required" would be a lie.
     */
    const missing = f.required ? (message ?? `"${f.label || f.name}" is required.`) : message;
    let s: z.ZodTypeAny;
    switch (f.kind) {
      case "email": {
        let e = z.string({ message: missing }).max(MAX_ANSWER_LENGTH);
        e = e.regex(EMAIL_RE, message ?? `Enter a valid email address for "${f.label || f.name}".`);
        s = e;
        break;
      }
      case "number": {
        let n = z.number({ message: missing ?? `"${f.label || f.name}" must be a number.` });
        if (f.min != null) n = n.min(f.min, message ?? `"${f.label || f.name}" must be ${f.min} or more.`);
        if (f.max != null) n = n.max(f.max, message ?? `"${f.label || f.name}" must be ${f.max} or less.`);
        s = n;
        break;
      }
      case "date":
        s = z.string({ message: missing }).max(40).refine((v) => v === "" || !Number.isNaN(Date.parse(v)), {
          message: message ?? `Enter a valid date for "${f.label || f.name}".`,
        });
        break;
      case "checkbox":
        s = z.boolean();
        break;
      case "consent":
        // Required means required: an unticked consent box is a failed submission.
        s = z.literal(true, { message: message ?? `Please confirm "${f.label || f.name}" to continue.` });
        break;
      case "select":
      case "radio": {
        const values = (f.choices ?? []).map((c) => c.value);
        s = values.length
          ? z.string({ message: missing }).refine((v) => values.includes(v), {
              message: message ?? `Choose one of: ${values.join(", ")}.`,
            })
          : z.string({ message: missing }).max(MAX_ANSWER_LENGTH);
        break;
      }
      default: {
        let t = z.string({ message: missing }).max(f.maxLength ?? MAX_ANSWER_LENGTH, message ?? `"${f.label || f.name}" is too long (max ${f.maxLength ?? MAX_ANSWER_LENGTH} characters).`);
        if (f.minLength != null) t = t.min(f.minLength, message ?? `"${f.label || f.name}" must be at least ${f.minLength} characters.`);
        // Compile the pattern ONLY if it is ReDoS-safe. A catastrophic-backtracking
        // pattern (accidental or hostile) would block the event loop for the whole
        // instance on one anonymous submit — the answer-length cap does not bound
        // that (backtracking is exponential; Zod runs .regex() even after .max()
        // fails). An unsafe OR invalid pattern is simply not enforced, the same
        // fail-open-for-the-visitor choice the invalid case already made.
        if (f.pattern && safe(f.pattern)) {
          try {
            t = t.regex(new RegExp(f.pattern), message ?? `"${f.label || f.name}" is not in the expected format.`);
          } catch {
            /* an invalid stored pattern must never gate a real visitor */
          }
        }
        s = t;
      }
    }

    if (f.required) {
      // An empty string satisfies z.string() but not a required question.
      //
      shape[f.name] = f.kind === "checkbox"
        ? z.literal(true, { message: message ?? `"${f.label || f.name}" is required.` })
        : s.refine((v) => v !== "" && v !== null && v !== undefined, {
            message: message ?? `"${f.label || f.name}" is required.`,
          });
    } else {
      shape[f.name] = s.optional().nullable();
    }
  }
  return z.object(shape).strict() as unknown as z.ZodType<Record<string, unknown>>;
}

/** Field-keyed errors, the shape the endpoint returns and a frontend renders
 *  next to each input (WCAG 3.3.1 wants the error identified per field). */
export function submissionErrors(err: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of err.issues) {
    const key = issue.path.length ? String(issue.path[0]) : "_form";
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}

/**
 * What gets stored alongside the answers: the label and kind of every field AS
 * ANSWERED. A submission must stay readable after the form is edited — Payload
 * stores rows pointing at mutable field definitions and Strapi keys its blob by
 * label, so renaming a label rewrites history in one and breaks it in the other.
 * For consent this is the evidence itself: the exact wording that was agreed to.
 */
export function fieldSnapshot(spec: FormSpec): { name: string; label: string; kind: FormFieldKind }[] {
  return spec.fields
    .filter((f) => f.kind !== "static" && f.name)
    .map((f) => ({ name: f.name, label: f.label, kind: f.kind }));
}

/** True when this content type is the Form block. Kept here so no surface
 *  hardcodes the name in a second place. */
export const FORM_TYPE_NAME = "Form";
export function isFormType(typeName: string): boolean {
  return typeName === FORM_TYPE_NAME;
}

/** Is this a form FIELD block type? (Used to keep field payloads public.) */
export function isFormFieldType(typeName: string): boolean {
  return typeName in BLOCK_KIND;
}

/* --------------------------- authoring the form ---------------------------
 * A field key is an identifier the answer is stored under, and it is the first
 * control an editor meets on every field — the one genuinely technical step in
 * building a form. These two helpers let the admin remove it from the job:
 * derive the key from the label already typed, and name a collision out loud
 * instead of dropping the field in silence.
 */

/** Letters no NFKD decomposition recovers; the Nordic ones matter most here. */
const KEY_TRANSLITERATIONS: Record<string, string> = {
  æ: "ae", ø: "oe", å: "aa", ä: "ae", ö: "oe", ü: "ue", ß: "ss", ð: "d", þ: "th",
};

/**
 * `"Company name"` → `"companyName"`; `"Ønsket dato"` → `"oensketDato"`.
 *
 * Returns `""` when the label leaves nothing usable, so a caller can leave the
 * key alone rather than writing a broken one over it. The result always
 * satisfies FIELD_KEY_PATTERN (`^[a-zA-Z][a-zA-Z0-9_]*$`, max 60).
 */
export function fieldKeyFromLabel(label: string): string {
  const words = label
    .toLowerCase()
    .replace(/[æøåäöüßðþ]/g, (c) => KEY_TRANSLITERATIONS[c] ?? c)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip the accents NFKD just split off
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (words.length === 0) return "";
  const key = words.map((w, i) => (i === 0 ? w : w.replace(/^./, (c) => c.toUpperCase()))).join("");
  // A key must START with a letter, so a label like "1st choice" needs a lead.
  return (/^[0-9]/.test(key) ? `f${key}` : key).slice(0, 60);
}

/**
 * Field keys used by more than one field in a `fields` area.
 *
 * Two fields with one key would overwrite each other's answer, so
 * `formSpecFrom` keeps only the first. Unwarned, that reads to the editor as a
 * field they filled in and published that never appeared on the site — so the
 * admin shows this on every field involved, not just the dropped one: either of
 * them could be the mistake.
 */
export function duplicateFieldKeys(area: readonly unknown[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const raw of area) {
    if (!raw || typeof raw !== "object") continue;
    const b = raw as { blockType?: unknown; inline?: unknown; data?: unknown };
    if (typeof b.blockType !== "string" || !isFormFieldType(b.blockType)) continue;
    // `inline` is the stored shape, `data` the delivered one (see formSpecFrom).
    const payload = (b.inline ?? b.data) as Record<string, unknown> | null | undefined;
    if (!payload || typeof payload !== "object") continue;
    const key = typeof payload.name === "string" ? payload.name.trim() : "";
    // A blank key is the required-field validation's job, not a collision.
    if (!key) continue;
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
  }
  return duplicates;
}

/** Type-only re-export so callers can pass a resolver without importing both. */
export type { BlockTypeResolver };
