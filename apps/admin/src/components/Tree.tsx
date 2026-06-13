import {
  DndContext,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import * as Ctx from "@radix-ui/react-context-menu";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ContentTypeDef, TreeNode } from "@paperboy/shared";
import { api } from "../lib/api.js";
import { Icon } from "../lib/icons.js";
import { localeIndicator } from "../lib/locale-indicator.js";
import { TypeIcon, useTypeIconName } from "../lib/typeIcons.js";
import { Dialog, DialogContent } from "./ui/dialog.js";
import { useToast } from "./ui/toast.js";

const EXPAND_KEY = "paperboy-tree-expanded";
const ONLY_LOCALE_KEY = "paperboy-tree-only-locale";

/**
 * Drag-and-drop spans the WHOLE tree from a single DndContext at the root (each
 * level keeps a SortableContext for reorder animation). Drop intent is decided
 * from the gesture (Notion/file-tree style):
 *   - dragged clearly to the RIGHT (horizontal intent) → "inside" = RE-PARENT
 *     (nest under the row it's over)
 *   - otherwise a plain reorder: "before"/"after" the target by vertical position.
 * Gating nesting on horizontal intent keeps ordinary vertical reorders from ever
 * being mis-read as nesting. Rows register their parentId in a shared registry so
 * the root handler can build the right move() call without threading state up.
 */
type DropMode = "before" | "after" | "inside";
interface TreeDnd {
  registry: Map<string, { parentId: string | null }>;
  activeId: string | null;
  over: { id: string; mode: DropMode } | null;
  dragEnabled: boolean;
}
const TreeDndContext = createContext<TreeDnd | null>(null);

const NEST_THRESHOLD_PX = 36; // a DELIBERATE rightward drag is needed to nest

function dropFromEvent(e: DragEndEvent | DragOverEvent): { id: string; mode: DropMode } | null {
  const over = e.over;
  const activeRect = e.active.rect.current.translated;
  if (!over || !activeRect || String(over.id) === String(e.active.id)) return null;
  const center = activeRect.top + activeRect.height / 2;
  const ratio = (center - over.rect.top) / over.rect.height;
  // Nest ONLY on a clear rightward drag AND while over the row's body (middle
  // band). Hovering a row's top/bottom edge always reorders — so an ordinary
  // reorder that drifts a little right can't accidentally nest.
  if (e.delta.x > NEST_THRESHOLD_PX && ratio > 0.25 && ratio < 0.75) {
    return { id: String(over.id), mode: "inside" };
  }
  return { id: String(over.id), mode: ratio < 0.5 ? "before" : "after" };
}

interface TreeProps {
  selectedId: string | null;
  onSelect: (id: string) => void;
  canCreate: boolean;
  canDelete: boolean;
  types: ContentTypeDef[];
  locale: string;
  /** Optional controls (e.g. the pin/auto-hide toggle) rendered in the header. */
  headerActions?: React.ReactNode;
}

