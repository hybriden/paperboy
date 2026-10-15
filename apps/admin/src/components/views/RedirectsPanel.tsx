import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import {
  api,
  type NotFoundRow,
  type RedirectImportResult,
  type RedirectInput,
  type RedirectRule,
  type RedirectStatus,
  type RedirectTestResult,
} from "../../lib/api.js";
import { Icon } from "../../lib/icons.js";
import { relativeTime } from "../../lib/relative-time.js";
import { useUser } from "../../lib/user.js";
import { PagePicker } from "../fields/LinkField.js";
import { Badge } from "../ui/badge.js";
import { Callout } from "../ui/callout.js";
import { useConfirm } from "../ui/confirm.js";
import { Dialog, DialogContent } from "../ui/dialog.js";
import { EmptyState } from "../ui/empty-state.js";
import { Surface } from "../ui/surface.js";
import { Switch } from "../ui/switch.js";
import { useToast } from "../ui/toast.js";

/**
 * Settings → Redirects, for the active site.
 *
 * Built to answer three questions at a glance: what redirects where (the rule
 * list, with each page target's LIVE url), is it right (problems inline on the
 * row, plus "Test a URL" that follows any address hop by hop), and is it used
 * (hits + last hit, and the 404 log for what still breaks). Rules fire only
 * where no published page answers, so nothing here can hide a live page.
 */

const STATUS_LABEL: Record<RedirectStatus, string> = {
  301: "301 Permanent",
  308: "308 Permanent",
  302: "302 Temporary",
  307: "307 Temporary",
  410: "410 Gone",
};
const ORIGIN_LABEL = { manual: "manual", auto: "automatic", import: "imported" } as const;
const YEAR_MS = 365 * 24 * 3600 * 1000;

type Filter = "all" | "problems" | "auto" | "manual" | "import" | "unused";

/** No visit in a year (or never, and older than a year): Google's minimum keep time has passed. */
function isUnused(r: RedirectRule, now: number): boolean {
  return now - new Date(r.lastHitAt ?? r.createdAt).getTime() > YEAR_MS;
}

function TargetCell({ rule }: { rule: RedirectRule }) {
  const t = rule.target;
  if (t.kind === "gone") return <span className="text-muted">Gone — nothing to show</span>;
  if (t.kind === "url") return <span className="break-all font-mono text-xs">{t.url}</span>;
  if (t.kind === "path") return <span className="break-all font-mono text-xs">{t.path}</span>;
  return (
    <span className="flex min-w-0 flex-col">
      <span className="truncate text-fg">
        <Icon.File width={12} height={12} className="mr-1 inline align-[-1px] text-muted" />
        {t.name ?? "(missing page)"}
      </span>
      <span className="break-all font-mono text-[11px] text-muted">{t.url ?? "not published"}</span>
    </span>
  );
}

