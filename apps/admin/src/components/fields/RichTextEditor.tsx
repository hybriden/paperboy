import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import { type Editor, EditorContent, useEditor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useState } from "react";
import { type AiTask, api } from "../../lib/api.js";
import { type PbCaret, takeCaret } from "../../lib/caret.js";
import { Icon } from "../../lib/icons.js";
import { MediaPicker } from "../MediaLibrary.js";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "../ui/menu.js";
import { useToast } from "../ui/toast.js";

const EMPTY = { type: "doc", content: [{ type: "paragraph" }] };

/** Block-level images; keeps the asset documentId so the source asset stays
 *  traceable (delivery absolutizes the stored — usually relative — src), and
 *  supports drag-to-resize via a `width` attr (percent of the text column,
 *  15–100; null = natural size). Percent survives any frontend responsively. */
const AssetImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      "data-document-id": { default: null },
      width: {
        default: null,
        parseHTML: (el: HTMLElement) => {
          const m = /^(\d+(?:\.\d+)?)%$/.exec((el.style?.width || el.getAttribute("width") || "").trim());
          return m ? Math.round(Number(m[1])) : null;
        },
        renderHTML: (attrs: { width?: number | null }) => (attrs.width ? { style: `width: ${attrs.width}%` } : {}),
      },
    };
  },
  // Custom node view: wraps the <img> with a corner handle that resizes by
  // dragging. The width is applied live as a percent of the editor column and
  // committed to the node attrs (one undo step) on release.
  addNodeView() {
    return ({ node, editor, getPos }) => {
      let current = node;
      const dom = document.createElement("div");
      dom.className = "pb-rt-img";
      const img = document.createElement("img");
      const handle = document.createElement("span");
      handle.className = "pb-rt-img-handle";
      handle.title = "Drag to resize";
      dom.append(img, handle);

      const apply = () => {
        img.src = String(current.attrs.src ?? "");
        img.alt = String(current.attrs.alt ?? "");
        dom.style.width = current.attrs.width ? `${current.attrs.width}%` : "";
      };
      apply();

      handle.addEventListener("pointerdown", (e: PointerEvent) => {
        if (!editor.isEditable) return;
        e.preventDefault();
        e.stopPropagation(); // don't start a ProseMirror node drag
        const column = (dom.parentElement ?? editor.view.dom).getBoundingClientRect().width;
        const startX = e.clientX;
        const startWidth = dom.getBoundingClientRect().width;
        let pct: number | null = null;
        const move = (ev: PointerEvent) => {
          const next = Math.round(((startWidth + (ev.clientX - startX)) / column) * 100);
          pct = Math.min(100, Math.max(15, next));
          dom.style.width = `${pct}%`;
        };
        const up = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          const pos = typeof getPos === "function" ? getPos() : undefined;
          if (pct !== null && typeof pos === "number") {
            editor.view.dispatch(editor.view.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, width: pct }));
          }
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      });

      return {
        dom,
        update(n) {
          if (n.type !== current.type) return false;
          current = n;
          apply();
          return true;
        },
        selectNode() {
          dom.classList.add("pb-rt-img-selected");
        },
        deselectNode() {
          dom.classList.remove("pb-rt-img-selected");
        },
        // Style mutations during the live drag must not make PM re-render the node.
        ignoreMutation: () => true,
      };
    };
  },
});

/**
 * Toolbar button. Deliberately a MODULE-LEVEL component: defined inside the
 * editor it gets a new identity per render, and the editor re-renders between
 * the capture and bubble phase of every click (the property-focus tracking in
 * Editor.tsx sets state in onClickCapture). React then remounts the button
 * mid-click and its onClick never fires — toolbar dead, keyboard fine.
 */
function Btn({
  on,
  active,
  label,
  children,
}: {
  on: () => void;
  active?: boolean;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      onMouseDown={(e) => e.preventDefault()}
      onClick={on}
      className={`grid h-7 w-7 place-items-center rounded ${active ? "bg-accent/15 text-accent-700" : "text-muted hover:bg-line/60 hover:text-fg"}`}
    >
      {children}
    </button>
  );
}

/**
 * ✨ AI menu for the rich-text toolbar (module-level, see Btn). Works on the
 * CURRENT SELECTION — predictable scope, and the replacement can't mangle the
 * structure of the whole document. The selection survives the menu click
 * because TipTap keeps it in editor state while blurred.
 */
