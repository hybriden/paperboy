import Link from "@tiptap/extension-link";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Icon } from "../../lib/icons.js";

const EMPTY = { type: "doc", content: [{ type: "paragraph" }] };

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
  const editor = useEditor({
    extensions: [
      // StarterKit now bundles Link; disable it so our custom-configured Link
      // (no duplicate extension warning) is the only one registered.
      StarterKit.configure({ heading: { levels: [2, 3] }, link: false }),
      Link.configure({ openOnClick: false, autolink: true, HTMLAttributes: { rel: "noopener" } }),
    ],
    content: (value && typeof value === "object" && "type" in (value as object) ? value : EMPTY) as object,
    onUpdate: ({ editor }) => onChange(editor.getJSON()),
    editorProps: {
      attributes: {
        id,
        class:
          "prose-paperboy min-h-[120px] rounded-b-[var(--radius)] border border-t-0 border-line bg-panel px-3 py-2.5 text-sm text-fg outline-none focus:border-accent",
      },
    },
  });

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
      <div className="flex flex-wrap items-center gap-0.5 rounded-t-[var(--radius)] border border-line bg-canvas px-1.5 py-1">
        <Btn label="Bold" active={active?.bold} on={() => editor.chain().focus().toggleBold().run()}><Icon.Bold width={14} height={14} /></Btn>
        <Btn label="Italic" active={active?.italic} on={() => editor.chain().focus().toggleItalic().run()}><Icon.Italic width={14} height={14} /></Btn>
        <span className="mx-1 h-4 w-px bg-line" />
        <Btn label="Heading 2" active={active?.h2} on={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}><span className="text-xs font-bold">H2</span></Btn>
        <Btn label="Heading 3" active={active?.h3} on={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}><span className="text-xs font-bold">H3</span></Btn>
        <span className="mx-1 h-4 w-px bg-line" />
        <Btn label="Bullet list" active={active?.bullet} on={() => editor.chain().focus().toggleBulletList().run()}><Icon.ListBullet width={14} height={14} /></Btn>
        <Btn label="Quote" active={active?.quote} on={() => editor.chain().focus().toggleBlockquote().run()}><Icon.Quote width={14} height={14} /></Btn>
        <Btn label="Link" active={active?.link} on={setLink}><Icon.Link width={14} height={14} /></Btn>
        <span className="mx-1 h-4 w-px bg-line" />
        <Btn label="Undo" on={() => editor.chain().focus().undo().run()}><Icon.Undo width={14} height={14} /></Btn>
        <Btn label="Redo" on={() => editor.chain().focus().redo().run()}><Icon.Redo width={14} height={14} /></Btn>
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}
