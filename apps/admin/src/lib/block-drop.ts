import type { BlockInstance, FieldDef } from "@paperboy/shared";

/**
 * Turn a preview drag-drop payload (a shared block or a page dragged onto the
 * rendered page in the live preview) into a content-area block instance — or
 * explain why it can't be placed. This mirrors the rules in the in-form
 * ContentArea drop handler (fields/ContentArea.tsx) so on-page and in-form
 * dropping behave identically; it's the one place those rules live for the
 * cross-iframe path.
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

export function blockInstanceFromDrop(payload: DropPayload, field: FieldDef, key: string): DropResult {
  if (field.type !== "contentArea") return { ok: false, reason: "not-area" };
  if (!payload?.documentId || !payload?.blockType) return { ok: false, reason: "bad-payload" };

  if (payload.kind === "block") {
    // allowedBlocks (empty = any) constrains which BLOCK types may be placed here.
    const allowed = !field.allowedBlocks.length || field.allowedBlocks.includes(payload.blockType);
    if (!allowed) return { ok: false, reason: "not-allowed" };
  } else if (payload.kind !== "page") {
    // Pages drop as teasers; media/image-on-preview isn't supported yet.
    return { ok: false, reason: "unsupported-kind" };
  }

  return {
    ok: true,
    block: { key, blockType: payload.blockType, display: "automatic", inline: null, ref: payload.documentId },
  };
}
