import { PanelResizeHandle } from "react-resizable-panels";

/** A thin draggable divider between resizable panes (vertical bar). */
export function ResizeHandle({ className = "" }: { className?: string }) {
  return (
    <PanelResizeHandle
      className={`group relative w-1.5 shrink-0 bg-line/40 outline-none transition-colors hover:bg-accent/40 data-[resize-handle-state=drag]:bg-accent ${className}`}
      aria-label="Resize panel"
    >
      {/* wider invisible hit area + a centered grip dot column */}
      <span className="absolute inset-y-0 -left-1 -right-1" />
      <span className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-[8px] leading-[3px] text-muted/60 group-hover:text-accent">⋮</span>
    </PanelResizeHandle>
  );
}