function TestBox() {
  const [url, setUrl] = useState("");
  const [result, setResult] = useState<{ url: string; data: RedirectTestResult } | null>(null);
  const run = useMutation({
    mutationFn: (u: string) => api.testRedirect(u),
    onSuccess: (data, u) => setResult({ url: u, data }),
  });
  const last = result?.data.steps.at(-1);
  const verdict = !result || !last
    ? null
    : last.result === "page" && result.data.hops === 0
      ? { tone: "positive" as const, text: "A published page answers this URL — no redirect needed." }
      : last.result === "page" || last.result === "external"
        ? { tone: result.data.hops > 1 ? ("caution" as const) : ("positive" as const), text: result.data.hops > 1 ? `Ends on a page, but in ${result.data.hops} hops — point the first rule straight at the final URL.` : "Ends on a page in one hop." }
        : last.result === "gone"
          ? { tone: "default" as const, text: "Answers 410 Gone." }
          : last.result === "loop"
            ? { tone: "critical" as const, text: "Redirect loop — the URL comes back to itself." }
            : { tone: "critical" as const, text: result.data.hops ? "Redirects to a URL nothing answers (404)." : "Nothing answers this URL — visitors get a 404." };
  return (
    <div className="flex flex-col gap-2 border-b border-line p-3">
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (url.trim()) run.mutate(url.trim()); }}>
        <label className="sr-only" htmlFor="redirect-test">Test a URL</label>
        <input id="redirect-test" className="field-input font-mono text-xs" placeholder="Test a URL — /old-page or https://www.example.com/old-page" value={url} onChange={(e) => setUrl(e.target.value)} />
        <button className="btn-subtle shrink-0 px-3 text-xs" disabled={run.isPending || !url.trim()}>Test</button>
      </form>
      {run.isError && <p className="text-xs text-danger">{(run.error as Error).message}</p>}
      {result && verdict && (
        <div className="flex flex-col gap-1.5 text-xs" aria-live="polite">
          <ol className="flex flex-wrap items-center gap-1.5">
            {result.data.steps.map((s, i) => (
              <li key={i} className="flex items-center gap-1.5">
                <code className="rounded bg-line/60 px-1.5 py-0.5">{s.path}</code>
                {s.status && <Badge tone={s.status === 410 ? "default" : "primary"}>{s.status}</Badge>}
                {s.result === "external" && <><span aria-hidden>→</span><code className="rounded bg-line/60 px-1.5 py-0.5">{s.location}</code></>}
                {s.result === "redirect" && <span aria-hidden>→</span>}
                {s.result === "page" && <Badge tone="positive">page</Badge>}
                {s.result === "not-found" && <Badge tone="critical">404</Badge>}
              </li>
            ))}
          </ol>
          <Badge tone={verdict.tone} className="self-start">{verdict.text}</Badge>
        </div>
      )}
    </div>
  );
}

