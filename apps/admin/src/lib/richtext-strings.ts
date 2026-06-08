/**
 * Extract and re-insert the translatable text of a TipTap richtext document,
 * preserving its structure. The AI translate flow only knew how to translate
 * plain `text`/`markdown` fields, so it copied richtext fields (e.g. an article
 * `body`) verbatim — leaving the bulk of a page untranslated (2026-06-08).
 *
 * `collect` returns every text node's string in document order; `apply` walks an
 * IDENTICAL order and swaps each text node's string for the translated one,
 * returning a deep clone (the source doc is never mutated). Only `text` is
 * touched, so headings, lists, links and other marks survive untouched.
 *
 * Granularity is per text node: a span split by an inline mark (bold/link)
 * translates as separate fragments. That is fine for prose-heavy content (each
 * paragraph is usually one text node) and is vastly better than no translation;
 * callers needing sentence-level context on mark-heavy text would pre-merge.
 *
 * Pure: no DOM, no network — unit-tested (richtext-strings.test.ts).
 */
type Node = { type?: string; text?: string; content?: unknown[]; [k: string]: unknown };

function visit(node: unknown, fn: (n: Node) => void): void {
  if (!node || typeof node !== "object") return;
  const n = node as Node;
  if (n.type === "text" && typeof n.text === "string") fn(n);
  if (Array.isArray(n.content)) for (const c of n.content) visit(c, fn);
}

/** Every text node's string, in document order. */
export function collectRichTextStrings(doc: unknown): string[] {
  const out: string[] = [];
  visit(doc, (n) => out.push(n.text as string));
  return out;
}

/**
 * A deep clone of `doc` with the i-th text node's string replaced by
 * `strings[i]`. A missing/undefined replacement keeps the original (so a short
 * or failed translation batch can never blank text).
 */
export function applyRichTextStrings(doc: unknown, strings: readonly (string | undefined)[]): unknown {
  const clone = JSON.parse(JSON.stringify(doc));
  let i = 0;
  visit(clone, (n) => {
    const next = strings[i];
    if (typeof next === "string") n.text = next;
    i++;
  });
  return clone;
}