function AiMenu({ editor, hasSelection }: { editor: Editor; hasSelection: boolean }) {
  const toast = useToast();
  const [pending, setPending] = useState(false);

  async function run(task: AiTask, label: string) {
    const { from, to } = editor.state.selection;
    const text = editor.state.doc.textBetween(from, to, "\n").trim();
    if (!text) return;
    setPending(true);
    try {
      const r = await api.aiAssist(task, text);
      editor.chain().focus().insertContentAt({ from, to }, r.result).run();
      if (r.provider === "fallback") toast.success(`${label} (basic mode)`, "Set an AI key in Settings for full AI.");
    } catch (e) {
      toast.error(`${label} failed`, (e as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <Menu>
      <MenuTrigger
        className={`flex h-7 items-center gap-1 rounded px-1.5 text-xs ${pending ? "text-accent-700" : "text-muted hover:bg-line/60 hover:text-fg"} disabled:opacity-50`}
        aria-label="AI writing tools"
        disabled={pending || !hasSelection}
        title={hasSelection ? "AI writing tools" : "Select some text first"}
        onMouseDown={(e: React.MouseEvent) => e.preventDefault()}
      >
        <span aria-hidden>✨</span>
        {pending ? "Thinking…" : "AI"}
      </MenuTrigger>
      <MenuContent>
        <MenuItem onSelect={() => void run("improve", "Improve writing")}>Improve writing</MenuItem>
        <MenuItem onSelect={() => void run("summarize", "Summarize")}>Summarize selection</MenuItem>
      </MenuContent>
    </Menu>
  );
}

/** Full TipTap rich-text editor (lazy-loaded). Stores TipTap doc JSON. */
export default function RichTextEditor({
  id,
  value,
  onChange,
}: {
  id: string;
  value: unknown;
  onChange: (doc: unknown) => void;
}) {
  const [picking, setPicking] = useState(false); // insert-image media picker
  const editor = useEditor({
    extensions: [
      // StarterKit now bundles Link; disable it so our custom-configured Link
      // (no duplicate extension warning) is the only one registered.
      StarterKit.configure({ heading: { levels: [2, 3] }, link: false }),
      Link.configure({ openOnClick: false, autolink: true, HTMLAttributes: { rel: "noopener" } }),
      AssetImage.configure({ allowBase64: false }),
    ],
    content: (value && typeof value === "object" && "type" in (value as object) ? value : EMPTY) as object,
    onUpdate: ({ editor }) => onChange(editor.getJSON()),
    editorProps: {
      attributes: {
        id,
        class:
          "prose-paperboy min-h-[120px] rounded-b-[var(--radius)] border border-t-0 border-line bg-panel px-3 py-2.5 text-sm text-fg outline-none focus:border-accent",
      },
      // Drop a media asset (dragged from the Assets pane) → insert an image
      // node at the drop position; an OS image FILE uploads through the normal
      // asset pipeline first, then inserts the same node. Same
      // application/x-paperboy channel as image fields and content areas.
      handleDrop: (view, event) => {
        const insertAt = (pos: number, src: string, alt: string, documentId: string | null) => {
          const imageNode = view.state.schema.nodes.image;
          if (!imageNode) return;
          view.dispatch(
            view.state.tr.insert(
              pos,
              // width: 100 → autofit the text column on insert; resize by hand after.
              imageNode.create({ src, alt, "data-document-id": documentId, width: 100 }),
            ),
          );
        };
        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? view.state.selection.to;

        const file = event.dataTransfer?.files?.[0];
        if (file) {
          if (!file.type.startsWith("image/")) return false;
          event.preventDefault();
          // Async: upload, then insert at the captured position (clamped — the
          // doc may have changed while the upload was in flight).
          void api.uploadAsset(file).then(
            (asset) => insertAt(Math.min(pos, view.state.doc.content.size), asset.url, asset.alt || file.name, asset.documentId),
            () => undefined, // upload errors surface via the assets pane next refresh
          );
          return true;
        }

        const raw = event.dataTransfer?.getData("application/x-paperboy");
        if (!raw) return false;
        try {
          const p = JSON.parse(raw) as { kind?: string; documentId?: string; url?: string; alt?: string };
          if (p.kind !== "media" || !p.url) return false;
          event.preventDefault();
          insertAt(pos, p.url, p.alt ?? "", p.documentId ?? null);
          return true;
        } catch {
          return false;
        }
      },
      // External drags don't get PM's dragover handling — without preventDefault
      // the browser refuses the drop.
      handleDOMEvents: {
        dragover: (_view, event) => {
          if (event.dataTransfer?.types.includes("application/x-paperboy") || event.dataTransfer?.types.includes("Files")) event.preventDefault();
          return false;
        },
      },
    },
  });

  // Click-to-caret (on-page editing): the preview reported where inside this
  // field the click landed; find that snippet in the doc and put the caret
  // there. The snippet comes from a single rendered DOM text node, which maps
  // 1:1 to a doc text node, so a plain per-text-node search suffices.
  useEffect(() => {
    if (!editor) return;
    const applyCaret = (caret: PbCaret) => {
      let pos: number | null = null;
      editor.state.doc.descendants((n, p) => {
        if (pos !== null) return false;
        if (n.isText && n.text) {
          const i = n.text.indexOf(caret.snippet);
          if (i >= 0) pos = p + i + Math.min(Math.max(caret.offset, 0), caret.snippet.length);
        }
        return pos === null;
      });
      if (pos === null) return; // text changed since render — field focus is still right
      editor.chain().focus().setTextSelection(pos).run();
      editor.view.dispatch(editor.view.state.tr.scrollIntoView());
    };
    const queued = takeCaret(id);
    if (queued) requestAnimationFrame(() => applyCaret(queued)); // after lazy mount + initial layout
    const onEvent = (e: Event) => {
      if ((e as CustomEvent).detail?.id !== id) return;
      const c = takeCaret(id);
      if (c) applyCaret(c);
    };
    window.addEventListener("pb:caret", onEvent);
    return () => window.removeEventListener("pb:caret", onEvent);
  }, [editor, id]);

  // TipTap v3 doesn't re-render on transactions by default — subscribe to the
  // active states the toolbar highlights, or they'd be permanently stale.
  const active = useEditorState({
    editor,
    selector: ({ editor: e }) =>
      e
        ? {
            bold: e.isActive("bold"),
            italic: e.isActive("italic"),
            h2: e.isActive("heading", { level: 2 }),
            h3: e.isActive("heading", { level: 3 }),
            bullet: e.isActive("bulletList"),
            quote: e.isActive("blockquote"),
            link: e.isActive("link"),
            hasSelection: !e.state.selection.empty,
          }
        : null,
  });

  if (!editor) return <div className="h-[150px] animate-pulse rounded-[var(--radius)] bg-line/40" />;

  const setLink = () => {
    const prev = editor.getAttributes("link").href as string | undefined;
    const url = window.prompt("Link URL", prev ?? "https://");
    if (url === null) return;
    if (url === "") editor.chain().focus().unsetLink().run();
    else editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-0.5 rounded-t-[var(--radius)] border border-line bg-panel px-1.5 py-1">
        <Btn label="Bold" active={active?.bold} on={() => editor.chain().focus().toggleBold().run()}><Icon.Bold width={14} height={14} /></Btn>
        <Btn label="Italic" active={active?.italic} on={() => editor.chain().focus().toggleItalic().run()}><Icon.Italic width={14} height={14} /></Btn>
        <span className="mx-1 h-4 w-px bg-line" />
        <Btn label="Heading 2" active={active?.h2} on={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}><span className="text-xs font-bold">H2</span></Btn>
        <Btn label="Heading 3" active={active?.h3} on={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}><span className="text-xs font-bold">H3</span></Btn>
        <span className="mx-1 h-4 w-px bg-line" />
        <Btn label="Bullet list" active={active?.bullet} on={() => editor.chain().focus().toggleBulletList().run()}><Icon.ListBullet width={14} height={14} /></Btn>
        <Btn label="Quote" active={active?.quote} on={() => editor.chain().focus().toggleBlockquote().run()}><Icon.Quote width={14} height={14} /></Btn>
        <Btn label="Link" active={active?.link} on={setLink}><Icon.Link width={14} height={14} /></Btn>
        <Btn label="Insert image" on={() => setPicking(true)}><Icon.Image width={14} height={14} /></Btn>
        <span className="mx-1 h-4 w-px bg-line" />
        <Btn label="Undo" on={() => editor.chain().focus().undo().run()}><Icon.Undo width={14} height={14} /></Btn>
        <Btn label="Redo" on={() => editor.chain().focus().redo().run()}><Icon.Redo width={14} height={14} /></Btn>
        <span className="mx-1 h-4 w-px bg-line" />
        <AiMenu editor={editor} hasSelection={active?.hasSelection ?? false} />
      </div>
      <EditorContent editor={editor} />
      {picking && (
        <MediaPicker
          onClose={() => setPicking(false)}
          onPick={(a) => {
            // Same node shape as the Assets-pane drag-drop path above;
            // width: 100 → autofit the text column on insert.
            editor.chain().focus().insertContent({ type: "image", attrs: { src: a.url, alt: a.alt, "data-document-id": a.documentId, width: 100 } }).run();
            setPicking(false);
          }}
        />
      )}
    </div>
  );
}
