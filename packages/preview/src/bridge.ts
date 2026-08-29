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
import { ATTR, DRAG_MIME, PROTOCOL_VERSION, parsePreviewMessage, type Rect } from "./protocol.js";

export interface PreviewBridgeOptions {
  /** Window to post messages to. Default: the parent window. */
  target?: Window;
  /** Document to bind to. Default: the ambient `document`. */
  doc?: Document;
  /** Outline/highlight color. Default: Paperboy blue. */
  accent?: string;
  /**
   * Show the "Preview — click to edit" badge. Default: true. It is an entry
   * hint, not chrome: fixed top-center it inevitably covers page content, so it
   * is click-transparent and fades itself out after a few seconds — the dashed
   * outlines on editable elements carry the mode from there.
   */
  badge?: boolean;
  /**
   * Origin of the embedding admin, e.g. "https://cms.example.com". Optional and
   * additive (omit it and nothing changes for already-deployed frontends), but
   * RECOMMENDED: when set, inbound messages must come from this origin, and
   * outbound messages are addressed to it instead of "*" — so field text and
   * caret snippets can't leak to whatever origin happens to be the parent.
   *
   * Regardless of this option, the bridge only ever accepts messages whose
   * `event.source` IS the target window (see `fromParent`).
   */
  parentOrigin?: string;
}

const EDITABLE = `[${ATTR.field}],[${ATTR.blockIndex}]`;

