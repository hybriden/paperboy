import { Suspense, lazy } from "react";

const Editor = lazy(() => import("./RichTextEditor.js"));

/** Lazy-loaded TipTap rich text (ProseMirror bundle only loads when an RTE field is shown). */
export function RichText({ id, label, value, onChange, disabled = false }: { id: string; label: string; value: unknown; onChange: (doc: unknown) => void; disabled?: boolean }) {
  return (
    <Suspense fallback={<div className="h-[150px] animate-pulse rounded-(--radius) bg-line/40" />}>
      <Editor id={id} label={label} value={value} onChange={onChange} disabled={disabled} />
    </Suspense>
  );
}
