"use client";
import { useEffect } from "react";

/**
 * Visual on-page editing bridge — runs ONLY in the preview iframe (draft mode).
 *
 * - Outlines editable regions (data-pb-field / data-pb-block-index) on hover.
 * - On click, tells the parent editor which field/block was picked, INCLUDING
 *   the element's viewport rect so the admin can anchor an on-page overlay
 *   editor at the same spot ("Edit on page" mode).
 * - Keeps re-posting the picked element's rect on scroll/resize so the overlay
 *   tracks the page.
 * - Applies live patches from the admin (paperboy:patch) so typing in the
 *   overlay updates the page WITHOUT a full iframe reload.
 * - Persists the scroll position across reloads (autosave still reloads the
 *   iframe when structure changes), so the page doesn't jump to the top.
 *
 * No sensitive data crosses the boundary — field names, rects and draft
 * content the iframe could already read with its preview secret.
 */
export function PreviewBridge() {
  useEffect(() => {
    const STYLE = "2px solid var(--pb-edit, #c8362f)";
    let hovered: HTMLElement | null = null;
    let tracked: HTMLElement | null = null; // last-clicked element (rect updates)

    const editable = (el: EventTarget | null): HTMLElement | null => {
      let node = el as HTMLElement | null;
      while (node && node !== document.body) {
        if (node.hasAttribute?.("data-pb-field") || node.hasAttribute?.("data-pb-block-index")) return node;
        node = node.parentElement;
      }
      return null;
    };

    const descriptor = (target: HTMLElement) => {
      const blockIndexAttr = target.getAttribute("data-pb-block-index");
      const r = target.getBoundingClientRect();
      return {
        field: target.getAttribute("data-pb-field") ?? (blockIndexAttr != null ? "mainArea" : null),
        blockIndex: blockIndexAttr != null ? Number(blockIndexAttr) : null,
        blockType: target.getAttribute("data-pb-block-type"),
        rect: { x: r.x, y: r.y, w: r.width, h: r.height },
      };
    };

    const onOver = (e: MouseEvent) => {
      const target = editable(e.target);
      if (target === hovered) return;
      if (hovered) hovered.style.outline = "";
      hovered = target;
      if (target) {
        target.style.outline = STYLE;
        target.style.outlineOffset = "2px";
        target.style.cursor = "pointer";
      }
    };
    const onOut = () => { if (hovered) { hovered.style.outline = ""; hovered = null; } };

    const onClick = (e: MouseEvent) => {
      const target = editable(e.target);
      if (!target) return;
      e.preventDefault();
      e.stopPropagation();
      tracked = target;
      window.parent.postMessage({ type: "paperboy:edit", ...descriptor(target) }, "*");
    };

    // While an element is picked, stream its rect so the overlay follows
    // page scroll / window resize. rAF-coalesced; parent ignores it when no
    // overlay is open.
    let rafPending = false;
    const postRect = () => {
      rafPending = false;
      if (!tracked || !tracked.isConnected) return;
      window.parent.postMessage({ type: "paperboy:rect", ...descriptor(tracked) }, "*");
    };
    const onScrollOrResize = () => {
      if (!rafPending && tracked) {
        rafPending = true;
        requestAnimationFrame(postRect);
      }
      // Persist scroll for reload continuity (throttled by rAF above is enough).
      try {
        sessionStorage.setItem(`pb-scroll:${location.pathname}`, String(window.scrollY));
      } catch { /* storage may be unavailable */ }
    };

    // Live patches from the overlay editor: swap a field's rendered content
    // in place instead of reloading the whole page.
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { type?: string; field?: string; text?: string; html?: string };
      if (d?.type === "paperboy:patch" && d.field) {
        const el = document.querySelector<HTMLElement>(`[data-pb-field="${CSS.escape(d.field)}"]`);
        if (!el) return;
        if (typeof d.html === "string") el.innerHTML = d.html;
        else if (typeof d.text === "string") el.textContent = d.text;
        // The element may have been replaced/resized — refresh the overlay anchor.
        if (tracked && !tracked.isConnected) tracked = el;
        onScrollOrResize();
      } else if (d?.type === "paperboy:focus" && d.field) {
        // (existing behavior) scroll the region into view + flash it
        const el = document.querySelector<HTMLElement>(`[data-pb-field="${CSS.escape(d.field)}"]`);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          el.style.outline = STYLE;
          el.style.outlineOffset = "2px";
          setTimeout(() => { el.style.outline = ""; }, 1200);
        }
      }
    };

    // Restore scroll from before the last reload.
    try {
      const saved = sessionStorage.getItem(`pb-scroll:${location.pathname}`);
      if (saved) window.scrollTo(0, Number(saved));
    } catch { /* ignore */ }

    document.addEventListener("mouseover", onOver);
    document.addEventListener("mouseout", onOut);
    document.addEventListener("click", onClick, true); // capture so links don't navigate first
    window.addEventListener("scroll", onScrollOrResize, { passive: true });
    window.addEventListener("resize", onScrollOrResize);
    window.addEventListener("message", onMessage);
    window.parent.postMessage({ type: "paperboy:preview-ready" }, "*");
    return () => {
      document.removeEventListener("mouseover", onOver);
      document.removeEventListener("mouseout", onOut);
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("scroll", onScrollOrResize);
      window.removeEventListener("resize", onScrollOrResize);
      window.removeEventListener("message", onMessage);
      if (hovered) hovered.style.outline = "";
    };
  }, []);

  return null;
}
