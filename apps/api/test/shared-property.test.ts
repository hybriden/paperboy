import fc from "fast-check";
import { describe, it } from "vitest";
import {
  type ContentTypeDef,
  type FieldDef,
  type FieldType,
  coerceData,
  coerceFieldValue,
  dataSchemaFor,
  detectContentLanguage,
} from "@paperboy/shared";

/**
 * Property-based hardening of the pure shared layer (no DB). These assert
 * INVARIANTS over generated adversarial input, not fixed cases: the coercion
 * chokepoint and the markdown/richtext/language helpers must never throw, never
 * hang, and never emit a structure the next layer (validation / the TipTap
 * editor / the publish guard) chokes on.
 */

const f = (type: FieldType, extra: Partial<FieldDef> = {}): FieldDef => ({
  name: "fld",
  displayName: "Fld",
  type,
  localized: false,
  required: false,
  delivery: "public",
  allowedBlocks: [],
  allowedTypes: [],
  options: [{ value: "a", label: "A" }, { value: "b", label: "B" }],
  multiple: false,
  group: "Content",
  ...extra,
});

const ALL_TYPES: FieldType[] = ["text", "markdown", "richtext", "boolean", "number", "datetime", "select", "link", "image", "media", "reference", "contentArea"];

describe("coerceFieldValue — property: never throws, terminates, sane output", () => {
  it("never throws for ANY field type × ANY JSON value", () => {
    fc.assert(
      fc.property(fc.constantFrom(...ALL_TYPES), fc.jsonValue(), fc.option(fc.string(), { nil: undefined }), (type, value, locale) => {
        coerceFieldValue(f(type), value as unknown, locale);
        return true;
      }),
      { numRuns: 2000 },
    );
  });

  it("never throws on deeply-nested wrapper objects (self-key / locale / carrier soup)", () => {
    const wrapperKey = fc.constantFrom("fld", "en", "nb", "en-US", "text", "value", "raw", "content", "markdown", "type", "documentId", "blockType");
    const nested = fc.letrec((tie) => ({
      node: fc.oneof(
        { depthSize: "small" },
        fc.string(),
        fc.dictionary(wrapperKey, tie("node"), { maxKeys: 3 }),
        fc.array(tie("node"), { maxLength: 3 }),
      ),
    })).node;
    fc.assert(
      fc.property(fc.constantFrom(...ALL_TYPES), nested, (type, value) => {
        const out = coerceFieldValue(f(type), value as unknown);
        return out === undefined ? value === undefined : true; // never invents undefined
      }),
      { numRuns: 2000 },
    );
  });

  it("text/markdown coercion yields a string or leaves a non-coercible object (never a partial primitive-wrapper)", () => {
    fc.assert(
      fc.property(fc.constantFrom<"text" | "markdown">("text", "markdown"), fc.jsonValue(), (type, value) => {
        const out = coerceFieldValue(f(type), value as unknown);
        // Acceptable outputs: a string, or an object/array/number/bool/null passed through.
        // The forbidden outcome is silently dropping to undefined when input wasn't undefined.
        if (value !== undefined && out === undefined) return false;
        return true;
      }),
      { numRuns: 1500 },
    );
  });
});

