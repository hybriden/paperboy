import { Fragment, type ReactNode } from "react";
import type { DeliveryContent } from "@paperboy/shared";
import DOMPurify from "isomorphic-dompurify";
import { marked } from "marked";
import { fetchList } from "../lib/delivery";

marked.setOptions({ gfm: true, breaks: false });

/* ---- TipTap doc → React (paragraphs, headings, lists, quote, bold/italic/link) ---- */
interface Node {
  type: string;
  text?: string;
  content?: Node[];
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  attrs?: Record<string, unknown>;
}

function renderText(node: Node, key: number): ReactNode {
  let el: ReactNode = node.text ?? "";
  for (const m of node.marks ?? []) {
    if (m.type === "bold") el = <strong>{el}</strong>;
    else if (m.type === "italic") el = <em>{el}</em>;
    else if (m.type === "code") el = <code>{el}</code>;
    else if (m.type === "link") el = <a href={String(m.attrs?.href ?? "#")} rel="noopener">{el}</a>;
  }
  return <Fragment key={key}>{el}</Fragment>;
}

function renderNode(node: Node, key: number): ReactNode {
  const kids = (node.content ?? []).map((c, i) => renderNode(c, i));
  switch (node.type) {
    case "text":
      return renderText(node, key);
    case "paragraph":
      return <p key={key}>{kids}</p>;
    case "heading": {
      const lvl = Number(node.attrs?.level ?? 2);
      const Tag = (lvl === 3 ? "h3" : "h2") as "h2" | "h3";
      return <Tag key={key}>{kids}</Tag>;
    }
    case "bulletList":
      return <ul key={key}>{kids}</ul>;
    case "orderedList":
      return <ol key={key}>{kids}</ol>;
    case "listItem":
      return <li key={key}>{kids}</li>;
    case "blockquote":
      return <blockquote key={key}>{kids}</blockquote>;
    case "hardBreak":
      return <br key={key} />;
    default:
      return <Fragment key={key}>{kids}</Fragment>;
  }
}

/**
 * Render any text-ish field value: a TipTap doc (richtext fields) renders via
 * the node walker above; a STRING (markdown / plain-text fields — the delivery
 * API returns markdown verbatim) is parsed with marked and sanitised.
 */
function Rich({ doc, className }: { doc: unknown; className?: string }) {
  if (typeof doc === "string") {
    if (!doc.trim()) return null;
    const html = DOMPurify.sanitize(marked.parse(doc, { async: false }) as string);
    return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
  }
  const d = doc as Node | null;
  if (!d?.content) return null;
  return <div className={className}>{d.content.map((n, i) => renderNode(n, i))}</div>;
}

/* ----------------------------- blocks ----------------------------- */
interface AreaBlock {
  blockType: string;
  display: string;
  shared: boolean;
  data?: Record<string, unknown>;
  content?: DeliveryContent;
}
const blockData = (b: AreaBlock): Record<string, unknown> => (b.shared ? b.content?.data : b.data) ?? {};

/** Newest-first by publishDate (fallback name) — the teaser/list ordering. */
function newestFirst(items: DeliveryContent[]): DeliveryContent[] {
  return [...items].sort((a, b) =>
    String((b.data as Record<string, unknown>).publishDate ?? "").localeCompare(
      String((a.data as Record<string, unknown>).publishDate ?? ""),
    ) || a.name.localeCompare(b.name),
  );
}

