import type { BlockInstance, ContentTypeDef } from "@paperboy/shared";

/**
 * Where the properties pane currently is inside a document's block tree.
 *
 * A content area used to render every block's whole form inline, which meant a
 * field could sit two bordered containers deep with its own padding and radius
 * and no rhythm survived it (measured 2026-08-25). Now a block is one compact
 * row and opening it navigates the pane INTO that block — so there is only ever
 * one form on screen, whatever the nesting depth.
 *
 * A step names the content-area field it walked through and the block it opened.
 * The block's `key` is the identity, not its index: a step must survive the
 * block being dragged to a different position while the pane is open.
 *
 * Not a modal, deliberately. A modal covers the live preview, which is the point
 * of the side-by-side view, and it stacks: a Form block holds ten FormField
 * parts, so "edit the email field" would be two dialogs deep. A path just grows.
 */
export interface BlockPathStep {
  /** The contentArea field this block lives in. */
  field: string;
  /** The block instance's own key. */
  key: string;
}

export type BlockPath = BlockPathStep[];

/** The blocks held by one content-area field of a data object. */
function areaOf(data: Record<string, unknown>, field: string): BlockInstance[] {
  const v = data[field];
  return Array.isArray(v) ? (v as BlockInstance[]) : [];
}

/**
 * Walk a path and return the block it points at, or null if any step is stale —
 * which happens legitimately: the block was removed, or another editor's save
 * arrived. Callers treat null as "go back to the top", never as an error.
 */
export function blockAtPath(data: Record<string, unknown>, path: BlockPath): BlockInstance | null {
  let current = data;
  let block: BlockInstance | null = null;
  for (const step of path) {
    const found = areaOf(current, step.field).find((b) => b.key === step.key);
    if (!found) return null;
    block = found;
    current = found.inline ?? {};
  }
  return block;
}

/**
 * Map an index-based path from preview messages ({ field, blockIndex }[]) to a
 * key-based BlockPath ({ field, key }[]).
 * Returns null if any step cannot be resolved (e.g. index out of bounds or block missing).
 */
export function resolveBlockPath(
  data: Record<string, unknown>,
  path: { field: string; blockIndex: number }[],
): BlockPath | null {
  const result: BlockPath = [];
  let current = data;
  for (const step of path) {
    const blocks = areaOf(current, step.field);
    const block = blocks[step.blockIndex];
    if (!block || !block.key) return null;
    result.push({ field: step.field, key: block.key });
    current = block.inline ?? {};
  }
  return result;
}

/**
 * Immutably update the block targeted by a BlockPath.
 * Calls `update(targetBlock)` and re-embeds the updated block up to the root.
 * If any step along path does not exist, returns original data unchanged.
 */
export function updateBlockAtPath(
  data: Record<string, unknown>,
  path: BlockPath,
  update: (block: BlockInstance) => BlockInstance,
): Record<string, unknown> {
  const head = path[0];
  if (!head) return data;
  const rest = path.slice(1);
  const arr = areaOf(data, head.field);
  let changed = false;
  const nextArr = arr.map((b) => {
    if (b.key !== head.key) return b;
    if (rest.length === 0) {
      changed = true;
      return update(b);
    }
    const inlineData = b.inline ?? {};
    const nextInline = updateBlockAtPath(inlineData, rest, update);
    if (nextInline === inlineData) return b;
    changed = true;
    return { ...b, inline: nextInline };
  });
  if (!changed) return data;
  return { ...data, [head.field]: nextArr };
}

/**
 * The line of text a compact row shows under (or beside) the block's type name.
 *
 * A row that says only "Hero" makes you open it to find out which hero it is, so
 * the row carries the block's own most-identifying value instead. Preference
 * order matches what the frontends treat as a block's title, and it falls back
 * to the first non-empty string field so a type nobody anticipated still says
 * something useful.
 */
const SUMMARY_FIELDS = ["heading", "title", "name", "label", "question", "topic", "quote", "text", "intro"];

export function blockSummary(block: BlockInstance, type?: ContentTypeDef): string {
  const data = block.inline ?? {};
  const asText = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

  for (const name of SUMMARY_FIELDS) {
    const found = asText(data[name]);
    if (found) return found;
  }
  // Anything else the type declares as single-line text, in declared order.
  for (const f of type?.fields ?? []) {
    if (f.type !== "text" && f.type !== "select") continue;
    const found = asText(data[f.name]);
    if (found) return found;
  }
  return "";
}

