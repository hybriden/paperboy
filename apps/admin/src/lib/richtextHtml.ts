import { generateHTML } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import StarterKit from "@tiptap/starter-kit";

/**
 * TipTap doc JSON → HTML, with the SAME extension set as the RichTextEditor.
 * Used for live on-page-preview patches (the page swaps the field's innerHTML
 * while typing in the overlay, instead of a full iframe reload).
 *
 * Loaded via dynamic import so TipTap stays out of the main editor chunk.
 */
export function richTextHtml(doc: unknown): string | null {
  if (!doc || typeof doc !== "object") return null;
  try {
    return generateHTML(doc as Parameters<typeof generateHTML>[0], [
      StarterKit.configure({ heading: { levels: [2, 3] }, link: false }),
      Link,
      Image,
    ]);
  } catch {
    return null;
  }
}
