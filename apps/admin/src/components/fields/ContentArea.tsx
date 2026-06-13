import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { BlockDisplayOption, BlockInstance, ContentTypeDef, FieldDef } from "@paperboy/shared";
import { api } from "../../lib/api.js";
import { Icon } from "../../lib/icons.js";
import { ImageField } from "../MediaLibrary.js";
import { useToast } from "../ui/toast.js";
import { MarkdownEditor } from "./MarkdownEditor.js";
import { ReferenceField } from "./ReferenceField.js";
import { RichText } from "./RichText.js";

let keyCounter = 0;
const newKey = () => `b_${Date.now().toString(36)}_${keyCounter++}`;

interface Props {
  field: FieldDef;
  value: BlockInstance[];
  onChange: (next: BlockInstance[]) => void;
  types: ContentTypeDef[];
  sharedBlocks: { documentId: string; name: string; type: string }[];
}

const DISPLAY_OPTIONS: BlockDisplayOption[] = ["automatic", "full", "wide", "narrow"];

export function ContentArea({ field, value, onChange, types, sharedBlocks }: Props) {
  const blocks = value ?? [];
  const allowed = field.allowedBlocks.length
    ? types.filter((t) => field.allowedBlocks.includes(t.name))
    : types.filter((t) => t.kind === "block");
  // Page names for teaser entries (same key/cache as ReferenceField).
  const pages = useQuery({ queryKey: ["pages"], queryFn: ({ signal }) => api.pages(signal) });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const toast = useToast();
  const qc = useQueryClient();

  function addInline(blockType: string) {
    onChange([...blocks, { key: newKey(), blockType, display: "automatic", inline: {}, ref: null }]);
  }
  function addShared(documentId: string, blockType: string) {
    onChange([...blocks, { key: newKey(), blockType, display: "automatic", inline: null, ref: documentId }]);
  }

  // ----- image drops: a dropped image becomes a BLOCK carrying that image -----
  // Candidates = allowed block types that have an image field. One candidate →
  // insert immediately; several → a popover at the drop point; none → toast.
  const imageCandidates = allowed.filter((t) => t.kind === "block" && t.fields.some((f) => f.type === "image"));
  const [imagePicker, setImagePicker] = useState<{ x: number; y: number; documentId: string; index: number } | null>(null);

  /** Insertion index from the drop's Y position over the block rows. */
  function dropIndex(e: React.DragEvent): number {
    const rows = (e.currentTarget as HTMLElement).querySelectorAll(":scope > ul > li");
    let index = blocks.length;
    rows.forEach((row, i) => {
      const r = row.getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2 && i < index) index = i;
    });
    return index;
  }

  function insertImageBlock(blockType: string, documentId: string, index: number) {
    const type = allowed.find((t) => t.name === blockType);
    const imageField = type?.fields.find((f) => f.type === "image");
    if (!imageField) return;
    const next = [...blocks];
    next.splice(index, 0, { key: newKey(), blockType, display: "automatic", inline: { [imageField.name]: documentId }, ref: null });
    onChange(next);
  }

  function dropImage(documentId: string, index: number, at: { x: number; y: number }) {
    if (imageCandidates.length === 0) {
      toast.error("Can’t drop an image here", "No block allowed in this area has an image field.");
      return;
    }
    if (imageCandidates.length === 1) {
      insertImageBlock(imageCandidates[0]!.name, documentId, index);
      return;
    }
    setImagePicker({ ...at, documentId, index });
  }

  /** OS file drop: upload through the normal asset pipeline, then insert. */
  async function dropFile(file: File, index: number, at: { x: number; y: number }) {
    if (!file.type.startsWith("image/")) {
      toast.error("Only images can be dropped here", file.name);
      return;
    }
    try {
      const asset = await api.uploadAsset(file);
      qc.invalidateQueries({ queryKey: ["assets"] });
      dropImage(asset.documentId, index, at);
    } catch (err) {
      toast.error("Upload failed", (err as Error).message);
    }
  }

  // Drop a shared block (Assets pane), a page (content tree — becomes a
  // teaser), a media asset (becomes a block with its image field set), or an
  // OS image file (uploaded, then the same image-block flow).
  const [dropOver, setDropOver] = useState(false);
  function onDrop(e: React.DragEvent) {
    setDropOver(false);
    const at = { x: e.clientX, y: e.clientY };
    const index = dropIndex(e);

    // In-app payload FIRST: dragging an existing media asset / shared block /
    // page references it (no upload). A library/stock thumbnail's native <img>
    // drag also tags the image along as a file — taking the file path would
    // RE-UPLOAD a duplicate, so the payload always wins.
    const raw = e.dataTransfer.getData("application/x-paperboy");
    if (raw) {
      e.preventDefault();
      e.stopPropagation();
      try {
        const p = JSON.parse(raw) as { kind?: string; documentId?: string; blockType?: string; url?: string };
        if (p.kind === "media" && p.documentId) {
          if (p.url?.endsWith(".pdf")) {
            toast.error("Can’t drop a PDF here", "Content-area image drops take images.");
            return;
          }
          dropImage(p.documentId, index, at);
          return;
        }
        if (!p.documentId || !p.blockType) return;
        if (p.kind === "block") {
          // allowedBlocks constrains which BLOCK types may be placed here.
          const ok = !field.allowedBlocks.length || field.allowedBlocks.includes(p.blockType);
          if (ok) addShared(p.documentId, p.blockType);
        } else if (p.kind === "page") {
          // Pages are always placeable (rendered as teasers, not as blocks).
          addShared(p.documentId, p.blockType);
        }
      } catch { /* ignore */ }
      return;
    }

    // No payload → a genuine OS file drop from the desktop: upload it.
    if (e.dataTransfer.files.length > 0) {
      e.preventDefault();
      e.stopPropagation(); // content areas can nest (contentArea block fields)
      void dropFile(e.dataTransfer.files[0]!, index, at);
    }
  }
  function updateBlock(key: string, patch: Partial<BlockInstance>) {
    onChange(blocks.map((b) => (b.key === key ? { ...b, ...patch } : b)));
  }
  function removeBlock(key: string) {
    onChange(blocks.filter((b) => b.key !== key));
  }
  function move(key: string, dir: -1 | 1) {
    const i = blocks.findIndex((b) => b.key === key);
    const j = i + dir;
    if (j < 0 || j >= blocks.length) return;
    onChange(arrayMove(blocks, i, j));
  }

  function onDragEnd(e: DragEndEvent) {
    // Reorder existing blocks (drag handle is the grip on each block).
    const activeId = String(e.active.id);
    const overId = e.over ? String(e.over.id) : null;
    if (overId && activeId !== overId) {
      const from = blocks.findIndex((b) => b.key === activeId);
      const to = blocks.findIndex((b) => b.key === overId);
      if (from >= 0 && to >= 0) onChange(arrayMove(blocks, from, to));
    }
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      {/* Block palette — click to add (drag the grip on a block to reorder). */}
      <div className="mb-2 flex flex-wrap gap-1.5" aria-label="Block palette">
        {allowed.map((t) => (
          <button
            key={t.name}
            type="button"
            onClick={() => addInline(t.name)}
            className="rounded-full border border-accent/40 bg-accent/5 px-3 py-1 text-xs font-medium text-accent-700 hover:bg-accent/10"
            title={`Add ${t.displayName}`}
          >
            + {t.displayName}
          </button>
        ))}
        {sharedBlocks.length > 0 && (
          <details className="relative">
            <summary className="btn-subtle cursor-pointer list-none px-2 py-1 text-xs">+ Shared block</summary>
            <div className="absolute z-10 mt-1 w-56 rounded border border-line bg-white p-1 shadow-panel">
              {sharedBlocks.map((b) => (
                <button key={b.documentId} className="block w-full truncate rounded px-2 py-1 text-left text-xs hover:bg-canvas"
                  onClick={() => addShared(b.documentId, b.type)}>
                  {b.name} <span className="text-muted">· {b.type}</span>
                </button>
              ))}
            </div>
          </details>
        )}
      </div>

      {/* Content area */}
      <div
        data-testid={`content-area-${field.name}`}
        className={`rounded-md border-2 border-dashed p-2 transition-colors ${dropOver ? "border-accent bg-accent/10" : "border-line bg-canvas/60"}`}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("application/x-paperboy") || e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            setDropOver(true);
          }
        }}
        onDragLeave={() => setDropOver(false)}
        onDrop={onDrop}
      >
        {blocks.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-muted">
            {dropOver ? "Drop it here" : "Click a block above to add it, or drag in a shared block (Assets pane), a page (content tree — shown as a teaser), or an image (library or your desktop)."}
          </p>
        ) : (
          <SortableContext items={blocks.map((b) => b.key)} strategy={verticalListSortingStrategy}>
            <ul className="m-0 list-none space-y-2 p-0">
              {blocks.map((b, i) => (
                <SortableBlock
                  key={b.key}
                  index={i}
                  block={b}
                  type={types.find((t) => t.name === b.blockType)}
                  sharedName={
                    sharedBlocks.find((s) => s.documentId === b.ref)?.name ??
                    pages.data?.find((p) => p.documentId === b.ref)?.name
                  }
                  onUpdate={(patch) => updateBlock(b.key, patch)}
                  onRemove={() => removeBlock(b.key)}
                  onMove={(d) => move(b.key, d)}
                />
              ))}
            </ul>
          </SortableContext>
        )}
      </div>

      {imagePicker && (
        <ImageBlockPicker
          at={imagePicker}
          candidates={imageCandidates}
          onPick={(blockType) => {
            insertImageBlock(blockType, imagePicker.documentId, imagePicker.index);
            setImagePicker(null);
          }}
          onClose={() => setImagePicker(null)}
        />
      )}
    </DndContext>
  );
}

