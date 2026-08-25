import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { isSafeUrl } from "@paperboy/shared";
import { api } from "../../lib/api.js";
import { Icon } from "../../lib/icons.js";

/**
 * The link editor.
 *
 * A link is one of five things an editor actually means, and each wants a
 * different control: a PAGE in this site, an external URL, an email address, a
 * phone number, or an anchor on the current page. The old field was a single
 * text input labelled "https://… or /path", which made the most valuable case —
 * pointing at a page — a hand-typed string that silently rots the moment
 * someone renames a slug.
 *
 * Picking a page stores its documentId, and delivery resolves the live path at
 * read time. So the editor never types a path, and moving or renaming the
 * target rewrites every link to it. This is the shape of Optimizely's link
 * dialog (Page / Media / External / Email tabs over a permanent-link store).
 */

type Mode = "page" | "url" | "email" | "phone" | "anchor";

const MODES: { key: Mode; label: string; hint: string }[] = [
  { key: "page", label: "Page", hint: "A page in this site — the URL follows it if it moves." },
  { key: "url", label: "URL", hint: "An address outside this site." },
  { key: "email", label: "Email", hint: "Opens the visitor’s mail app." },
  { key: "phone", label: "Phone", hint: "Dials on a mobile." },
  { key: "anchor", label: "Anchor", hint: "Jumps to a section of the current page." },
];

interface LinkVal {
  href?: string;
  documentId?: string;
  anchor?: string;
  text?: string;
  target?: string;
  title?: string;
}

/** A retyped text field can still hold a bare string; treat it as the href. */
function asLink(value: unknown): LinkVal {
  if (typeof value === "string") return value.trim() ? { href: value.trim() } : {};
  if (value && typeof value === "object" && !Array.isArray(value)) return value as LinkVal;
  return {};
}

function detectMode(v: LinkVal): Mode {
  if (v.documentId) return "page";
  const href = v.href ?? "";
  if (href.startsWith("mailto:")) return "email";
  if (href.startsWith("tel:")) return "phone";
  if (href.startsWith("#")) return "anchor";
  // An EMPTY link starts on Page. Most links point at a page in the site, and
  // it is the option that cannot rot — opening on the URL box would land the
  // editor in the hand-typed habit this field exists to replace.
  if (!href) return "page";
  return "url";
}

