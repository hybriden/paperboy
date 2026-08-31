import type { ContentTypeDef } from "@paperboy/shared";
import type { VersionDetail } from "./api.js";

/**
 * Field-by-field comparison of two content versions, with an inline word diff
 * for the text of each field.
 *
 * The word diff is an LCS over tokens, which is quadratic in the token count —
 * fine for a heading, a frozen tab for two versions of a long article. So a
 * richtext body is diffed PARAGRAPH BY PARAGRAPH (a doc is paragraph-structured,
 * and an edit rarely touches more than a few), and any single matrix that would
 * exceed DIFF_CELL_CAP cells makes the whole field fall back to a plain
 * before/after rendering instead of freezing the tab.
 */

/** Plain text of a TipTap doc: block nodes on their own lines, inline text run together. */
export function docToText(doc: unknown): string {
  const node = doc as { text?: string; content?: unknown[] } | null | undefined;
  if (!node) return "";
  if (typeof node.text === "string") return node.text;
  const children = node.content ?? [];
  const inline = children.some((c) => typeof (c as { text?: unknown } | null)?.text === "string");
  return children.map(docToText).filter(Boolean).join(inline ? "" : "\n");
}

export interface FieldDiff {
  key: string;
  label: string;
  aText: string;
  bText: string;
  changed: boolean;
}

function isEmpty(x: unknown): boolean {
  return x == null || x === "";
}
function deepEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (isEmpty(a) && isEmpty(b)) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/** Render any field value as comparable plain text (uniform word-diff input). */
function textOf(fieldType: string, value: unknown): string {
  if (value == null) return "";
  switch (fieldType) {
    case "richtext":
      return docToText(value);
    case "boolean":
      return value ? "Yes" : "No";
    case "link": {
      const v = value as { href?: string; text?: string };
      return [v.text, v.href].filter(Boolean).join(" — ");
    }
    case "reference": {
      const v = value as { documentId?: string; type?: string };
      return v.documentId ? `${v.type ?? "ref"}:${v.documentId}` : "";
    }
    case "contentArea": {
      if (!Array.isArray(value)) return "";
      const blocks = value as Array<{ blockType?: string }>;
      const types = blocks.map((bl) => bl.blockType ?? "block").join(", ");
      return blocks.length ? `${types} (${blocks.length} block${blocks.length === 1 ? "" : "s"})` : "";
    }
    case "select":
      if (Array.isArray(value)) return (value as string[]).join(", ");
      break;
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function diffFields(type: ContentTypeDef | undefined, a: VersionDetail, b: VersionDetail): FieldDiff[] {
  const meta: Array<{ key: string; label: string; av: unknown; bv: unknown; ft: string }> = [
    { key: "__name", label: "Name", av: a.name, bv: b.name, ft: "text" },
    { key: "__slug", label: "URL segment", av: a.slug ?? "", bv: b.slug ?? "", ft: "text" },
    { key: "__nav", label: "Show in navigation", av: a.displayInNav, bv: b.displayInNav, ft: "boolean" },
    ...(type?.fields ?? []).map((f) => ({ key: f.name, label: f.displayName, av: a.data[f.name], bv: b.data[f.name], ft: f.type })),
  ];
  return meta.map((m) => ({ key: m.key, label: m.label, aText: textOf(m.ft, m.av), bText: textOf(m.ft, m.bv), changed: !deepEq(m.av, m.bv) }));
}

export interface DiffSegment {
  t: "eq" | "del" | "ins";
  s: string;
}

/** Largest LCS matrix (cells) diffed inline; past it the field shows plain before/after. */
export const DIFF_CELL_CAP = 250_000;

/** LCS diff of two token lists, or null when the matrix would exceed DIFF_CELL_CAP. */
function lcsDiff(a: string[], b: string[]): DiffSegment[] | null {
  const n = a.length;
  const m = b.length;
  if (n * m > DIFF_CELL_CAP) return null;
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1]! + 1 : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!);
    }
  }
  const out: DiffSegment[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ t: "eq", s: a[i]! });
      i++;
      j++;
    } else if (dp[(i + 1) * w + j]! >= dp[i * w + j + 1]!) {
      out.push({ t: "del", s: a[i]! });
      i++;
    } else {
      out.push({ t: "ins", s: b[j]! });
      j++;
    }
  }
  while (i < n) out.push({ t: "del", s: a[i++]! });
  while (j < m) out.push({ t: "ins", s: b[j++]! });
  return out;
}

/** Paragraphs and the newlines between them, both kept as tokens so each side re-joins to its input. */
const lines = (s: string) => s.split(/(\n)/).filter(Boolean);
/** Words and the whitespace between them, likewise. */
const tokens = (s: string) => s.split(/(\s+)/).filter(Boolean);

/**
 * Word-level diff of two texts, paragraph by paragraph. Null when some paragraph
 * pair (or the paragraph lists themselves) is too large to diff inline.
 */
export function wordDiff(aText: string, bText: string): DiffSegment[] | null {
  const paragraphs = lcsDiff(lines(aText), lines(bText));
  if (!paragraphs) return null;
  const out: DiffSegment[] = [];
  // Changed paragraphs between two matches are paired up in order and diffed
  // word by word; whatever is left over is a whole inserted/deleted paragraph.
  let dels: string[] = [];
  let inss: string[] = [];
  const flush = (): boolean => {
    const pairs = Math.min(dels.length, inss.length);
    for (let k = 0; k < pairs; k++) {
      const inner = lcsDiff(tokens(dels[k]!), tokens(inss[k]!));
      if (!inner) return false;
      out.push(...inner);
    }
    for (const s of dels.slice(pairs)) out.push({ t: "del", s });
    for (const s of inss.slice(pairs)) out.push({ t: "ins", s });
    dels = [];
    inss = [];
    return true;
  };
  for (const p of paragraphs) {
    if (p.t === "del") dels.push(p.s);
    else if (p.t === "ins") inss.push(p.s);
    else {
      if (!flush()) return null;
      out.push(p);
    }
  }
  return flush() ? out : null;
}