function RuleDialog({ rule, initialSource, onClose }: { rule: RedirectRule | null; initialSource?: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const pages = useQuery({ queryKey: ["pages"], queryFn: ({ signal }) => api.pages(signal) });
  const locales = useQuery({ queryKey: ["locales", "enabled"], queryFn: ({ signal }) => api.locales(signal) });
  const t = rule?.target;
  const [source, setSource] = useState(rule?.source ?? initialSource ?? "");
  const [mode, setMode] = useState<"page" | "path" | "gone">(t?.kind === "page" || !t ? "page" : t.kind === "gone" ? "gone" : "path");
  const [documentId, setDocumentId] = useState(t?.kind === "page" ? t.documentId : "");
  const [targetLocale, setTargetLocale] = useState(t?.kind === "page" ? t.locale : "");
  const [path, setPath] = useState(t?.kind === "path" ? t.path : t?.kind === "url" ? t.url : "");
  const [status, setStatus] = useState<RedirectStatus>(rule?.status && rule.status !== 410 ? rule.status : 301);
  const [keepQuery, setKeepQuery] = useState(rule?.keepQuery ?? true);
  const [note, setNote] = useState(rule?.note ?? "");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState("");
  const pickRef = useRef<HTMLButtonElement>(null);
  const pageName = pages.data?.find((p) => p.documentId === documentId)?.name ?? (t?.kind === "page" ? t.name : null);

  const save = useMutation({
    mutationFn: () => {
      const body: RedirectInput = {
        source: source.trim(),
        status: mode === "gone" ? 410 : status,
        keepQuery,
        note: note.trim() || null,
        ...(mode === "page" ? { targetDocumentId: documentId, targetLocale: targetLocale || null, target: null } : mode === "path" ? { target: path.trim(), targetDocumentId: null } : { target: null, targetDocumentId: null }),
      };
      return rule ? api.updateRedirect(rule.id, body) : api.createRedirect(body);
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["redirects"] });
      void qc.invalidateQueries({ queryKey: ["not-found"] });
      const extra = [r.collapsed && "the target was itself redirected, so it now points at the final destination", r.repointed > 0 && `${r.repointed} rule${r.repointed === 1 ? "" : "s"} that pointed here now skip the extra hop`].filter(Boolean).join("; ");
      toast.success(rule ? "Redirect updated" : "Redirect created", extra || r.redirect.source);
      onClose();
    },
    onError: (e) => setError((e as Error).message),
  });
  const valid = source.trim() && (mode === "gone" || (mode === "page" ? !!documentId : !!path.trim()));

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={rule ? "Edit redirect" : "New redirect"} description="Applies only where no published page answers the source." size="lg">
        <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); if (valid) save.mutate(); }}>
          <label className="text-sm">
            <span className="field-label">From</span>
            <input className="field-input font-mono text-xs" value={source} placeholder="/old-page   or   /old-section/*   or   https://old-site.com/page" onChange={(e) => setSource(e.target.value)} />
            <span className="mt-1 block text-xs text-muted">Case and a trailing slash don’t matter. End with <code>/*</code> to redirect everything under a path — the rest of the path is carried over.</span>
          </label>

          <fieldset className="text-sm">
            <legend className="field-label">To</legend>
            <div className="mb-2 flex gap-1" role="radiogroup" aria-label="Target kind">
              {([["page", "A page"], ["path", "Path or URL"], ["gone", "Gone (410)"]] as const).map(([k, label]) => (
                <button key={k} type="button" role="radio" aria-checked={mode === k} className={`rounded-full px-3 py-1 text-xs ${mode === k ? "bg-accent text-white" : "bg-line/60 text-fg hover:bg-line"}`} onClick={() => setMode(k)}>{label}</button>
              ))}
            </div>
            {mode === "page" && (
              <div className="relative flex flex-wrap items-center gap-2">
                <button ref={pickRef} type="button" className="field-input flex min-w-60 flex-1 items-center justify-between text-left" onClick={() => setPickerOpen(true)}>
                  <span className={pageName ? "text-fg" : "text-muted"}>{pageName ?? "Choose a page…"}</span>
                  <span className="shrink-0 rounded bg-published/15 px-1.5 py-0.5 text-[11px] text-fg">follows the page</span>
                </button>
                {(locales.data?.length ?? 0) > 1 && (
                  <select aria-label="Language version" className="field-input w-auto" value={targetLocale} onChange={(e) => setTargetLocale(e.target.value)}>
                    <option value="">site default language</option>
                    {locales.data!.map((l) => <option key={l.code} value={l.code}>{l.displayName}</option>)}
                  </select>
                )}
                {pickerOpen && (
                  <PagePicker
                    pages={pages.data ?? []}
                    onPick={(id) => { setDocumentId(id); setPickerOpen(false); pickRef.current?.focus(); }}
                    onClose={() => { setPickerOpen(false); pickRef.current?.focus(); }}
                  />
                )}
                <span className="block w-full text-xs text-muted">Recommended: if the page moves later, the redirect follows it — no chains.</span>
              </div>
            )}
            {mode === "path" && (
              <>
                <input aria-label="Target path or URL" className="field-input font-mono text-xs" value={path} placeholder="/new-page   or   https://other-site.com/page" onChange={(e) => setPath(e.target.value)} />
                <span className="mt-1 block text-xs text-muted">A path that a published page answers is saved as that page.</span>
              </>
            )}
            {mode === "gone" && <p className="text-xs text-muted">Tells search engines the page is gone for good and won’t come back. Prefer a redirect to the closest page if there is one — that keeps the link value.</p>}
          </fieldset>

          {mode !== "gone" && (
            <div className="flex flex-wrap items-end gap-4">
              <label className="text-sm">
                <span className="field-label">Type</span>
                <select className="field-input" value={status} onChange={(e) => setStatus(Number(e.target.value) as RedirectStatus)}>
                  <option value={301}>301 Permanent (recommended)</option>
                  <option value={308}>308 Permanent, keeps method</option>
                  <option value={302}>302 Temporary</option>
                  <option value={307}>307 Temporary, keeps method</option>
                </select>
              </label>
              <div className="pb-2">
                <Switch checked={keepQuery} onCheckedChange={setKeepQuery} label="Keep query string (?utm_… carried along)" />
              </div>
            </div>
          )}
          {mode !== "gone" && (status === 302 || status === 307) && (
            <Callout tone="caution">A temporary redirect does not move the old URL’s ranking to the new one. Use 301 for a page that has moved for good.</Callout>
          )}

          <label className="text-sm">
            <span className="field-label">Note <span className="text-muted">(optional)</span></span>
            <input className="field-input" value={note} placeholder="Why this redirect exists" onChange={(e) => setNote(e.target.value)} />
          </label>

          {error && <p className="text-xs text-danger" role="alert">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
            <button className="btn-primary" disabled={!valid || save.isPending}>{rule ? "Save" : "Create redirect"}</button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ImportDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [csv, setCsv] = useState("");
  const [preview, setPreview] = useState<RedirectImportResult | null>(null);
  const run = useMutation({
    mutationFn: (dryRun: boolean) => api.importRedirects(csv, dryRun),
    onSuccess: (r, dryRun) => {
      if (dryRun) return setPreview(r);
      void qc.invalidateQueries({ queryKey: ["redirects"] });
      toast.success("Redirects imported", `${r.created} created, ${r.updated} updated${r.errors ? `, ${r.errors} skipped` : ""}`);
      onClose();
    },
    onError: (e) => toast.error("Couldn’t import", (e as Error).message),
  });
  const ready = preview && preview.created + preview.updated > 0;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Import redirects" description="CSV with the columns source, target, and optionally status, keepQuery, note. Existing sources are updated, never duplicated." size="xl">
        <div className="flex flex-col gap-3">
          <input
            type="file"
            accept=".csv,text/csv,text/plain"
            aria-label="CSV file"
            className="text-xs"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void f.text().then((t) => { setCsv(t); setPreview(null); }); }}
          />
          <textarea aria-label="CSV" className="field-textarea font-mono text-xs" rows={6} placeholder={"source,target,status\n/old-page/,/new-page,301\n/old-section/*,/new-section,301\n/discontinued,,410"} value={csv} onChange={(e) => { setCsv(e.target.value); setPreview(null); }} />
          {preview && (
            <div className="max-h-72 overflow-auto rounded-(--radius) border border-line">
              <p className="sticky top-0 border-b border-line bg-panel px-3 py-2 text-xs">
                <strong>{preview.created}</strong> new · <strong>{preview.updated}</strong> updated · <strong className={preview.errors ? "text-danger" : ""}>{preview.errors}</strong> with errors (skipped)
              </p>
              <table className="w-full text-xs">
                <tbody>
                  {preview.rows.map((r) => (
                    <tr key={r.line} className="border-b border-line last:border-0">
                      <td className="px-2 py-1 text-muted">{r.line}</td>
                      <td className="px-2 py-1 font-mono">{r.source}</td>
                      <td className="px-2 py-1 font-mono">{r.target || "—"}</td>
                      <td className="px-2 py-1">
                        <Badge tone={r.action === "error" ? "critical" : r.action === "create" ? "positive" : r.action === "update" ? "primary" : "default"}>{r.action}</Badge>
                        {r.message && <span className="ml-1 text-danger">{r.message}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
            {!preview ? (
              <button type="button" className="btn-primary" disabled={!csv.trim() || run.isPending} onClick={() => run.mutate(true)}>Preview</button>
            ) : (
              <button type="button" className="btn-primary" disabled={!ready || run.isPending} onClick={() => run.mutate(false)}>
                Import {preview.created + preview.updated} rule{preview.created + preview.updated === 1 ? "" : "s"}
              </button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function NotFoundList({ canWrite, onCreate }: { canWrite: boolean; onCreate: (path: string) => void }) {
  const qc = useQueryClient();
  const [showCovered, setShowCovered] = useState(false);
  const rows = useQuery({ queryKey: ["not-found"], queryFn: ({ signal }) => api.notFound(signal) });
  const dismiss = useMutation({
    mutationFn: (paths: string[]) => api.dismissNotFound(paths),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["not-found"] }),
  });
  const all = rows.data ?? [];
  const visible = all.filter((r) => showCovered || r.coveredBy === null);
  const covered = all.length - all.filter((r) => r.coveredBy === null).length;
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2 text-xs text-muted">
        <span>Paths visitors (and crawlers) got a 404 for, reported by the frontend. Path only — no query string, no IP. Kept 90 days.</span>
        {covered > 0 && (
          <Switch checked={showCovered} onCheckedChange={setShowCovered} label={`Show ${covered} now covered by a rule`} />
        )}
      </div>
      {visible.map((r: NotFoundRow) => (
        <div key={r.path} className="flex items-center gap-3 border-b border-line px-3 py-2 text-sm last:border-0">
          <code className="min-w-0 flex-1 break-all text-xs">{r.path}</code>
          <span className="tnum shrink-0 text-xs text-muted" title={`First seen ${new Date(r.firstSeen).toLocaleString()}`}>{r.hits} × · {relativeTime(r.lastSeen)}</span>
          {r.coveredBy !== null ? (
            <Badge tone="positive">covered</Badge>
          ) : (
            canWrite && (
              <span className="flex shrink-0 gap-1">
                <button className="rounded px-2 py-0.5 text-xs text-accent-700 hover:bg-accent/10" onClick={() => onCreate(r.path)}>Create redirect</button>
                <button className="rounded px-2 py-0.5 text-xs text-muted hover:bg-line/60" onClick={() => dismiss.mutate([r.path])}>Dismiss</button>
              </span>
            )
          )}
        </div>
      ))}
      {rows.isSuccess && visible.length === 0 && (
        <EmptyState title="No broken links reported">
          Your frontend reports 404s with <code>reportTraffic()</code> from <code>@paperboycms/client</code>. Nothing here means none were reported, or the frontend doesn’t report yet.
        </EmptyState>
      )}
    </div>
  );
}

export function RedirectsPanel() {
  const { user } = useUser();
  const canWrite = user.permissions.includes("content.publish");
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const rules = useQuery({ queryKey: ["redirects"], queryFn: ({ signal }) => api.redirects(signal) });
  const notFound = useQuery({ queryKey: ["not-found"], queryFn: ({ signal }) => api.notFound(signal) });
  const [tab, setTab] = useState<"rules" | "404">("rules");
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<{ rule: RedirectRule | null; source?: string } | null>(null);
  const [importing, setImporting] = useState(false);

  const del = useMutation({
    mutationFn: (ids: number[]) => api.deleteRedirects(ids),
    onSuccess: (r) => { setSelected(new Set()); void qc.invalidateQueries({ queryKey: ["redirects"] }); toast.success(`${r.deleted} redirect${r.deleted === 1 ? "" : "s"} deleted`); },
    onError: (e) => toast.error("Couldn’t delete", (e as Error).message),
  });
  const exportCsv = async () => {
    try {
      const csv = await api.redirectsCsv();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
      a.download = "redirects.csv";
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      toast.error("Couldn’t export", (e as Error).message);
    }
  };

  const all = useMemo(() => rules.data ?? [], [rules.data]);
  // "Unused for a year" is judged against when the panel opened, not re-read every render.
  const [now] = useState(() => Date.now());
  const counts = {
    all: all.length,
    problems: all.filter((r) => r.problems.length).length,
    auto: all.filter((r) => r.origin === "auto").length,
    manual: all.filter((r) => r.origin === "manual").length,
    import: all.filter((r) => r.origin === "import").length,
    unused: all.filter((r) => isUnused(r, now)).length,
  };
  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return all.filter((r) => {
      if (filter === "problems" && !r.problems.length) return false;
      if ((filter === "auto" || filter === "manual" || filter === "import") && r.origin !== filter) return false;
      if (filter === "unused" && !isUnused(r, now)) return false;
      if (!needle) return true;
      const t = r.target;
      const hay = [r.source, r.note ?? "", t.kind === "page" ? `${t.name ?? ""} ${t.url ?? ""}` : t.kind === "path" ? t.path : t.kind === "url" ? t.url : "gone"].join(" ").toLowerCase();
      return hay.includes(needle);
    });
  }, [all, q, filter, now]);
  const allVisibleSelected = visible.length > 0 && visible.every((r) => selected.has(r.id));
  const toggle = (id: number) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const FILTERS: [Filter, string][] = [["all", "All"], ["problems", "Problems"], ["auto", "Automatic"], ["manual", "Manual"], ["import", "Imported"], ["unused", "Unused 12 mo"]];

  return (
    <section className="mb-8">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xs font-bold uppercase tracking-wide text-muted">Redirects</h2>
        {canWrite && (
          <div className="flex gap-1.5">
            <button className="btn-subtle px-2 py-1 text-xs" onClick={() => setImporting(true)}>Import CSV</button>
            <button className="btn-subtle px-2 py-1 text-xs" onClick={() => void exportCsv()}>Export CSV</button>
            <button className="btn-subtle px-2 py-1 text-xs" onClick={() => setEditing({ rule: null })}><Icon.Plus width={14} height={14} /> New redirect</button>
          </div>
        )}
      </div>
      <p className="mb-2 text-xs text-muted">
        Old URLs and where they go now. A rule only fires where no published page answers, so it can never hide a live page. Publishing a new slug or moving a page adds a 301 automatically. Keep redirects for at least a year — the “Unused” filter shows which have had no visits in that time.
      </p>
      <Surface elevation={1} className="overflow-hidden">
        <TestBox />
        <div className="flex gap-1 border-b border-line px-3 pt-2" role="tablist">
          {([["rules", `Rules (${all.length})`], ["404", `404s (${(notFound.data ?? []).filter((r) => r.coveredBy === null).length})`]] as const).map(([k, label]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={`-mb-px border-b-2 px-3 py-1.5 text-xs font-medium ${tab === k ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg"}`} onClick={() => setTab(k)}>{label}</button>
          ))}
        </div>

        {tab === "404" ? (
          <NotFoundList canWrite={canWrite} onCreate={(path) => setEditing({ rule: null, source: path })} />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
              <label className="flex min-w-48 flex-1 items-center gap-1.5 rounded-(--radius) border border-line bg-panel px-2">
                <Icon.Search width={14} height={14} className="text-muted" />
                <input type="search" aria-label="Search redirects" className="w-full bg-transparent py-1 text-xs outline-none" placeholder="Search source, target or note" value={q} onChange={(e) => setQ(e.target.value)} />
              </label>
              <div className="flex flex-wrap gap-1">
                {FILTERS.filter(([k]) => k === "all" || counts[k] > 0).map(([k, label]) => (
                  <button key={k} aria-pressed={filter === k} className={`rounded-full px-2.5 py-0.5 text-xs ${filter === k ? (k === "problems" ? "bg-danger text-white" : "bg-accent text-white") : "bg-line/60 text-fg hover:bg-line"}`} onClick={() => setFilter(k)}>
                    {label} <span className="tnum opacity-75">{counts[k]}</span>
                  </button>
                ))}
              </div>
            </div>
            {canWrite && selected.size > 0 && (
              <div className="flex items-center gap-2 border-b border-line bg-accent-50/50 px-3 py-1.5 text-xs">
                {selected.size} selected
                <button
                  className="rounded px-2 py-0.5 text-danger hover:bg-danger/10"
                  onClick={() => confirm.ask({ title: `Delete ${selected.size} redirect${selected.size === 1 ? "" : "s"}?`, description: "Visitors and search engines following these old URLs will get a 404 instead.", confirmLabel: "Delete", onConfirm: () => del.mutate([...selected]) })}
                >Delete</button>
                <button className="rounded px-2 py-0.5 text-muted hover:bg-line/60" onClick={() => setSelected(new Set())}>Clear</button>
              </div>
            )}

            {visible.length > 0 && (
              <div className="relative overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-muted">
                      {canWrite && (
                        <th className="w-8 px-3 py-1.5">
                          <input type="checkbox" aria-label="Select all shown" checked={allVisibleSelected} onChange={() => setSelected(allVisibleSelected ? new Set() : new Set(visible.map((r) => r.id)))} />
                        </th>
                      )}
                      <th className="px-3 py-1.5 font-semibold">From</th>
                      <th className="px-3 py-1.5 font-semibold">To</th>
                      <th className="px-3 py-1.5 font-semibold">Type</th>
                      <th className="px-3 py-1.5 font-semibold">Used</th>
                      <th className="px-3 py-1.5"><span className="sr-only">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((r) => (
                      <tr key={r.id} className={`border-b border-line align-top last:border-0 ${r.problems.length ? "bg-danger-subtle/30" : ""}`}>
                        {canWrite && (
                          <td className="px-3 py-2"><input type="checkbox" aria-label={`Select ${r.source}`} checked={selected.has(r.id)} onChange={() => toggle(r.id)} /></td>
                        )}
                        <td className="max-w-64 px-3 py-2">
                          <code className="break-all text-xs">{r.source}</code>
                          <div className="mt-0.5 flex flex-wrap gap-1">
                            <Badge>{ORIGIN_LABEL[r.origin]}</Badge>
                            {r.note && <span className="text-[11px] text-muted">{r.note}</span>}
                          </div>
                        </td>
                        <td className="max-w-72 px-3 py-2">
                          <TargetCell rule={r} />
                          {r.problems.map((p) => (
                            <p key={p.code} className="mt-1 text-[11px] text-danger">⚠ {p.message}</p>
                          ))}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2"><Badge tone={r.status === 410 ? "default" : r.status === 302 || r.status === 307 ? "caution" : "primary"}>{STATUS_LABEL[r.status]}</Badge></td>
                        <td className="whitespace-nowrap px-3 py-2 text-xs text-muted">
                          {r.hits > 0 ? <><span className="tnum text-fg">{r.hits}</span> · {r.lastHitAt ? relativeTime(r.lastHitAt) : ""}</> : "never"}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-right">
                          {canWrite && (
                            <>
                              <button className="rounded px-2 py-0.5 text-xs text-accent-700 hover:bg-accent/10" onClick={() => setEditing({ rule: r })}>Edit</button>
                              <button
                                className="rounded px-2 py-0.5 text-xs text-danger hover:bg-danger/10"
                                onClick={() => confirm.ask({ title: `Delete the redirect from ${r.source}?`, description: "Visitors and search engines following the old URL will get a 404 instead.", confirmLabel: "Delete", onConfirm: () => del.mutate([r.id]) })}
                              >Delete</button>
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {rules.isSuccess && all.length === 0 && (
              <EmptyState title="No redirects yet">
                Moving a site? Import the old URLs as CSV. Renaming or moving a published page adds its redirect by itself.
              </EmptyState>
            )}
            {rules.isSuccess && all.length > 0 && visible.length === 0 && <p className="p-4 text-sm text-muted">No redirect matches.</p>}
          </>
        )}
      </Surface>
      {editing && <RuleDialog rule={editing.rule} initialSource={editing.source} onClose={() => setEditing(null)} />}
      {importing && <ImportDialog onClose={() => setImporting(false)} />}
      {confirm.dialog}
    </section>
  );
}
