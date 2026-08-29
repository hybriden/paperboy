import type { AreaBlock } from "@paperboycms/client";
import type { DeliveryContent } from "@paperboy/shared";

/**
 * One delivered document, wrapped as the AreaBlock shape the Renderer's Block
 * component renders. The standalone preview route
 * (/{locale}/preview/block/{documentId}) shows a shared block through the SAME
 * component it renders through inline — so what an editor sees standalone is
 * exactly what a page embedding it will show.
 *
 * Lives outside the component file so Fast Refresh can keep component state
 * (a module exporting non-components loses that), and because it is pure data
 * wrapping with its own unit test.
 */
export function standaloneAreaBlock(content: DeliveryContent): AreaBlock {
  return {
    blockType: content.type,
    display: "automatic",
    shared: true,
    content: {
      documentId: content.documentId,
      type: content.type,
      kind: content.kind,
      name: content.name,
      urlPath: content.urlPath ?? null,
      data: content.data as Record<string, unknown>,
      fieldTypes: content.fieldTypes,
      form: content.form,
    },
  };
}
