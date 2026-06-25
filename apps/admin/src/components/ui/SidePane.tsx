import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "../../lib/icons.js";

/** Pinned (always-shown, in-flow) vs auto-hide (collapsed to an edge rail). */
export function usePinned(key: string, fallback = true): [boolean, () => void] {
  const [pinned, setPinned] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : v === "1";
    } catch {
      return fallback;
    }
  });
  const toggle = useCallback(() => {
    setPinned((p) => {
      const next = !p;
      try { localStorage.setItem(key, next ? "1" : "0"); } catch { /* ignore */ }
      return next;
    });
  }, [key]);
  return [pinned, toggle];
}

/** Header control: pin to keep the pane open, or unpin to let it auto-hide. */
export function PinButton({ pinned, onToggle }: { pinned: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={pinned}
      title={pinned ? "Auto-hide this panel" : "Keep this panel open"}
      className={`grid h-7 w-7 place-items-center rounded ${pinned ? "text-accent-700 hover:bg-accent/10" : "text-muted hover:bg-line/60"}`}
    >
      {pinned ? <Icon.Pin width={15} height={15} /> : <Icon.PinOff width={15} height={15} />}
    </button>
  );
}

/**
 * Auto-hide rail: a thin always-visible strip on the workspace edge. Hovering it
 * (or the revealed flyout) rolls the full pane out as an overlay. Once the
 * pointer has been away for 1.5s it rolls back into the edge (no fade — a pure
 * slide). The 1.5s grace is JS-driven so the pane stays open AND interactive
 * during it; moving back in cancels the hide. Clicking the rail re-pins it.
 */
const HIDE_DELAY_MS = 1500;

export function AutoHideRail({
  side,
  label,
  width = 288,
  onPin,
  children,
}: {
  side: "left" | "right";
  label: string;
  width?: number;
  onPin: () => void;
  children: ReactNode;
}) {
  const isLeft = side === "left";
  const [revealed, setRevealed] = useState(false);
  const hideTimer = useRef<number | null>(null);

  const cancelHide = useCallback(() => {
    if (hideTimer.current != null) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }, []);
  const reveal = useCallback(() => {
    cancelHide();
    setRevealed(true);
  }, [cancelHide]);
  const scheduleHide = useCallback(() => {
    cancelHide();
    hideTimer.current = window.setTimeout(() => setRevealed(false), HIDE_DELAY_MS);
  }, [cancelHide]);
  useEffect(() => cancelHide, [cancelHide]);

  return (
    <div
      onMouseEnter={reveal}
      onMouseLeave={scheduleHide}
      className={`relative z-20 flex h-full w-9 shrink-0 flex-col bg-panel ${isLeft ? "border-r border-line" : "border-l border-line"}`}
    >
      <button
        type="button"
        onClick={onPin}
        aria-label={`Show ${label} panel`}
        title={`Show ${label} (click to pin open)`}
        className="flex flex-1 flex-col items-center gap-2 py-3 text-muted hover:bg-line/40 hover:text-fg"
      >
        <Icon.Chevron width={14} height={14} className={isLeft ? "" : "rotate-180"} />
        <span className="text-[11px] font-bold uppercase tracking-wider [writing-mode:vertical-rl]">{label}</span>
      </button>
      {/* Flyout overlay — rolls out on hover; rolls back into the edge 1.5s after
          the pointer leaves (transform only, no fade — see .pb-flyout). */}
      <div
        style={{ width }}
        data-side={side}
        data-revealed={revealed}
        className={`pb-flyout absolute top-0 z-30 h-full shadow-panel ${isLeft ? "left-9" : "right-9"}`}
      >
        {children}
      </div>
    </div>
  );
}