export function Tree({ selectedId, onSelect, canCreate, canDelete, types, locale, headerActions }: TreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(EXPAND_KEY) ?? "[]"));
    } catch {
      return new Set();
    }
  });
  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState<{ parentId: string | null } | null>(null);
  const [moving, setMoving] = useState<{ documentId: string; name: string } | null>(null);
  const site = useQuery({ queryKey: ["site"], queryFn: ({ signal }) => api.site(signal) });
  // Locales (default first) so an untranslated node can show the code it DOES
  // exist in, preferring the site default — mirrors Optimizely's tree.
  const locales = useQuery({ queryKey: ["locales"], queryFn: ({ signal }) => api.locales(signal) });
  const localeOrder = (locales.data ?? [])
    .slice()
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
    .map((l) => l.code);

  // "Show only the current language" — hides nodes with no version in the active
  // locale (Optimizely's "Show content in current language only"). Persisted.
  const [onlyCurrentLocale, setOnlyCurrentLocale] = useState<boolean>(
    () => localStorage.getItem(ONLY_LOCALE_KEY) === "1",
  );
  const updateOnlyLocale = (v: boolean) => {
    setOnlyCurrentLocale(v);
    localStorage.setItem(ONLY_LOCALE_KEY, v ? "1" : "0");
  };

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      localStorage.setItem(EXPAND_KEY, JSON.stringify([...next]));
      return next;
    });

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]'));
    const idx = items.findIndex((el) => el === document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); items[Math.min(idx + 1, items.length - 1)]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); items[Math.max(idx - 1, 0)]?.focus(); }
    else if (e.key === "Home") { e.preventDefault(); items[0]?.focus(); }
    else if (e.key === "End") { e.preventDefault(); items[items.length - 1]?.focus(); }
  }

  // ----- whole-tree drag-and-drop (reorder + drag-to-nest) -----
  const qc = useQueryClient();
  const toast = useToast();
  const registry = useRef<Map<string, { parentId: string | null }>>(new Map());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [over, setOver] = useState<{ id: string; mode: DropMode } | null>(null);
  const dragEnabled = !filter; // filtering hides siblings, so disable drag while filtering
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const move = useMutation({
    mutationFn: (v: { id: string; parentId: string | null; beforeId?: string | null; afterId?: string | null }) =>
      api.move(v.id, { parentId: v.parentId, beforeId: v.beforeId ?? null, afterId: v.afterId ?? null }),
    onSuccess: (_r, v) => {
      qc.invalidateQueries({ queryKey: ["tree"] });
      qc.invalidateQueries({ queryKey: ["pages"] });
      qc.invalidateQueries({ queryKey: ["content", v.id] });
    },
    onError: (e) => {
      qc.invalidateQueries({ queryKey: ["tree"] });
      toast.error("Couldn’t move", (e as Error).message);
    },
  });

  function onDragEnd(e: DragEndEvent) {
    const id = String(e.active.id);
    const drop = dropFromEvent(e);
    setActiveId(null);
    setOver(null);
    if (!drop || drop.id === id) return;
    const target = registry.current.get(drop.id);
    if (!target) return;
    if (drop.mode === "inside") {
      move.mutate({ id, parentId: drop.id });
      if (!expanded.has(drop.id)) toggle(drop.id); // reveal the new child
    } else if (drop.mode === "before") {
      move.mutate({ id, parentId: target.parentId, beforeId: drop.id });
    } else {
      move.mutate({ id, parentId: target.parentId, afterId: drop.id });
    }
  }

  const dnd: TreeDnd = { registry: registry.current, activeId, over, dragEnabled };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-line px-3 py-2.5">
        <h2 className="text-[13px] font-bold uppercase tracking-wide text-muted">Content</h2>
        <div className="flex items-center gap-1">
          {canCreate && (
            <button className="btn-subtle px-2 py-1 text-xs" onClick={() => setCreating({ parentId: null })} aria-label="Create new content">
              <Icon.Plus width={14} height={14} /> New
            </button>
          )}
          {headerActions}
        </div>
      </div>
      <div className="px-3 py-2">
        <div className="relative">
          <Icon.Search width={14} height={14} className="pointer-events-none absolute left-2.5 top-2 text-muted" />
          <input
            className="field-input py-1 pl-8 text-[13px]"
            placeholder="Filter…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Filter content tree"
          />
        </div>
        {localeOrder.length > 1 && (
          <label
            className="mt-2 flex cursor-pointer select-none items-center gap-1.5 text-[11px] text-muted"
            title="Hide content that isn’t translated to the current language"
          >
            <input
              type="checkbox"
              className="h-3 w-3 accent-accent"
              checked={onlyCurrentLocale}
              onChange={(e) => updateOnlyLocale(e.target.checked)}
            />
            Only ‘{locale}’
          </label>
        )}
      </div>

      <TreeDndContext.Provider value={dnd}>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          // Measure droppables ONCE before the drag and don't re-measure during
          // it — guarantees no measure↔render feedback loop even if something
          // shifts layout mid-drag.
          measuring={{ droppable: { strategy: MeasuringStrategy.BeforeDragging } }}
          onDragStart={(e: DragStartEvent) => setActiveId(String(e.active.id))}
          onDragOver={(e: DragOverEvent) => {
            const d = dropFromEvent(e);
            const next = d && d.id !== String(e.active.id) ? d : null;
            // Only update when it actually changes — avoids redundant re-renders
            // during a drag (extra guard against measure↔render feedback).
            setOver((prev) => (prev?.id === next?.id && prev?.mode === next?.mode ? prev : next));
          }}
          onDragEnd={onDragEnd}
          onDragCancel={() => { setActiveId(null); setOver(null); }}
          accessibility={{ container: typeof document !== "undefined" ? document.body : undefined }}
        >
          <div role="tree" aria-label="Content tree" className="min-h-0 flex-1 overflow-auto px-1.5 pb-3" onKeyDown={onKeyDown}>
            <Level
              parentId={null}
              depth={0}
              ancestors={EMPTY_ANCESTORS}
              startPageId={site.data?.startPageId ?? null}
              expanded={expanded}
              toggle={toggle}
              selectedId={selectedId}
              onSelect={onSelect}
              filter={filter.toLowerCase()}
              locale={locale}
              localeOrder={localeOrder}
              onlyCurrentLocale={onlyCurrentLocale}
              canCreate={canCreate}
              canDelete={canDelete}
              onNewChild={(parentId) => setCreating({ parentId })}
              onMove={(documentId, name) => setMoving({ documentId, name })}
            />
          </div>
        </DndContext>
      </TreeDndContext.Provider>

      {creating && (
        <CreateDialog
          parentId={creating.parentId}
          types={types.filter((t) => t.kind === "page")}
          locale={locale}
          onClose={() => setCreating(null)}
          onCreated={(id) => {
            setCreating(null);
            onSelect(id);
          }}
        />
      )}

      {moving && <MoveDialog node={moving} onClose={() => setMoving(null)} />}
    </div>
  );
}

