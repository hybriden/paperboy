import { z } from "zod";

/**
 * Public-files support: robots.txt, sitemap.xml, llms.txt and security.txt.
 *
 * Paperboy is headless, so these files are SERVED from the frontend's origin —
 * but generated HERE from CMS content and per-site config, so they never go
 * stale when content is published (a build-time sitemap misses everything
 * published after the last frontend deploy). The delivery API exposes them as
 * ready-made text (GET /delivery/{robots.txt,sitemap.xml,llms.txt,security.txt});
 * a frontend proxies each path through — apps/web is the reference.
 *
 * These builders are PURE (no I/O) so the exact file contents are unit-testable.
 * URL convention: `${canonicalBaseUrl}/${locale}${urlPath}` — the reference
 * frontend's locale-prefixed scheme. A frontend with different URLs builds its
 * own files from GET /delivery/pages instead.
 */

/** Editor-controlled file config, stored per site (site.seo_files). */
export const SeoFilesConfig = z.object({
  /** Extra robots.txt directives appended verbatim (e.g. AI-crawler rules). */
  robotsExtra: z.string().max(4000).optional(),
  /** llms.txt blockquote summary (llmstxt.org: the line under the H1). */
  llmsSummary: z.string().max(2000).optional(),
  /** Full llms.txt override (markdown) — when set, generation is skipped. */
  llmsOverride: z.string().max(20000).optional(),
  /** RFC 9116 Contact — mailto:/https: URI (a bare email is normalized). */
  securityContact: z.string().max(300).optional(),
  /** RFC 9116 Policy URL (optional). */
  securityPolicyUrl: z.string().max(300).optional(),
  /** RFC 9116 Preferred-Languages, comma-separated (optional, e.g. "en, no"). */
  securityLanguages: z.string().max(100).optional(),
});
export type SeoFilesConfig = z.infer<typeof SeoFilesConfig>;

/** Tolerant read of the stored jsonb — unknown keys dropped, bad shapes → {}. */
export function parseSeoFilesConfig(raw: unknown): SeoFilesConfig {
  const parsed = SeoFilesConfig.safeParse(raw ?? {});
  return parsed.success ? parsed.data : {};
}

/** One (page, locale) row of the public page inventory (GET /delivery/pages). */
export interface PublicPageEntry {
  documentId: string;
  type: string;
  name: string;
  locale: string;
  urlPath: string;
  /** ISO timestamp of the delivered version (sitemap <lastmod>). */
  lastmod: string;
  /** Page opted out of indexing (reserved SEO group) — excluded from sitemap/llms. */
  noIndex: boolean;
  /** Short description for llms.txt (teaser text → meta description → summary/intro). */
  description?: string;
}

const stripTrailingSlash = (u: string) => u.trim().replace(/\/+$/, "");
const xmlEscape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** Absolute page URL under the reference frontend's locale-prefixed scheme. */
export function publicPageUrl(canonicalBaseUrl: string, locale: string, urlPath: string): string {
  return `${stripTrailingSlash(canonicalBaseUrl)}/${locale}${urlPath === "/" ? "" : urlPath}`;
}

/** robots.txt: default-allow, editor extras, sitemap pointer (absolute URLs only). */
export function buildRobotsTxt(opts: { canonicalBaseUrl?: string | null; robotsExtra?: string }): string {
  const lines = ["User-agent: *", "Allow: /"];
  const extra = opts.robotsExtra?.trim();
  if (extra) lines.push("", extra);
  if (opts.canonicalBaseUrl) lines.push("", `Sitemap: ${stripTrailingSlash(opts.canonicalBaseUrl)}/sitemap.xml`);
  return `${lines.join("\n")}\n`;
}

/**
 * sitemap.xml from the indexable page inventory. One <url> per (page, locale);
 * pages living in several locales carry xhtml:link hreflang alternates (incl.
 * self, per the sitemap spec). noIndex pages are EXCLUDED — robots/sitemaps
 * must never advertise paths the page itself asks crawlers to ignore.
 */
