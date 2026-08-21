import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { dragAtMessage, dragEndMessage, dragSourceMessage, dropAtMessage, focusMessage, patchMessage } from "@paperboycms/preview/protocol";
import { api } from "../lib/api.js";
import { Icon } from "../lib/icons.js";
import { isPreviewActivity, originOf } from "../lib/preview-origin.js";
import { Surface } from "./ui/surface.js";

/**
 * How long before expiry we refresh the preview token. The API mints 15-minute
 * tokens; refreshing at 10 keeps a long editing session from loading a preview with
 * an already-dead token.
 *
 * There is deliberately NO build-time secret here any more. VITE_PREVIEW_SECRET
 * inlined the long-lived PREVIEW_SECRET into this bundle, which nginx serves with
 * no auth — so anyone who fetched the admin's JS could read every draft, forever.
 */
const PREVIEW_TOKEN_REFRESH_MS = 10 * 60 * 1000;

/** Fallback web origin when no preview URL is configured in Settings: derive it
 *  from the host the admin is loaded on (works on localhost, LAN IP or domain). */
function fallbackWebUrl(): string {
  const env = import.meta.env.VITE_WEB_URL as string | undefined;
  if (env) return env;
  if (typeof window !== "undefined") return `${window.location.protocol}//${window.location.hostname}:8092`;
  return "http://localhost:8092";
}

/**
 * Origin of the preview frontend — the ONLY origin the admin exchanges bridge
 * messages with. Used to address outbound posts (never "*", which would hand draft
 * content to whatever the iframe has navigated to) and to authenticate inbound
 * ones (see Editor's message handler). Null only if no origin can be determined,
 * in which case callers must fail closed.
 */