/** ListBlock: a teaser list of a referenced page's newest children (async RSC). */
async function ListBlockTeasers({ d, locale, preview, edit }: { d: Record<string, unknown>; locale: string; preview: boolean; edit: Record<string, unknown> }) {
  const source = d.source as { documentId?: string } | null | undefined;
  const count = typeof d.count === "number" && d.count > 0 ? d.count : 3;
  const items = source?.documentId
    ? newestFirst(await fetchList(null, locale, preview, source.documentId)).slice(0, count)
    : [];
  return (
    <section className="block block--narrow" data-block="ListBlock" {...edit}>
      <h2>{String(d.heading ?? "")}</h2>
      {items.length === 0 ? (
        <p className="post-meta">Nothing to list yet.</p>
      ) : (
        <ul className="post-list">
          {items.map((p) => {
            const pd = p.data as Record<string, unknown>;
            const date = fmtDate(pd.publishDate);
            return (
              <li key={p.documentId} className="card post-card">
                <a className="post-link" href={p.urlPath ? `/${locale}${p.urlPath}` : "#"}>
                  <h3>{String(pd.title ?? p.name)}</h3>
                </a>
                {date ? <p className="post-meta">{date}</p> : null}
                {pd.summary ? <p className="post-summary">{String(pd.summary)}</p> : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Block({ b, index, locale, preview }: { b: AreaBlock; index: number; locale: string; preview: boolean }) {
  const d = blockData(b);
  // data-pb-* markers let the editor's preview map a click back to this block.
  const edit = { "data-pb-block-index": index, "data-pb-block-type": b.blockType, "data-pb-shared": b.shared ? "true" : undefined };
  if (b.blockType === "HeroBlock") {
    const img = d.heroImage as { url?: string; alt?: string } | null | undefined;
    const cta = String(d.ctaUrl ?? "");
    const href = cta.startsWith("/") ? `/${locale}${cta}` : cta;
    return (
      <section className={`block block--full block--${b.display}`} data-block="HeroBlock" {...edit}>
        {img?.url ? <img className="hero-image" src={img.url} alt={img.alt ?? ""} loading="lazy" /> : null}
        <h2>{String(d.title ?? "")}</h2>
        {d.subtitle ? <p>{String(d.subtitle)}</p> : null}
        {cta ? <a href={href}>Learn more</a> : null}
      </section>
    );
  }
  if (b.blockType === "CardBlock") {
    return (
      <div className={`block card card--${b.display}`} data-block="CardBlock" {...edit}>
        <h3>{String(d.title ?? "")}</h3>
        <Rich doc={d.body} className="richtext" />
      </div>
    );
  }
  if (b.blockType === "ListBlock") {
    return <ListBlockTeasers d={d} locale={locale} preview={preview} edit={edit} />;
  }
  // A PAGE dropped into the content area renders as a teaser — a compact card
  // linking to the page (Optimizely-style). A teaser ALWAYS links to the
  // content it teases: the whole card is the link, and a page that has no
  // public path (e.g. an unpublished ancestor) renders nothing at all.
  if (b.shared && b.content?.kind === "page") {
    const c = b.content;
    if (!c.urlPath) return null;
    const summary = d.summary ?? d.metaDescription ?? null;
    const date = fmtDate(d.publishDate);
    return (
      <a className={`block card post-card post-link card--${b.display}`} href={`/${locale}${c.urlPath}`} data-block="PageTeaser" {...edit}>
        <h3>{String(d.title ?? c.name)}</h3>
        {date ? <p className="post-meta">{date}</p> : null}
        {summary ? <p className="post-summary">{String(summary)}</p> : <Rich doc={d.intro} className="post-summary" />}
      </a>
    );
  }
  return <div className="block card" data-block={b.blockType} {...edit}>Unknown block: {b.blockType}</div>;
}

/* ----------------------------- blog ----------------------------- */
function fmtDate(v: unknown): string | null {
  const s = typeof v === "string" ? v : "";
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

/** A single BlogPost: title, date, summary lead, and the rich-text body. */
function BlogPostView({ content }: { content: DeliveryContent }) {
  const d = content.data as Record<string, unknown>;
  const date = fmtDate(d.publishDate);
  return (
    <main className="wrap" data-document-id={content.documentId}>
      <article className="post">
        <h1 className="page-heading" data-pb-field="title">{String(d.title ?? content.name)}</h1>
        {date ? <p className="post-meta">{date}</p> : null}
        {d.summary ? <p className="post-summary" data-pb-field="summary">{String(d.summary)}</p> : null}
        <div data-pb-field="body"><Rich doc={d.body} className="richtext post-body" /></div>
      </article>
    </main>
  );
}

/** The item list a ListPage renders. Children live under the list page itself. */
function PostList({ posts, locale, basePath }: { posts: DeliveryContent[]; locale: string; basePath: string }) {
  const href = (p: DeliveryContent) => `/${locale}${p.urlPath ?? `${basePath}/${p.slug ?? ""}`}`;
  return (
    <ul className="post-list">
      {posts.map((p) => {
        const d = p.data as Record<string, unknown>;
        const date = fmtDate(d.publishDate);
        return (
          <li key={p.documentId} className="card post-card">
            <a className="post-link" href={href(p)}>
              <h3>{String(d.title ?? p.name)}</h3>
            </a>
            {date ? <p className="post-meta">{date}</p> : null}
            {d.summary ? <p className="post-summary">{String(d.summary)}</p> : null}
          </li>
        );
      })}
    </ul>
  );
}

export function Renderer({ content, posts, locale = "en", basePath = "", preview = false }: { content: DeliveryContent; posts?: DeliveryContent[]; locale?: string; basePath?: string; preview?: boolean }) {
  if (content.type === "BlogPost") return <BlogPostView content={content} />;

  const data = content.data as Record<string, unknown>;
  // Content types are data, so user-created types name their fields freely:
  // accept `mainArea` or the first array that looks like a content area.
  const isArea = (v: unknown): v is AreaBlock[] =>
    Array.isArray(v) && v.every((b) => b != null && typeof b === "object" && "blockType" in (b as object));
  const area = [data.mainArea, ...Object.values(data)].filter(isArea).find((a) => a.length > 0) ?? [];
  return (
    <main className="wrap" data-document-id={content.documentId}>
      <h1 className="page-heading" data-pb-field="heading">{String(data.heading ?? content.name)}</h1>
      <div data-pb-field="intro"><Rich doc={data.intro} className="intro richtext" /></div>
      {data.body != null ? <div data-pb-field="body"><Rich doc={data.body} className="richtext" /></div> : null}
      {area.map((b, i) => <Block key={i} b={b} index={i} locale={locale} preview={preview} />)}
      {posts && posts.length > 0 ? <PostList posts={posts} locale={locale} basePath={basePath} /> : null}
    </main>
  );
}
