/**
 * Delivery-consumption helpers — pure, DOM-free, framework-agnostic transforms
 * for content the Delivery API returns. They sit alongside `mediaUrl` as
 * "render what you fetched" utilities (a frontend still owns its own markup —
 * these only normalize values). Shared so frontends don't each reimplement them.
 */

/* ----------------------------- richtext → HTML ---------------------------- */

interface RtNode {
  type?: string;
  text?: string;
  content?: RtNode[];
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function safeHref(href: string): string {
  const h = (href || "").trim();
  return /^(https?:|mailto:|tel:|\/|#)/i.test(h) ? h : "#";
}

function applyMarks(text: string, marks?: { type: string; attrs?: Record<string, unknown> }[]): string {
  let out = esc(text);
  for (const m of marks ?? []) {
    switch (m.type) {
      case "bold":
        out = `<strong>${out}</strong>`;
        break;
      case "italic":
        out = `<em>${out}</em>`;
        break;
      case "strike":
        out = `<s>${out}</s>`;
        break;
      case "code":
        out = `<code>${out}</code>`;
        break;
      case "link": {
        const href = esc(safeHref(String(m.attrs?.href ?? "#")));
        const blank = m.attrs?.target === "_blank" ? ' target="_blank" rel="noopener noreferrer"' : "";
        out = `<a href="${href}"${blank}>${out}</a>`;
        break;
      }
    }
  }
  return out;
}

function renderNode(node: RtNode): string {
  if (node.type === "text") return applyMarks(node.text ?? "", node.marks);
  const inner = (node.content ?? []).map(renderNode).join("");
  switch (node.type) {
    case "doc":
      return inner;
    case "paragraph":
      return `<p>${inner}</p>`;
    case "heading": {
      const lvl = Math.min(Math.max(Number(node.attrs?.level ?? 2), 1), 6);
      return `<h${lvl}>${inner}</h${lvl}>`;
    }
    case "bulletList":
      return `<ul>${inner}</ul>`;
    case "orderedList":
      return `<ol>${inner}</ol>`;
    case "listItem":
      return `<li>${inner}</li>`;
    case "blockquote":
      return `<blockquote>${inner}</blockquote>`;
    case "codeBlock":
      return `<pre><code>${inner}</code></pre>`;
    case "image": {
      // Images dropped into the CMS richtext editor; delivery absolutizes src.
      const src = String(node.attrs?.src ?? "").trim();
      if (!/^(https?:|\/)/i.test(src)) return "";
      const alt = esc(String(node.attrs?.alt ?? ""));
      // Editor drag-resize stores a percent width on the image node; apply inline.
      const width = Number(node.attrs?.width);
      const style = Number.isFinite(width) && width >= 10 && width <= 100 ? ` style="width:${Math.round(width)}%"` : "";
      return `<img src="${esc(src)}" alt="${alt}" loading="lazy"${style}/>`;
    }
    case "horizontalRule":
      return "<hr/>";
    case "hardBreak":
      return "<br/>";
    default:
      return inner;
  }
}

/**
 * Render a Paperboy richtext value (TipTap JSON doc) to a SANITISED HTML string:
 * text is escaped, link/image URLs are restricted to safe schemes — safe to
 * inject with `innerHTML` / `set:html`. (Frameworks that render to nodes rather
 * than an HTML string should walk the doc themselves.)
 */
export function renderRichText(doc: unknown): string {
  if (!doc || typeof doc !== "object") return "";
  return renderNode(doc as RtNode);
}

/** True if a value looks like a richtext document (vs a plain string/markdown). */
export function isRichTextDoc(v: unknown): boolean {
  return !!v && typeof v === "object" && ((v as RtNode).type === "doc" || Array.isArray((v as RtNode).content));
}

/* --------------------------- content-area blocks -------------------------- */

/** A block as the Delivery API serializes it inside a content area. */
export interface AreaBlock {
  blockType: string;
  display?: string;
  shared?: boolean;
  /** Inline block field values. */
  data?: Record<string, unknown>;
  /** Shared block / referenced page (resolved at populate >= 1). */
  content?: { kind?: string; name?: string; urlPath?: string | null; data?: Record<string, unknown> };
}

/** A block's field values: inline blocks carry `data`, shared blocks `content.data`. */
export function blockData(b: AreaBlock): Record<string, unknown> {
  return (b.shared ? b.content?.data : b.data) ?? {};
}

const looksLikeBlocks = (v: unknown): v is AreaBlock[] =>
  Array.isArray(v) && v.length > 0 && v.every((b) => b != null && typeof b === "object" && "blockType" in (b as object));

/**
 * Every content-area field on a delivered item's `data`, keyed by field name.
 * Content types are data, so areas can be named anything — a non-empty array of
 * blocks is detected by shape; an EMPTY array is shape-identical to any other
 * empty list, so it only counts when conventionally named (…Area, e.g.
 * `mainArea`). This keeps an empty `tags: []` from looking like a content area.
 */
export function contentAreas(data: Record<string, unknown>): { field: string; blocks: AreaBlock[] }[] {
  return Object.entries(data)
    .filter(([field, v]) => looksLikeBlocks(v) || (Array.isArray(v) && v.length === 0 && /area$/i.test(field)))
    .map(([field, v]) => ({ field, blocks: v as AreaBlock[] }));
}
