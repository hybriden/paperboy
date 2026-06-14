import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { Asset, StockSearchResult } from "@paperboy/shared";
import { api } from "../lib/api.js";
import { Icon } from "../lib/icons.js";
import { AI_OFF_HINT, useAiEnabled } from "../lib/useAiStatus.js";
import { FolderNav } from "./FolderNav.js";
import { Dialog, DialogContent } from "./ui/dialog.js";
import { useToast } from "./ui/toast.js";

const ACCEPT = "image/png,image/jpeg,image/gif,image/webp";

/**
 * Seed for the stock-image search in image pickers — the page name/heading,
 * provided by the editor so every nested image field (incl. content-area
 * blocks) opens the Stock tab with a relevant query pre-filled.
 */
export const StockQueryContext = createContext("");

function useAssets() {
  return useQuery({ queryKey: ["assets"], queryFn: ({ signal }) => api.assets(signal) });
}

/** Hidden file input + button that uploads and refreshes the ["assets"] cache.
 *  When `folderId` is set, the new image is filed into that media folder. */
function UploadButton({ onUploaded, label = "Upload", folderId }: { onUploaded?: (a: Asset) => void; label?: string; folderId?: string | null }) {
  const qc = useQueryClient();
  const toast = useToast();
  const ref = useRef<HTMLInputElement>(null);
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const asset = await api.uploadAsset(file);
      if (folderId) await api.setAssetFolder(asset.documentId, folderId);
      return asset;
    },
    onSuccess: (asset) => {
      void qc.invalidateQueries({ queryKey: ["assets"] });
      toast.success("Image uploaded", asset.filename);
      onUploaded?.(asset);
    },
    onError: (e) => toast.error("Upload failed", (e as Error).message),
  });
  return (
    <>
      <input
        ref={ref}
        type="file"
        accept={ACCEPT}
        aria-label="Upload image"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) upload.mutate(f);
          e.target.value = "";
        }}
      />
      <button className="btn-subtle px-2 py-1 text-xs" disabled={upload.isPending} onClick={() => ref.current?.click()}>
        <Icon.Plus width={14} height={14} /> {upload.isPending ? "Uploading…" : label}
      </button>
    </>
  );
}

function AssetThumb({ asset, selected, onClick }: { asset: Asset; selected?: boolean; onClick?: () => void }) {
  return (
    <button
      type="button"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("application/x-paperboy", JSON.stringify({ kind: "media", documentId: asset.documentId, url: asset.url, alt: asset.alt }));
        e.dataTransfer.effectAllowed = "copy";
      }}
      onClick={onClick}
      title={`${asset.filename}${asset.alt ? ` · ${asset.alt}` : ""} — pick, or drag onto an image field`}
      className={`group relative aspect-square cursor-grab overflow-hidden rounded-[var(--radius)] border active:cursor-grabbing ${selected ? "border-accent ring-2 ring-accent" : "border-line hover:border-accent/50"}`}
    >
      <img src={asset.url} alt={asset.alt} loading="lazy" className="h-full w-full bg-canvas object-cover" />
    </button>
  );
}