interface LevelProps {
  parentId: string | null;
  depth: number;
  expanded: Set<string>;
  toggle: (id: string) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  filter: string;
  locale: string;
  /** Locale codes in display order (site default first) for the untranslated chip. */
  localeOrder: string[];
  /** Hide nodes with no version in the active locale (Optimizely's toggle). */
  onlyCurrentLocale: boolean;
  canCreate: boolean;
  canDelete: boolean;
  onNewChild: (parentId: string) => void;
  onMove: (documentId: string, name: string) => void;
  /** The documentId of the site start page (served at "/"), for the tree marker. */
  startPageId: string | null;
  /** documentIds of all ancestors of this level — a hard guard so a data cycle
   *  (a page that is somehow its own ancestor) can NEVER infinitely recurse the
   *  render and freeze the tab. */
  ancestors: Set<string>;
}

const MAX_TREE_DEPTH = 50; // absolute backstop against runaway recursion
const EMPTY_ANCESTORS: Set<string> = new Set();

function Level(props: LevelProps) {
  const { parentId, depth, filter } = props;
  const parentKey = parentId ?? "root";
  // Keep the tree "live": refresh when the tab regains focus and poll on a slow
  // cadence WHILE focused, so a publish/translate from another tab — or from the
  // MCP agent — updates each node's status without a manual reload. Same-tab
  // edits update instantly via the editor's ["tree"] invalidation.
  const q = useQuery({
    queryKey: ["tree", parentKey],
    queryFn: ({ signal }) => api.tree(parentId ?? undefined, signal),
    refetchOnWindowFocus: true,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false, // don't poll a backgrounded tab
  });

  if (q.isLoading) {
    return (
      <div className="space-y-1 px-2 py-1" aria-busy>
        {[0, 1, 2].map((i) => <div key={i} className="h-7 animate-pulse rounded bg-line/50" />)}
      </div>
    );
  }
  if (q.isError) return <p className="px-2 text-xs text-danger">Failed to load</p>;

  const all = q.data ?? [];
  // Defensive: never render a node that is already one of its own ancestors.
  // A stale/cyclic cache entry would otherwise draw the same documentId twice —
  // and because expand state is keyed by id, expanding one would toggle the
  // other. Filtering it out keeps every node unique in the rendered tree.
  const inScope = all.filter((n) => !props.ancestors.has(n.documentId));
  const byText = filter ? inScope.filter((n) => n.name.toLowerCase().includes(filter)) : inScope;
  // "Only current language": drop nodes with no version in the active locale.
  const nodes = props.onlyCurrentLocale ? byText.filter((n) => props.locale in n.locales) : byText;
  if (nodes.length === 0 && depth === 0) {
    const empty = filter ? "No matches." : props.onlyCurrentLocale ? `No content in ‘${props.locale}’.` : "No content yet.";
    return (
      <div className="px-3 py-8 text-center">
        <p className="text-sm text-muted">{empty}</p>
      </div>
    );
  }

  // One SortableContext per level (reorder animation within a sibling group); the
  // DndContext + drop-intent handling live at the tree root so a drag can cross
  // levels to nest under any page.
  return (
    <SortableContext items={nodes.map((n) => n.documentId)} strategy={verticalListSortingStrategy}>
      <ul role="group" className="m-0 list-none p-0">
        {/* {...props} FIRST, then node — otherwise a `node` leaked through the
            parent's props spread would override this row's own node, making
            every descendant render as its ancestor (the "Home under Home" bug). */}
        {nodes.map((node) => (
          <Row key={node.documentId} {...props} node={node} />
        ))}
      </ul>
    </SortableContext>
  );
}

