import { generalBlockTypes, isFormType, type ContentTypeDef, type FieldDef } from "@paperboy/shared";

/**
 * Which block types a content area offers for INLINE adding — THE one home for
 * the rule, shared by the sidebar ContentArea palette and the on-page "＋ Add
 * block" overlay (paperboy:add-block). The two must agree, or the preview
 * offers a block the write chokepoint (assertAllowedTypes) then rejects.
 *
 * Follows the order the type author DECLARED — they list the everyday blocks
 * first, while `types` arrives sorted by internal name. No allow-list means
 * "any block", which must NOT include the parts (nestedOnly) that only make
 * sense inside a specific parent — an allow-list is how a container opts in.
 *
 * A Form is never offered inline, allow-listed or not: submissions post
 * against a documentId only a SHARED block has, so an inline Form is dead on
 * the page. It is added through the reuse picker instead.
 */
export function allowedBlockTypesFor(field: FieldDef, types: ContentTypeDef[]): ContentTypeDef[] {
  const allowed = field.allowedBlocks.length
    ? field.allowedBlocks.flatMap((name) => types.find((t) => t.name === name) ?? [])
    : generalBlockTypes(types);
  return allowed.filter((t) => !isFormType(t.name));
}
