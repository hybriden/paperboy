/**
 * initPreviewBridge — the browser-side on-page-editing bridge that runs INSIDE
 * the Paperboy preview iframe. Framework-agnostic: it operates purely on the
 * DOM-attribute conventions in ./protocol (data-pb-field / data-pb-area /
 * data-pb-block-index), so any frontend (Astro, Next, plain HTML) calls it once
 * and gets identical behavior:
 *
 *   - hover/click an editable region → posts `paperboy:edit` (with rect + click
 *     + caret) so the admin can focus the field or open an anchored overlay;
 *   - drag a shared block / page from the Assets pane onto a content area →
 *     posts `paperboy:drop`;
 *   - streams the picked element's rect on scroll/resize (`paperboy:rect`);
 *   - applies `paperboy:patch` (live content swap, no reload) and
 *     `paperboy:focus` (scroll + highlight) from the admin;
 *   - persists scroll position across the reloads autosave triggers.
 *
 * It injects its own minimal styles, so consumers ship NO bridge CSS. Returns a
 * teardown function (removes listeners, injected nodes, body class).
 */
import { ATTR, DRAG_MIME, PROTOCOL_VERSION, parsePreviewMessage, type Rect } from "./protocol";

export interface PreviewBridgeOptions {
  /** Window to post messages to. Default: the parent window. */
  target?: Window;
  /** Document to bind to. Default: the ambient `document`. */
  doc?: Document;
  /** Outline/highlight color. Default: Paperboy blue. */
  accent?: string;
  /** Show the "Preview — click to edit" badge. Default: true. */
  badge?: boolean;
}

const EDITABLE = `[${ATTR.field}],[${ATTR.blockIndex}]`;

