import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { ContentTypeDef } from "@paperboy/shared";
import { api } from "../lib/api.js";
import { Icon } from "../lib/icons.js";
import { TypeIcon } from "../lib/typeIcons.js";
import { FolderNav } from "./FolderNav.js";
import { MediaTab } from "./MediaLibrary.js";
import { Dialog, DialogContent } from "./ui/dialog.js";
import { useToast } from "./ui/toast.js";

/**
 * Assets pane: Shared Blocks (reusable, own lifecycle) + Media.
 * Local/inline blocks are NOT here — they live inside their page's content area.
 */
export function AssetPane({
  blockTypes,
  selectedId,
  onSelect,
  canCreate,
  headerActions,
}: {
  blockTypes: ContentTypeDef[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  canCreate: boolean;
  /** Optional controls (e.g. the pin/auto-hide toggle) rendered in the header. */
  headerActions?: React.ReactNode;
}) {
  const [tab, setTab] = useState<"blocks" | "media">("blocks");
  const [creating, setCreating] = useState(false);
  const [folderId, setFolderId] = useState<string | null>(null);
  const qc = useQueryClient();
  const toast = useToast();
  const blocks = useQuery({ queryKey: ["blocks"], queryFn: ({ signal }) => api.blocks(signal) });

  const move = useMutation({
    mutationFn: (v: { id: string; folderId: string | null }) => api.setBlockFolder(v.id, v.folderId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["blocks"] }),
    onError: (e) => toast.error("Couldn’t move block", (e as Error).message),
  });
  const trash = useMutation({
    mutationFn: (id: string) => api.trash(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["blocks"] });
      void qc.invalidateQueries({ queryKey: ["tree"] });
      void qc.invalidateQueries({ queryKey: ["trash"] });
      void qc.invalidateQueries({ queryKey: ["dashboard"] });
      toast.success("Moved to trash", "Restore it from Settings → Trash.");
    },
    onError: (e) => toast.error("Couldn’t delete block", (e as Error).message),
  });

  // Only the shared blocks in the current folder (null = root/unfiled).
  const visibleBlocks = blocks.data?.filter((b) => (b.folderId ?? null) === folderId);

  return (
    <aside className="flex h-full w-full flex-col border-l border-line bg-panel">
      <div className="flex items-center justify-between border-b border-line px-3 py-2.5">
        <h2 className="text-[13px] font-bold uppercase tracking-wide text-muted">Assets</h2>
        <div className="flex items-center gap-1">
          {canCreate && tab === "blocks" && (
            <button className="btn-subtle px-2 py-1 text-xs" onClick={() => setCreating(true)} aria-label="New shared block">
              <Icon.Plus width={14} height={14} /> Block
            </button>
          )}
          {headerActions}
        </div>
      </div>
      <div className="flex gap-1 border-b border-line px-2 pt-2" role="tablist" aria-label="Asset type">
        {(["blocks", "media"] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t}
            className={`border-b-2 px-2.5 py-1.5 text-xs font-medium capitalize ${tab === t ? "border-accent text-accent-700" : "border-transparent text-muted hover:text-fg"}`}
            onClick={() => setTab(t)}>
            {t === "blocks" ? "Shared blocks" : "Media"}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-1.5">
        {tab === "blocks" && (
          <>
            <FolderNav kind="block" currentFolderId={folderId} onNavigate={setFolderId} onMoveItem={(id, target) => move.mutate({ id, folderId: target })} />
            {blocks.isLoading && [0, 1].map((i) => <div key={i} className="mb-1 h-9 animate-pulse rounded bg-line/50" />)}
            {visibleBlocks?.length === 0 && <p className="px-2 py-6 text-center text-xs text-muted">{folderId ? "This folder is empty. Drag blocks here." : "No shared blocks yet."}</p>}
            {visibleBlocks?.map((b) => {
              const loc = Object.values(b.locales)[0];
              const selected = selectedId === b.documentId;
              return (
                <div
                  key={b.documentId}
                  draggable
                  onDragStart={(e) => {
                    const payload = { kind: "block", documentId: b.documentId, blockType: b.type, name: b.name };
                    e.dataTransfer.setData("application/x-paperboy", JSON.stringify(payload));
                    e.dataTransfer.effectAllowed = "copy";
                    // Broadcast for the (cross-origin) preview iframe, where the
                    // browser hides dataTransfer — PreviewPane relays it to the bridge.
                    window.dispatchEvent(new CustomEvent("pb:dragsource", { detail: payload }));
                  }}
                  onDragEnd={() => window.dispatchEvent(new CustomEvent("pb:dragend"))}
                  className={`group flex w-full cursor-grab items-center gap-2 rounded-[var(--radius)] px-2 py-1.5 text-left text-sm active:cursor-grabbing ${selected ? "bg-accent/15 font-medium text-fg" : "text-fg hover:bg-line/50"}`}
                  title={`${b.name} · ${b.type} — open, or drag into a content area / folder`}
                >
                  <Icon.Grip width={13} height={13} className="shrink-0 text-muted/60" />
                  <TypeIcon name={blockTypes.find((t) => t.name === b.type)?.icon} fallback="blocks" width={15} height={15} className="shrink-0 text-muted" />
                  <button type="button" className="min-w-0 flex-1 truncate text-left" onClick={() => onSelect(b.documentId)}>{b.name}</button>
                  <span className={`h-2 w-2 shrink-0 rounded-full ${loc?.status === "published" ? "bg-published" : "bg-draft"}`} />
                  {canCreate && (
                    <button
                      type="button"
                      className="invisible shrink-0 px-0.5 text-muted hover:text-danger group-hover:visible"
                      title="Move block to trash"
                      disabled={trash.isPending}
                      onClick={() => { if (window.confirm(`Move “${b.name}” to trash? Restore it later from Settings → Trash.`)) trash.mutate(b.documentId); }}
                    >
                      <Icon.Trash width={13} height={13} />
                    </button>
                  )}
                </div>
              );
            })}
          </>
        )}
        {tab === "media" && <MediaTab />}
      </div>

      {creating && <CreateBlockDialog blockTypes={blockTypes} folderId={folderId} onClose={() => setCreating(false)} onCreated={onSelect} />}
    </aside>
  );
}