describe("richtext coercion (markdown→TipTap + sanitizer) — property", () => {
  const isDoc = (v: unknown) => !!v && typeof v === "object" && (v as { type?: string }).type === "doc" && Array.isArray((v as { content?: unknown }).content);

  it("any STRING → a valid TipTap doc with heading levels clamped to 2..3; never throws", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 4000 }), (s) => {
        const out = coerceFieldValue(f("richtext"), s) as { content?: Array<{ type?: string; attrs?: { level?: number } }> };
        if (!isDoc(out)) return false;
        for (const n of out.content ?? []) {
          if (n.type === "heading" && (n.attrs?.level ?? 2) !== 2 && n.attrs?.level !== 3) return false;
        }
        return true;
      }),
      { numRuns: 1500 },
    );
  });

  it("pathological markdown (marker soup, unbalanced, long runs) terminates fast — no ReDoS", () => {
    const evil = fc.oneof(
      fc.string({ unit: fc.constantFrom("*", "_", "[", "]", "(", ")", "`", "#", ">", "-", "\n", " "), maxLength: 6000 }),
      fc.integer({ min: 200, max: 5000 }).map((n) => "*".repeat(n)),
      fc.integer({ min: 200, max: 5000 }).map((n) => "[".repeat(n)),
      fc.integer({ min: 50, max: 800 }).map((n) => "**_`".repeat(n)),
    );
    fc.assert(
      fc.property(evil, (s) => {
        const start = Date.now();
        const out = coerceFieldValue(f("richtext"), s);
        return isDoc(out) && Date.now() - start < 500; // bounded — a backtracking spiral would blow past this
      }),
      { numRuns: 300 },
    );
  });

  it("sanitizer is a fixpoint on arbitrary doc-ish structures (incl. junk marks + deep nesting)", () => {
    const junkMark = fc.oneof(fc.constant(null), fc.constant(undefined), fc.integer(), fc.record({ type: fc.oneof(fc.string(), fc.integer(), fc.constant(null)) }, { requiredKeys: [] }));
    const docish = fc.letrec((tie) => ({
      node: fc.record(
        {
          type: fc.constantFrom("doc", "paragraph", "heading", "bulletList", "listItem", "blockquote", "codeBlock", "text", "image", "separator", "callout", "unknownThing"),
          text: fc.option(fc.string(), { nil: undefined }),
          attrs: fc.option(fc.record({ level: fc.integer({ min: 0, max: 9 }), src: fc.option(fc.webUrl(), { nil: undefined }) }, { requiredKeys: [] }), { nil: undefined }),
          marks: fc.option(fc.array(junkMark, { maxLength: 4 }), { nil: undefined }),
          content: fc.option(fc.array(tie("node"), { maxLength: 4 }), { nil: undefined }),
        },
        { requiredKeys: ["type"] },
      ),
    })).node;
    const arbDoc = fc.record({ type: fc.constant("doc"), content: fc.array(docish, { maxLength: 6 }) });
    fc.assert(
      fc.property(arbDoc, (doc) => {
        const once = coerceFieldValue(f("richtext"), doc);
        const twice = coerceFieldValue(f("richtext"), once);
        return isDoc(once) && JSON.stringify(once) === JSON.stringify(twice);
      }),
      { numRuns: 1000 },
    );
  });

  // FIDELITY — the 2026-06-07 "feilutformet body" class, generically: an agent
  // writes Markdown to a richtext field (set_field is a plain string) and the
  // old code wrapped it as LITERAL plaintext, so "##", "**" and "- " rendered
  // verbatim. This locks the whole class rather than one fixed example: for ANY
  // Markdown assembled from plain letter-words, the doc's visible text must keep
  // every word and contain NO leftover syntax markers. (Fails loudly on both the
  // literal-plaintext bug and any future regression that drops/glues content.)
  it("markdown→richtext preserves every word and leaves no literal syntax markers", () => {
    // Letter-only words (incl. æøå) can never themselves be a markdown marker,
    // so a marker in the rendered text can only be leaked syntax.
    const word = fc
      .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyzæøå".split("")), { minLength: 2, maxLength: 7 })
      .map((cs) => cs.join(""));
    const words = (min: number, max: number) => fc.array(word, { minLength: min, maxLength: max });
    const block = fc.oneof(
      fc.record({ kind: fc.constant("h"), ws: words(1, 4) }),
      fc.record({ kind: fc.constant("p"), ws: words(1, 8) }),
      fc.record({ kind: fc.constant("ul"), items: fc.array(words(1, 4), { minLength: 1, maxLength: 4 }) }),
      fc.record({ kind: fc.constant("ol"), items: fc.array(words(1, 4), { minLength: 1, maxLength: 4 }) }),
    );

    // Collect every text node's text, depth-first.
    const renderText = (node: unknown): string => {
      if (!node || typeof node !== "object") return "";
      const n = node as { type?: string; text?: string; content?: unknown[] };
      if (n.type === "text") return typeof n.text === "string" ? n.text : "";
      return Array.isArray(n.content) ? n.content.map(renderText).join(" ") : "";
    };

    fc.assert(
      fc.property(fc.array(block, { minLength: 1, maxLength: 6 }), (blocks) => {
        const expected: string[] = [];
        const md = blocks
          .map((b) => {
            if (b.kind === "h") {
              expected.push(...b.ws);
              return `## ${b.ws.join(" ")}`;
            }
            if (b.kind === "p") {
              expected.push(...b.ws);
              return b.ws.join(" ");
            }
            const bullet = b.kind === "ul";
            return b.items
              .map((it, i) => {
                expected.push(...it);
                return `${bullet ? "-" : `${i + 1}.`} ${it.join(" ")}`;
              })
              .join("\n");
          })
          .join("\n\n");

        const doc = coerceFieldValue(f("richtext"), md);
        if (!isDoc(doc)) return false;
        const rendered = renderText(doc).toLowerCase();

        // No markdown syntax leaked into the visible text.
        if (/[#*`>]/.test(rendered)) return false; // headings/bold/code/quote markers
        if (/(^|\s)[-+]\s/.test(rendered)) return false; // bullet markers
        if (/(^|\s)\d+\.\s/.test(rendered)) return false; // ordered-list markers

        // Every source word survives (no dropped or glued content).
        const tokens = new Set(rendered.split(/\s+/).filter(Boolean));
        return expected.every((w) => tokens.has(w));
      }),
      { numRuns: 1000 },
    );
  });
});

