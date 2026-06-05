import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api.js";

const PREVIEW_SECRET = (import.meta.env.VITE_PREVIEW_SECRET as string) ?? "dev-preview-secret-change-me";

/** Fallback web origin when no preview URL is configured in Settings: derive it
 *  from the host the admin is loaded on (works on localhost, LAN IP or domain). */
function fallbackWebUrl(): string {
  const env = import.meta.env.VITE_WEB_URL as string | undefined;
  if (env) return env;
  if (typeof window !== "undefined") return `${window.location.protocol}//${window.location.hostname}:8092`;
  return "http://localhost:8092";
}

/**
 * Public (published) URL of a page on the end-user site. Shared by the preview
 * iframe (which appends the ?pb=<secret> draft param) and the "View on site"
 * shortcut in the publish menu (which opens it as-is — published perspective).
 */
export function publicSiteUrl(
  site: { startPageId: string | null; previewBaseUrl: string } | undefined,
  locale: string,
  urlPath: string | null,
  documentId?: string,
): string {
  const base = (site?.previewBaseUrl || fallbackWebUrl()).replace(/\/+$/, "");
  // The start page is served at the front-end root ("/"), not at its slug path.
  const isStart = !!documentId && site?.startPageId === documentId;
  const path = isStart ? "" : urlPath && urlPath !== "/" ? urlPath : "";
  return `${base}/${encodeURIComponent(locale)}${path}`;
}

type Device = "desktop" | "tablet" | "mobile";
// Real viewport widths the page is rendered at; the stage scales them to fit the
// pane (scaled) so "desktop" shows the true desktop layout, not a
// narrow column that trips the site's mobile breakpoints.
const WIDTHS: Record<Device, number> = { desktop: 1280, tablet: 834, mobile: 390 };
// Real device viewport heights so `100vh` sections look right (not inflated).
const HEIGHTS: Record<Device, number> = { desktop: 860, tablet: 1112, mobile: 844 };

/** Element rect inside the iframe's viewport (CSS px, pre-scale). */
export interface PbRect { x: number; y: number; w: number; h: number }
export type PreviewMode = "inspect" | "edit";