export function buildSitemapXml(pages: PublicPageEntry[], canonicalBaseUrl: string): string {
  const indexable = pages.filter((p) => !p.noIndex);
  const byDoc = new Map<string, PublicPageEntry[]>();
  for (const p of indexable) {
    const list = byDoc.get(p.documentId) ?? [];
    list.push(p);
    byDoc.set(p.documentId, list);
  }
  const urls: string[] = [];
  for (const p of indexable) {
    const loc = xmlEscape(publicPageUrl(canonicalBaseUrl, p.locale, p.urlPath));
    const siblings = byDoc.get(p.documentId)!;
    const alternates =
      siblings.length > 1
        ? siblings
            .map(
              (s) =>
                `    <xhtml:link rel="alternate" hreflang="${xmlEscape(s.locale)}" href="${xmlEscape(publicPageUrl(canonicalBaseUrl, s.locale, s.urlPath))}"/>`,
            )
            .join("\n")
        : "";
    urls.push(
      [
        "  <url>",
        `    <loc>${loc}</loc>`,
        `    <lastmod>${xmlEscape(p.lastmod)}</lastmod>`,
        alternates,
        "  </url>",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ...urls,
    "</urlset>",
    "",
  ].join("\n");
}

/**
 * llms.txt (llmstxt.org): H1 site name, optional blockquote summary, then the
 * indexable pages of the DEFAULT locale as a markdown link list with short
 * descriptions. An editor override (full markdown) wins outright.
 */
export function buildLlmsTxt(opts: {
  siteName: string;
  canonicalBaseUrl: string;
  defaultLocale: string;
  pages: PublicPageEntry[];
  summary?: string;
  override?: string;
}): string {
  const override = opts.override?.trim();
  if (override) return `${override}\n`;
  const lines = [`# ${opts.siteName}`];
  const summary = opts.summary?.trim();
  if (summary) lines.push("", `> ${summary.replace(/\s+/g, " ")}`);
  const pages = opts.pages.filter((p) => !p.noIndex && p.locale === opts.defaultLocale);
  if (pages.length) {
    lines.push("", "## Pages", "");
    for (const p of pages) {
      const url = publicPageUrl(opts.canonicalBaseUrl, p.locale, p.urlPath);
      const desc = p.description?.trim();
      lines.push(`- [${p.name}](${url})${desc ? `: ${desc}` : ""}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** A bare email is unambiguously a mailto: contact (RFC 9116 wants a URI). */
function normalizeContact(contact: string): string {
  const c = contact.trim();
  return /^[a-z][a-z0-9+.-]*:/i.test(c) ? c : c.includes("@") ? `mailto:${c}` : c;
}

/** How long a generated security.txt stays valid. The file is regenerated on
 *  every request, so a rolling window keeps Expires honest with zero upkeep
 *  (RFC 9116 requires Expires and recommends < 1 year). */
export const SECURITY_TXT_VALIDITY_DAYS = 180;

/** security.txt (RFC 9116). Returns null when no Contact is configured —
 *  Contact is the one REQUIRED field, and serving a file without it is invalid. */
export function buildSecurityTxt(
  opts: { securityContact?: string; securityPolicyUrl?: string; securityLanguages?: string; canonicalBaseUrl?: string | null },
  now: Date = new Date(),
): string | null {
  const contact = opts.securityContact?.trim();
  if (!contact) return null;
  const expires = new Date(now.getTime() + SECURITY_TXT_VALIDITY_DAYS * 24 * 60 * 60 * 1000);
  const lines = [`Contact: ${normalizeContact(contact)}`, `Expires: ${expires.toISOString()}`];
  if (opts.securityPolicyUrl?.trim()) lines.push(`Policy: ${opts.securityPolicyUrl.trim()}`);
  if (opts.securityLanguages?.trim()) lines.push(`Preferred-Languages: ${opts.securityLanguages.trim()}`);
  if (opts.canonicalBaseUrl) lines.push(`Canonical: ${stripTrailingSlash(opts.canonicalBaseUrl)}/.well-known/security.txt`);
  return `${lines.join("\n")}\n`;
}
