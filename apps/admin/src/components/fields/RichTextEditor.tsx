import Link from "@tiptap/extension-link";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Icon } from "../../lib/icons.js";

const EMPTY = { type: "doc", content: [{ type: "paragraph" }] };

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

  if (!editor) return <div className="h-[150px] animate-pulse rounded-[var(--radius)] bg-line/40" />;

  const Btn = ({
    on,
    active,
    label,
    children,
  }: {
    on: () => void;
    active?: boolean;
    label: string;
    children: React.ReactNode;
  }) => (
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
        <Btn label="Bold" active={editor.isActive("bold")} on={() => editor.chain().focus().toggleBold().run()}><Icon.Bold width={14} height={14} /></Btn>
        <Btn label="Italic" active={editor.isActive("italic")} on={() => editor.chain().focus().toggleItalic().run()}><Icon.Italic width={14} height={14} /></Btn>
        <span className="mx-1 h-4 w-px bg-line" />
        <Btn label="Heading 2" active={editor.isActive("heading", { level: 2 })} on={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}><span className="text-xs font-bold">H2</span></Btn>
        <Btn label="Heading 3" active={editor.isActive("heading", { level: 3 })} on={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}><span className="text-xs font-bold">H3</span></Btn>
        <span className="mx-1 h-4 w-px bg-line" />
        <Btn label="Bullet list" active={editor.isActive("bulletList")} on={() => editor.chain().focus().toggleBulletList().run()}><Icon.ListBullet width={14} height={14} /></Btn>
        <Btn label="Quote" active={editor.isActive("blockquote")} on={() => editor.chain().focus().toggleBlockquote().run()}><Icon.Quote width={14} height={14} /></Btn>
        <Btn label="Link" active={editor.isActive("link")} on={setLink}><Icon.Link width={14} height={14} /></Btn>
        <span className="mx-1 h-4 w-px bg-line" />
        <Btn label="Undo" on={() => editor.chain().focus().undo().run()}><Icon.Undo width={14} height={14} /></Btn>
        <Btn label="Redo" on={() => editor.chain().focus().redo().run()}><Icon.Redo width={14} height={14} /></Btn>
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}
