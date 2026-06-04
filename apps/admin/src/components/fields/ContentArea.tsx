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
import { useState } from "react";
import type { BlockDisplayOption, BlockInstance, ContentTypeDef, FieldDef } from "@paperboy/shared";
import { Icon } from "../../lib/icons.js";
import { ImageField } from "../MediaLibrary.js";
import { MarkdownEditor } from "./MarkdownEditor.js";
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

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function addInline(blockType: string) {
    onChange([...blocks, { key: newKey(), blockType, display: "automatic", inline: {}, ref: null }]);
  }
  function addShared(documentId: string, blockType: string) {
    onChange([...blocks, { key: newKey(), blockType, display: "automatic", inline: null, ref: documentId }]);
  }

  // Drop a shared block dragged from the Assets pane into this content area.
  const [dropOver, setDropOver] = useState(false);
  function onDrop(e: React.DragEvent) {
    setDropOver(false);
    const raw = e.dataTransfer.getData("application/x-paperboy");
    if (!raw) return;
    e.preventDefault();
    try {
      const p = JSON.parse(raw) as { kind?: string; documentId?: string; blockType?: string };
      if (p.kind === "block" && p.documentId && p.blockType) {
        const ok = !field.allowedBlocks.length || field.allowedBlocks.includes(p.blockType);
        if (ok) addShared(p.documentId, p.blockType);
      }
    } catch { /* ignore */ }
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
        onDragOver={(e) => { if (e.dataTransfer.types.includes("application/x-paperboy")) { e.preventDefault(); setDropOver(true); } }}
        onDragLeave={() => setDropOver(false)}
        onDrop={onDrop}
      >
        {blocks.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-muted">
            {dropOver ? "Drop the shared block here" : "Click a block above to add it, or drag a shared block from the Assets pane."}
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
                  sharedName={sharedBlocks.find((s) => s.documentId === b.ref)?.name}
                  onUpdate={(patch) => updateBlock(b.key, patch)}
                  onRemove={() => removeBlock(b.key)}
                  onMove={(d) => move(b.key, d)}
                />
              ))}
            </ul>
          </SortableContext>
        )}
      </div>
    </DndContext>
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

  return (
    <li id={`pb-block-${index}`} ref={setNodeRef} style={style} className={`rounded border border-line bg-panel shadow-sm ${isDragging ? "opacity-60 ring-2 ring-accent" : ""}`}>
      <div className="flex items-center gap-2 border-b border-line bg-canvas px-2 py-1.5">
        <button {...attributes} {...listeners} className="cursor-grab text-muted active:cursor-grabbing" aria-label="Drag to reorder">
          <Icon.Grip width={16} height={16} />
        </button>
        <span className="text-[13px] font-semibold text-fg">{type?.displayName ?? block.blockType}</span>
        {isShared ? (
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
              onChange={(v) => onUpdate({ inline: { ...(block.inline ?? {}), [f.name]: v } })} />
          ))}
        </div>
      )}
      {isShared && (
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
          onChange={(e) => onChange(e.target.value ? { ...((value as object) ?? {}), href: e.target.value } : null)} />
      )}
      {field.type === "image" && <ImageField id={id} value={value} onChange={onChange} />}
    </div>
  );
}