/** Assets pane → Media tab: grid + upload + per-image alt text + stock import. */
export function MediaTab() {
  const assets = useAssets();
  const qc = useQueryClient();
  const toast = useToast();
  const [mode, setMode] = useState<"library" | "stock">("library");
  const [folderId, setFolderId] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [alt, setAlt] = useState("");
  const move = useMutation({
    mutationFn: (v: { id: string; folderId: string | null }) => api.setAssetFolder(v.id, v.folderId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["assets"] }),
    onError: (e) => toast.error("Couldn’t move image", (e as Error).message),
  });
  const saveAlt = useMutation({
    mutationFn: (v: { id: string; alt: string }) => api.updateAssetAlt(v.id, v.alt),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["assets"] });
      setEditing(null);
      toast.success("Alt text saved");
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteAsset(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["assets"] });
      setEditing(null);
      toast.success("Image deleted");
    },
    onError: (e) => toast.error("Couldn’t delete", (e as Error).message),
  });
  // Vision: the server looks at the ACTUAL IMAGE (downscaled) — a filename can't
  // describe a picture, so without a configured key the button is simply off.
  const aiEnabled = useAiEnabled();
  const suggestAlt = useMutation({
    mutationFn: (documentId: string) => api.aiAltText(documentId),
    onSuccess: (r) => {
      setAlt(r.result);
      toast.success("Alt text suggested", "Generated from the image — review, then save.");
    },
    onError: (e) => toast.error("Couldn’t describe the image", (e as Error).message),
  });

  // Only the images in the current folder (null = root/unfiled).
  const visible = assets.data?.filter((a) => (a.folderId ?? null) === folderId);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-1.5 pb-2">
        <div className="flex gap-1" role="tablist" aria-label="Image source">
          {([["library", `${visible?.length ?? 0} images`], ["stock", "Stock"]] as const).map(([key, label]) => (
            <button key={key} type="button" role="tab" aria-selected={mode === key}
              className={`rounded px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${mode === key ? "bg-accent/15 text-accent-700" : "text-muted hover:bg-line/60"}`}
              onClick={() => setMode(key)}>
              {label}
            </button>
          ))}
        </div>
        {mode === "library" && <UploadButton label="Upload" folderId={folderId} />}
      </div>
      {mode === "library" && (
        <FolderNav kind="media" currentFolderId={folderId} onNavigate={setFolderId} onMoveItem={(id, target) => move.mutate({ id, folderId: target })} />
      )}
      {mode === "stock" && (
        <div className="overflow-auto px-1.5">
          {/* Imported photos land in the library — drag them into richtext/image fields. */}
          <StockTab cols="grid-cols-2" onPick={() => setMode("library")} />
        </div>
      )}
      {mode === "library" && assets.isLoading && <div className="grid grid-cols-2 gap-1.5 px-1.5">{[0, 1, 2, 3].map((i) => <div key={i} className="aspect-square animate-pulse rounded bg-line/50" />)}</div>}
      {mode === "library" && visible?.length === 0 && <p className="px-2 py-8 text-center text-xs text-muted">{folderId ? "This folder is empty. Upload or drag images here." : "No images yet. Upload one."}</p>}
      {mode === "library" && (
        <div className="grid grid-cols-2 gap-1.5 overflow-auto px-1.5">
          {visible?.map((a) => (
            <div key={a.documentId}>
              <AssetThumb asset={a} onClick={() => { setEditing(a.documentId); setAlt(a.alt); }} />
            </div>
          ))}
        </div>
      )}
      {editing && (
        <Dialog open onOpenChange={(o) => !o && setEditing(null)}>
          <DialogContent title="Image details" className="w-[380px]">
            <img src={assets.data?.find((a) => a.documentId === editing)?.url} alt="" className="mb-3 max-h-48 w-full rounded border border-line object-contain" />
            {(() => {
              const meta = assets.data?.find((a) => a.documentId === editing)?.sourceMeta;
              return meta ? (
                <p className="mb-2 text-[11px] text-muted">
                  Photo by <a href={meta.creditUrl} target="_blank" rel="noopener noreferrer" className="underline hover:text-fg">{meta.credit}</a>
                  {" "}on <a href={meta.sourceUrl} target="_blank" rel="noopener noreferrer" className="underline hover:text-fg">{meta.providerName}</a>
                </p>
              ) : null;
            })()}
            <div className="flex items-center justify-between">
              <label className="field-label" htmlFor="alt">Alt text (accessibility)</label>
              <button
                type="button"
                className="btn-subtle px-1.5 py-0.5 text-[11px]"
                disabled={suggestAlt.isPending || !aiEnabled}
                title={aiEnabled ? "Describe the image with AI" : AI_OFF_HINT}
                onClick={() => suggestAlt.mutate(editing)}
              >
                {suggestAlt.isPending ? "Looking…" : "Describe image"}
              </button>
            </div>
            <input id="alt" aria-label="Alt text" className="field-input mb-4" value={alt} onChange={(e) => setAlt(e.target.value)} placeholder="Describe the image" />
            <div className="flex items-center justify-between gap-2">
              <button
                className="btn-ghost px-2 text-xs text-danger"
                disabled={remove.isPending}
                onClick={() => { if (confirm("Delete this image? References to it will show as missing.")) remove.mutate(editing); }}
              >
                <Icon.Trash width={13} height={13} /> Delete
              </button>
              <div className="flex gap-2">
                <button className="btn-ghost" onClick={() => setEditing(null)}>Cancel</button>
                <button className="btn-primary" disabled={saveAlt.isPending} onClick={() => saveAlt.mutate({ id: editing, alt })}>Save</button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

/** Image picker dialog (used by the `image` field + richtext toolbar): library + stock search. */
export function MediaPicker({ onPick, onClose }: { onPick: (a: Asset) => void; onClose: () => void }) {
  const assets = useAssets();
  const [tab, setTab] = useState<"library" | "stock">("library");
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Choose image" description="Pick an existing image, upload a new one, or import a stock photo." className="w-[560px]">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex gap-1" role="tablist" aria-label="Image source">
            {([["library", "Library"], ["stock", "Stock"]] as const).map(([key, label]) => (
              <button key={key} type="button" role="tab" aria-selected={tab === key}
                className={`rounded px-2.5 py-1 text-xs font-medium ${tab === key ? "bg-accent/15 text-accent-700" : "text-muted hover:bg-line/60"}`}
                onClick={() => setTab(key)}>
                {label}
              </button>
            ))}
          </div>
          {tab === "library" && <UploadButton label="Upload new" onUploaded={(a) => onPick(a)} />}
        </div>
        {tab === "library" ? (
          <>
            {assets.data?.length === 0 && <p className="py-8 text-center text-sm text-muted">No images yet — upload one above.</p>}
            <div className="grid max-h-[50vh] grid-cols-4 gap-2 overflow-auto">
              {assets.data?.map((a) => <AssetThumb key={a.documentId} asset={a} onClick={() => onPick(a)} />)}
            </div>
          </>
        ) : (
          <StockTab onPick={onPick} />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Stock search: query the configured provider, import-on-select into the library. */
function StockTab({ onPick, cols = "grid-cols-3" }: { onPick: (a: Asset) => void; cols?: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const suggested = useContext(StockQueryContext);
  const [q, setQ] = useState(suggested);
  const [debounced, setDebounced] = useState(suggested);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 400);
    return () => clearTimeout(t);
  }, [q]);

  const search = useQuery({
    queryKey: ["stock-search", debounced],
    queryFn: ({ signal }) => api.stockSearch(debounced, signal),
    enabled: debounced.trim().length > 1,
    staleTime: 5 * 60_000, // protects the provider's request budget
    retry: false,
  });
  const [importing, setImporting] = useState<string | null>(null);
  const importPhoto = useMutation({
    mutationFn: (r: StockSearchResult) => api.stockImport({ providerId: r.id, alt: r.description }),
    onSuccess: (asset) => {
      void qc.invalidateQueries({ queryKey: ["assets"] });
      toast.success("Image imported", asset.sourceMeta ? `Photo by ${asset.sourceMeta.credit} on ${asset.sourceMeta.providerName}` : asset.filename);
      onPick(asset);
    },
    onError: (e) => toast.error("Import failed", (e as Error).message),
    onSettled: () => setImporting(null),
  });

  return (
    <div>
      <input
        className="field-input mb-3"
        type="search"
        placeholder="Search stock photos…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        aria-label="Search stock photos"
      />
      {search.isLoading && <div className={`grid ${cols} gap-2`}>{[0, 1, 2, 3].map((i) => <div key={i} className="aspect-square animate-pulse rounded bg-line/50" />)}</div>}
      {search.isError && (
        // Unconfigured/key errors are self-teaching (they point at Settings → Stock images).
        <p className="py-8 text-center text-sm text-muted">{(search.error as Error).message}</p>
      )}
      {!search.isError && debounced.trim().length <= 1 && <p className="py-8 text-center text-sm text-muted">Type to search stock photos.</p>}
      {search.data?.length === 0 && <p className="py-8 text-center text-sm text-muted">No results for “{debounced}”.</p>}
      <div className={`grid max-h-[50vh] ${cols} gap-2 overflow-auto`}>
        {search.data?.map((r) => (
          <figure key={r.id} className="min-w-0">
            <button
              type="button"
              className="relative block aspect-square w-full overflow-hidden rounded-[var(--radius)] border border-line hover:border-accent/50 disabled:opacity-60"
              disabled={importing !== null}
              title={r.description || "Import this photo"}
              onClick={() => { setImporting(r.id); importPhoto.mutate(r); }}
            >
              <img src={r.thumbUrl} alt={r.description} loading="lazy" className="h-full w-full bg-canvas object-cover" />
              {importing === r.id && (
                <span className="absolute inset-0 grid place-items-center bg-canvas/70 text-xs font-medium">Importing…</span>
              )}
            </button>
            {/* Required provider attribution (e.g. Unsplash guidelines). */}
            <figcaption className="mt-0.5 truncate text-[10px] text-muted">
              Photo by <a href={r.creditUrl} target="_blank" rel="noopener noreferrer" className="underline hover:text-fg" onClick={(e) => e.stopPropagation()}>{r.credit}</a>
              {" "}on <a href={r.sourceUrl} target="_blank" rel="noopener noreferrer" className="underline hover:text-fg" onClick={(e) => e.stopPropagation()}>Unsplash</a>
            </figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
}

/** The `image` content-type field: thumbnail + choose/clear. Stores asset documentId. */
export function ImageField({ id, value, disabled, onChange }: { id: string; value: unknown; disabled?: boolean; onChange: (v: string | null) => void }) {
  const assets = useAssets();
  const qc = useQueryClient();
  const toast = useToast();
  const [picking, setPicking] = useState(false);
  const [dropOver, setDropOver] = useState(false);
  const current = typeof value === "string" && value ? assets.data?.find((a) => a.documentId === value) : undefined;

  const onDrop = (e: React.DragEvent) => {
    setDropOver(false);

    // An in-app asset reference (dragging a library/stock thumbnail) is checked
    // FIRST and wins over any file: the browser's native <img> drag tags the
    // image along in dataTransfer.files too, and taking that file path would
    // RE-UPLOAD a duplicate of an asset that already exists (the reported bug —
    // import a stock photo, drag it into an image field, end up with two).
    const raw = e.dataTransfer.getData("application/x-paperboy");
    if (raw) {
      try {
        const p = JSON.parse(raw) as { kind?: string; documentId?: string };
        if ((p.kind === "media" || p.kind === "image") && p.documentId) {
          e.preventDefault();
          e.stopPropagation(); // handled here — don't let the content area also act on it
          onChange(p.documentId);
        }
        // Block/page payloads fall through on purpose: dropping a shared block
        // over an image field should still reach the content area.
      } catch { /* ignore */ }
      return;
    }

    // No in-app payload → a genuine OS file drop from the desktop: upload it.
    // stopPropagation: this field usually sits INSIDE a content area whose own
    // drop handler would otherwise see the same event and upload AGAIN.
    const file = e.dataTransfer.files[0];
    if (file) {
      e.preventDefault();
      e.stopPropagation();
      if (!file.type.startsWith("image/")) {
        toast.error("Only images can be dropped here", file.name);
        return;
      }
      api.uploadAsset(file).then(
        (asset) => {
          void qc.invalidateQueries({ queryKey: ["assets"] });
          onChange(asset.documentId);
        },
        (err) => toast.error("Upload failed", (err as Error).message),
      );
    }
  };

  return (
    <div
      id={id}
      className={`flex items-center gap-3 rounded-[var(--radius)] ${dropOver ? "ring-2 ring-accent ring-offset-2" : ""}`}
      onDragOver={(e) => { if (!disabled && (e.dataTransfer.types.includes("application/x-paperboy") || e.dataTransfer.types.includes("Files"))) { e.preventDefault(); setDropOver(true); } }}
      onDragLeave={() => setDropOver(false)}
      onDrop={disabled ? undefined : onDrop}
    >
      <div className="grid h-20 w-20 shrink-0 place-items-center overflow-hidden rounded-[var(--radius)] border border-line bg-canvas">
        {current ? <img src={current.url} alt={current.alt} className="h-full w-full object-cover" /> : <Icon.Image width={22} height={22} className="text-muted/60" />}
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="flex gap-2">
          <button type="button" className="btn-subtle px-2 py-1 text-xs" disabled={disabled} onClick={() => setPicking(true)}>
            {current ? "Replace" : "Choose image"}
          </button>
          {value ? (
            <button type="button" className="btn-ghost px-2 py-1 text-xs text-danger" disabled={disabled} onClick={() => onChange(null)}>Clear</button>
          ) : null}
        </div>
        {current && <span className="text-xs text-muted">{current.alt || current.filename}</span>}
        {typeof value === "string" && value && !current && <span className="text-xs text-draft">Image not found</span>}
      </div>
      {picking && <MediaPicker onClose={() => setPicking(false)} onPick={(a) => { onChange(a.documentId); setPicking(false); }} />}
    </div>
  );
}
