/**
 * The preview message protocol — the single source of truth for the contract
 * between the Paperboy CMS admin (parent window) and a frontend rendered inside
 * the preview iframe. BOTH ends import these types so they can't drift.
 *
 * Pure types + constants: NO DOM, NO framework. The admin imports this module
 * directly (`@paperboycms/preview/protocol`); the iframe bridge builds on it.
 *
 * Compatibility: the admin and each frontend deploy independently, so the
 * protocol is ADDITIVE-ONLY and both ends IGNORE unknown message types and
 * treat fields as optional — an old frontend against a new admin (or vice
 * versa) degrades gracefully instead of throwing.
 */

export const PROTOCOL_VERSION = 1;

/** DOM attribute conventions the bridge interprets. The host frontend is
 *  responsible for emitting them on the right elements; the bridge only reads
 *  them. This is the contract surface between markup and behavior. */
export const ATTR = {
  /** An editable field region; value = field name. */
  field: "data-pb-field",
  /** A content area that accepts block drops; value = field name. */
  area: "data-pb-area",
  /** A rendered block inside an area; value = its index. */
  blockIndex: "data-pb-block-index",
  /** A rendered block's type (optional companion to blockIndex). */
  blockType: "data-pb-block-type",
} as const;

/** MIME type carried by an Assets-pane drag (shared block / page / media). */
export const DRAG_MIME = "application/x-paperboy";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Click position inside a field, so the admin can place its caret/overlay. */
export interface Caret {
  snippet: string;
  offset: number;
}

/* ----------------------------- iframe → admin ----------------------------- */

export interface ReadyMessage {
  type: "paperboy:preview-ready";
  version: number;
}

export interface EditMessage {
  type: "paperboy:edit";
  field: string | null;
  blockIndex: number | null;
  blockType?: string | null;
  rect: Rect;
  click?: { x: number; y: number };
  caret?: Caret | null;
}

export interface RectMessage {
  type: "paperboy:rect";
  field: string | null;
  blockIndex: number | null;
  rect: Rect;
}

export interface DropMessage {
  type: "paperboy:drop";
  /** The content-area field the block was dropped on. */
  field: string | null;
  /** The Assets-pane payload (e.g. { kind, documentId, blockType, name }). */
  payload: unknown;
}

/* ----------------------------- admin → iframe ----------------------------- */

export interface PatchMessage {
  type: "paperboy:patch";
  field: string;
  text?: string;
  html?: string;
}

export interface FocusMessage {
  type: "paperboy:focus";
  field: string;
}

/** A drag started in the admin (Assets pane). Broadcast to the iframe so the
 *  bridge can accept the drop WITHOUT reading dataTransfer — browsers hide drag
 *  data from a cross-origin preview iframe, so postMessage is the reliable path. */
export interface DragSourceMessage {
  type: "paperboy:dragsource";
  /** The same payload the Assets pane puts on dataTransfer (e.g. { kind, documentId, blockType, name }). */
  payload: unknown;
}

export interface DragEndMessage {
  type: "paperboy:dragend";
}

/** Cross-origin iframes don't receive the parent's drag events, so the admin
 *  catches the drag over an overlay and forwards the pointer position (in the
 *  iframe's own viewport coords) here; the bridge hit-tests which content area
 *  is under it. `drag-at` highlights it; `drop-at` carries the payload to drop. */
export interface DragAtMessage {
  type: "paperboy:drag-at";
  x: number;
  y: number;
}

export interface DropAtMessage {
  type: "paperboy:drop-at";
  x: number;
  y: number;
  payload: unknown;
}

export type FromPreview = ReadyMessage | EditMessage | RectMessage | DropMessage;
export type ToPreview = PatchMessage | FocusMessage | DragSourceMessage | DragEndMessage | DragAtMessage | DropAtMessage;
export type PaperboyMessage = FromPreview | ToPreview;

const KNOWN_TYPES = new Set<string>([
  "paperboy:preview-ready",
  "paperboy:edit",
  "paperboy:rect",
  "paperboy:drop",
  "paperboy:patch",
  "paperboy:focus",
  "paperboy:dragsource",
  "paperboy:dragend",
  "paperboy:drag-at",
  "paperboy:drop-at",
]);

/**
 * Narrow an untrusted `MessageEvent.data` to a known protocol message, or null.
 * Unknown `paperboy:*` types return null (forward-compatible: a newer peer can
 * send a message an older peer simply ignores).
 */
export function parsePreviewMessage(data: unknown): PaperboyMessage | null {
  if (!data || typeof data !== "object") return null;
  const type = (data as { type?: unknown }).type;
  if (typeof type !== "string" || !KNOWN_TYPES.has(type)) return null;
  return data as PaperboyMessage;
}

/* --------- builders for the admin → iframe direction (pure, no DOM) -------- */

export const patchMessage = (field: string, content: { text?: string; html?: string }): PatchMessage => ({
  type: "paperboy:patch",
  field,
  ...content,
});

export const focusMessage = (field: string): FocusMessage => ({ type: "paperboy:focus", field });

export const dragSourceMessage = (payload: unknown): DragSourceMessage => ({ type: "paperboy:dragsource", payload });

export const dragEndMessage = (): DragEndMessage => ({ type: "paperboy:dragend" });

export const dragAtMessage = (x: number, y: number): DragAtMessage => ({ type: "paperboy:drag-at", x, y });

export const dropAtMessage = (x: number, y: number, payload: unknown): DropAtMessage => ({ type: "paperboy:drop-at", x, y, payload });