/**
 * "Insert dropped image as which block?" — shown at the drop point when more
 * than one allowed block type carries an image field.
 */
function ImageBlockPicker({
  at,
  candidates,
  onPick,
  onClose,
}: {
  at: { x: number; y: number };
  candidates: ContentTypeDef[];
  onPick: (blockType: string) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} aria-hidden />
      <div
        role="menu"
        aria-label="Insert image as block"
        className="fixed z-50 w-52 rounded-[var(--radius)] border border-line bg-panel p-1 shadow-pop"
        style={{ left: Math.min(at.x, window.innerWidth - 220), top: Math.min(at.y, window.innerHeight - 40 * candidates.length - 16) }}
      >
        <p className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Insert image as…</p>
        {candidates.map((t) => (
          <button
            key={t.name}
            role="menuitem"
            type="button"
            className="block w-full rounded px-2 py-1.5 text-left text-sm text-fg hover:bg-canvas"
            onClick={() => onPick(t.name)}
          >
            {t.displayName}
          </button>
        ))}
      </div>
    </>
  );
}

function SortableBlock({
  block,
  index,
  type,
  sharedName,
  onUpdate,
  onRemove,
  onMove,
}: {
  block: BlockInstance;
  index: number;
  type?: ContentTypeDef;
  sharedName?: string;
  onUpdate: (patch: Partial<BlockInstance>) => void;
  onRemove: () => void;
  onMove: (d: -1 | 1) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: block.key });
  const style = { transform: CSS.Transform.toString(transform), transition };
  const isShared = block.ref !== null;
  // A referenced PAGE renders as a teaser on the site (not as a block).
  const isTeaser = isShared && type?.kind === "page";

  return (
    <li id={`pb-block-${index}`} ref={setNodeRef} style={style} className={`rounded border border-line bg-panel shadow-sm ${isDragging ? "opacity-60 ring-2 ring-accent" : ""}`}>
      <div className="flex items-center gap-2 border-b border-line bg-canvas px-2 py-1.5">
        <button {...attributes} {...listeners} className="cursor-grab text-muted active:cursor-grabbing" aria-label="Drag to reorder">
          <Icon.Grip width={16} height={16} />
        </button>
        <span className="text-[13px] font-semibold text-fg">{type?.displayName ?? block.blockType}</span>
        {isTeaser ? (
          <span className="rounded bg-published/15 px-1.5 py-0.5 text-[11px] font-medium text-fg" title="Shown as a teaser linking to this page">teaser{sharedName ? `: ${sharedName}` : ""}</span>
        ) : isShared ? (
          <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[11px] font-medium text-fg">shared{sharedName ? `: ${sharedName}` : ""}</span>
        ) : (
          <span className="rounded bg-line px-1.5 py-0.5 text-[11px] text-muted">inline</span>
        )}
        <select
          className="ml-auto rounded border border-line bg-panel px-1 py-0.5 text-xs text-fg"
          value={block.display}
          aria-label="Display option"
          onChange={(e) => onUpdate({ display: e.target.value as BlockDisplayOption })}
        >
          {DISPLAY_OPTIONS.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <div className="flex items-center gap-0.5">
          <button className="rounded p-1 text-muted hover:bg-line" aria-label="Move up" onClick={() => onMove(-1)}><Icon.Up width={14} height={14} /></button>
          <button className="rounded p-1 text-muted hover:bg-line" aria-label="Move down" onClick={() => onMove(1)}><Icon.Down width={14} height={14} /></button>
          <button className="rounded p-1 text-danger hover:bg-danger/10" aria-label="Remove block" onClick={onRemove}><Icon.Trash width={14} height={14} /></button>
        </div>
      </div>
      {!isShared && type && (
        <div className="space-y-2 p-2.5">
          {type.fields.map((f) => (
            <BlockField key={f.name} field={f} fieldId={`bf-${block.key}-${f.name}`} value={(block.inline ?? {})[f.name]}
              onChange={(v) => onUpdate({ inline: { ...block.inline, [f.name]: v } })} />
          ))}
        </div>
      )}
      {isTeaser && (
        <p className="px-2.5 py-2 text-xs text-muted">Rendered as a teaser — a compact card linking to the page. Edit the page itself from the tree.</p>
      )}
      {isShared && !isTeaser && (
        <p className="px-2.5 py-2 text-xs text-muted">Edit this shared block from its own page in the tree. Changes apply everywhere it is used.</p>
      )}
    </li>
  );
}

