import { blockData, contentAreas, pbAreaAttrs, renderRichText, type AreaBlock, type DeliveryContent } from "@paperboycms/client";
import { ATTR } from "@paperboycms/preview/protocol";
import { standaloneAreaBlock } from "../lib/standalone-block";
import { DEFAULT_LOCALE } from "../lib/locale";
import { submitFormAction } from "../actions/submit-form";
import { Form } from "./Form";
import DOMPurify from "isomorphic-dompurify";
import { marked } from "marked";
import { fetchList } from "../lib/delivery";

marked.setOptions({ gfm: true, breaks: false });

/** Render a scalar field/attr value (typed `unknown`, always a scalar at runtime);
 *  objects/arrays/null become "" rather than "[object Object]". */
function asText(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  return "";
}

/** The on-page-editing field marker, spelled through the published ATTR
 *  contract so the attribute name can't drift from the bridge that reads it. */
const pbField = (name: string) => ({ [ATTR.field]: name });

/** A CTA from a plain text field never met the write-time link guard, and React
 *  blocks javascript: but lets data:/vbscript: through — allow only safe schemes
 *  and relative paths (a single leading slash: `//host` is protocol-relative,
 *  i.e. an off-site link in disguise); anything else drops the link. */
function safeHref(raw: string): string | null {
  const h = raw.trim();
  return /^(https?:|mailto:|tel:|\/(?!\/)|[#?.])/i.test(h) ? h : null;
}

/**
 * Render any text-ish field value: a TipTap doc (richtext fields) renders via the
 * published @paperboycms/client `renderRichText` — the single source of truth for
 * the doc→HTML walk, which escapes text and restricts link/image URLs to safe
 * schemes (so a `data:`/`javascript:` href can't reach the DOM). A STRING (markdown
 * / plain-text fields — the delivery API returns markdown verbatim) is parsed with
 * marked and sanitised. Both branches yield trusted HTML, injected with innerHTML.
 */
function Rich({ doc, className }: { doc: unknown; className?: string }) {
  if (typeof doc === "string") {
    if (!doc.trim()) return null;
    const html = DOMPurify.sanitize(marked.parse(doc, { async: false }) as string);
    return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
  }
  const html = renderRichText(doc);
  if (!html) return null;
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** A richtext/markdown value with no rendered content — empty string, no doc,
 *  or a doc of only empty paragraphs (and no media). Such a field renders no
 *  DOM, so on-page editing needs a placeholder to give it a clickable target. */
function richIsEmpty(doc: unknown): boolean {
  if (doc == null) return true;
  if (typeof doc === "string") return !doc.trim();
  const text = (n: { text?: string; content?: unknown[] }): string =>
    typeof n?.text === "string" ? n.text : Array.isArray(n?.content) ? n.content.map((c) => text(c as never)).join("") : "";
  const hasMedia = (n: { type?: string; content?: unknown[] }): boolean => {
    if (n?.type && n.type !== "doc" && n.type !== "paragraph" && n.type !== "text") return true;
    return Array.isArray(n?.content) ? n.content.some((c) => hasMedia(c as never)) : false;
  };
  const d = doc as { type?: string; content?: unknown[] };
  return !text(d).trim() && !hasMedia(d);
}

/** A rich-text region marked for on-page editing. Empty + preview → a visible,
 *  clickable placeholder (the bridge outlines it and a click opens the on-page
 *  editor for the field). Empty + public → nothing. Only rendered when the
 *  field actually applies to this type (`applies`). */
function EditableRich({ field, label, value, className, preview, applies }: { field: string; label: string; value: unknown; className?: string; preview: boolean; applies: boolean }) {
  if (richIsEmpty(value)) {
    if (!preview || !applies) return null;
    return (
      <div
        {...pbField(field)}
        style={{ border: "1.5px dashed var(--pb-edit, #c8362f)", borderRadius: 8, padding: "1rem", opacity: 0.7, cursor: "pointer" }}
      >
        <span className="post-meta" style={{ margin: 0 }}>Empty {label} — click to write.</span>
      </div>
    );
  }
  return (
    <div {...pbField(field)}>
      <Rich doc={value} className={className} />
    </div>
  );
}

/* ----------------------------- blocks ----------------------------- */
// AreaBlock / blockData / contentAreas come from @paperboycms/client (shared,
// DOM-free delivery-consumption helpers).

/** ListBlock: a teaser list of a referenced page's children (async RSC), in the
 *  order delivery already applies — the container's declared child_sort. A
 *  child with no public path (unpublished ancestor) is not listed: a teaser
 *  always links, and there is nothing to link to. */
async function ListBlockTeasers({ d, locale, preview, edit }: { d: Record<string, unknown>; locale: string; preview: boolean; edit: Record<string, unknown> }) {
  const source = d.source as { documentId?: string } | null | undefined;
  const count = typeof d.count === "number" && d.count > 0 ? d.count : 3;
  const items = source?.documentId
    ? (await fetchList(null, locale, preview, source.documentId)).filter((p) => p.urlPath).slice(0, count)
    : [];
  return (
    <section className="block block--narrow" data-block="ListBlock" {...edit}>
      <h2>{asText(d.heading)}</h2>
      {items.length === 0 ? (
        <p className="post-meta">Nothing to list yet.</p>
      ) : (
        <ul className="post-list">
          {items.map((p) => {
            const pd = p.data as Record<string, unknown>;
            const date = fmtDate(pd.publishDate);
            return (
              <li key={p.documentId} className="card post-card">
                <a className="post-link" href={`/${locale}${p.urlPath}`}>
                  <h3>{asText(pd.title) || p.name}</h3>
                </a>
                {date ? <p className="post-meta">{date}</p> : null}
                {pd.summary ? <p className="post-summary">{asText(pd.summary)}</p> : null}
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
  // ATTR markers let the editor's preview map a click back to this block. Only
  // the attributes declared in @paperboycms/preview's ATTR contract — a former
  // "shared" marker was undeclared and read by nothing (L5).
  const edit = { [ATTR.blockIndex]: index, [ATTR.blockType]: b.blockType };
  if (b.blockType === "HeroBlock") {
    const img = d.heroImage as { url?: string; alt?: string } | null | undefined;
    // Two HeroBlock shapes exist: the seed's (title/subtitle/ctaUrl/heroImage) and
    // the built-in template's (heading/image/primaryLink). This follows the seed
    // and honours the template's primaryLink — a delivery-resolved {href, text}.
    const link = d.primaryLink as { href?: unknown; text?: unknown } | null | undefined;
    const cta = safeHref(asText(d.ctaUrl) || asText(link?.href));
    const href = cta?.startsWith("/") ? `/${locale}${cta}` : cta;
    return (
      <section className={`block block--full block--${b.display}`} data-block="HeroBlock" {...edit}>
        {img?.url ? <img className="hero-image" src={img.url} alt={img.alt ?? ""} loading="lazy" /> : null}
        {/* ATTR.field INSIDE a block: the preview bridge posts the field name
            plus the enclosing block index, and the editor opens its on-page
            overlay scoped to this block instance. */}
        <h2 {...pbField("title")}>{asText(d.title)}</h2>
        {d.subtitle ? <p {...pbField("subtitle")}>{asText(d.subtitle)}</p> : null}
        {href ? <a href={href}>{asText(link?.text) || "Learn more"}</a> : null}
      </section>
    );
  }
  if (b.blockType === "CardBlock") {
    return (
      <div className={`block card card--${b.display}`} data-block="CardBlock" {...edit}>
        <h3 {...pbField("title")}>{asText(d.title)}</h3>
        <div {...pbField("body")}>
          <Rich doc={d.body} className="richtext" />
        </div>
      </div>
    );
  }
  if (b.blockType === "ListBlock") {
    return <ListBlockTeasers d={d} locale={locale} preview={preview} edit={edit} />;
  }
  // A FORM referenced into the area. It must be a shared block: the submission
  // is posted against the form's own documentId, which only a document has.
  // The delivered `form` spec carries everything needed to draw it.
  if (b.shared && b.content?.type === "Form" && b.content.form && b.content.documentId) {
    // Read server-side per request, not in the client component: the image is
    // built without this NEXT_PUBLIC_ var (see .env.example), so Next never inlines it.
    return (
      <div className={`block block--${b.display}`} data-block="Form" {...edit}>
        <Form spec={b.content.form} formId={b.content.documentId} action={submitFormAction} turnstileSiteKey={process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY} />
      </div>
    );
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
        <h3>{asText(d.title) || c.name}</h3>
        {date ? <p className="post-meta">{date}</p> : null}
        {summary ? <p className="post-summary">{asText(summary)}</p> : <Rich doc={d.intro} className="post-summary" />}
      </a>
    );
  }
  return <div className="block card" data-block={b.blockType} {...edit}>Unknown block: {b.blockType}</div>;
}

/* ------------------------- standalone block preview ------------------------ */

/** The standalone route's body: the block alone, on a bare shell, rendered by
 *  the same Block component pages use inline (wrapping: lib/standalone-block). */
export function StandaloneBlock({ content, locale, preview }: { content: DeliveryContent; locale: string; preview: boolean }) {
  return (
    <main className="wrap" data-document-id={content.documentId}>
      <Block b={standaloneAreaBlock(content)} index={0} locale={locale} preview={preview} />
    </main>
  );
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
        <h1 className="page-heading" {...pbField("title")}>{asText(d.title) || content.name}</h1>
        {date ? <p className="post-meta">{date}</p> : null}
        {d.summary ? <p className="post-summary" {...pbField("summary")}>{asText(d.summary)}</p> : null}
        <div {...pbField("body")}><Rich doc={d.body} className="richtext post-body" /></div>
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
              <h3>{asText(d.title) || p.name}</h3>
            </a>
            {date ? <p className="post-meta">{date}</p> : null}
            {d.summary ? <p className="post-summary">{asText(d.summary)}</p> : null}
          </li>
        );
      })}
    </ul>
  );
}

export function Renderer({ content, posts, locale = DEFAULT_LOCALE, basePath = "", preview = false }: { content: DeliveryContent; posts?: DeliveryContent[]; locale?: string; basePath?: string; preview?: boolean }) {
  if (content.type === "BlogPost") return <BlogPostView content={content} />;

  const data = content.data as Record<string, unknown>;
  // Content areas, identified from the SCHEMA (fieldTypes) — the same discipline
  // the "applies" comment below describes. Passing fieldTypes is what makes an
  // area named anything (and an area that is currently empty) discoverable.
  // `mainArea` is preferred so an EMPTY area still surfaces a placeholder target
  // in preview; otherwise the first non-empty area renders.
  const areas = contentAreas(data, content.fieldTypes).sort((a, b) =>
    a.field === "mainArea" ? -1 : b.field === "mainArea" ? 1 : 0,
  );
  const picked = areas.find((a) => a.blocks.length > 0) ?? areas[0] ?? { field: "mainArea", blocks: [] as AreaBlock[] };
  const areaField = picked.field;
  const area = picked.blocks;
  return (
    <main className="wrap" data-document-id={content.documentId}>
      {/* "applies" comes from the SCHEMA (fieldTypes), not value presence: a
          field belongs to this type even when its value is empty/absent — and a
          type WITHOUT a heading field gets no heading marker at all. */}
      <h1 className="page-heading" {...("heading" in content.fieldTypes ? pbField("heading") : {})}>{asText(data.heading) || content.name}</h1>
      <EditableRich field="intro" label="intro" value={data.intro} className="intro richtext" preview={preview} applies={"intro" in content.fieldTypes} />
      <EditableRich field="body" label="body" value={data.body} className="richtext" preview={preview} applies={"body" in content.fieldTypes} />
      {area.length > 0 ? (
        // In preview the area gets an ATTR.area wrapper (via pbAreaAttrs) so
        // shared blocks / pages dragged from the admin can be dropped anywhere
        // on it; outside preview the helper emits nothing and the wrapper is a
        // plain div with no editor markers.
        preview ? (
          <div {...pbAreaAttrs(areaField, preview)}>
            {area.map((b, i) => <Block key={i} b={b} index={i} locale={locale} preview={preview} />)}
          </div>
        ) : (
          area.map((b, i) => <Block key={i} b={b} index={i} locale={locale} preview={preview} />)
        )
      ) : preview && areas.length > 0 ? (
        // Empty content area: render a visible, clickable target ONLY in preview
        // so on-page editing has somewhere to land. The ATTR.field marker lets
        // the bridge outline it and route the click to this field in the form
        // (where blocks are added / dropped). Never shown on the public page.
        <div
          {...pbAreaAttrs(areaField, preview)}
          {...pbField(areaField)}
          style={{ border: "2px dashed var(--pb-edit, #c8362f)", borderRadius: 8, padding: "2.5rem 1rem", textAlign: "center", opacity: 0.7, cursor: "pointer" }}
        >
          <p className="post-meta" style={{ margin: 0 }}>This area is empty — click to open the block palette.</p>
        </div>
      ) : null}
      {posts && posts.length > 0 ? <PostList posts={posts} locale={locale} basePath={basePath} /> : null}
    </main>
  );
}
