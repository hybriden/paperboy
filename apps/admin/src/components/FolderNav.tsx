import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { Folder, FolderKind } from "@paperboy/shared";
import { api } from "../lib/api.js";
import { Icon } from "../lib/icons.js";
import { useToast } from "./ui/toast.js";

/**
 * Folder navigator for an asset-pane tab (Media or Shared blocks). Owns the
 * folders query + CRUD for one tree (`kind`); the parent tracks the current
 * folder and filters its items by it. Folders accept drops of items of the
 * matching kind (drag payload `application/x-paperboy`) to file them.
 */
export function FolderNav({
  kind,
  currentFolderId,
  onNavigate,
  onMoveItem,
}: {
  kind: FolderKind;
  currentFolderId: string | null;
  onNavigate: (folderId: string | null) => void;
  /** Move an item (matching this tree's kind) into a folder. null = root. */
  onMoveItem: (documentId: string, folderId: string | null) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const folders = useQuery({ queryKey: ["folders", kind], queryFn: ({ signal }) => api.folders(kind, signal) });
  const [dropTarget, setDropTarget] = useState<string | null | "none">("none");

  const all = folders.data ?? [];
  const byId = new Map(all.map((f) => [f.documentId, f]));
  const children = all.filter((f) => (f.parentId ?? null) === currentFolderId);

  // Breadcrumb: walk parentId up from the current folder to the root.
  const trail: Folder[] = [];
  let cur = currentFolderId ? byId.get(currentFolderId) : undefined;
  const guard = new Set<string>();
  while (cur && !guard.has(cur.documentId)) {
    guard.add(cur.documentId);
    trail.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }

  const invalidate = () => qc.invalidateQueries({ queryKey: ["folders", kind] });
  const create = useMutation({
    mutationFn: (name: string) => api.createFolder({ kind, parentId: currentFolderId, name }),
    onSuccess: () => invalidate(),
    onError: (e) => toast.error("Couldn’t create folder", (e as Error).message),
  });
  const rename = useMutation({
    mutationFn: (v: { id: string; name: string }) => api.updateFolder(v.id, { name: v.name }),
    onSuccess: () => invalidate(),
    onError: (e) => toast.error("Couldn’t rename folder", (e as Error).message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteFolder(id),
    onSuccess: (_r, id) => {
      invalidate();
      if (currentFolderId === id) onNavigate(byId.get(id)?.parentId ?? null);
      toast.success("Folder deleted", "Its contents moved up one level.");
    },
    onError: (e) => toast.error("Couldn’t delete folder", (e as Error).message),
  });

  // Accept a drop only if the dragged item belongs to this tree's kind.
  const itemKind = kind === "media" ? "media" : "block";
  const parsePaperboy = (e: React.DragEvent): { documentId: string } | null => {
    const raw = e.dataTransfer.getData("application/x-paperboy");
    if (!raw) return null;
    try {
      const p = JSON.parse(raw) as { kind?: string; documentId?: string };
      if (p.kind === itemKind && p.documentId) return { documentId: p.documentId };
    } catch { /* ignore */ }
    return null;
  };
  const dropProps = (folderId: string | null) => ({
    onDragOver: (e: React.DragEvent) => {
      if (e.dataTransfer.types.includes("application/x-paperboy")) { e.preventDefault(); setDropTarget(folderId); }
    },
    onDragLeave: () => setDropTarget("none"),
    onDrop: (e: React.DragEvent) => {
      setDropTarget("none");
      const item = parsePaperboy(e);
      if (item) { e.preventDefault(); onMoveItem(item.documentId, folderId); }
    },
  });
  const isDrop = (folderId: string | null) => dropTarget === folderId;

  return (
    <div className="mb-1.5 px-1.5">
      {/* Breadcrumb — Root is also a drop target (move an item out of folders). */}
      <div className="flex flex-wrap items-center gap-0.5 text-[11px] text-muted">
        <button
          type="button"
          onClick={() => onNavigate(null)}
          className={`rounded px-1 py-0.5 hover:bg-line/60 ${currentFolderId === null ? "font-semibold text-fg" : ""} ${isDrop(null) ? "bg-accent/20 ring-1 ring-accent" : ""}`}
          {...dropProps(null)}
        >
          <Icon.Folder width={12} height={12} className="-mt-0.5 mr-0.5 inline" />All
        </button>
        {trail.map((f) => (
          <span key={f.documentId} className="flex items-center gap-0.5">
            <Icon.Chevron width={11} height={11} className="text-muted/50" />
            <button
              type="button"
              onClick={() => onNavigate(f.documentId)}
              className={`rounded px-1 py-0.5 hover:bg-line/60 ${currentFolderId === f.documentId ? "font-semibold text-fg" : ""}`}
            >
              {f.name}
            </button>
          </span>
        ))}
        <button
          type="button"
          className="btn-ghost ml-auto px-1.5 py-0.5 text-[11px]"
          title="New folder here"
          disabled={create.isPending}
          onClick={() => {
            const name = window.prompt("New folder name")?.trim();
            if (name) create.mutate(name);
          }}
        >
          <Icon.Plus width={12} height={12} /> Folder
        </button>
      </div>

      {/* Subfolders of the current folder. */}
      {children.length > 0 && (
        <ul className="mt-1.5 flex flex-col gap-0.5">
          {children.map((f) => (
            <li key={f.documentId}>
              <div
                className={`group flex items-center gap-1.5 rounded-[var(--radius)] px-1.5 py-1 text-sm hover:bg-line/50 ${isDrop(f.documentId) ? "bg-accent/20 ring-1 ring-accent" : ""}`}
                {...dropProps(f.documentId)}
              >
                <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={() => onNavigate(f.documentId)}>
                  <Icon.Folder width={15} height={15} className="shrink-0 text-muted" />
                  <span className="truncate">{f.name}</span>
                </button>
                <button
                  type="button"
                  className="invisible px-1 text-muted hover:text-fg group-hover:visible"
                  title="Rename folder"
                  onClick={() => {
                    const name = window.prompt("Rename folder", f.name)?.trim();
                    if (name && name !== f.name) rename.mutate({ id: f.documentId, name });
                  }}
                >
                  <Icon.Edit width={12} height={12} />
                </button>
                <button
                  type="button"
                  className="invisible px-1 text-muted hover:text-danger group-hover:visible"
                  title="Delete folder"
                  onClick={() => {
                    if (window.confirm(`Delete folder “${f.name}”? Its contents move up one level — nothing is deleted.`)) remove.mutate(f.documentId);
                  }}
                >
                  <Icon.Trash width={12} height={12} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
