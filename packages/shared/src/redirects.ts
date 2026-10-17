import { z } from "zod";

/**
 * Redirects: the pure half (no I/O) — path normalization, the delivered
 * manifest's shape, and the matcher a frontend runs against it. The CMS stores
 * the rules (packages/db/src/redirects.ts); the frontend applies them, and only
 * where no published page answers the request. docs/plans/2026-10-15-redirects.md has the why.
 *
 * `@paperboycms/client` ships its own copy of `matchRedirect` (it is published
 * and dependency-free); `client-redirects.test.ts` pins the two together, the
 * same arrangement as the preview-token pair.
 */

export const REDIRECT_STATUSES = [301, 302, 307, 308, 410] as const;
export type RedirectStatus = (typeof REDIRECT_STATUSES)[number];
export const RedirectOrigin = z.enum(["manual", "auto", "import"]);
export type RedirectOrigin = z.infer<typeof RedirectOrigin>;

/** How a frontend prefixes locales in its URLs (site.locale_prefix). */
export const LocalePrefix = z.enum(["always", "except-default"]);
export type LocalePrefix = z.infer<typeof LocalePrefix>;

export interface SiteUrlScheme {
  localePrefix: LocalePrefix;
  defaultLocale: string;
}

/** The path a visitor requests for a page: "/nb/om-oss", or "/om-oss" for the
 *  default locale under 'except-default'. A start page's urlPath is "/". */
export function sitePath(urlPath: string, locale: string, scheme: SiteUrlScheme): string {
  const path = urlPath === "/" ? "" : urlPath;
  if (scheme.localePrefix === "except-default" && locale === scheme.defaultLocale) return path || "/";
  return `/${locale}${path}`;
}

/** The inverse of sitePath: which (locale, urlPath) a requested path names, or
 *  null when it can't be a page path under this scheme. */
export function splitSitePath(path: string, scheme: SiteUrlScheme, locales: string[]): { locale: string; urlPath: string } | null {
  const first = path.split("/")[1] ?? "";
  if (locales.includes(first)) {
    const rest = path.slice(first.length + 1) || "/";
    // Under 'except-default' the default locale is never prefixed: /nb/x is not a page path.
    if (scheme.localePrefix === "except-default" && first === scheme.defaultLocale) return null;
    return { locale: first, urlPath: rest };
  }
  return scheme.localePrefix === "except-default" ? { locale: scheme.defaultLocale, urlPath: path } : null;
}

/**
 * The canonical form every source path is stored and matched in: decoded,
 * lowercase, one leading slash, no trailing slash (except "/"), no duplicate
 * slashes, no query or fragment. "/Om-Oss/" and "/om-oss" are the same rule.
 */
