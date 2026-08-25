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

/** The data object whose fields the pane should render for `path`. */
export function dataAtPath(data: Record<string, unknown>, path: BlockPath): Record<string, unknown> {
  if (path.length === 0) return data;
  return blockAtPath(data, path)?.inline ?? {};
}

/**
 * One field set, immutably, at the end of a path.
 *
 * Returns the ORIGINAL object when a step is stale, so a write into a block that
 * no longer exists is a no-op rather than a resurrection.
 */
export function setFieldAtPath(
  data: Record<string, unknown>,
  path: BlockPath,
  field: string,
  value: unknown,
): Record<string, unknown> {
  if (path.length === 0) return { ...data, [field]: value };

  const [step, ...rest] = path;
  if (!step) return { ...data, [field]: value };
  const blocks = areaOf(data, step.field);
  const index = blocks.findIndex((b) => b.key === step.key);
  if (index < 0) return data;

  const block = blocks[index]!;
  const nextBlocks = [...blocks];
  nextBlocks[index] = { ...block, inline: setFieldAtPath(block.inline ?? {}, rest, field, value) };
  return { ...data, [step.field]: nextBlocks };
}

/**
 * The type definition and a human label for every step of a path — what the
 * breadcrumb renders. Steps whose block or type has gone are dropped, so a
 * breadcrumb never shows a dead crumb.
 */
export function pathCrumbs(
  data: Record<string, unknown>,
  path: BlockPath,
  types: ContentTypeDef[],
): { step: BlockPathStep; label: string; type?: ContentTypeDef }[] {
  const out: { step: BlockPathStep; label: string; type?: ContentTypeDef }[] = [];
  let current = data;
  for (const step of path) {
    const block = areaOf(current, step.field).find((b) => b.key === step.key);
    if (!block) break;
    const type = types.find((t) => t.name === block.blockType);
    out.push({ step, label: type?.displayName ?? block.blockType, type });
    current = block.inline ?? {};
  }
  return out;
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
