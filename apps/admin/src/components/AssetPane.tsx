import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ContentTypeDef } from "@paperboy/shared";
import { api } from "../lib/api.js";
import { Icon } from "../lib/icons.js";
import { MediaTab } from "./MediaLibrary.js";
import { Dialog, DialogContent } from "./ui/dialog.js";

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
  const blocks = useQuery({ queryKey: ["blocks"], queryFn: ({ signal }) => api.blocks(signal) });

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
            {blocks.isLoading && [0, 1].map((i) => <div key={i} className="mb-1 h-9 animate-pulse rounded bg-line/50" />)}
            {blocks.data?.length === 0 && <p className="px-2 py-6 text-center text-xs text-muted">No shared blocks yet.</p>}
            {blocks.data?.map((b) => {
              const loc = Object.values(b.locales)[0];
              const selected = selectedId === b.documentId;
              return (
                <button
                  key={b.documentId}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData("application/x-paperboy", JSON.stringify({ kind: "block", documentId: b.documentId, blockType: b.type, name: b.name }));
                    e.dataTransfer.effectAllowed = "copy";
                  }}
                  onClick={() => onSelect(b.documentId)}
                  className={`flex w-full cursor-grab items-center gap-2 rounded-[var(--radius)] px-2 py-1.5 text-left text-sm active:cursor-grabbing ${selected ? "bg-accent/15 font-medium text-fg" : "text-fg hover:bg-line/50"}`}
                  title={`${b.name} · ${b.type} — open, or drag into a content area`}
                >
                  <Icon.Grip width={13} height={13} className="shrink-0 text-muted/60" />
                  <Icon.Block width={15} height={15} className="shrink-0 text-muted" />
                  <span className="truncate">{b.name}</span>
                  <span className={`ml-auto h-2 w-2 shrink-0 rounded-full ${loc?.status === "published" ? "bg-published" : "bg-draft"}`} />
                </button>
              );
            })}
          </>
        )}
        {tab === "media" && <MediaTab />}
      </div>

      {creating && <CreateBlockDialog blockTypes={blockTypes} onClose={() => setCreating(false)} onCreated={onSelect} />}
    </aside>
  );
}

function CreateBlockDialog({
  blockTypes,
  onClose,
  onCreated,
}: {
  blockTypes: ContentTypeDef[];
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const qc = useQueryClient();
  const [type, setType] = useState(blockTypes[0]?.name ?? "");
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: () => api.create({ type, parentId: null, locale: "en", name }),
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ["blocks"] });
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
        <input id="nb-name" className="field-input mb-4" value={name} autoFocus onChange={(e) => setName(e.target.value)} placeholder="e.g. Campaign banner" />
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
