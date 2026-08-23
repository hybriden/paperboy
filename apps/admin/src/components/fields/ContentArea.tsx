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
import { useEffect, useMemo, useState } from "react";
import { duplicateFieldKeys, fieldKeyFromLabel, generalBlockTypes, isFormFieldType } from "@paperboy/shared";
import type { BlockDisplayOption, BlockInstance, ContentTypeDef, FieldDef } from "@paperboy/shared";
import { api } from "../../lib/api.js";
import { fieldWidthClass } from "../../lib/field-width.js";
import { Icon } from "../../lib/icons.js";
import { ImageField } from "../MediaLibrary.js";
import { LinkField } from "./LinkField.js";
import { useToast } from "../ui/toast.js";
import { MarkdownEditor } from "./MarkdownEditor.js";
import { ReferenceField } from "./ReferenceField.js";
import { SharedBlockPicker } from "./SharedBlockPicker.js";
import { RichText } from "./RichText.js";

let keyCounter = 0;
const newKey = () => `b_${Date.now().toString(36)}_${keyCounter++}`;

interface Props {
  field: FieldDef;
  value: BlockInstance[];
  onChange: (next: BlockInstance[]) => void;
  types: ContentTypeDef[];
  sharedBlocks: { documentId: string; name: string; type: string }[];
  /** Read-only (no content.update). Hides the palette and locks every control. */
  disabled?: boolean;
  /** Nesting level (a contentArea field INSIDE an inline block renders another
   *  ContentArea). Editing stops at MAX_AREA_DEPTH; the write chokepoint's own
   *  depth cap is deeper, so nothing storable becomes uneditable in practice. */
  depth?: number;
}

const DISPLAY_OPTIONS: BlockDisplayOption[] = ["automatic", "full", "wide", "narrow"];
/** Deepest inline nesting the editor renders (page → block → … ). */
const MAX_AREA_DEPTH = 4;

