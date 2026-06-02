import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { Asset } from "@paperboy/shared";
import { api } from "../lib/api.js";
import { Icon } from "../lib/icons.js";
import { Dialog, DialogContent } from "./ui/dialog.js";
import { useToast } from "./ui/toast.js";

const ACCEPT = "image/png,image/jpeg,image/gif,image/webp";

function useAssets() {
  return useQuery({ queryKey: ["assets"], queryFn: ({ signal }) => api.assets(signal) });
}

/** Hidden file input + button that uploads and refreshes the ["assets"] cache. */
function UploadButton({ onUploaded, label = "Upload" }: { onUploaded?: (a: Asset) => void; label?: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const ref = useRef<HTMLInputElement>(null);
  const upload = useMutation({
    mutationFn: (file: File) => api.uploadAsset(file),
    onSuccess: (asset) => {
      qc.invalidateQueries({ queryKey: ["assets"] });
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

/** Assets pane → Media tab: grid + upload + per-image alt text. */
export function MediaTab() {
  const assets = useAssets();
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<string | null>(null);
  const [alt, setAlt] = useState("");
  const saveAlt = useMutation({
    mutationFn: (v: { id: string; alt: string }) => api.updateAssetAlt(v.id, v.alt),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["assets"] });
      setEditing(null);
      toast.success("Alt text saved");
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteAsset(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["assets"] });
      setEditing(null);
      toast.success("Image deleted");
    },
    onError: (e) => toast.error("Couldn’t delete", (e as Error).message),
  });
  const suggestAlt = useMutation({
    mutationFn: (filename: string) => api.aiAssist("alt_text", filename),
    onSuccess: (r) => {
      setAlt(r.result);
      if (r.provider === "fallback") toast.success("Draft alt text added", "Basic mode — set ANTHROPIC_API_KEY for full AI.");
    },
    onError: (e) => toast.error("AI request failed", (e as Error).message),
  });

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-1.5 pb-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">{assets.data?.length ?? 0} images</span>
        <UploadButton label="Upload" />
      </div>
      {assets.isLoading && <div className="grid grid-cols-2 gap-1.5 px-1.5">{[0, 1, 2, 3].map((i) => <div key={i} className="aspect-square animate-pulse rounded bg-line/50" />)}</div>}
      {assets.data?.length === 0 && <p className="px-2 py-8 text-center text-xs text-muted">No images yet. Upload one.</p>}
      <div className="grid grid-cols-2 gap-1.5 overflow-auto px-1.5">
        {assets.data?.map((a) => (
          <div key={a.documentId}>
            <AssetThumb asset={a} onClick={() => { setEditing(a.documentId); setAlt(a.alt); }} />
          </div>
        ))}
      </div>
      {editing && (
        <Dialog open onOpenChange={(o) => !o && setEditing(null)}>
          <DialogContent title="Image details" className="w-[380px]">
            <img src={assets.data?.find((a) => a.documentId === editing)?.url} alt="" className="mb-3 max-h-48 w-full rounded border border-line object-contain" />
            <div className="flex items-center justify-between">
              <label className="field-label" htmlFor="alt">Alt text (accessibility)</label>
              <button
                type="button"
                className="btn-subtle px-1.5 py-0.5 text-[11px]"
                disabled={suggestAlt.isPending}
                onClick={() => suggestAlt.mutate(assets.data?.find((a) => a.documentId === editing)?.filename ?? "image")}
              >
                <span aria-hidden>✨</span> {suggestAlt.isPending ? "Thinking…" : "Suggest"}
              </button>
            </div>
            <input id="alt" className="field-input mb-4" value={alt} onChange={(e) => setAlt(e.target.value)} placeholder="Describe the image" />
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

/** Image picker dialog (used by the `image` field). */
function MediaPicker({ onPick, onClose }: { onPick: (a: Asset) => void; onClose: () => void }) {
  const assets = useAssets();
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Choose image" description="Pick an existing image or upload a new one." className="w-[560px]">
        <div className="mb-3 flex justify-end">
          <UploadButton label="Upload new" onUploaded={(a) => onPick(a)} />
        </div>
        {assets.data?.length === 0 && <p className="py-8 text-center text-sm text-muted">No images yet — upload one above.</p>}
        <div className="grid max-h-[50vh] grid-cols-4 gap-2 overflow-auto">
          {assets.data?.map((a) => <AssetThumb key={a.documentId} asset={a} onClick={() => onPick(a)} />)}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The `image` content-type field: thumbnail + choose/clear. Stores asset documentId. */
export function ImageField({ id, value, disabled, onChange }: { id: string; value: unknown; disabled?: boolean; onChange: (v: string | null) => void }) {
  const assets = useAssets();
  const [picking, setPicking] = useState(false);
  const [dropOver, setDropOver] = useState(false);
  const current = typeof value === "string" && value ? assets.data?.find((a) => a.documentId === value) : undefined;

  const onDrop = (e: React.DragEvent) => {
    setDropOver(false);
    const raw = e.dataTransfer.getData("application/x-paperboy");
    if (!raw) return;
    e.preventDefault();
    try {
      const p = JSON.parse(raw) as { kind?: string; documentId?: string };
      if ((p.kind === "media" || p.kind === "image") && p.documentId) onChange(p.documentId);
    } catch { /* ignore */ }
  };

  return (
    <div
      id={id}
      className={`flex items-center gap-3 rounded-[var(--radius)] ${dropOver ? "ring-2 ring-accent ring-offset-2" : ""}`}
      onDragOver={(e) => { if (!disabled && e.dataTransfer.types.includes("application/x-paperboy")) { e.preventDefault(); setDropOver(true); } }}
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
