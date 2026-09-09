import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { isFormType } from "@paperboy/shared";
import type { ContentTypeDef } from "@paperboy/shared";
import { DRAG_MIME } from "@paperboycms/preview/protocol";
import { api } from "../lib/api.js";
import { Icon } from "../lib/icons.js";
import { TypeIcon } from "../lib/typeIcons.js";
import { FolderNav } from "./FolderNav.js";
import { MediaTab } from "./MediaLibrary.js";
import { Dialog, DialogContent } from "./ui/dialog.js";
import { EmptyState } from "./ui/empty-state.js";
import { Skeleton } from "./ui/skeleton.js";
import { useToast } from "./ui/toast.js";

/**
 * Assets pane: Shared Blocks (reusable, own lifecycle) + Globals + Media.
 * Local/inline blocks are NOT here — they live inside their page's content area.
 *
 * Globals sit here because they are per-site singletons kept out of the page
 * tree ("config, not content structure"). Before this tab nothing in the admin
 * listed them at all, so a site's header/footer/settings were editable only by
 * typing a name you already knew into the command palette.
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
  const [tab, setTab] = useState<"blocks" | "globals" | "media">("blocks");
  const [creating, setCreating] = useState(false);
  const [folderId, setFolderId] = useState<string | null>(null);
  // Forms are shared blocks technically, but editors look for "my form", not
  // "my block" — a kind filter appears once the library holds at least one.
  const [blockKind, setBlockKind] = useState<"all" | "forms" | "blocks">("all");
  const qc = useQueryClient();
  const toast = useToast();
  const blocks = useQuery({ queryKey: ["blocks"], queryFn: ({ signal }) => api.blocks(signal) });
  const globals = useQuery({ queryKey: ["globals"], queryFn: ({ signal }) => api.globals(signal), enabled: tab === "globals" });

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

  // Only the shared blocks in the current folder (null = root/unfiled),
  // then the kind filter on top.
  const hasForms = blocks.data?.some((b) => isFormType(b.type)) ?? false;
  const visibleBlocks = blocks.data?.filter(
    (b) =>
      (b.folderId ?? null) === folderId &&
      (blockKind === "all" || (blockKind === "forms") === isFormType(b.type)),
  );

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
        {(["blocks", "globals", "media"] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t}
            className={`border-b-2 px-2.5 py-1.5 text-xs font-medium capitalize ${tab === t ? "border-accent text-accent-700" : "border-transparent text-muted hover:text-fg"}`}
            onClick={() => setTab(t)}>
            {t === "blocks" ? "Shared blocks" : t === "globals" ? "Globals" : "Media"}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-1.5">
        {tab === "blocks" && (
          <>
            {hasForms && (
              <div role="group" aria-label="Block kind" className="mb-1.5 flex gap-1 px-1 pt-1">
                {(
                  [
                    ["all", "All"],
                    ["forms", "Forms"],
                    ["blocks", "Blocks"],
                  ] as const
                ).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    aria-pressed={blockKind === k}
                    className={`rounded-full px-2 py-0.5 text-xs ${
                      blockKind === k ? "bg-accent/15 font-semibold text-accent-700" : "text-muted hover:bg-canvas"
                    }`}
                    onClick={() => setBlockKind(k)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
            <FolderNav kind="block" currentFolderId={folderId} onNavigate={setFolderId} onMoveItem={(id, target) => move.mutate({ id, folderId: target })} />
            {blocks.isLoading && [0, 1].map((i) => <Skeleton key={i} className="mb-1 h-9" />)}
            {visibleBlocks?.length === 0 && (
              <EmptyState className="py-6">
                {blockKind === "forms"
                  ? "No forms here yet."
                  : folderId
                    ? "This folder is empty. Drag blocks here."
                    : "No shared blocks yet."}
              </EmptyState>
            )}
            {visibleBlocks?.map((b) => {
              const loc = Object.values(b.locales)[0];
              const selected = selectedId === b.documentId;
              return (
                <div
                  key={b.documentId}
                  draggable
                  onDragStart={(e) => {
                    const payload = { kind: "block", documentId: b.documentId, blockType: b.type, name: b.name };
                    e.dataTransfer.setData(DRAG_MIME, JSON.stringify(payload));
                    e.dataTransfer.effectAllowed = "copy";
                    // Broadcast for the (cross-origin) preview iframe, where the
                    // browser hides dataTransfer — PreviewPane relays it to the bridge.
                    window.dispatchEvent(new CustomEvent("pb:dragsource", { detail: payload }));
                  }}
                  onDragEnd={() => window.dispatchEvent(new CustomEvent("pb:dragend"))}
                  className={`group flex w-full cursor-grab items-center gap-2 rounded-(--radius) px-2 py-1.5 text-left text-sm active:cursor-grabbing ${selected ? "bg-accent/15 font-medium text-fg" : "text-fg hover:bg-line/50"}`}
                  title={`${b.name} · ${b.type} — open, or drag into a content area / folder`}
                >
                  <Icon.Grip width={13} height={13} className="shrink-0 text-muted/60" />
                  <TypeIcon name={blockTypes.find((t) => t.name === b.type)?.icon} fallback="blocks" width={15} height={15} className="shrink-0 text-muted" />
                  <button type="button" className="min-w-0 flex-1 truncate text-left" onClick={() => onSelect(b.documentId)}>{b.name}</button>
                  <span
                    role="img"
                    aria-label={loc?.status === "published" ? "Published" : "Draft"}
                    className={`h-2 w-2 shrink-0 rounded-full ${loc?.status === "published" ? "bg-published" : "bg-draft"}`}
                  />
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
        {tab === "globals" && (
          <>
            {globals.isLoading && [0, 1].map((i) => <Skeleton key={i} className="mb-1 h-9" />)}
            {globals.data?.length === 0 && (
              <EmptyState className="py-6">
                No globals in this site. They are created from a global-kind content type.
              </EmptyState>
            )}
            {globals.data?.map((g) => {
              const loc = Object.values(g.locales)[0];
              const selected = selectedId === g.documentId;
              return (
                <div
                  key={g.documentId}
                  className={`group flex w-full items-center gap-2 rounded-(--radius) px-2 py-1.5 text-left text-sm ${selected ? "bg-accent/15 font-medium text-fg" : "text-fg hover:bg-line/50"}`}
                  title={`${g.name} · ${g.type} — one per site`}
                >
                  <TypeIcon name={blockTypes.find((t) => t.name === g.type)?.icon} fallback="settings" width={15} height={15} className="shrink-0 text-muted" />
                  <button type="button" className="min-w-0 flex-1 truncate text-left" onClick={() => onSelect(g.documentId)}>{g.name}</button>
                  <span
                    role="img"
                    aria-label={loc?.status === "published" ? "Published" : "Draft"}
                    className={`h-2 w-2 shrink-0 rounded-full ${loc?.status === "published" ? "bg-published" : "bg-draft"}`}
                  />
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
  const [type, setType] = useState(blockTypes.find((t) => !t.nestedOnly)?.name ?? blockTypes[0]?.name ?? "");
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
      <DialogContent title="New shared block" description="A reusable block with its own publishing lifecycle." size="sm">
        <label className="field-label" htmlFor="nb-type">Block type</label>
        <select id="nb-type" className="field-input mb-3" value={type} onChange={(e) => setType(e.target.value)}>
          {/* Parts (a form's field blocks) CAN be shared deliberately — one
              consent checkbox reused across forms — but they are the rare case,
              so they go last under their own heading instead of burying the
              four everyday block types among ten of them. */}
          {blockTypes.filter((t) => !t.nestedOnly).map((t) => <option key={t.name} value={t.name}>{t.displayName}</option>)}
          {blockTypes.some((t) => t.nestedOnly) && (
            <optgroup label="Parts (used inside another type)">
              {blockTypes.filter((t) => t.nestedOnly).map((t) => <option key={t.name} value={t.name}>{t.displayName}</option>)}
            </optgroup>
          )}
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
