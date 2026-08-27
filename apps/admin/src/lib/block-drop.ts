import type { BlockInstance, FieldDef } from "@paperboy/shared";

/**
 * Turn a preview drag-drop payload (a shared block or a page dragged onto the
 * rendered page in the live preview) into a content-area block instance — or
 * explain why it can't be placed. Enforces the SAME two placement rules the
 * in-form ContentArea drop handler (fields/ContentArea.tsx) does: allowedBlocks,
 * and — pass `nestedOnly` — that a part (nestedOnly type) may not land in an
 * area that allows any block. Without the second, a part dropped on the page
 * landed here and the SERVER then rejected it on save (assertPlacement), so the
 * block appeared and then vanished.
 */
export interface DropPayload {
  kind?: string;
  documentId?: string;
  blockType?: string;
  name?: string;
}

export type DropResult =
  | { ok: true; block: BlockInstance }
  | { ok: false; reason: "not-area" | "bad-payload" | "not-allowed" | "unsupported-kind" };

export function blockInstanceFromDrop(payload: DropPayload, field: FieldDef, key: string, nestedOnly?: ReadonlySet<string>): DropResult {
  if (field.type !== "contentArea") return { ok: false, reason: "not-area" };
  if (!payload?.documentId || !payload?.blockType) return { ok: false, reason: "bad-payload" };

  if (payload.kind === "block") {
    // allowedBlocks (empty = any) constrains which BLOCK types may be placed here.
    const allowed = !field.allowedBlocks.length || field.allowedBlocks.includes(payload.blockType);
    if (!allowed) return { ok: false, reason: "not-allowed" };
    // "any block" means any GENERAL block: a part belongs only where its area
    // named it (same rule as ContentArea + the server's assertPlacement).
    if (!field.allowedBlocks.length && nestedOnly?.has(payload.blockType)) return { ok: false, reason: "not-allowed" };
  } else if (payload.kind !== "page") {
    // Pages drop as teasers; media/image-on-preview isn't supported yet.
    return { ok: false, reason: "unsupported-kind" };
  }

  return {
    ok: true,
    block: { key, blockType: payload.blockType, display: "automatic", inline: null, ref: payload.documentId },
  };
}