export function previewOrigin(site: { previewBaseUrl: string } | undefined): string | null {
  return originOf(site?.previewBaseUrl || fallbackWebUrl());
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
  kind,
  refreshSignal = 0,
  focusField,
  mode = "inspect",
  overlay,
  livePatch,
}: {
  locale: string;
  urlPath: string | null;
  documentId?: string;
  /** Content kind — a PAGE with no urlPath has nothing to preview (see below). */
  kind?: string;
  refreshSignal?: number;
  focusField?: { field: string; blockIndex?: number; n: number } | null;
  /** inspect = click focuses the sidebar field (classic); edit = on-page overlay. */
  mode?: PreviewMode;
  /** Anchored on-page editor: rect + click offset from the bridge, content from
   *  Editor. The card opens at the CLICK point (ox/oy within the element) — a
   *  very tall element would otherwise push it out of sight. */
  overlay?: { rect: PbRect; ox: number; oy: number; content: React.ReactNode; onClose: () => void } | null;
  /** Live DOM patch for the page (text/html swap, no reload) — keyed by n. */
  livePatch?: { field: string; text?: string; html?: string; blockIndex?: number; n: number } | null;
}) {
  const [device, setDevice] = useState<Device>("desktop");
  const [nonce, setNonce] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // Preview origin is configured in Settings → Site; fall back to the
  // build-time/derived host if it hasn't been set yet.
  const site = useQuery({ queryKey: ["site"], queryFn: ({ signal }) => api.site(signal) });
  // Every post below is addressed to THIS origin, never "*": a wildcard would
  // deliver draft content (patchMessage carries the rendered field html) to
  // whatever the iframe currently holds — and an editor clicking an external link
  // inside the preview is enough to make that a third party. Null = unknown
  // origin, in which case we post nothing rather than broadcasting.
  const targetOrigin = previewOrigin(site.data);
  const postToPreview = (message: unknown): void => {
    if (!targetOrigin) return;
    iframeRef.current?.contentWindow?.postMessage(message, targetOrigin);
  };
  // Reload the iframe whenever the editor saves (near-live preview).
  useEffect(() => { if (refreshSignal > 0) setNonce((n) => n + 1); }, [refreshSignal]);
  // Editor → preview: when a property is focused, scroll to + highlight its region.
  useEffect(() => {
    if (focusField?.field) postToPreview(focusMessage(focusField.field, { blockIndex: focusField.blockIndex }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusField, targetOrigin]);
  // Dragging a shared block from the Assets pane: a CROSS-ORIGIN preview iframe
  // never receives the parent's drag events, so we show an overlay over the
  // preview that catches the drag in the admin, then forward the pointer (in the
  // iframe's own coords) so the bridge can hit-test the content area under it.
  const [drag, setDrag] = useState<{ payload: unknown } | null>(null);
  /**
   * Did the preview actually load? A frontend that refuses framing
   * (`frame-ancestors 'none'` or `X-Frame-Options: DENY`) renders an EMPTY iframe and
   * reports only a console error the editor never sees — so the pane looked broken
   * with no explanation. We can't read a cross-origin frame to check, and no error
   * event fires, so this infers it from silence: @paperboycms/preview posts
   * `paperboy:preview-ready` on load, and if nothing arrives we show an actionable
   * hint ALONGSIDE the iframe rather than replacing it (the frontend may simply not
   * run the bridge, in which case the preview is fine and the hint is just advice).
   */
  const [bridgeSeen, setBridgeSeen] = useState(false);
  const [quiet, setQuiet] = useState(false);
  // The hint is dismissable PER FRONTEND: a preview that renders fine without
  // the bridge would otherwise show it on every visit (reported 2026-08-20 —
  // the hint sat under a perfectly working preview).
  const hintKey = `pb-preview-hint-dismissed:${targetOrigin}`;
  const [hintDismissed, setHintDismissed] = useState(() => Boolean(targetOrigin && localStorage.getItem(hintKey)));
  useEffect(() => {
    setHintDismissed(Boolean(targetOrigin && localStorage.getItem(`pb-preview-hint-dismissed:${targetOrigin}`)));
  }, [targetOrigin]);
  const dismissHint = () => {
    if (targetOrigin) localStorage.setItem(hintKey, "1");
    setHintDismissed(true);
  };
  useEffect(() => {
    // ANY valid bridge message counts as proof of life, not just preview-ready —
    // the hint below must only ever appear when the frame is truly silent.
    const onReady = (e: MessageEvent) => {
      if (isPreviewActivity(e.origin, targetOrigin, e.data)) setBridgeSeen(true);
    };
    window.addEventListener("message", onReady);
    return () => window.removeEventListener("message", onReady);
  }, [targetOrigin]);
  useEffect(() => {
    setQuiet(false);
    setBridgeSeen(false);
    const t = setTimeout(() => setQuiet(true), 4000);
    return () => clearTimeout(t);
  }, [nonce, device, urlPath, locale]);
  useEffect(() => {
    const onStart = (e: Event) => {
      const payload = (e as CustomEvent).detail;
      setDrag({ payload });
      postToPreview(dragSourceMessage(payload));
    };
    const onEnd = () => {
      setDrag(null);
      postToPreview(dragEndMessage());
    };
    window.addEventListener("pb:dragsource", onStart);
    window.addEventListener("pb:dragend", onEnd);
    return () => {
      window.removeEventListener("pb:dragsource", onStart);
      window.removeEventListener("pb:dragend", onEnd);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetOrigin]);
  // Editor → preview: live-update the clicked field's rendered content so the
  // page reflects overlay typing WITHOUT a full iframe reload.
  useEffect(() => {
    if (livePatch?.field) {
      postToPreview(patchMessage(livePatch.field, { text: livePatch.text, html: livePatch.html }, { blockIndex: livePatch.blockIndex }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [livePatch, targetOrigin]);
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
  const isStart = !!documentId && site.data?.startPageId === documentId;
  const path = isStart ? "" : urlPath && urlPath !== "/" ? urlPath : "";
  // Load the page directly with a ?pbt=<token> preview param (no /api/draft
  // redirect, no Secure cookie) — works over plain HTTP and any host. The token is
  // minted per session by the API; a cross-origin iframe can't rely on cookies,
  // which is why this rides in the query string at all.
  const previewToken = useQuery({
    queryKey: ["preview-token"],
    queryFn: ({ signal }) => api.previewToken(signal),
    refetchInterval: PREVIEW_TOKEN_REFRESH_MS,
    refetchOnMount: false,
    staleTime: PREVIEW_TOKEN_REFRESH_MS,
    retry: false,
  });
  const src = previewToken.data
    ? `${publicSiteUrl(site.data, locale, urlPath, documentId)}?pbt=${encodeURIComponent(previewToken.data.token)}&n=${nonce}`
    : null;

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
  // into pane coordinates. The ring outlines the whole element; the card is
  // anchored at the CLICK POINT inside it (ox/oy, preserved across rect
  // updates while the page scrolls), clamped so it always fits the pane.
  const CARD_W = 380;
  const CARD_H_EST = 340; // clamp allowance so the card's body stays visible
  const anchor = overlay
    ? (() => {
        const sx = tx + overlay.rect.x * scale;
        const sy = overlay.rect.y * scale;
        const sw = overlay.rect.w * scale;
        const sh = overlay.rect.h * scale;
        const clickX = tx + (overlay.rect.x + overlay.ox) * scale;
        const clickY = (overlay.rect.y + overlay.oy) * scale;
        return {
          ring: { left: sx, top: sy, width: sw, height: sh },
          card: {
            left: Math.max(8, Math.min(clickX - 40, Math.max(8, box.w - CARD_W - 8))),
            top: Math.max(8, Math.min(clickY + 14, Math.max(8, box.h - CARD_H_EST))),
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
            <button key={d} className={`rounded px-2 py-0.5 text-xs capitalize ${device === d ? "bg-accent/15 font-semibold text-accent-700" : "text-muted hover:bg-canvas"}`}
              onClick={() => setDevice(d)}>{d}</button>
          ))}
        </div>
        <button className="btn-subtle px-2 py-0.5 text-xs" onClick={() => setNonce((n) => n + 1)}>Refresh</button>
        <span className="text-[11px] tabular-nums text-muted">{target}px · {Math.round(scale * 100)}%</span>
        <span className="ml-auto truncate text-xs text-muted">/{locale}{path}</span>
      </div>
      <div ref={stageRef} className="relative min-h-0 flex-1 overflow-hidden bg-canvas">
        {kind === "page" && !urlPath && !isStart ? (
          // A page without a URL segment resolves to NOTHING on the site —
          // loading the iframe would show some other page (e.g. its parent).
          <div className="grid h-full place-items-center p-6 text-center">
            <div className="max-w-xs text-sm text-muted">
              <p className="font-medium text-fg">No URL yet</p>
              <p className="mt-1">Give this page a URL segment (the chip next to the name) to preview it on the site.</p>
            </div>
          </div>
        ) : (
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
          {src ? (
            <>
            <iframe
              key={device}
              ref={iframeRef}
              title="Content preview"
              src={src}
              className="border border-line bg-white shadow-panel"
              style={{ width: "100%", height: "100%", border: 0 }}
            />
            {quiet && !bridgeSeen && targetOrigin && !hintDismissed && (
              // Advice, not a verdict: the admin CANNOT read a cross-origin frame, so
              // its only proof of life is a paperboy:* postMessage from the
              // @paperboycms/preview bridge. A frontend that renders fine but doesn't
              // run the bridge is indistinguishable from a refused frame — so say so
              // honestly, and let the editor dismiss it per frontend.
              <div className="pointer-events-auto absolute inset-x-0 bottom-0 border-t border-line bg-panel/95 p-3 pr-9 text-xs text-muted">
                <button
                  type="button"
                  className="absolute right-2 top-2 rounded p-1 text-muted hover:bg-line/60 hover:text-fg"
                  aria-label="Dismiss this hint for this frontend"
                  title="Dismiss for this frontend"
                  onClick={dismissHint}
                >
                  <Icon.X width={14} height={14} />
                </button>
                <strong className="text-fg">No response from the preview bridge.</strong>{" "}
                <span className="block">
                  <strong className="text-fg">If the preview shows content above</strong>, everything is fine — your frontend at{" "}
                  <code className="font-mono">{targetOrigin}</code> just isn’t running{" "}
                  <code className="font-mono">@paperboycms/preview</code>, which powers on-page editing and live
                  updates. Add the bridge to enable those (and this hint goes away), or dismiss this with the ×.
                </span>
                <span className="mt-1 block">
                  <strong className="text-fg">If the preview is empty</strong>, the frontend is probably refusing to be
                  framed. It must allow this admin as a frame ancestor — scoped to the framed request, so the public
                  site stays unframable:
                </span>
                <code className="mt-1 block break-all rounded bg-line/50 px-2 py-1 font-mono">
                  {`Content-Security-Policy: frame-ancestors ${window.location.origin}`}
                  <br />
                  {"// only when Sec-Fetch-Dest: iframe — otherwise frame-ancestors 'none'"}
                </code>
                <span className="mt-1 block">
                  and must NOT send <code className="font-mono">X-Frame-Options: DENY</code> (it blocks framing on its
                  own, and can’t express “only the CMS”). Paperboy can’t set headers on another origin — this has to
                  change on the frontend; <code className="font-mono">apps/web/middleware.ts</code> is a working
                  example.
                </span>
              </div>
            )}
            </>
          ) : (
            // Show the SERVER's reason, never a guessed one. This used to hardcode
            // "the server has no PREVIEW_SECRET configured", which became a lie the
            // moment the mint route also started returning 403 for section-scoped
            // roles — telling an Author to go fix a config that is perfectly fine.
            // Both messages are written to be read by the person seeing them.
            <div className="flex h-full items-center justify-center border border-line bg-panel p-6 text-center text-sm text-muted">
              {previewToken.isError
                ? ((previewToken.error as Error | undefined)?.message ??
                  "Preview isn’t available right now.")
                : "Preparing preview…"}
            </div>
          )}
        </div>
        )}
        {/* Drop catcher: a cross-origin preview iframe can't receive the parent's
            drag events, so while a block is being dragged we overlay the stage,
            accept the drop here, and forward the pointer (in iframe coords) to
            the bridge to hit-test + insert. Only present during a drag. */}
        {drag && (
          <div
            className="absolute inset-0 z-20"
            style={{ cursor: "copy" }}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
              const r = stageRef.current?.getBoundingClientRect();
              if (r) postToPreview(dragAtMessage((e.clientX - r.left - tx) / scale, (e.clientY - r.top) / scale));
            }}
            onDrop={(e) => {
              e.preventDefault();
              const r = stageRef.current?.getBoundingClientRect();
              let payload: unknown = drag.payload;
              const raw = e.dataTransfer.getData("application/x-paperboy");
              if (raw) { try { payload = JSON.parse(raw); } catch { /* fall back to broadcast payload */ } }
              if (r) postToPreview(dropAtMessage((e.clientX - r.left - tx) / scale, (e.clientY - r.top) / scale, payload));
              setDrag(null);
            }}
          >
            <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-full bg-accent px-3 py-1 text-xs font-medium text-white shadow-panel">
              Drop onto a content area to add the block
            </div>
          </div>
        )}
        {anchor && overlay && (
          <>
            {/* Highlight ring over the element being edited. */}
            <div
              className="pointer-events-none absolute z-10 rounded-xs ring-2 ring-accent"
              style={anchor.ring}
              aria-hidden
            />
            {/* The anchored editor card (unscaled admin UI). */}
            <Surface
              elevation={2}
              radius="lg"
              className="absolute z-20"
              style={{ ...anchor.card, width: CARD_W }}
              role="dialog"
              aria-label="Edit property"
            >
              {overlay.content}
            </Surface>
          </>
        )}
      </div>
    </div>
  );
}
