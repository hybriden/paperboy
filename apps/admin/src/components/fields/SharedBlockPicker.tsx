import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../lib/icons.js";

export interface PickerBlock {
  documentId: string;
  name: string;
  type: string;
}

/**
 * "Insert an existing block here" — the reuse path for a content area.
 *
 * A shared block belongs to no page: it can be placed in ANY content area that
 * allows its type, and the same document then renders everywhere it is used.
 * This picker is how that is reached, so it has to stay usable once an instance
 * holds more than a handful of blocks — the previous control was a fixed-width
 * dropdown listing every shared block in the site, unsearchable and with names
 * truncated at 224px.
 *
 * It also OMITS what the area forbids. `allowedBlocks` is enforced when the
 * write lands, so offering a block whose type this area rejects only produces a
 * validation error a few clicks later — the same reason the palette is hidden
 * outright when the editor has no permission to write.
 */
export function SharedBlockPicker({
  at,
  allowedBlocks,
  sharedBlocks,
  pages,
  onPick,
  onClose,
}: {
  /** Where the trigger sits, in viewport coordinates. */
  at: { x: number; y: number };
  /** Empty means the area accepts any block type. */
  allowedBlocks: string[];
  sharedBlocks: PickerBlock[];
  /** Pages render as teasers and are always placeable — never in allowedBlocks. */
  pages: PickerBlock[];
  onPick: (documentId: string, blockType: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  // Focus on mount via a ref rather than the autoFocus attribute (a11y lint).
  useEffect(() => searchRef.current?.focus(), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const { blocks, teasers, hiddenByRules } = useMemo(() => {
    const placeable = allowedBlocks.length
      ? sharedBlocks.filter((b) => allowedBlocks.includes(b.type))
      : sharedBlocks;
    const match = (b: PickerBlock) => {
      const q = query.trim().toLowerCase();
      if (!q) return true;
      return b.name.toLowerCase().includes(q) || b.type.toLowerCase().includes(q);
    };
    return {
      blocks: placeable.filter(match),
      teasers: pages.filter(match),
      hiddenByRules: sharedBlocks.length - placeable.length,
    };
  }, [allowedBlocks, sharedBlocks, pages, query]);

  const first = blocks[0] ?? teasers[0];

  const row = (b: PickerBlock, teaser: boolean) => (
    <button
      key={b.documentId}
      type="button"
      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-fg hover:bg-canvas"
      onClick={() => onPick(b.documentId, b.type)}
    >
      <span className="min-w-0 flex-1 truncate">{b.name}</span>
      <span className="shrink-0 text-[11px] text-muted">{teaser ? "teaser" : b.type}</span>
    </button>
  );

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} aria-hidden />
      {/* FIXED, not absolute: a content area can sit deep inside the scrolling
          form column, and an absolutely-positioned popover is clipped by it.
          Clamped to the viewport so it never opens off-screen. */}
      <div
        role="dialog"
        aria-label="Insert an existing block"
        className="fixed z-50 w-80 rounded-(--radius) border border-line bg-panel p-1 shadow-pop"
        style={{
          left: Math.max(8, Math.min(at.x, window.innerWidth - 336)),
          top: Math.max(8, Math.min(at.y, window.innerHeight - 400)),
        }}
      >
        <div className="flex items-center gap-1.5 border-b border-line px-1.5 pb-1.5">
          <Icon.Search width={14} height={14} />
          <input
            ref={searchRef}
            type="search"
            className="w-full bg-transparent py-1 text-xs text-fg outline-none"
            placeholder="Search blocks and pages…"
            aria-label="Search blocks and pages"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // Type a few letters, press Enter — the common case is one match.
              if (e.key === "Enter" && first) {
                e.preventDefault();
                onPick(first.documentId, first.type);
              }
            }}
          />
        </div>

        <div className="max-h-72 overflow-y-auto py-1">
          {blocks.length > 0 && (
            <>
              <p className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Shared blocks</p>
              {blocks.map((b) => row(b, false))}
            </>
          )}
          {teasers.length > 0 && (
            <>
              <p className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Pages (as teaser)</p>
              {teasers.map((p) => row(p, true))}
            </>
          )}
          {blocks.length === 0 && teasers.length === 0 && (
            <p className="px-2 py-3 text-center text-xs text-muted">
              {query ? `Nothing matches “${query}”.` : "No shared blocks yet — create one from the Assets pane."}
            </p>
          )}
        </div>

        {hiddenByRules > 0 && (
          // Say it rather than leave the editor hunting for a block that is
          // deliberately not offered here.
          <p className="border-t border-line px-2 py-1.5 text-[11px] text-muted">
            {hiddenByRules} shared {hiddenByRules === 1 ? "block is" : "blocks are"} not allowed in this area.
          </p>
        )}
      </div>
    </>
  );
}