function Row(props: LevelProps & { node: TreeNode }) {
  const { node, depth, expanded, toggle, selectedId, onSelect, locale, canCreate, canDelete, onNewChild, onMove } = props;
  const toast = useToast();
  const qc = useQueryClient();
  const dnd = useContext(TreeDndContext);
  const dragEnabled = dnd?.dragEnabled ?? false;

  // Register this row's parent so the root drop handler can build the move() call.
  useEffect(() => {
    const reg = dnd?.registry;
    if (!reg) return;
    reg.set(node.documentId, { parentId: node.parentId });
    return () => { reg.delete(node.documentId); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.documentId, node.parentId]);

  const overInside = dnd?.over?.id === node.documentId && dnd.over.mode === "inside" && dnd.activeId !== node.documentId;
  const overBefore = dnd?.over?.id === node.documentId && dnd.over.mode === "before";
  const overAfter = dnd?.over?.id === node.documentId && dnd.over.mode === "after";
  const indent = depth * 14 + 4;
  const duplicate = useMutation({
    mutationFn: () => api.duplicate(node.documentId, locale),
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ["tree"] });
      qc.invalidateQueries({ queryKey: ["blocks"] });
      toast.success("Duplicated", `Created “${created.name}”.`);
      onSelect(created.documentId);
    },
    onError: (e) => toast.error("Couldn’t duplicate", (e as Error).message),
  });
  const trash = useMutation({
    mutationFn: () => api.trash(node.documentId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tree"] });
      qc.invalidateQueries({ queryKey: ["blocks"] });
      qc.invalidateQueries({ queryKey: ["trash"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      toast.success("Moved to trash", "Restore it from Settings → Trash.");
    },
    onError: (e) => toast.error("Couldn’t delete", (e as Error).message),
  });
  // Delete just THIS language variant (not the whole document). Confirmed —
  // it's permanent and not recoverable from Trash. Used to re-translate: delete
  // the wrong variant, then the editor's "Translate from …" offer reappears.
  const [confirmDelVariant, setConfirmDelVariant] = useState(false);
  const deleteVariant = useMutation({
    mutationFn: () => api.deleteVariant(node.documentId, locale),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tree"] });
      qc.invalidateQueries({ queryKey: ["blocks"] });
      qc.invalidateQueries({ queryKey: ["content", node.documentId] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      toast.success(`Deleted ${locale.toUpperCase()} version`, `“${node.name}” keeps its other languages.`);
    },
    onError: (e) => toast.error("Couldn’t delete version", (e as Error).message),
  });
  const setStart = useMutation({
    mutationFn: (id: string | null) => api.setStartPage(id),
    onSuccess: (_r, id) => {
      qc.invalidateQueries({ queryKey: ["site"] });
      toast.success(id ? "Start page set" : "Start page cleared", id ? `“${node.name}” is now served at /` : undefined);
    },
    onError: (e) => toast.error("Couldn’t set start page", (e as Error).message),
  });
  const isStartPage = props.startPageId === node.documentId;
  const isOpen = expanded.has(node.documentId);
  const isSelected = selectedId === node.documentId;
  // The type's configured icon; falls back to a generic kind icon while the
  // content-types query loads or for unknown types.
  const iconName = useTypeIconName(node.type);
  // Translation state vs the active locale: an untranslated node is shown
  // italic/muted with the code it DOES exist in (Optimizely-style), instead of
  // a status dot that would be meaningless for a locale it has no version in.
  const ind = localeIndicator(node.locales, locale, props.localeOrder);
  const loc = node.locales[locale];

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: node.documentId, disabled: !dragEnabled });
  const style = { transform: CSS.Transform.toString(transform), transition };

  function onRowKey(e: React.KeyboardEvent) {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(node.documentId); }
    else if (e.key === "ArrowRight" && node.hasChildren && !isOpen) { e.preventDefault(); toggle(node.documentId); }
    else if (e.key === "ArrowLeft" && isOpen) { e.preventDefault(); toggle(node.documentId); }
  }

  return (
    <li ref={setNodeRef} style={style} role="none" className={isDragging ? "opacity-60" : ""}>
      {/* The row sits in a relative wrapper; drop indicators are ABSOLUTE
          overlays scoped to the row (not its children). In-flow indicators would
          change row heights → dnd-kit re-measures → over flips → re-render →
          re-measure: an oscillation that can hang the tab. */}
      <div className="relative">
        {overBefore && <div className="pointer-events-none absolute top-0 z-10 h-0.5 rounded-full bg-accent" style={{ left: indent, right: 4 }} aria-hidden />}
        {overAfter && <div className="pointer-events-none absolute bottom-0 z-10 h-0.5 rounded-full bg-accent" style={{ left: indent, right: 4 }} aria-hidden />}
      <Ctx.Root>
        <Ctx.Trigger asChild>
          <div
            role="treeitem"
            aria-selected={isSelected}
            aria-expanded={node.hasChildren ? isOpen : undefined}
            data-nest-target={overInside ? "true" : undefined}
            tabIndex={isSelected ? 0 : -1}
            onKeyDown={onRowKey}
            onClick={() => onSelect(node.documentId)}
            // Pages can be dragged into a content area, where they render as a
            // teaser (native HTML5 drag — same channel as the Assets pane).
            // dnd-kit reorder/nest stays on the grip; a native drag starting
            // there is suppressed so the two can't fight over the gesture.
            draggable={node.kind === "page"}
            onDragStart={(e) => {
              if ((e.target as HTMLElement).closest('[aria-label="Drag to reorder or nest"]')) {
                e.preventDefault();
                return;
              }
              e.dataTransfer.setData(
                "application/x-paperboy",
                JSON.stringify({ kind: "page", documentId: node.documentId, blockType: node.type, name: node.name }),
              );
              e.dataTransfer.effectAllowed = "copy";
            }}
            className={`group flex cursor-pointer items-center gap-1 rounded-[var(--radius)] py-1.5 pr-1.5 text-sm transition-colors ${
              overInside ? "bg-accent/15 ring-2 ring-inset ring-accent" : isSelected ? "bg-accent/15 font-medium text-fg" : "text-fg hover:bg-line/50"
            }`}
            style={{ paddingLeft: indent }}
            title={`${node.name} · ${node.type}`}
          >
            {node.hasChildren ? (
              <button
                tabIndex={-1}
                aria-label={isOpen ? "Collapse" : "Expand"}
                onClick={(e) => { e.stopPropagation(); toggle(node.documentId); }}
                className="grid h-4 w-4 shrink-0 place-items-center text-muted"
              >
                <Icon.Chevron width={12} height={12} className={isOpen ? "rotate-90 transition-transform" : "transition-transform"} />
              </button>
            ) : (
              <span className="h-4 w-4 shrink-0" aria-hidden />
            )}
            <TypeIcon name={iconName} fallback={node.kind === "block" ? "blocks" : "file"} width={15} height={15} className="shrink-0 text-muted" />
            <span className={`truncate ${ind.translated ? "" : "italic text-muted"}`}>{node.name}</span>
            {isStartPage && (
              <span className="shrink-0 rounded bg-accent/15 px-1 text-[10px] font-semibold text-accent-700" title="Served at / (site start page)">/</span>
            )}
            {dragEnabled && (
              <button
                {...attributes}
                {...listeners}
                tabIndex={-1}
                aria-label="Drag to reorder or nest"
                title="Drag to reorder, or drop onto a page to nest inside it"
                onClick={(e) => e.stopPropagation()}
                className="ml-auto cursor-grab text-muted opacity-0 group-hover:opacity-100 active:cursor-grabbing"
              >
                <Icon.Grip width={14} height={14} />
              </button>
            )}
            {ind.translated ? (
              <span
                className={`${dragEnabled ? "" : "ml-auto"} h-2 w-2 shrink-0 rounded-full ${loc?.status === "published" ? "bg-published" : "bg-draft"}`}
                title={loc?.status === "published" ? (loc.hasUnpublishedChanges ? "Published · unpublished changes" : "Published") : "Draft"}
              />
            ) : (
              <span
                className={`${dragEnabled ? "" : "ml-auto"} shrink-0 rounded bg-line/60 px-1 text-[10px] font-medium uppercase leading-tight text-muted`}
                title={`Not translated to ‘${locale}’ — exists in ${ind.availableCodes.join(", ") || "no language"}`}
              >
                {ind.fallbackCode ?? "—"}
              </span>
            )}
          </div>
        </Ctx.Trigger>
        <Ctx.Portal>
          <Ctx.Content className="z-50 min-w-[180px] overflow-hidden rounded-[var(--radius-lg)] border border-line bg-panel p-1 shadow-pop">
            <CtxItem onSelect={() => onSelect(node.documentId)}>Open</CtxItem>
            {canCreate && node.kind === "page" && <CtxItem onSelect={() => onNewChild(node.documentId)}>New child page</CtxItem>}
            {canCreate && node.kind === "page" && <CtxItem onSelect={() => onMove(node.documentId, node.name)}>Move to…</CtxItem>}
            {canCreate && <CtxItem onSelect={() => duplicate.mutate()}>Duplicate</CtxItem>}
            {/* Setting the start page needs publish rights; canDelete tracks the
                same Editor/Admin roles as content.publish in the default RBAC. */}
            {canDelete && node.kind === "page" && !isStartPage && <CtxItem onSelect={() => setStart.mutate(node.documentId)}>Set as start page</CtxItem>}
            {canDelete && node.kind === "page" && isStartPage && <CtxItem onSelect={() => setStart.mutate(null)}>Unset start page</CtxItem>}
            <CtxItem onSelect={() => { navigator.clipboard?.writeText(node.documentId); toast.success("Copied document ID"); }}>Copy document ID</CtxItem>
            {/* Delete just the active-language version — only when another
                language remains (deleting the last one is "Move to trash"). */}
            {canDelete && ind.translated && Object.keys(node.locales).length > 1 && (
              <CtxItem destructive onSelect={() => setConfirmDelVariant(true)}>Delete {locale.toUpperCase()} version</CtxItem>
            )}
            {canDelete && <CtxItem destructive onSelect={() => trash.mutate()}>Move to trash</CtxItem>}
          </Ctx.Content>
        </Ctx.Portal>
      </Ctx.Root>
      {confirmDelVariant && (
        <Dialog open onOpenChange={(o) => !o && setConfirmDelVariant(false)}>
          <DialogContent
            title={`Delete ${locale.toUpperCase()} version?`}
            description={`This permanently removes the ${locale.toUpperCase()} version of “${node.name}”. Its other languages are kept. This cannot be undone (it is not recoverable from Trash).`}
            className="w-[460px]"
          >
            <div className="flex justify-end gap-2">
              <button className="btn-ghost" onClick={() => setConfirmDelVariant(false)}>Cancel</button>
              <button
                className="btn-danger"
                disabled={deleteVariant.isPending}
                onClick={() => { deleteVariant.mutate(); setConfirmDelVariant(false); }}
              >
                {deleteVariant.isPending ? "Deleting…" : `Delete ${locale.toUpperCase()} version`}
              </button>
            </div>
          </DialogContent>
        </Dialog>
      )}
      </div>
      {node.hasChildren && isOpen && depth < MAX_TREE_DEPTH && !props.ancestors.has(node.documentId) && (
        <Level
          {...props}
          parentId={node.documentId}
          depth={depth + 1}
          ancestors={new Set([...props.ancestors, node.documentId])}
        />
      )}
    </li>
  );
}

