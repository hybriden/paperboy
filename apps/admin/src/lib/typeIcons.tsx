import { Icon as IconifyIcon, addCollection } from "@iconify/react";
import { useQuery } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { api } from "./api.js";

/**
 * Content-type icons: Phosphor DUOTONE (via the bundled Iconify collection —
 * fully offline, no icon CDN). The ~1.5k-icon collection is code-split and
 * loaded lazily so the first paint doesn't pay for it; TypeIcon renders a
 * fixed-size placeholder until it lands (one-time flash, then cached).
 *
 * Stored value: "ph:<name>" (e.g. "ph:rocket") — the duotone weight is applied
 * at render so stored names stay within the 40-char schema limit and survive a
 * future weight change. Legacy lucide names (pre-Phosphor types and old seeds)
 * are mapped via LEGACY below.
 */

let phosphorNames: ReadonlyArray<string> = [];
let phosphorSet: ReadonlySet<string> = new Set();
let loaded = false;
const listeners = new Set<() => void>();

// Duotone-only subset (regenerate with scripts/gen-ph-duotone.mjs) — 1/6 the
// size of the full all-weights collection.
void import("./ph-duotone.json").then((mod) => {
  const collection = (mod as { default?: unknown }).default ?? mod;
  addCollection(collection as Parameters<typeof addCollection>[0]);
  const icons = (collection as { icons: Record<string, unknown> }).icons;
  phosphorNames = Object.keys(icons)
    .filter((n) => n.endsWith("-duotone"))
    .map((n) => n.slice(0, -"-duotone".length))
    .sort();
  phosphorSet = new Set(phosphorNames);
  loaded = true;
  for (const l of listeners) l();
});

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** True once the Phosphor collection chunk has loaded. */
function useIconsReady(): boolean {
  return useSyncExternalStore(subscribe, () => loaded, () => false);
}

/** All duotone base names (e.g. "rocket"), sorted — for the icon picker. */
export function usePhosphorIconNames(): ReadonlyArray<string> {
  useIconsReady();
  return phosphorNames;
}

/** Lucide-era stored names (the old curated set + pre-lucide seeds) → Phosphor. */
const LEGACY: Record<string, string> = {
  file: "file", "file-text": "file-text", files: "files", newspaper: "newspaper",
  "book-open": "book-open", library: "books", "layout-template": "layout",
  "layout-grid": "squares-four", "layout-list": "rows", "layout-dashboard": "gauge",
  layers: "stack", square: "square", blocks: "stack", component: "puzzle-piece",
  puzzle: "puzzle-piece", box: "cube", boxes: "stack", package: "package",
  image: "image", images: "images", camera: "camera", video: "video-camera", music: "music-notes",
  globe: "globe", map: "map-trifold", "map-pin": "map-pin", compass: "compass", home: "house",
  "building-2": "buildings", landmark: "bank", store: "storefront",
  "shopping-cart": "shopping-cart", tag: "tag", tags: "tag",
  settings: "gear", wrench: "wrench", "sliders-horizontal": "sliders-horizontal",
  database: "database", server: "hard-drives", code: "code", terminal: "terminal",
  user: "user", users: "users", mail: "envelope", "message-square": "chat-text", phone: "phone",
  calendar: "calendar", clock: "clock",
  star: "star", heart: "heart", award: "medal", target: "target", flag: "flag",
  bookmark: "bookmark", bell: "bell", megaphone: "megaphone", rss: "rss", link: "link",
  search: "magnifying-glass", lightbulb: "lightbulb", rocket: "rocket", zap: "lightning", flame: "fire",
  leaf: "leaf", coffee: "coffee", car: "car", plane: "airplane", briefcase: "briefcase",
  "graduation-cap": "graduation-cap", shield: "shield", lock: "lock", key: "key",
  folder: "folder", "folder-open": "folder-open", archive: "archive", inbox: "tray",
  list: "list", table: "table", quote: "quotes", type: "text-aa", pencil: "pencil",
  palette: "palette", sparkles: "sparkle", block: "stack", dashboard: "gauge",
};

/** Stored value → Phosphor duotone base name ("rocket"), with fallback. */
export function resolveIconBase(name: string | undefined | null, fallback = "file"): string {
  const raw = (name?.trim() || fallback).replace(/^ph:/, "").replace(/-duotone$/, "");
  const base = LEGACY[raw] ?? raw;
  if (!loaded || phosphorSet.has(base)) return base;
  const fb = LEGACY[fallback] ?? fallback;
  return phosphorSet.has(fb) ? fb : "file";
}

/** Render a content-type icon by its stored name. Accepts width/height/className. */
export function TypeIcon({
  name,
  fallback,
  width = 16,
  height = 16,
  className,
}: {
  name: string | undefined | null;
  fallback?: string;
  width?: number | string;
  height?: number | string;
  className?: string;
}) {
  const ready = useIconsReady();
  if (!ready) return <span style={{ width, height }} className={`inline-block shrink-0 ${className ?? ""}`} aria-hidden />;
  return <IconifyIcon icon={`ph:${resolveIconBase(name, fallback)}-duotone`} width={width} height={height} className={className} />;
}

/**
 * Icon name for a content TYPE name (e.g. "BlogPost" → its configured icon),
 * via the shared ["content-types"] query — usable in any row without prop
 * threading. Returns undefined while loading / for unknown types.
 */
export function useTypeIconName(typeName: string): string | undefined {
  const q = useQuery({
    queryKey: ["content-types"],
    queryFn: ({ signal }) => api.contentTypes(signal),
    staleTime: 60_000,
  });
  return q.data?.find((t) => t.name === typeName)?.icon;
}