export function PreviewPane({
  locale,
  urlPath,
  documentId,
  refreshSignal = 0,
  focusField,
  mode = "inspect",
  onModeChange,
  overlay,
  livePatch,
}: {
  locale: string;
  urlPath: string | null;
  documentId?: string;
  refreshSignal?: number;
  focusField?: { field: string; n: number } | null;
  /** inspect = click focuses the sidebar field (classic); edit = on-page overlay. */
  mode?: PreviewMode;
  onModeChange?: (m: PreviewMode) => void;
  /** Anchored on-page editor: rect comes from the bridge, content from Editor. */
  overlay?: { rect: PbRect; content: React.ReactNode; onClose: () => void } | null;
  /** Live DOM patch for the page (text/html swap, no reload) — keyed by n. */
  livePatch?: { field: string; text?: string; html?: string; n: number } | null;
}) {
  const [device, setDevice] = useState<Device>("desktop");
  const [nonce, setNonce] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // Reload the iframe whenever the editor saves (near-live preview).
  useEffect(() => { if (refreshSignal > 0) setNonce((n) => n + 1); }, [refreshSignal]);
  // Editor → preview: when a property is focused, scroll to + highlight its region.
  useEffect(() => {
    if (focusField?.field) iframeRef.current?.contentWindow?.postMessage({ type: "paperboy:focus", field: focusField.field }, "*");
  }, [focusField]);
  // Editor → preview: live-update the clicked field's rendered content so the
  // page reflects overlay typing WITHOUT a full iframe reload.
  useEffect(() => {
    if (livePatch?.field) {
      iframeRef.current?.contentWindow?.postMessage(
        { type: "paperboy:patch", field: livePatch.field, text: livePatch.text, html: livePatch.html },
        "*",
      );
    }
  }, [livePatch]);
  // Esc closes the on-page overlay (when focus is on the admin side).
  useEffect(() => {
    if (!overlay) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") overlay.onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [overlay]);

  // Measure the stage so we can scale the fixed-width viewport down to fit.
  const stageRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);
  // Preview origin is configured in Settings → Site; fall back
  // to the build-time/derived host if it hasn't been set yet.
  const site = useQuery({ queryKey: ["site"], queryFn: ({ signal }) => api.site(signal) });
  const isStart = !!documentId && site.data?.startPageId === documentId;
  const path = isStart ? "" : urlPath && urlPath !== "/" ? urlPath : "";
  // Load the page directly with a ?pb=<secret> preview param (no /api/draft
  // redirect, no Secure cookie) — works over plain HTTP and any host.
  const src = `${publicSiteUrl(site.data, locale, urlPath, documentId)}?pb=${encodeURIComponent(PREVIEW_SECRET)}&n=${nonce}`;

  // Fit the device viewport to the pane WIDTH (the dimension that matters for a
  // desktop layout), then make the iframe tall enough to FILL the pane height so
  // there's no empty gap — the page scrolls inside the iframe. For tablet/mobile
  // (taller than the pane) we also cap by height so the whole device shows.
  const target = WIDTHS[device];
  const vh = HEIGHTS[device];
  const pad = 16;
  const widthScale = box.w ? (box.w - pad) / target : 1;
  const fitScale = box.w && box.h ? Math.min((box.w - pad) / target, (box.h - pad) / vh) : 1;
  const scale = Math.max(0.1, Math.min(1, device === "desktop" ? widthScale : fitScale));
  const scaledW = target * scale;
  const tx = Math.max(0, (box.w - scaledW) / 2);
  // Desktop fills the pane height (scroll inside); tablet/mobile keep their real height.
  const innerH = device === "desktop" && scale ? box.h / scale : vh;

  // On-page overlay placement: transform the bridge-reported (pre-scale) rect
  // into pane coordinates, anchor the card under the element, clamp to the pane.
  const CARD_W = 380;
  const anchor = overlay
    ? (() => {
        const sx = tx + overlay.rect.x * scale;
        const sy = overlay.rect.y * scale;
        const sw = overlay.rect.w * scale;
        const sh = overlay.rect.h * scale;
        return {
          ring: { left: sx, top: sy, width: sw, height: sh },
          card: {
            left: Math.max(8, Math.min(sx, Math.max(8, box.w - CARD_W - 8))),
            top: Math.max(8, Math.min(sy + sh + 8, Math.max(8, box.h - 240))),
          },
        };
      })()
    : null;

  return (
    <div className="flex h-full flex-col">
      {/* Persistent "viewing drafts" banner (editors must know). */}
      <div className={`flex items-center gap-2 px-3 py-1.5 text-xs font-medium ${mode === "edit" ? "bg-accent/15 text-accent-700" : "bg-draft/15 text-draft"}`} role="status">
        <span className={`h-2 w-2 rounded-full ${mode === "edit" ? "bg-accent" : "bg-draft"}`} />
        {mode === "edit"
          ? "On-page editing — click an element to edit it right here"
          : "Preview — click any heading, text or block to edit it"}
      </div>
      <div className="flex items-center gap-2 border-b border-line bg-panel px-3 py-2">
        <div className="flex rounded border border-line p-0.5">
          {(["desktop", "tablet", "mobile"] as Device[]).map((d) => (
            <button key={d} className={`rounded px-2 py-0.5 text-xs capitalize ${device === d ? "bg-accent text-white" : "text-muted hover:bg-canvas"}`}
              onClick={() => setDevice(d)}>{d}</button>
          ))}
        </div>
        <button className="btn-subtle px-2 py-0.5 text-xs" onClick={() => setNonce((n) => n + 1)}>Refresh</button>
        {onModeChange && (
          <button
            className={`rounded border px-2 py-0.5 text-xs ${mode === "edit" ? "border-accent bg-accent/15 font-medium text-accent-700" : "border-line text-muted hover:bg-canvas"}`}
            aria-pressed={mode === "edit"}
            title="Edit properties directly on the page (Optimizely-style on-page edit)"
            onClick={() => onModeChange(mode === "edit" ? "inspect" : "edit")}
          >
            ✎ Edit on page
          </button>
        )}
        <span className="text-[11px] tabular-nums text-muted">{target}px · {Math.round(scale * 100)}%</span>
        <span className="ml-auto truncate text-xs text-muted">/{locale}{path}</span>
      </div>
      <div ref={stageRef} className="relative min-h-0 flex-1 overflow-hidden bg-canvas">
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: target,
            height: innerH,
            transform: `translate(${tx}px, 0) scale(${scale})`,
            transformOrigin: "top left",
          }}
        >
          <iframe
            key={device}
            ref={iframeRef}
            title="Content preview"
            src={src}
            className="border border-line bg-white shadow-panel"
            style={{ width: "100%", height: "100%", border: 0 }}
          />
        </div>
        {anchor && overlay && (
          <>
            {/* Highlight ring over the element being edited. */}
            <div
              className="pointer-events-none absolute z-10 rounded-sm ring-2 ring-accent"
              style={anchor.ring}
              aria-hidden
            />
            {/* The anchored editor card (unscaled admin UI). */}
            <div
              className="absolute z-20 rounded-[var(--radius-lg)] border border-line bg-panel shadow-pop"
              style={{ ...anchor.card, width: CARD_W }}
              role="dialog"
              aria-label="Edit property"
            >
              {overlay.content}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