export function initPreviewBridge(options: PreviewBridgeOptions = {}): () => void {
  const doc = options.doc ?? document;
  const win = doc.defaultView ?? (globalThis as unknown as Window);
  const target = options.target ?? win.parent;
  const accent = options.accent ?? "#0077BC";
  const showBadge = options.badge ?? true;
  /** Where outbound messages are addressed. "*" only when no parentOrigin is given. */
  const postOrigin = options.parentOrigin ?? "*";

  /**
   * Is this message really from the admin that embedded us?
   *
   * `paperboy:patch` ends in `el.innerHTML = …`, so this handler is an HTML
   * injection sink. Framing rules (CSP frame-ancestors) don't protect it: any page
   * can `window.open(previewUrl)`, hold the returned handle, and postMessage into
   * it without ever framing it. So identity is checked on the WINDOW HANDLE — a
   * foreign sender has a different `source`, and one that can't be attributed at
   * all (no source) is refused too.
   */
  const fromParent = (e: MessageEvent): boolean => {
    if (e.source !== target) return false;
    if (options.parentOrigin !== undefined && e.origin !== options.parentOrigin) return false;
    return true;
  };

  // ---- injected chrome (styles + optional badge); consumers ship no CSS ----
  const style = doc.createElement("style");
  style.dataset.pbBridge = "";
  style.textContent = `
    body.pb-editing [${ATTR.field}],body.pb-editing [${ATTR.blockIndex}]{cursor:pointer;outline:1px dashed ${accent}73;outline-offset:3px}
    body.pb-editing [${ATTR.field}]:hover,body.pb-editing [${ATTR.blockIndex}]:hover{outline:2px solid ${accent};outline-offset:3px}
    body.pb-editing [${ATTR.field}].pb-focus{outline:3px solid ${accent};outline-offset:3px;box-shadow:0 0 0 6px ${accent}2e}
    body.pb-editing [${ATTR.area}].pb-drop-active{outline:3px solid ${accent};outline-offset:4px;background:${accent}14}
    body.pb-editing [${ATTR.area}]{outline:1px dotted ${accent}59;outline-offset:6px}
    body.pb-editing [${ATTR.area}]:hover{outline:2px dotted ${accent}a6;outline-offset:6px}
    body.pb-editing [${ATTR.area}]:empty{min-height:3rem}
    .pb-area-tag{position:fixed;z-index:99998;pointer-events:none;background:${accent};color:#fff;font:600 10px/1 ui-sans-serif,system-ui,sans-serif;padding:3px 7px;border-radius:4px;opacity:.92;transform:translateY(-50%)}
    .pb-area-add{position:fixed;z-index:99998;background:#fff;color:${accent};border:1px solid ${accent};font:600 12px/1 ui-sans-serif,system-ui,sans-serif;padding:6px 12px;border-radius:999px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.18);transform:translate(-50%,-50%)}
    .pb-area-add:hover{background:${accent};color:#fff}
    .pb-edit-badge{position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:99999;pointer-events:none;background:${accent};color:#fff;font:600 12px/1 ui-sans-serif,system-ui,sans-serif;padding:7px 14px;border-radius:999px;box-shadow:0 2px 8px rgba(0,0,0,.25);animation:pb-badge-out .4s ease 4s forwards}
    @keyframes pb-badge-out{to{opacity:0;visibility:hidden}}
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
    // A field rendered INSIDE a block carries data-pb-field while the enclosing
    // block root carries data-pb-block-index — report both so the admin can
    // open the field editor scoped to that block instance. closest() includes
    // el itself, so a plain block-root click keeps its pre-0.3 shape.
    const blockEl = el.closest<HTMLElement>(`[${ATTR.blockIndex}]`);
    const bi = blockEl?.getAttribute(ATTR.blockIndex) ?? null;
    const r = el.getBoundingClientRect();
    return {
      field: el.getAttribute(ATTR.field),
      blockIndex: bi != null ? Number(bi) : null,
      blockType: blockEl?.getAttribute(ATTR.blockType) ?? null,
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
    target?.postMessage({ type: "paperboy:edit", ...describe(el), click: { x: e.clientX, y: e.clientY }, caret: caretAt(e, el) }, postOrigin);
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
    target?.postMessage({ type: "paperboy:drop", field: checkAreaValue(zone), payload }, postOrigin);
  };

  // ---- area chrome: name tag + "add block" chip for the hovered area ----
  // ONE fixed-position pair in <body>, tracked to whichever area the pointer is
  // over — never DOM injected INSIDE an area, where it would become a grid/flex
  // item and break the frontend's layout. The dotted outline (CSS above) shows
  // every area's extent; hovering names it and offers the add affordance.
  const areaTag = doc.createElement("div");
  areaTag.className = "pb-area-tag";
  areaTag.style.display = "none";
  const areaAdd = doc.createElement("button");
  areaAdd.type = "button";
  areaAdd.className = "pb-area-add";
  areaAdd.textContent = "＋ Add block";
  areaAdd.style.display = "none";
  doc.body.appendChild(areaTag);
  doc.body.appendChild(areaAdd);

  let hoveredArea: HTMLElement | null = null;
  const hideAreaChrome = () => {
    hoveredArea = null;
    areaTag.style.display = "none";
    areaAdd.style.display = "none";
  };
  const positionAreaChrome = () => {
    if (!hoveredArea?.isConnected) { hideAreaChrome(); return; }
    const r = hoveredArea.getBoundingClientRect();
    // Tag straddles the top-left corner; chip straddles the bottom-center edge
    // (both transform-centered in the CSS), so neither covers area content.
    areaTag.style.left = `${Math.max(4, r.x + 8)}px`;
    areaTag.style.top = `${Math.max(10, r.y)}px`;
    areaAdd.style.left = `${r.x + r.width / 2}px`;
    areaAdd.style.top = `${Math.min(win.innerHeight - 20, r.y + r.height)}px`;
  };
  const onPointerOver = (e: PointerEvent) => {
    const t = e.target as HTMLElement | null;
    // The chip/tag sit OUTSIDE the area element — hovering them must not count
    // as leaving the area, or the chip vanishes under the pointer.
    if (t === areaAdd || t === areaTag) return;
    const area = (t?.closest?.(`[${ATTR.area}]`) as HTMLElement | null) ?? null;
    if (area === hoveredArea) return;
    if (!area) { hideAreaChrome(); return; }
    hoveredArea = area;
    areaTag.textContent = area.getAttribute(ATTR.area) ?? "";
    areaTag.style.display = "";
    areaAdd.style.display = "";
    positionAreaChrome();
  };
  const onAddClick = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!hoveredArea?.isConnected) return;
    const r = hoveredArea.getBoundingClientRect();
    target?.postMessage(
      { type: "paperboy:add-block", field: checkAreaValue(hoveredArea), rect: { x: r.x, y: r.y, w: r.width, h: r.height } as Rect },
      postOrigin,
    );
  };
  areaAdd.addEventListener("click", onAddClick);

  // ---- track the picked element's rect on scroll/resize; persist scroll ----
  let raf = false;
  const onScrollOrResize = () => {
    if ((tracked || hoveredArea) && !raf) {
      raf = true;
      win.requestAnimationFrame(() => {
        raf = false;
        if (tracked?.isConnected) {
          const { field, blockIndex, rect } = describe(tracked);
          target?.postMessage({ type: "paperboy:rect", field, blockIndex, rect }, postOrigin);
        }
        positionAreaChrome(); // keep the hovered area's tag + chip glued to it
      });
    }
    try { win.sessionStorage.setItem(`pb-scroll:${doc.location.pathname}`, String(win.scrollY)); } catch { /* ignore */ }
  };

  // ---- admin → preview: live patch + focus ----
  let focusTimer: ReturnType<typeof setTimeout> | undefined;
  const onMessage = (e: MessageEvent) => {
    if (!fromParent(e)) return; // sender check BEFORE parsing — see fromParent
    const msg = parsePreviewMessage(e.data);
    if (!msg) return;
    if (msg.type === "paperboy:ping") {
      // Liveness probe: answer with the same announcement sent at init, so the
      // admin can confirm the bridge is alive at ANY time instead of having to
      // catch that one-shot message (see PingMessage in ./protocol).
      target?.postMessage({ type: "paperboy:preview-ready", version: PROTOCOL_VERSION }, postOrigin);
      return;
    }
    if (msg.type === "paperboy:patch") {
      // blockIndex (sent for fields inside blocks) scopes the lookup to that
      // block root, so same-named fields in sibling blocks stay untouched. An
      // unresolvable scope falls back to the page-wide lookup (old behavior).
      const scope: ParentNode =
        (msg.blockIndex != null ? doc.querySelector(`[${ATTR.blockIndex}="${msg.blockIndex}"]`) : null) ?? doc;
      const el = scope.querySelector<HTMLElement>(`[${ATTR.field}="${cssEscape(msg.field)}"]`);
      if (!el) return;
      if (typeof msg.html === "string") el.innerHTML = msg.html;
      else if (typeof msg.text === "string") el.textContent = msg.text;
      if (tracked && !tracked.isConnected) tracked = el;
      onScrollOrResize();
    } else if (msg.type === "paperboy:focus") {
      // blockIndex scopes the highlight to that block; a field the markup does
      // not tag falls back to flashing the block root itself, so the editor's
      // form always answers with SOME visible anchor on the page.
      const blockEl = msg.blockIndex != null ? doc.querySelector<HTMLElement>(`[${ATTR.blockIndex}="${msg.blockIndex}"]`) : null;
      const el =
        (blockEl ?? doc).querySelector<HTMLElement>(`[${ATTR.field}="${cssEscape(msg.field)}"]`) ??
        (msg.blockIndex != null ? blockEl : null);
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
      if (zone) target?.postMessage({ type: "paperboy:drop", field: checkAreaValue(zone), payload: msg.payload }, postOrigin);
    }
  };

  doc.addEventListener("click", onClick, true); // capture so links don't navigate first
  doc.addEventListener("pointerover", onPointerOver);
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

  target?.postMessage({ type: "paperboy:preview-ready", version: PROTOCOL_VERSION }, postOrigin);

  return function teardown() {
    doc.removeEventListener("click", onClick, true);
    doc.removeEventListener("pointerover", onPointerOver);
    doc.removeEventListener("dragover", onDragOver);
    doc.removeEventListener("dragleave", onDragLeave);
    doc.removeEventListener("drop", onDrop);
    win.removeEventListener("dragend", onDragEnd);
    win.removeEventListener("scroll", onScrollOrResize);
    win.removeEventListener("resize", onScrollOrResize);
    win.removeEventListener("message", onMessage);
    clearTimeout(focusTimer);
    setDropZone(null);
    areaAdd.removeEventListener("click", onAddClick);
    areaTag.remove();
    areaAdd.remove();
    style.remove();
    badgeEl?.remove();
    doc.body.classList.remove("pb-editing");
  };
}