function CreateBlockDialog({
  blockTypes,
  folderId,
  onClose,
  onCreated,
}: {
  blockTypes: ContentTypeDef[];
  /** File the new block into this folder (null = root). */
  folderId: string | null;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const qc = useQueryClient();
  const [type, setType] = useState(blockTypes[0]?.name ?? "");
  const [name, setName] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => { nameRef.current?.focus(); }, []);
  const create = useMutation({
    mutationFn: async () => {
      const created = await api.create({ type, parentId: null, locale: "en", name });
      if (folderId) await api.setBlockFolder(created.documentId, folderId);
      return created;
    },
    onSuccess: (created) => {
      void qc.invalidateQueries({ queryKey: ["blocks"] });
      onClose();
      onCreated(created.documentId);
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="New shared block" description="A reusable block with its own publishing lifecycle." className="w-[380px]">
        <label className="field-label" htmlFor="nb-type">Block type</label>
        <select id="nb-type" className="field-input mb-3" value={type} onChange={(e) => setType(e.target.value)}>
          {blockTypes.map((t) => <option key={t.name} value={t.name}>{t.displayName}</option>)}
        </select>
        <label className="field-label" htmlFor="nb-name">Name</label>
        <input id="nb-name" ref={nameRef} aria-label="Name" className="field-input mb-4" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Campaign banner" />
        {create.isError && <p role="alert" className="mb-3 text-sm text-danger">{(create.error as Error).message}</p>}
        <div className="flex justify-end gap-2">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={!name || !type || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? "Creating…" : "Create block"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
