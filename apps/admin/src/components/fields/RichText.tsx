import { Suspense, lazy } from "react";

const Editor = lazy(() => import("./RichTextEditor.js"));

type Doc = { type: "doc"; content: Array<{ type: string; content?: Array<{ type: string; text?: string }> }> };

/** Kept for compatibility (plain-text round-trip with TipTap-shaped JSON). */
export function docToText(doc: unknown): string {
  const d = doc as Doc | null | undefined;
  if (!d || !Array.isArray(d.content)) return "";
  return d.content.map((p) => (p.content ?? []).map((t) => t.text ?? "").join("")).join("\n");
}
export function textToDoc(text: string): Doc {
  return {
    type: "doc",
    content: text.split("\n").map((line) => ({
      type: "paragraph",
      content: line ? [{ type: "text", text: line }] : [],
    })),
  };
}

/** Lazy-loaded TipTap rich text (ProseMirror bundle only loads when an RTE field is shown). */
export function RichText({ id, value, onChange }: { id: string; value: unknown; onChange: (doc: unknown) => void }) {
  return (
    <Suspense fallback={<div className="h-[150px] animate-pulse rounded-[var(--radius)] bg-line/40" />}>
      <Editor id={id} value={value} onChange={onChange} />
    </Suspense>
  );
}