function BlockField({ field, fieldId, value, onChange }: { field: FieldDef; fieldId: string; value: unknown; onChange: (v: unknown) => void }) {
  const id = fieldId;
  return (
    <div>
      <label className="field-label text-[12px]" htmlFor={id}>{field.displayName}</label>
      {field.type === "text" && (
        <input id={id} className="field-input py-1" value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)} />
      )}
      {field.type === "markdown" && (
        <MarkdownEditor id={id} value={(value as string) ?? ""} onChange={(v) => onChange(v)} minHeight={160} />
      )}
      {field.type === "richtext" && <RichText id={id} value={value} onChange={onChange} />}
      {field.type === "boolean" && (
        <input id={id} type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
      )}
      {field.type === "number" && (
        <input id={id} type="number" className="field-input py-1" value={(value as number) ?? ""} onChange={(e) => onChange(Number(e.target.value))} />
      )}
      {field.type === "datetime" && (
        <input id={id} type="datetime-local" className="field-input py-1" value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value || null)} />
      )}
      {field.type === "select" && (
        <select id={id} className="field-input py-1" value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">— choose —</option>
          {field.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      )}
      {field.type === "link" && (
        <input id={id} className="field-input py-1" placeholder="https://… or /path"
          value={((value as { href?: string } | null) ?? {}).href ?? ""}
          onChange={(e) => onChange(e.target.value ? { ...(value as object), href: e.target.value } : null)} />
      )}
      {field.type === "reference" && <ReferenceField id={id} value={value} onChange={onChange} />}
      {field.type === "image" && <ImageField id={id} value={value} onChange={onChange} />}
    </div>
  );
}