describe("detectContentLanguage — property: no false 'nb' (it gates the publish guard)", () => {
  const EN_WORDS = ["the", "and", "of", "to", "in", "is", "that", "it", "for", "with", "as", "are", "was", "this", "have", "from", "system", "service", "content", "model", "users", "about", "which", "will", "would", "page", "data", "build", "release"];

  it("never throws; long pure-English prose (even with a few æøå in names) is never classified nb", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...EN_WORDS), { minLength: 40, maxLength: 120 }),
        fc.integer({ min: 0, max: 2 }), // a few stray Norwegian chars (names, quotes)
        (words, accents) => {
          let text = words.join(" ") + ".";
          for (let i = 0; i < accents; i++) text += " Møller";
          const r = detectContentLanguage(text);
          return r === "en" || r === "unknown"; // crucially NOT "nb"
        },
      ),
      { numRuns: 800 },
    );
  });

  it("short texts are always 'unknown' (never block on thin evidence)", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...EN_WORDS, "og", "ikke", "det", "på"), { minLength: 0, maxLength: 20 }), (words) => {
        return detectContentLanguage(words.join(" ")) === "unknown";
      }),
      { numRuns: 400 },
    );
  });
});

describe("coerceData → dataSchemaFor(draft) — property: coerced output never throws on parse", () => {
  const ct = (fields: FieldDef[]): ContentTypeDef => ({ name: "T", displayName: "T", kind: "page", description: "", icon: "file", fields });
  it("draft validation never THROWS (it returns safeParse) on coerced plausible agent data", () => {
    const type = ct(ALL_TYPES.map((t, i) => f(t, { name: `f${i}` })));
    fc.assert(
      fc.property(
        fc.dictionary(fc.constantFrom(...type.fields.map((x) => x.name)), fc.jsonValue(), { maxKeys: 6 }),
        (data) => {
          const coerced = coerceData(type, data as Record<string, unknown>, "en");
          // safeParse must never throw (it returns {success}); a throw = a crash bug.
          const r = dataSchemaFor(type, false).safeParse(coerced);
          return typeof r.success === "boolean";
        },
      ),
      { numRuns: 1500 },
    );
  });
});
