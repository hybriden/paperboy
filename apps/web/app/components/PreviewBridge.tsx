"use client";
import { useEffect } from "react";

/**
 * Visual on-page editing bridge — runs ONLY in the preview iframe (draft mode).
 * Outlines editable regions on hover and, on click, tells the parent editor which
 * field/block to focus via postMessage. No sensitive data crosses — just names.
 */
export function PreviewBridge() {
  useEffect(() => {
    const STYLE = "2px solid var(--pb-edit, #c8362f)";
    let hovered: HTMLElement | null = null;

    const editable = (el: EventTarget | null): HTMLElement | null => {
      let node = el as HTMLElement | null;
      while (node && node !== document.body) {
        if (node.hasAttribute?.("data-pb-field") || node.hasAttribute?.("data-pb-block-index")) return node;
        node = node.parentElement;
      }
      return null;
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
      const blockIndexAttr = target.getAttribute("data-pb-block-index");
      window.parent.postMessage(
        {
          type: "paperboy:edit",
          field: target.getAttribute("data-pb-field") ?? (blockIndexAttr != null ? "mainArea" : null),
          blockIndex: blockIndexAttr != null ? Number(blockIndexAttr) : null,
          blockType: target.getAttribute("data-pb-block-type"),
        },
        "*",
      );
    };

    document.addEventListener("mouseover", onOver);
    document.addEventListener("mouseout", onOut);
    document.addEventListener("click", onClick, true); // capture so links don't navigate first
    window.parent.postMessage({ type: "paperboy:preview-ready" }, "*");
    return () => {
      document.removeEventListener("mouseover", onOver);
      document.removeEventListener("mouseout", onOut);
      document.removeEventListener("click", onClick, true);
      if (hovered) hovered.style.outline = "";
    };
  }, []);

  return null;
}