export function normalizePath(raw: string): string {
  let path = raw.split(/[?#]/)[0] ?? "";
  try {
    path = decodeURIComponent(path);
  } catch {
    /* a malformed escape is matched as written */
  }
  path = `/${path}`.replace(/\/{2,}/g, "/").toLowerCase();
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/**
 * A source as an editor types it: a path ("/old-page/"), a prefix ("/blog/*")
 * or a full URL on the old site ("https://www.example.com/old/"), which is
 * reduced to its path. Returns a self-teaching error instead of guessing.
 */
export function parseRedirectSource(raw: string): { path: string; match: "exact" | "prefix" } | { error: string } {
  let input = raw.trim();
  if (!input) return { error: 'Source is required — a path like "/old-page" or a prefix like "/blog/*".' };
  if (/^https?:\/\//i.test(input)) {
    try {
      const url = new URL(input);
      if (url.search) return { error: `Source "${raw}" has a query string. Sources match the path only — drop "${url.search}" (Keep query on the rule passes it along).` };
      input = url.pathname;
    } catch {
      return { error: `Source "${raw}" is not a valid URL.` };
    }
  }
  if (!input.startsWith("/")) return { error: `Source "${raw}" must start with "/", e.g. "/${input}".` };
  if (/[?#]/.test(input)) return { error: `Source "${raw}" has a query string or fragment. Sources match the path only — drop everything from "?" or "#".` };
  let match: "exact" | "prefix" = "exact";
  if (input.endsWith("/*")) {
    match = "prefix";
    input = input.slice(0, -2) || "/";
  }
  if (input.includes("*")) return { error: `Source "${raw}" uses "*" in the middle. Only a trailing "/*" (everything under a path) is supported.` };
  const path = normalizePath(input);
  if (match === "prefix" && path === "/") return { error: 'A prefix rule on "/*" would redirect the whole site. Name a section, e.g. "/blog/*".' };
  return { path, match };
}

/** "/blog/*" for a prefix rule, the path itself otherwise — how a source is shown and exported. */
export function formatRedirectSource(path: string, match: "exact" | "prefix"): string {
  return match === "prefix" ? `${path === "/" ? "" : path}/*` : path;
}

/** A target as typed: an internal path, or an absolute http(s) URL. */
export function parseRedirectTarget(raw: string): { path: string } | { url: string } | { error: string } {
  const input = raw.trim();
  if (!input) return { error: "Target is required (or use status 410 Gone for a page that is gone for good)." };
  if (/^https?:\/\//i.test(input)) {
    try {
      return { url: new URL(input).toString() };
    } catch {
      return { error: `Target "${raw}" is not a valid URL.` };
    }
  }
  if (!input.startsWith("/")) return { error: `Target "${raw}" must be a path starting with "/" or a full https:// URL.` };
  if (input.startsWith("//")) return { error: `Target "${raw}" starts with "//", which browsers read as another site. Use a full https:// URL for an external target.` };
  return { path: input };
}

/** One rule as delivered to a frontend. `to` is already the live URL (page
 *  targets resolved); null for 410 Gone. */
export interface RedirectManifestRule {
  id: number;
  from: string;
  match: "exact" | "prefix";
  to: string | null;
  status: RedirectStatus;
  keepQuery: boolean;
}

/** GET /delivery/redirects. Rules apply only where no published page answers. */
export interface RedirectManifest {
  version: 1;
  rules: RedirectManifestRule[];
}

export interface RedirectMatch {
  rule: RedirectManifestRule;
  status: RedirectStatus;
  /** Where to send the visitor (null for 410). Relative to the site unless the rule targets another site. */
  location: string | null;
}

/**
 * The rule a request path (+ optional query) hits, or null. Exact rules win;
 * then the longest matching prefix. A prefix rule carries the rest of the path
 * over ("/blog/*" → "/artikler" sends "/blog/a/b" to "/artikler/a/b").
 */
export function matchRedirect(manifest: RedirectManifest, requestPath: string): RedirectMatch | null {
  const [rawPath = "", ...q] = requestPath.split("?");
  const query = q.join("?").split("#")[0] ?? "";
  const path = normalizePath(rawPath);
  let hit: RedirectManifestRule | undefined;
  let suffix = "";
  for (const rule of manifest.rules) {
    if (rule.match === "exact" && rule.from === path) {
      hit = rule;
      suffix = "";
      break;
    }
  }
  if (!hit) {
    for (const rule of manifest.rules) {
      if (rule.match !== "prefix") continue;
      const base = rule.from === "/" ? "" : rule.from;
      if ((path === rule.from || path.startsWith(`${base}/`)) && (!hit || rule.from.length > hit.from.length)) {
        hit = rule;
        suffix = path.slice(base.length);
      }
    }
  }
  if (!hit) return null;
  if (hit.to === null) return { rule: hit, status: hit.status, location: null };
  let location = suffix && suffix !== "/" ? `${hit.to.replace(/\/+$/, "")}${suffix}` : hit.to;
  if (hit.keepQuery && query) location += `${location.includes("?") ? "&" : "?"}${query}`;
  return { rule: hit, status: hit.status, location };
}

/**
 * Paths not worth logging as 404s: vulnerability scanners probing for other
 * platforms. Their volume would bury the real broken links. Old-site media
 * (/wp-content/uploads/...) is NOT noise — it is often linked from elsewhere.
 */
export function isNoise404(path: string): boolean {
  return (
    /\.(php\d?|aspx?|jsp|cgi|env|ini|sql|bak|old|swp|log|git)$/i.test(path) ||
    /^\/(wp-admin|wp-login|wp-includes|xmlrpc|\.git|\.env|\.well-known\/(?!security\.txt)|cgi-bin|phpmyadmin|vendor|admin\.php)/i.test(path) ||
    path.length > 400
  );
}

/* ------------------------------ CSV ------------------------------------- */

export const REDIRECT_CSV_COLUMNS = ["source", "target", "status", "keepQuery", "note"] as const;

/** RFC 4180 CSV → rows (quoted fields, escaped quotes, CRLF/LF). Comma or semicolon separated. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const sep = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}

/** Rows → CSV, quoting only where needed. A leading =+-@ is prefixed with ' so
 *  a spreadsheet never evaluates a cell as a formula. */
export function toCsv(rows: (string | number | boolean | null | undefined)[][]): string {
  const cell = (v: string | number | boolean | null | undefined) => {
    let s = v == null ? "" : String(v);
    if (/^[=+\-@]/.test(s)) s = `'${s}`;
    return /[",\r\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `${rows.map((r) => r.map(cell).join(",")).join("\r\n")}\r\n`;
}