export function initPreviewBridge(options: PreviewBridgeOptions = {}): () => void {
  const doc = options.doc ?? document;
  const win = doc.defaultView ?? (globalThis as unknown as Window);
  const target = options.target ?? win.parent;
  const accent = options.accent ?? "#0077BC";
  const showBadge = options.badge ?? true;

  // ---- injected chrome (styles + optional badge); consumers ship no CSS ----
  const style = doc.createElement("style");
  style.dataset.pbBridge = "";
  style.textContent = `
    body.pb-editing [${ATTR.field}],body.pb-editing [${ATTR.blockIndex}]{cursor:pointer;outline:1px dashed ${accent}73;outline-offset:3px}
    body.pb-editing [${ATTR.field}]:hover,body.pb-editing [${ATTR.blockIndex}]:hover{outline:2px solid ${accent};outline-offset:3px}
    body.pb-editing [${ATTR.field}].pb-focus{outline:3px solid ${accent};outline-offset:3px;box-shadow:0 0 0 6px ${accent}2e}
    body.pb-editing [${ATTR.area}].pb-drop-active{outline:3px solid ${accent};outline-offset:4px;background:${accent}14}
    .pb-edit-badge{position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:99999;background:${accent};color:#fff;font:600 12px/1 ui-sans-serif,system-ui,sans-serif;padding:7px 14px;border-radius:999px;box-shadow:0 2px 8px rgba(0,0,0,.25)}
  `;
  doc.head.appendChild(style);
  doc.body.classList.add("pb-editing");

  let badgeEl: HTMLElement | null = null;
  if (showBadge) {
    badgeEl = doc.createElement("div");
    badgeEl.className = "pb-edit-badge";
    badgeEl.textContent = "Preview — click any element to edit it";
    doc.body.appendChild(badgeEl);
  }

  const cssEscape = (s: string): string =>
    typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, "\\$&");

  let tracked: HTMLElement | null = null; // last-clicked element (rect updates follow it)

  const editableFrom = (t: EventTarget | null): HTMLElement | null =>
    (t as HTMLElement | null)?.closest?.(EDITABLE) ?? null;

  const describe = (el: HTMLElement) => {
    const bi = el.getAttribute(ATTR.blockIndex);
    const r = el.getBoundingClientRect();
    return {
      field: el.getAttribute(ATTR.field),
      blockIndex: bi != null ? Number(bi) : null,
      blockType: el.getAttribute(ATTR.blockType),
      rect: { x: r.x, y: r.y, w: r.width, h: r.height } as Rect,
    };
  };

  // Click position INSIDE a field → text snippet + offset, so the admin can put
  // its caret at the click (long bodies open where you clicked, not at the top).
  const caretAt = (e: MouseEvent, el: HTMLElement) => {
    let node: Node | null = null;
    let off = 0;
    const d = doc as Document & {
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    };
    if (d.caretPositionFromPoint) {
      const pos = d.caretPositionFromPoint(e.clientX, e.clientY);
      if (pos) { node = pos.offsetNode; off = pos.offset; }
    } else if (d.caretRangeFromPoint) {
      const r = d.caretRangeFromPoint(e.clientX, e.clientY);
      if (r) { node = r.startContainer; off = r.startOffset; }
    }
    if (!node || node.nodeType !== 3 /* TEXT_NODE */ || !el.contains(node)) return null;
    const text = (node as Text).data;
    if (!text.trim()) return null;
    const start = Math.max(0, off - 80);
    return { snippet: text.slice(start, off + 80), offset: off - start };
  };

  // ---- preview → admin: click a region to edit its field/block ----
  const onClick = (e: MouseEvent) => {
    const el = editableFrom(e.target);
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    tracked = el;
    target?.postMessage({ type: "paperboy:edit", ...describe(el), click: { x: e.clientX, y: e.clientY }, caret: caretAt(e, el) }, "*");
  };

  // ---- preview → admin: drag a shared block / page onto a content area ----
  // Same-origin: the MIME type is visible on dragover and the payload readable
  // on drop. CROSS-ORIGIN (admin and preview on different hosts): the browser
  // hides drag data from this iframe, so we rely on `dragPayload` — broadcast by
  // the admin via paperboy:dragsource on dragstart (see onMessage below).
  let dragPayload: unknown = null;
  let dropZone: HTMLElement | null = null;
  // data-pb-area's VALUE must be the contentArea FIELD NAME (it is posted back
  // as paperboy:drop {field} and looked up on the content type). A boolean-ish
  // marker is the classic mistake and makes every drop fail silently in the
  // editor — call it out in the frontend dev's own console.
  const warnedAreas = new Set<string>();
  const checkAreaValue = (zone: HTMLElement): string | null => {
    const field = zone.getAttribute(ATTR.area);
    if (field && /^(true|false|1|0|yes)$/i.test(field) && !warnedAreas.has(field)) {
      warnedAreas.add(field);
      console.warn(
        `[paperboy] ${ATTR.area}="${field}" looks like a boolean marker, but its value must be the contentArea FIELD NAME ` +
          `(e.g. ${ATTR.area}="mainArea") — the editor maps drops to the form field by this value. Use pbAreaAttrs() from @paperboycms/client.`,
      );
    }
    return field;
  };
  const setDropZone = (z: HTMLElement | null) => {
    if (dropZone === z) return;
    dropZone?.classList.remove("pb-drop-active");
    dropZone = z;
    dropZone?.classList.add("pb-drop-active");
  };
  const onDragOver = (e: DragEvent) => {
    // Opt in when the drag carries our MIME (same-origin) OR the admin told us a
    // drag is in progress (cross-origin, where types/data are hidden here).
    if (!e.dataTransfer?.types.includes(DRAG_MIME) && dragPayload == null) return;
    const zone = (e.target as HTMLElement | null)?.closest?.(`[${ATTR.area}]`) as HTMLElement | null;
    if (!zone) { setDropZone(null); return; }
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    setDropZone(zone);
  };
  const onDragLeave = (e: DragEvent) => {
    if (!(e.relatedTarget as HTMLElement | null)?.closest?.(`[${ATTR.area}]`)) setDropZone(null);
  };
  const onDragEnd = () => setDropZone(null);
  const onDrop = (e: DragEvent) => {
    const zone = (e.target as HTMLElement | null)?.closest?.(`[${ATTR.area}]`) as HTMLElement | null;
    // Prefer the admin-broadcast payload (works cross-origin); fall back to
    // dataTransfer for same-origin drags.
    let payload: unknown = dragPayload;
    if (payload == null) {
      const raw = e.dataTransfer?.getData(DRAG_MIME);
      if (raw) { try { payload = JSON.parse(raw); } catch { /* ignore */ } }
    }
    dragPayload = null;
    setDropZone(null);
    if (!zone || payload == null) return;
    e.preventDefault();
    target?.postMessage({ type: "paperboy:drop", field: checkAreaValue(zone), payload }, "*");
  };

  // ---- track the picked element's rect on scroll/resize; persist scroll ----
  let raf = false;
  const onScrollOrResize = () => {
    if (tracked && !raf) {
      raf = true;
      win.requestAnimationFrame(() => {
        raf = false;
        if (tracked?.isConnected) {
          const { field, blockIndex, rect } = describe(tracked);
          target?.postMessage({ type: "paperboy:rect", field, blockIndex, rect }, "*");
        }
      });
    }
    try { win.sessionStorage.setItem(`pb-scroll:${doc.location.pathname}`, String(win.scrollY)); } catch { /* ignore */ }
  };

  // ---- admin → preview: live patch + focus ----
  let focusTimer: ReturnType<typeof setTimeout> | undefined;
  const onMessage = (e: MessageEvent) => {
    const msg = parsePreviewMessage(e.data);
    if (!msg) return;
    if (msg.type === "paperboy:patch") {
      const el = doc.querySelector<HTMLElement>(`[${ATTR.field}="${cssEscape(msg.field)}"]`);
      if (!el) return;
      if (typeof msg.html === "string") el.innerHTML = msg.html;
      else if (typeof msg.text === "string") el.textContent = msg.text;
      if (tracked && !tracked.isConnected) tracked = el;
      onScrollOrResize();
    } else if (msg.type === "paperboy:focus") {
      const el = doc.querySelector<HTMLElement>(`[${ATTR.field}="${cssEscape(msg.field)}"]`);
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("pb-focus");
      clearTimeout(focusTimer);
      focusTimer = setTimeout(() => el.classList.remove("pb-focus"), 1600);
    } else if (msg.type === "paperboy:dragsource") {
      // The admin started dragging an Assets-pane item — remember the payload so
      // a same-origin drop on a content area works (dataTransfer is hidden
      // cross-origin; the cross-origin path uses drop-at below).
      dragPayload = msg.payload;
    } else if (msg.type === "paperboy:dragend") {
      dragPayload = null;
      setDropZone(null);
    } else if (msg.type === "paperboy:drag-at") {
      // Cross-origin: the admin caught the drag over its overlay and forwarded
      // the pointer (in our viewport coords). Highlight the content area under it.
      const el = doc.elementFromPoint(msg.x, msg.y) as HTMLElement | null;
      setDropZone((el?.closest(`[${ATTR.area}]`) as HTMLElement | null) ?? null);
    } else if (msg.type === "paperboy:drop-at") {
      const el = doc.elementFromPoint(msg.x, msg.y) as HTMLElement | null;
      const zone = el?.closest(`[${ATTR.area}]`) as HTMLElement | null;
      setDropZone(null);
      if (zone) target?.postMessage({ type: "paperboy:drop", field: checkAreaValue(zone), payload: msg.payload }, "*");
    }
  };

  doc.addEventListener("click", onClick, true); // capture so links don't navigate first
  doc.addEventListener("dragover", onDragOver);
  doc.addEventListener("dragleave", onDragLeave);
  doc.addEventListener("drop", onDrop);
  win.addEventListener("dragend", onDragEnd);
  win.addEventListener("scroll", onScrollOrResize, { passive: true });
  win.addEventListener("resize", onScrollOrResize);
  win.addEventListener("message", onMessage);

  // restore scroll from before the last autosave reload
  try {
    const saved = win.sessionStorage.getItem(`pb-scroll:${doc.location.pathname}`);
    if (saved) win.scrollTo(0, Number(saved));
  } catch { /* ignore */ }

  target?.postMessage({ type: "paperboy:preview-ready", version: PROTOCOL_VERSION }, "*");

  return function teardown() {
    doc.removeEventListener("click", onClick, true);
    doc.removeEventListener("dragover", onDragOver);
    doc.removeEventListener("dragleave", onDragLeave);
    doc.removeEventListener("drop", onDrop);
    win.removeEventListener("dragend", onDragEnd);
    win.removeEventListener("scroll", onScrollOrResize);
    win.removeEventListener("resize", onScrollOrResize);
    win.removeEventListener("message", onMessage);
    clearTimeout(focusTimer);
    setDropZone(null);
    style.remove();
    badgeEl?.remove();
    doc.body.classList.remove("pb-editing");
  };
}
