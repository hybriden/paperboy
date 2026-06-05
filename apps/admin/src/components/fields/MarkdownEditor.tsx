import DOMPurify from "dompurify";
import { marked } from "marked";
import { useEffect, useRef, useState } from "react";
import { type PbCaret, takeCaret } from "../../lib/caret.js";

marked.setOptions({ gfm: true, breaks: false });

type Tab = "write" | "preview";

/**
 * Markdown property editor: a formatting toolbar + a Write/Preview toggle. The
 * stored value stays RAW MARKDOWN (the delivery API returns it verbatim and the
 * front end renders it) — the toolbar just inserts markdown syntax, and the
 * preview renders it (sanitised) for confidence.
 */
export function MarkdownEditor({
  id,
  value,
  onChange,
  disabled = false,
  minHeight = 280,
}: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  minHeight?: number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [tab, setTab] = useState<Tab>("write");
  const valueRef = useRef(value);
  valueRef.current = value;

  // Click-to-caret (on-page editing): the preview reported the clicked text;
  // best-effort find it in the RAW markdown (rendered text nodes are usually
  // verbatim substrings of the source) and move the textarea caret there.
  useEffect(() => {
    if (!id) return;
    const applyCaret = (caret: PbCaret) => {
      setTab("write"); // the textarea only exists on the write tab
      requestAnimationFrame(() => {
        const el = ref.current;
        if (!el || el.disabled) return;
        const idx = valueRef.current.indexOf(caret.snippet);
        if (idx < 0) return; // markdown syntax in the way — field focus is still right
        const target = idx + Math.min(Math.max(caret.offset, 0), caret.snippet.length);
        el.focus();
        el.setSelectionRange(target, target);
        // Scroll the caret's line into view (monospace textarea: estimate by line).
        const line = valueRef.current.slice(0, target).split("\n").length;
        const lineHeight = Number.parseFloat(getComputedStyle(el).lineHeight) || 20;
        el.scrollTop = Math.max(0, (line - 3) * lineHeight);
      });
    };
    const queued = takeCaret(id);
    if (queued) requestAnimationFrame(() => applyCaret(queued));
    const onEvent = (e: Event) => {
      if ((e as CustomEvent).detail?.id !== id) return;
      const c = takeCaret(id);
      if (c) applyCaret(c);
    };
    window.addEventListener("pb:caret", onEvent);
    return () => window.removeEventListener("pb:caret", onEvent);
  }, [id]);

  const apply = (next: string, selStart: number, selEnd: number) => {
    onChange(next);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(selStart, selEnd);
    });
  };

  // Wrap the selection (e.g. ** ** for bold); inserts a placeholder if empty.
  const wrap = (before: string, after = before, placeholder = "") => {
    const el = ref.current;
    if (!el) return;
    const s = el.selectionStart;
    const e = el.selectionEnd;
    const sel = value.slice(s, e) || placeholder;
    const next = value.slice(0, s) + before + sel + after + value.slice(e);
    apply(next, s + before.length, s + before.length + sel.length);
  };

  // Prefix every selected line (e.g. "## ", "- ", "> ").
  const prefixLines = (prefix: string) => {
    const el = ref.current;
    if (!el) return;
    const s = el.selectionStart;
    const e = el.selectionEnd;
    const lineStart = value.lastIndexOf("\n", s - 1) + 1;
    const block = value.slice(lineStart, e) || "";
    const replaced = block
      .split("\n")
      .map((l) => prefix + l)
      .join("\n");
    const next = value.slice(0, lineStart) + replaced + value.slice(e);
    apply(next, lineStart, lineStart + replaced.length);
  };

  const link = () => {
    const el = ref.current;
    if (!el) return;
    const s = el.selectionStart;
    const e = el.selectionEnd;
    const text = value.slice(s, e) || "link text";
    const snippet = `[${text}](https://)`;
    const next = value.slice(0, s) + snippet + value.slice(e);
    const urlPos = s + text.length + 3; // inside the (…)
    apply(next, urlPos, urlPos + "https://".length);
  };

  const html = tab === "preview" ? DOMPurify.sanitize(marked.parse(value || "", { async: false }) as string) : "";

  return (
    <div className="rounded-[var(--radius)] border border-line bg-panel">
      <div className="flex flex-wrap items-center gap-0.5 border-b border-line bg-panel px-1.5 py-1">
        <Btn label="B" title="Bold" disabled={disabled} onClick={() => wrap("**", "**", "bold")} bold />
        <Btn label="I" title="Italic" disabled={disabled} onClick={() => wrap("_", "_", "italic")} italic />
        <Sep />
        <Btn label="H2" title="Heading" disabled={disabled} onClick={() => prefixLines("## ")} />
        <Btn label="❝" title="Quote" disabled={disabled} onClick={() => prefixLines("> ")} />
        <Btn label="• List" title="Bullet list" disabled={disabled} onClick={() => prefixLines("- ")} />
        <Btn label="1. List" title="Numbered list" disabled={disabled} onClick={() => prefixLines("1. ")} />
        <Btn label="</>" title="Inline code" disabled={disabled} onClick={() => wrap("`", "`", "code")} />
        <Btn label="Link" title="Link" disabled={disabled} onClick={link} />
        <div className="ml-auto flex rounded border border-line p-0.5">
          {(["write", "preview"] as Tab[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`rounded px-2 py-0.5 text-xs capitalize ${tab === t ? "bg-accent text-white" : "text-muted hover:bg-canvas"}`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>
      {tab === "write" ? (
        <textarea
          id={id}
          ref={ref}
          className="block w-full resize-y bg-transparent px-3 py-2 font-mono text-[13px] leading-relaxed text-fg outline-none"
          style={{ minHeight }}
          value={value}
          disabled={disabled}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          placeholder="# Markdown… (headings, **bold**, lists, `code`, tables)"
        />
      ) : (
        <div
          className="overflow-auto px-3 py-2 text-sm leading-relaxed [&_a]:text-accent-700 [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-line [&_blockquote]:pl-3 [&_blockquote]:text-muted [&_code]:rounded [&_code]:bg-line/60 [&_code]:px-1 [&_code]:font-mono [&_code]:text-[12px] [&_h1]:mb-2 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:mb-2 [&_h2]:mt-3 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:font-semibold [&_li]:my-0.5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_pre]:my-2 [&_pre]:overflow-auto [&_pre]:rounded [&_pre]:bg-line/60 [&_pre]:p-2 [&_table]:my-2 [&_td]:border [&_td]:border-line [&_td]:px-2 [&_th]:border [&_th]:border-line [&_th]:px-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5"
          style={{ minHeight }}
          // Rendered from the editor's own markdown and sanitised with DOMPurify.
          dangerouslySetInnerHTML={{ __html: html || "<p class='text-muted'>Nothing to preview.</p>" }}
        />
      )}
    </div>
  );
}

function Btn({
  label,
  title,
  onClick,
  disabled,
  bold,
  italic,
}: {
  label: string;
  title: string;
  onClick: () => void;
  disabled?: boolean;
  bold?: boolean;
  italic?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      // Keep the textarea selection (don't blur) when clicking a toolbar button.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={`rounded px-2 py-1 text-xs text-muted hover:bg-line/60 hover:text-fg disabled:opacity-50 ${bold ? "font-bold" : ""} ${italic ? "italic" : ""}`}
    >
      {label}
    </button>
  );
}

function Sep() {
  return <span className="mx-0.5 h-4 w-px bg-line" aria-hidden />;
}