function CtxItem({ children, onSelect, destructive }: { children: React.ReactNode; onSelect: () => void; destructive?: boolean }) {
  return (
    <Ctx.Item
      onSelect={onSelect}
      className={`cursor-pointer rounded-[var(--radius)] px-2.5 py-1.5 text-sm outline-none ${
        destructive
          ? "text-danger data-[highlighted]:bg-danger/10"
          : "text-fg data-[highlighted]:bg-accent/10 data-[highlighted]:text-accent-700"
      }`}
    >
      {children}
    </Ctx.Item>
  );
}

type PageRef = { documentId: string; name: string; parentId: string | null };

/** "Move to…" — pick a new parent (excluding the node itself and its descendants). */
function MoveDialog({ node, onClose }: { node: { documentId: string; name: string }; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [target, setTarget] = useState<string>("__root__");
  const pages = useQuery({ queryKey: ["pages"], queryFn: ({ signal }) => api.pages(signal) });
  const all: PageRef[] = pages.data ?? [];

  // Exclude self + all descendants (can't move a page under its own subtree).
  const excluded = new Set<string>([node.documentId]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const p of all) {
      if (p.parentId && excluded.has(p.parentId) && !excluded.has(p.documentId)) {
        excluded.add(p.documentId);
        changed = true;
      }
    }
  }
  const byId = new Map(all.map((p) => [p.documentId, p]));
  const pathLabel = (p: PageRef): string => {
    const segs: string[] = [];
    const guard = new Set<string>();
    let cur: PageRef | undefined = p;
    while (cur && !guard.has(cur.documentId)) {
      guard.add(cur.documentId);
      segs.unshift(cur.name);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return segs.join(" / ");
  };
  const candidates = all.filter((p) => !excluded.has(p.documentId)).sort((a, b) => pathLabel(a).localeCompare(pathLabel(b)));

  const move = useMutation({
    mutationFn: () => api.move(node.documentId, { parentId: target === "__root__" ? null : target }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tree"] }); // prefix: refresh every loaded level
      qc.invalidateQueries({ queryKey: ["pages"] });
      qc.invalidateQueries({ queryKey: ["content", node.documentId] });
      toast.success("Page moved", node.name);
      onClose();
    },
    onError: (e) => toast.error("Couldn’t move", (e as Error).message),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`Move “${node.name}”`} description="Choose a new parent. The page and its children keep their content; the URL updates to match the new position." className="w-[440px]">
        <label className="field-label" htmlFor="mv-target">New parent</label>
        <select id="mv-target" className="field-input mb-4" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="New parent">
          <option value="__root__">— Top level —</option>
          {candidates.map((p) => (
            <option key={p.documentId} value={p.documentId}>{pathLabel(p)}</option>
          ))}
        </select>
        <div className="flex justify-end gap-2">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={move.isPending} onClick={() => move.mutate()}>
            {move.isPending ? "Moving…" : "Move here"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CreateDialog(props: {
  parentId: string | null;
  types: ContentTypeDef[];
  locale: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const qc = useQueryClient();
  const [type, setType] = useState(props.types[0]?.name ?? "");
  const [name, setName] = useState("");
  // The dialog can mount before the types query resolves; the select would then
  // SHOW the first option while the state stays "" — Create disabled forever.
  useEffect(() => {
    if (!type && props.types[0]) setType(props.types[0].name);
  }, [props.types, type]);
  const create = useMutation({
    mutationFn: () => api.create({ type, parentId: props.parentId, locale: props.locale, name }),
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ["tree", props.parentId ?? "root"] });
      props.onCreated(created.documentId);
    },
  });

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 backdrop-blur-[1px] animate-fade-in" role="dialog" aria-modal aria-label="Create content">
      <div className="w-[400px] animate-scale-in rounded-[var(--radius-lg)] border border-line bg-panel p-5 shadow-pop">
        <h3 className="mb-3 text-base font-bold text-fg">{props.parentId ? "Create child content" : "Create content"}</h3>
        <label className="field-label" htmlFor="ctype">Content type</label>
        <select id="ctype" className="field-input mb-3" value={type} onChange={(e) => setType(e.target.value)}>
          {props.types.map((t) => <option key={t.name} value={t.name}>{t.displayName} ({t.kind})</option>)}
        </select>
        <label className="field-label" htmlFor="cname">Name</label>
        <input id="cname" className="field-input mb-4" value={name} autoFocus onChange={(e) => setName(e.target.value)} placeholder="e.g. About us" />
        {create.isError && <p role="alert" className="mb-3 text-sm text-danger">{(create.error as Error).message}</p>}
        <div className="flex justify-end gap-2">
          <button className="btn-ghost" onClick={props.onClose}>Cancel</button>
          <button className="btn-primary" disabled={!name || !type || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