export function ContentArea({ field, value, onChange, types, sharedBlocks, disabled = false, depth = 0 }: Props) {
  const blocks = value ?? [];
  // Form fields only: two sharing a key means the second never reaches the
  // visitor (formSpecFrom keeps the first). Warn on the field itself — a form
  // that silently drops a question the editor filled in and published is the
  // authoring-side version of garbage-in-success-out. Empty elsewhere.
  const duplicateKeys = duplicateFieldKeys(blocks);
  const nestedOnlyTypes = useMemo(() => new Set(types.filter((t) => t.nestedOnly).map((t) => t.name)), [types]);
  // Follow the order the type author DECLARED — they list the everyday fields
  // first, while `types` arrives sorted by internal name (which put "Text
  // field" ninth in the Form palette, behind "Checkbox" and "Choose one").
  const allowed = field.allowedBlocks.length
    ? field.allowedBlocks.flatMap((name) => types.find((t) => t.name === name) ?? [])
    // No allow-list means "any block" — which must NOT include the parts that
    // only make sense inside a specific parent (a Form's ten field blocks).
    : generalBlockTypes(types);
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
  const [pickerOpen, setPickerOpen] = useState<{ x: number; y: number } | null>(null);

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
      void qc.invalidateQueries({ queryKey: ["assets"] });
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
          // Mirror the write rule exactly (assertAllowedTypes): allowedBlocks
          // constrains which BLOCK types land here, and an area with no
          // allow-list takes any GENERAL block — not a part. Say why instead of
          // silently swallowing the drop, which read as a broken drag.
          const named = field.allowedBlocks.includes(p.blockType);
          if (field.allowedBlocks.length && !named) {
            toast.error("Can’t drop that block here", `This area doesn’t allow ${p.blockType}.`);
            return;
          }
          if (!field.allowedBlocks.length && nestedOnlyTypes.has(p.blockType)) {
            toast.error(
              "Can’t drop that block here",
              `${p.blockType} is a part — it belongs inside the type that lists it, not loose in a page.`,
            );
            return;
          }
          addShared(p.documentId, p.blockType);
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
      {/* Block palette — click to add (drag the grip on a block to reorder).
          Hidden entirely when read-only; offering controls that can only produce a
          403 is worse than not showing them. */}
      {!disabled && (
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
        {/* Reuse: place an EXISTING shared block (or a page, as a teaser). A
            shared block belongs to no page, so the same document can appear in
            any area that allows its type. */}
        <div className="relative">
          <button
            type="button"
            className="btn-subtle px-2 py-1 text-xs"
            aria-expanded={pickerOpen !== null}
            onClick={(e) => {
              if (pickerOpen) return setPickerOpen(null);
              const r = e.currentTarget.getBoundingClientRect();
              setPickerOpen({ x: r.left, y: r.bottom + 4 });
            }}
          >
            + Existing block
          </button>
          {pickerOpen && (
            <SharedBlockPicker
              at={pickerOpen}
              allowedBlocks={field.allowedBlocks}
              nestedOnlyTypes={nestedOnlyTypes}
              sharedBlocks={sharedBlocks}
              pages={pages.data ?? []}
              onPick={(documentId, blockType) => {
                addShared(documentId, blockType);
                setPickerOpen(null);
              }}
              onClose={() => setPickerOpen(null)}
            />
          )}
        </div>
      </div>
      )}

      {/* Content area */}
      <div
        data-testid={`content-area-${field.name}`}
        className={`rounded-md border-2 border-dashed p-2 transition-colors ${dropOver ? "border-accent bg-accent/10" : "border-line bg-canvas/60"}`}
        onDragOver={(e) => {
          if (disabled) return;
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
            {dropOver
              ? "Drop it here"
              : disabled
                // The palette is hidden when read-only, so don't tell the user to
                // "click a block above" — there is nothing above.
                ? "You don\u2019t have permission to edit this area."
                : "Click a block above to add it, or drag in a shared block (Assets pane), a page (content tree — shown as a teaser), or an image (library or your desktop)."}
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
                  disabled={disabled}
                  types={types}
                  sharedBlocks={sharedBlocks}
                  depth={depth}
                  duplicateKeys={duplicateKeys}
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
        className="fixed z-50 w-52 rounded-(--radius) border border-line bg-panel p-1 shadow-pop"
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

/**
 * A block's data after one of its fields changed.
 *
 * For a FORM FIELD block, leaving the Label also fills the field key when it is
 * still empty ("Company name" → "companyName") — that key is the one genuinely
 * technical thing an editor would otherwise have to invent. Only when empty:
 * the key is what stored answers are keyed by, so editing a label must never
 * silently re-key a form that already has submissions.
 */
function withDerivedKey(block: BlockInstance, fieldName: string, value: unknown): Record<string, unknown> {
  const inline = { ...block.inline };
  if (fieldName !== "label" || !isFormFieldType(block.blockType)) return inline;
  if (typeof inline.name === "string" && inline.name.trim()) return inline;
  const derived = fieldKeyFromLabel(typeof value === "string" ? value : "");
  // No usable key (an emoji-only label) — leave it rather than write a broken one.
  return derived ? { ...inline, name: derived } : inline;
}

function SortableBlock({
  block,
  index,
  type,
  sharedName,
  onUpdate,
  onRemove,
  onMove,
  disabled = false,
  types,
  sharedBlocks,
  depth,
  duplicateKeys,
}: {
  block: BlockInstance;
  index: number;
  type?: ContentTypeDef;
  sharedName?: string;
  onUpdate: (patch: Partial<BlockInstance>) => void;
  onRemove: () => void;
  onMove: (d: -1 | 1) => void;
  disabled?: boolean;
  types: ContentTypeDef[];
  sharedBlocks: { documentId: string; name: string; type: string }[];
  depth: number;
  duplicateKeys: Set<string>;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: block.key, disabled });
  const style = { transform: CSS.Transform.toString(transform), transition };
  const isShared = block.ref !== null;
  // A referenced PAGE renders as a teaser on the site (not as a block).
  const isTeaser = isShared && type?.kind === "page";
  const isFormField = !isShared && isFormFieldType(block.blockType);
  const storedKey = (block.inline ?? {}).name;
  const ownKey = isFormField && typeof storedKey === "string" ? storedKey.trim() : "";
  const clashingKey = ownKey && duplicateKeys.has(ownKey) ? ownKey : "";
  // A form field asks its question with the Label, so that comes first; the key
  // is derived from it and goes last. Presentation only — the schema is
  // unchanged, so this also fixes types created before the key was derivable.
  const fields = isFormField && type
    ? [...type.fields].sort((a, b) => Number(a.name === "name") - Number(b.name === "name"))
    : (type?.fields ?? []);

  return (
    <li id={`pb-block-${index}`} ref={setNodeRef} style={style} className={`rounded border border-line bg-panel shadow-xs ${isDragging ? "opacity-60 ring-2 ring-accent" : ""}`}>
      {/* flex-wrap + grouped controls: in a narrow form column (side-by-side view)
          the controls drop to their own row instead of painting outside the card. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line bg-canvas px-2 py-1.5">
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
        <div className="ml-auto flex flex-wrap items-center justify-end gap-1">
          <select
            className="rounded border border-line bg-panel px-1 py-0.5 text-xs text-fg"
            value={block.display}
            aria-label="Display option"
            disabled={disabled}
            onChange={(e) => onUpdate({ display: e.target.value as BlockDisplayOption })}
          >
            {DISPLAY_OPTIONS.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <div className="flex items-center gap-0.5">
            <button className="rounded p-1 text-muted hover:bg-line disabled:opacity-40" aria-label="Move up" disabled={disabled} onClick={() => onMove(-1)}><Icon.Up width={14} height={14} /></button>
            <button className="rounded p-1 text-muted hover:bg-line disabled:opacity-40" aria-label="Move down" disabled={disabled} onClick={() => onMove(1)}><Icon.Down width={14} height={14} /></button>
            <button className="rounded p-1 text-danger hover:bg-danger/10 disabled:opacity-40" aria-label="Remove block" disabled={disabled} onClick={onRemove}><Icon.Trash width={14} height={14} /></button>
          </div>
        </div>
      </div>
      {clashingKey && (
        <p className="border-b border-draft/40 bg-draft/10 px-2.5 py-1.5 text-xs text-draft">
          Another field already uses the key <code className="font-mono">{clashingKey}</code>, so only the first one
          reaches the form. Give this field a key of its own.
        </p>
      )}
      {!isShared && type && (
        <div className="space-y-2 p-2.5">
          {fields.map((f) => (
            // data-pb-prop(-block): focusing a field here highlights the SAME
            // field inside this block in the preview (paperboy:focus w/ block
            // scope). Top-level blocks only — the frontend indexes per area.
            // Same width discipline as a page's own fields — a block's date field
            // was still stretching to the column.
            <div key={f.name} className={fieldWidthClass(f)} {...(depth === 0 ? { "data-pb-prop": f.name, "data-pb-prop-block": index } : {})}>
              <BlockField field={f} fieldId={`bf-${block.key}-${f.name}`} value={(block.inline ?? {})[f.name]}
                disabled={disabled}
                types={types}
                sharedBlocks={sharedBlocks}
                depth={depth}
                onChange={(v) => onUpdate({ inline: { ...block.inline, [f.name]: v } })}
                // Only the one field that can derive something gets a commit
                // handler — otherwise tabbing through any text field would fire
                // an identical update and mark the document dirty.
                onCommit={isFormField && f.name === "label"
                  ? (v) => onUpdate({ inline: { ...withDerivedKey(block, f.name, v), [f.name]: v } })
                  : undefined} />
            </div>
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

function BlockField({ field, fieldId, value, onChange, onCommit, disabled = false, types, sharedBlocks, depth }: {
  field: FieldDef;
  fieldId: string;
  value: unknown;
  onChange: (v: unknown) => void;
  /** Fired when the visitor leaves a text field, for edits that should land
   *  once rather than per keystroke (deriving a form field's key from it). */
  onCommit?: (v: unknown) => void;
  disabled?: boolean;
  types: ContentTypeDef[];
  sharedBlocks: { documentId: string; name: string; type: string }[];
  depth: number;
}) {
  const id = fieldId;
  // A contentArea INSIDE an inline block: recurse into a full nested area
  // (repeatable structures — FAQ topics/questions, link lists, teaser lists —
  // are modelled exactly this way). Without this branch the field rendered
  // NOTHING here, so inline nested content was write-supported (coercion +
  // delivery recurse) but uneditable by humans.
  if (field.type === "contentArea") {
    return (
      <div>
        <div className="field-label text-[12px]">{field.displayName}</div>
        {field.helpText && <p className="mb-1 text-xs text-muted">{field.helpText}</p>}
        {depth + 1 >= MAX_AREA_DEPTH ? (
          <p className="rounded border border-dashed border-line px-2 py-1.5 text-xs text-muted">
            Nested too deep to edit inline — add this as a shared block and edit it from the Assets pane.
          </p>
        ) : (
          <ContentArea
            field={field}
            value={(value as BlockInstance[]) ?? []}
            onChange={onChange}
            types={types}
            sharedBlocks={sharedBlocks}
            disabled={disabled}
            depth={depth + 1}
          />
        )}
      </div>
    );
  }
  return (
    <div>
      <label className="field-label text-[12px]" htmlFor={id}>{field.displayName}</label>
      {field.type === "text" && (
        <input disabled={disabled} id={id} aria-label={field.displayName} className="field-input py-1" value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onCommit ? (e) => onCommit(e.target.value) : undefined} />
      )}
      {field.type === "markdown" && (
        <MarkdownEditor id={id} value={(value as string) ?? ""} onChange={(v) => onChange(v)} minHeight={160} disabled={disabled} />
      )}
      {field.type === "richtext" && <RichText id={id} value={value} onChange={onChange} disabled={disabled} />}
      {field.type === "boolean" && (
        <input disabled={disabled} id={id} aria-label={field.displayName} type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
      )}
      {field.type === "number" && (
        <input disabled={disabled} id={id} aria-label={field.displayName} type="number" className="field-input py-1" value={(value as number) ?? ""} onChange={(e) => onChange(Number(e.target.value))} />
      )}
      {field.type === "datetime" && (
        <input disabled={disabled} id={id} aria-label={field.displayName} type="datetime-local" className="field-input py-1" value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value || null)} />
      )}
      {field.type === "select" && (
        <select disabled={disabled} id={id} className="field-input py-1" value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">— choose —</option>
          {field.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      )}
      {/* A block's link field gets the SAME editor as a page's — it used to be a
          bare href input here, so an inline block could not set link text, a
          target, or (now) a page target at all. */}
      {field.type === "link" && <LinkField id={id} value={value} onChange={onChange} disabled={disabled} />}
      {field.type === "reference" && <ReferenceField id={id} allowedTypes={field.allowedTypes} value={value} onChange={onChange} disabled={disabled} />}
      {field.type === "image" && <ImageField id={id} value={value} onChange={onChange} disabled={disabled} />}
    </div>
  );
}