export function LinkField({
  id,
  value,
  disabled = false,
  onChange,
}: {
  id: string;
  value: unknown;
  disabled?: boolean;
  onChange: (v: unknown) => void;
}) {
  const v = asLink(value);
  const [mode, setMode] = useState<Mode>(() => detectMode(v));
  const [pickerOpen, setPickerOpen] = useState(false);

  const pages = useQuery({ queryKey: ["pages"], queryFn: ({ signal }) => api.pages(signal) });

  /** "Blog › A post" — an editor recognises the trail, not a slug path. */
  const namePath = useMemo(() => {
    const list = pages.data ?? [];
    const byId = new Map(list.map((p) => [p.documentId, p]));
    return (documentId: string): string => {
      const parts: string[] = [];
      let cur = byId.get(documentId);
      const guard = new Set<string>();
      while (cur && !guard.has(cur.documentId)) {
        guard.add(cur.documentId);
        parts.unshift(cur.name);
        cur = cur.parentId ? byId.get(cur.parentId) : undefined;
      }
      return parts.join(" › ");
    };
  }, [pages.data]);

  /** Write a patch, collapsing an entirely empty link back to null. */
  const set = (patch: LinkVal) => {
    const next: LinkVal = { ...v, ...patch };
    for (const k of Object.keys(next) as (keyof LinkVal)[]) {
      if (next[k] === "" || next[k] === undefined) delete next[k];
    }
    onChange(next.href || next.documentId || next.anchor || next.text || next.title ? next : null);
  };

  /** Switching mode drops the destination but keeps text/target/title. */
  const switchMode = (next: Mode) => {
    setMode(next);
    onChange(
      v.text || v.target || v.title
        ? { ...(v.text ? { text: v.text } : {}), ...(v.target ? { target: v.target } : {}), ...(v.title ? { title: v.title } : {}) }
        : null,
    );
  };

  const hrefSafe = mode !== "url" || !v.href || isSafeUrl(v.href);
  const selectedPage = v.documentId ? namePath(v.documentId) : "";
  // What the visitor will actually get, so the editor can see it before saving.
  const preview =
    mode === "page"
      ? v.documentId
        ? `${selectedPage || "(page)"}${v.anchor ? ` #${v.anchor.replace(/^#/, "")}` : ""}`
        : ""
      : (v.href ?? "");

  return (
    <div className="rounded-(--radius) border border-line bg-canvas/40 p-2">
      {/* Mode is a radiogroup, not tabs: it selects what the link IS. */}
      <div role="radiogroup" aria-label="Link type" className="mb-2 flex flex-wrap gap-1">
        {MODES.map((m) => (
          <button
            key={m.key}
            type="button"
            role="radio"
            aria-checked={mode === m.key}
            disabled={disabled}
            title={m.hint}
            className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-40 ${
              mode === m.key ? "bg-accent text-accent-fg" : "border border-line text-muted hover:bg-canvas"
            }`}
            onClick={() => switchMode(m.key)}
          >
            {m.label}
          </button>
        ))}
      </div>

      {mode === "page" && (
        <div className="relative mb-2">
          {/* The field's own <label for> names this control, so a screen reader
              says "Call to action, button". The CHOSEN page is the description,
              otherwise the selection would be announced as the name and the
              field it belongs to would go unsaid. */}
          <button
            type="button"
            id={id}
            disabled={disabled}
            aria-expanded={pickerOpen}
            aria-describedby={`${id}-target`}
            className="field-input flex w-full items-center gap-2 text-left"
            onClick={() => setPickerOpen((o) => !o)}
          >
            <Icon.File width={14} height={14} className="shrink-0 text-muted" />
            <span id={`${id}-target`} className={`min-w-0 flex-1 truncate ${selectedPage ? "text-fg" : "text-muted"}`}>
              {selectedPage || "Choose a page…"}
            </span>
            {v.documentId && (
              <span className="shrink-0 rounded bg-published/15 px-1.5 py-0.5 text-[11px] text-fg">follows the page</span>
            )}
          </button>
          {pickerOpen && (
            <PagePicker
              pages={pages.data ?? []}
              onPick={(documentId) => {
                set({ documentId, href: "" });
                setPickerOpen(false);
              }}
              onClose={() => setPickerOpen(false)}
            />
          )}
          <label className="field-label mt-2" htmlFor={`${id}-anchor`}>
            Section on that page (optional)
          </label>
          <input
            id={`${id}-anchor`}
            className="field-input"
            placeholder="e.g. faq"
            value={(v.anchor ?? "").replace(/^#/, "")}
            disabled={disabled}
            onChange={(e) => set({ anchor: e.target.value.replace(/^#/, "") })}
          />
        </div>
      )}

      {mode === "url" && (
        <div className="mb-2">
          <input
            id={id}
            className="field-input"
            placeholder="https://example.com"
            inputMode="url"
            value={v.href ?? ""}
            disabled={disabled}
            aria-label="Link URL"
            aria-invalid={!hrefSafe || undefined}
            onChange={(e) => set({ href: e.target.value, documentId: "" })}
          />
          {!hrefSafe && (
            // Say it here rather than let the save fail: the write chokepoint
            // rejects these schemes because they execute in the visitor's browser.
            <p className="mt-1 text-xs text-danger">
              Only http://, https://, mailto:, tel:, “/” or “#” addresses can be saved — this one would run code in the
              visitor’s browser.
            </p>
          )}
          <p className="mt-1 text-xs text-muted">
            Linking to a page in this site? Use <strong>Page</strong> — a typed path breaks when the page moves.
          </p>
        </div>
      )}

      {mode === "email" && (
        <input
          id={id}
          className="field-input mb-2"
          type="email"
          placeholder="name@example.com"
          value={(v.href ?? "").replace(/^mailto:/, "")}
          disabled={disabled}
          aria-label="Email address"
          onChange={(e) => set({ href: e.target.value ? `mailto:${e.target.value.trim()}` : "", documentId: "" })}
        />
      )}

      {mode === "phone" && (
        <input
          id={id}
          className="field-input mb-2"
          type="tel"
          placeholder="+47 123 45 678"
          value={(v.href ?? "").replace(/^tel:/, "")}
          disabled={disabled}
          aria-label="Phone number"
          onChange={(e) => set({ href: e.target.value ? `tel:${e.target.value.trim()}` : "", documentId: "" })}
        />
      )}

      {mode === "anchor" && (
        <input
          id={id}
          className="field-input mb-2"
          placeholder="section-id"
          value={(v.href ?? "").replace(/^#/, "")}
          disabled={disabled}
          aria-label="Anchor on this page"
          onChange={(e) => set({ href: e.target.value ? `#${e.target.value.replace(/^#/, "")}` : "", documentId: "" })}
        />
      )}

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="field-label" htmlFor={`${id}-text`}>Link text</label>
          <input
            id={`${id}-text`}
            className="field-input"
            placeholder={selectedPage || "What the link says"}
            value={v.text ?? ""}
            disabled={disabled}
            onChange={(e) => set({ text: e.target.value })}
          />
        </div>
        <div>
          <label className="field-label" htmlFor={`${id}-target`}>Opens in</label>
          <select
            id={`${id}-target`}
            className="field-input"
            value={v.target ?? "_self"}
            disabled={disabled}
            onChange={(e) => set({ target: e.target.value === "_blank" ? "_blank" : "" })}
          >
            <option value="_self">Same tab</option>
            <option value="_blank">New tab</option>
          </select>
        </div>
      </div>

      <div className="mt-2 flex items-center gap-2 border-t border-line pt-2 text-xs">
        <span className="text-muted">Goes to</span>
        <span className="min-w-0 flex-1 truncate font-mono text-fg">{preview || "—"}</span>
        {(v.href || v.documentId) && !disabled && (
          <button type="button" className="btn-subtle px-2 py-0.5 text-xs" onClick={() => onChange(null)}>
            Clear
          </button>
        )}
      </div>
    </div>
  );
}

/** Searchable page list, tree-ordered and indented by depth. */
function PagePicker({
  pages,
  onPick,
  onClose,
}: {
  pages: { documentId: string; name: string; parentId: string | null }[];
  onPick: (documentId: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => searchRef.current?.focus(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const rows = useMemo(() => {
    const children = new Map<string | null, typeof pages>();
    for (const p of pages) {
      const k = p.parentId ?? null;
      children.set(k, [...(children.get(k) ?? []), p]);
    }
    const out: { documentId: string; name: string; depth: number }[] = [];
    const seen = new Set<string>();
    const walk = (parent: string | null, depth: number) => {
      if (depth > 20) return;
      for (const p of children.get(parent) ?? []) {
        if (seen.has(p.documentId)) continue;
        seen.add(p.documentId);
        out.push({ documentId: p.documentId, name: p.name, depth });
        walk(p.documentId, depth + 1);
      }
    };
    walk(null, 0);
    const q = query.trim().toLowerCase();
    // Searching flattens: the hierarchy is noise once you are filtering.
    return q ? out.filter((r) => r.name.toLowerCase().includes(q)).map((r) => ({ ...r, depth: 0 })) : out;
  }, [pages, query]);

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-label="Choose a page"
        className="absolute z-50 mt-1 w-full min-w-72 rounded-(--radius) border border-line bg-panel p-1 shadow-pop"
      >
        <div className="flex items-center gap-1.5 border-b border-line px-1.5 pb-1.5">
          <Icon.Search width={14} height={14} />
          <input
            ref={searchRef}
            type="search"
            className="w-full bg-transparent py-1 text-xs text-fg outline-none"
            placeholder="Search pages…"
            aria-label="Search pages"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && rows[0]) {
                e.preventDefault();
                onPick(rows[0].documentId);
              }
            }}
          />
        </div>
        <div className="max-h-64 overflow-y-auto py-1">
          {rows.map((r) => (
            <button
              key={r.documentId}
              type="button"
              className="block w-full truncate rounded px-2 py-1.5 text-left text-xs text-fg hover:bg-canvas"
              style={{ paddingLeft: `${8 + r.depth * 12}px` }}
              onClick={() => onPick(r.documentId)}
            >
              {r.name}
            </button>
          ))}
          {rows.length === 0 && (
            <p className="px-2 py-3 text-center text-xs text-muted">
              {query ? `No page matches “${query}”.` : "No pages yet."}
            </p>
          )}
        </div>
      </div>
    </>
  );
}
