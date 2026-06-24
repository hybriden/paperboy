import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
import { type DashboardData, api } from "../../lib/api.js";
import { Icon } from "../../lib/icons.js";
import { AI_OFF_HINT, useAiEnabled } from "../../lib/useAiStatus.js";
import { useUser } from "../../lib/user.js";
import type { ShellOutlet } from "../Shell.js";
import { Dialog, DialogContent } from "../ui/dialog.js";
import { Badge } from "../ui/badge.js";
import { Surface } from "../ui/surface.js";
import { useToast } from "../ui/toast.js";
import { AiPanel, AuditPanel, ContentTypesPanel, DeliveryKeysPanel, LanguagesPanel, McpTokensPanel, PasswordPanel, SitePanel, StockImagesPanel, TrashPanel, TwoFactorPanel, UsersPanel, WebhooksPanel } from "./AdminPanels.js";

function StatCard({ label, value }: { label: string; value: number | string }) {
  return (
    <Surface elevation={1} padding="lg">
      <div className="masthead tnum text-4xl leading-none text-fg">{value}</div>
      <div className="mt-2 text-[11px] font-semibold uppercase tracking-wide text-muted">{label}</div>
    </Surface>
  );
}

/** "2h ago" / "in 3 days" — coarse on purpose; the dashboard is a glance. */
function relativeTime(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(diff);
  const fmt = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (abs < 60_000) return fmt.format(Math.round(diff / 1000), "second");
  if (abs < 3_600_000) return fmt.format(Math.round(diff / 60_000), "minute");
  if (abs < 86_400_000) return fmt.format(Math.round(diff / 3_600_000), "hour");
  return fmt.format(Math.round(diff / 86_400_000), "day");
}

function scheduleTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function DashSection({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 text-xs font-bold uppercase tracking-wide text-muted">{title}</h2>
      {hint && <p className="-mt-1 mb-2 text-xs text-muted">{hint}</p>}
      <Surface elevation={1} className="overflow-hidden">{children}</Surface>
    </section>
  );
}

function EmptyRow({ children }: { children: React.ReactNode }) {
  return <p className="p-5 text-sm text-muted">{children}</p>;
}

/** The alt-text gaps, fixable IN PLACE: click a thumbnail, write (or generate)
 *  the alt text, save — without leaving the dashboard. */
function AltTextGaps({ images, total }: { images: DashboardData["imagesMissingAlt"]; total: number }) {
  const qc = useQueryClient();
  const toast = useToast();
  const aiEnabled = useAiEnabled();
  const [editing, setEditing] = useState<DashboardData["imagesMissingAlt"][number] | null>(null);
  const [alt, setAlt] = useState("");
  const altRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing) altRef.current?.focus(); }, [editing]);

  const save = useMutation({
    mutationFn: (v: { id: string; alt: string }) => api.updateAssetAlt(v.id, v.alt),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["dashboard"] });
      void qc.invalidateQueries({ queryKey: ["assets"] });
      setEditing(null);
      toast.success("Alt text saved");
    },
    onError: (e) => toast.error("Couldn’t save alt text", (e as Error).message),
  });
  const describe = useMutation({
    mutationFn: (id: string) => api.aiAltText(id),
    onSuccess: (r) => setAlt(r.result),
    onError: (e) => toast.error("Couldn’t describe the image", (e as Error).message),
  });

  return (
    <div className="border-b border-line last:border-0">
      <div className="flex items-center gap-3 bg-canvas/50 px-4 py-2 text-sm">
        <span className="tnum text-base font-semibold text-fg">{total}</span>
        <span className="min-w-0 flex-1 truncate text-fg">{total === 1 ? "image without alt text" : "images without alt text"}</span>
        <span className="text-xs text-muted">click to fix</span>
      </div>
      <div className="flex flex-wrap gap-2 px-4 py-3">
        {images.map((img) => (
          <button
            key={img.documentId}
            type="button"
            className="h-16 w-16 overflow-hidden rounded border border-line transition-shadow hover:ring-2 hover:ring-accent"
            aria-label="Add alt text"
            title={`${img.filename} — add alt text`}
            onClick={() => { setEditing(img); setAlt(""); }}
          >
            <img src={img.url} alt="" className="h-full w-full object-cover" />
          </button>
        ))}
        {total > images.length && <span className="self-center text-xs text-muted">+ {total - images.length} more</span>}
      </div>
      {editing && (
        <Dialog open onOpenChange={(o) => !o && setEditing(null)}>
          <DialogContent title="Add alt text" description={editing.filename} size="sm">
            <img src={editing.url} alt="" className="mb-3 max-h-48 w-full rounded border border-line object-contain" />
            <div className="flex items-center justify-between">
              <label className="field-label" htmlFor="dash-alt">Alt text (accessibility)</label>
              <button
                type="button"
                className="btn-subtle px-1.5 py-0.5 text-[11px]"
                disabled={describe.isPending || !aiEnabled}
                title={aiEnabled ? "Describe the image with AI" : AI_OFF_HINT}
                onClick={() => describe.mutate(editing.documentId)}
              >
                {describe.isPending ? "Looking…" : "Describe image"}
              </button>
            </div>
            <input id="dash-alt" ref={altRef} aria-label="Alt text" className="field-input mb-4" value={alt} onChange={(e) => setAlt(e.target.value)} placeholder="Describe the image" />
            <div className="flex justify-end gap-2">
              <button className="btn-ghost" onClick={() => setEditing(null)}>Cancel</button>
              <button className="btn-primary" disabled={save.isPending || !alt.trim()} onClick={() => save.mutate({ id: editing.documentId, alt: alt.trim() })}>
                Save
              </button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

export function DashboardView() {
  const { setCrumb } = useOutletContext<ShellOutlet>();
  const navigate = useNavigate();
  useEffect(() => setCrumb(null), [setCrumb]);

  const tree = useQuery({ queryKey: ["tree", "root"], queryFn: ({ signal }) => api.tree(undefined, signal) });
  const types = useQuery({ queryKey: ["content-types"], queryFn: ({ signal }) => api.contentTypes(signal) });
  const locales = useQuery({ queryKey: ["locales"], queryFn: ({ signal }) => api.locales(signal) });
  const dash = useQuery({ queryKey: ["dashboard"], queryFn: ({ signal }) => api.dashboard(signal) });

  const nodes = tree.data ?? [];
  const pages = nodes.filter((n) => n.kind === "page");
  const blocks = nodes.filter((n) => n.kind === "block");
  const d = dash.data;
  const gaps = (d?.translation ?? []).filter((t) => t.missing > 0);
  const hk = d?.housekeeping;
  // Unused blocks and empty types render as their own groups below (the items
  // themselves, not a bare count) — only trash and webhooks stay simple rows.
  const housekeepingItems = hk
    ? ([
        { label: hk.trash === 1 ? "item in trash" : "items in trash", count: hk.trash, to: "/settings#trash" },
        ...(hk.failingWebhooks != null
          ? [{ label: hk.failingWebhooks === 1 ? "failing webhook" : "failing webhooks", count: hk.failingWebhooks, to: "/settings#webhooks", alarm: true }]
          : []),
      ] as { label: string; count: number; to: string; alarm?: boolean }[])
    : [];
  const attention = housekeepingItems.filter((i) => i.count > 0);
  const altGaps = d?.imagesMissingAlt ?? [];
  const unusedBlockRows = d?.unusedBlocksList ?? [];
  const emptyTypeRows = d?.emptyTypesList ?? [];
  const tidy = attention.length === 0 && altGaps.length === 0 && (hk?.unusedBlocks ?? 0) === 0 && (hk?.emptyTypes ?? 0) === 0;

  const skeleton = (n: number) => [...Array(n)].map((_, i) => <div key={i} className="h-12 animate-pulse border-b border-line bg-line/30 last:border-0" />);

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-5xl animate-slide-up p-8">
        <h1 className="masthead text-3xl text-fg">Newsroom dashboard</h1>
        <p className="mb-7 mt-1 text-sm text-muted">Everything Paperboy is delivering, at a glance.</p>

        <div className="mb-9 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatCard label="Top-level pages" value={pages.length} />
          <StatCard label="Shared blocks" value={blocks.length} />
          <StatCard label="Content types" value={types.data?.length ?? 0} />
          <StatCard label="Languages" value={locales.data?.length ?? 0} />
        </div>

        <div className="mb-8 grid gap-8 lg:grid-cols-2">
          {/* What was I doing? Unpublished drafts, newest edits first. */}
          <DashSection title="In progress" hint="Drafts with unpublished changes — click to resume.">
            {dash.isLoading && skeleton(3)}
            {d && d.wip.length === 0 && <EmptyRow>Nothing in progress — every change is published.</EmptyRow>}
            {d?.wip.map((w) => (
              <button
                key={`${w.documentId}:${w.locale}`}
                onClick={() => navigate(`/edit/${w.documentId}`)}
                className="flex w-full items-center gap-3 border-b border-line px-4 py-3 text-left text-sm transition-colors last:border-0 hover:bg-canvas"
              >
                {w.kind === "block" ? <Icon.Block width={16} height={16} className="shrink-0 text-muted" /> : <Icon.File width={16} height={16} className="shrink-0 text-muted" />}
                <span className="min-w-0 flex-1 truncate font-medium text-fg">{w.name}</span>
                <span className="hidden font-mono text-xs text-muted sm:inline">{w.locale}</span>
                <Badge tone={w.change === "new" ? "caution" : "primary"}>{w.change === "new" ? "draft" : "edited"}</Badge>
                <span className="tnum w-20 shrink-0 text-right text-xs text-muted">{relativeTime(w.at)}</span>
              </button>
            ))}
            {d && d.wipTotal > d.wip.length && (
              <p className="border-t border-line px-4 py-2 text-xs text-muted">+ {d.wipTotal - d.wip.length} more drafts</p>
            )}
          </DashSection>

          {/* Timed go-lives and expiries — the invisible queue, made visible. */}
          <DashSection title="Scheduled publishing" hint="Upcoming timed go-lives and expiries.">
            {dash.isLoading && skeleton(3)}
            {d && d.scheduled.length === 0 && <EmptyRow>Nothing scheduled.</EmptyRow>}
            {d?.scheduled.map((sch) => (
              <button
                key={`${sch.documentId}:${sch.locale}:${sch.action}`}
                onClick={() => navigate(`/edit/${sch.documentId}`)}
                className="flex w-full items-center gap-3 border-b border-line px-4 py-3 text-left text-sm transition-colors last:border-0 hover:bg-canvas"
              >
                <Icon.File width={16} height={16} className="shrink-0 text-muted" />
                <span className="min-w-0 flex-1 truncate font-medium text-fg">{sch.name}</span>
                <Badge tone={sch.action === "publish" ? "positive" : "critical"}>{sch.action === "publish" ? "goes live" : "expires"}</Badge>
                <span className="tnum shrink-0 text-xs text-muted">{scheduleTime(sch.at)}</span>
              </button>
            ))}
          </DashSection>
        </div>

        <div className="grid gap-8 lg:grid-cols-2">
          {/* Per-language coverage: the missing pages themselves, each a click
              away from the editor at that locale — where the "Translate from …"
              offer creates the AI-translated draft. */}
          <DashSection title="Translations" hint="Open a page to create its translation draft.">
            {dash.isLoading && skeleton(2)}
            {d && gaps.length === 0 && <EmptyRow>Every page exists in all languages.</EmptyRow>}
            {gaps.map((t) => (
              <div key={t.locale} className="border-b border-line last:border-0">
                <div className="flex items-center gap-3 bg-canvas/50 px-4 py-2 text-sm">
                  <span className="font-mono text-xs text-muted">{t.locale}</span>
                  <span className="min-w-0 flex-1 truncate font-medium text-fg">{t.displayName}</span>
                  <span className="tnum text-xs text-muted">{t.missing} {t.missing === 1 ? "page" : "pages"} not translated</span>
                </div>
                {t.pages.map((p) => (
                  <button
                    key={p.documentId}
                    onClick={() => navigate(`/edit/${p.documentId}?lang=${t.locale}`)}
                    className="flex w-full items-center gap-3 px-4 py-2 pl-9 text-left text-sm transition-colors hover:bg-canvas"
                  >
                    <Icon.File width={14} height={14} className="shrink-0 text-muted" />
                    <span className="min-w-0 flex-1 truncate text-fg">{p.name}</span>
                    <span className="text-xs text-accent">Translate →</span>
                  </button>
                ))}
                {t.missing > t.pages.length && (
                  <p className="px-4 py-1.5 pl-9 text-xs text-muted">+ {t.missing - t.pages.length} more</p>
                )}
              </div>
            ))}
          </DashSection>

          {/* Tidy-up signals: trash, orphans, alt-text gaps, dead webhooks. */}
          <DashSection title="Housekeeping">
            {dash.isLoading && skeleton(2)}
            {d && tidy && <EmptyRow>All tidy — nothing needs attention.</EmptyRow>}
            {hk && altGaps.length > 0 && <AltTextGaps images={altGaps} total={hk.missingAlt} />}
            {/* The unused blocks themselves: open one to place it on a page or trash it. */}
            {hk && hk.unusedBlocks > 0 && (
              <div className="border-b border-line last:border-0">
                <div className="flex items-center gap-3 bg-canvas/50 px-4 py-2 text-sm">
                  <span className="tnum text-base font-semibold text-fg">{hk.unusedBlocks}</span>
                  <span className="min-w-0 flex-1 truncate text-fg">{hk.unusedBlocks === 1 ? "unused shared block" : "unused shared blocks"}</span>
                  <span className="text-xs text-muted">not placed on any page</span>
                </div>
                {unusedBlockRows.map((b) => (
                  <button
                    key={b.documentId}
                    onClick={() => navigate(`/edit/${b.documentId}`)}
                    className="flex w-full items-center gap-3 px-4 py-2 pl-9 text-left text-sm transition-colors hover:bg-canvas"
                  >
                    <Icon.Block width={14} height={14} className="shrink-0 text-muted" />
                    <span className="min-w-0 flex-1 truncate text-fg">{b.name}</span>
                    <code className="rounded bg-line/70 px-1 font-mono text-[11px] text-muted">{b.type}</code>
                    <span className="text-xs text-accent">Review →</span>
                  </button>
                ))}
                {hk.unusedBlocks > unusedBlockRows.length && (
                  <p className="px-4 py-1.5 pl-9 text-xs text-muted">+ {hk.unusedBlocks - unusedBlockRows.length} more</p>
                )}
              </div>
            )}
            {/* The empty types themselves: open one in the model editor, where an
                unused type can be deleted (or keep it and create its first content). */}
            {hk && hk.emptyTypes > 0 && (
              <div className="border-b border-line last:border-0">
                <div className="flex items-center gap-3 bg-canvas/50 px-4 py-2 text-sm">
                  <span className="tnum text-base font-semibold text-fg">{hk.emptyTypes}</span>
                  <span className="min-w-0 flex-1 truncate text-fg">{hk.emptyTypes === 1 ? "content type without content" : "content types without content"}</span>
                  <span className="text-xs text-muted">create its first content, or delete it</span>
                </div>
                {emptyTypeRows.map((t) => (
                  <button
                    key={t.name}
                    onClick={() => navigate(`/settings#model:${t.name}`)}
                    className="flex w-full items-center gap-3 px-4 py-2 pl-9 text-left text-sm transition-colors hover:bg-canvas"
                  >
                    {t.kind === "block" ? <Icon.Block width={14} height={14} className="shrink-0 text-muted" /> : <Icon.File width={14} height={14} className="shrink-0 text-muted" />}
                    <span className="min-w-0 flex-1 truncate text-fg">{t.displayName}</span>
                    <code className="rounded bg-line/70 px-1 font-mono text-[11px] text-muted">{t.name}</code>
                    <span className="rounded bg-canvas px-1.5 py-0.5 text-[11px] text-muted">{t.kind}</span>
                    <span className="text-xs text-accent">Open in model →</span>
                  </button>
                ))}
                {hk.emptyTypes > emptyTypeRows.length && (
                  <p className="px-4 py-1.5 pl-9 text-xs text-muted">+ {hk.emptyTypes - emptyTypeRows.length} more</p>
                )}
              </div>
            )}
            {attention.map((item) => (
              <button
                key={item.label}
                onClick={() => navigate(item.to)}
                className="flex w-full items-center gap-3 border-b border-line px-4 py-3 text-left text-sm transition-colors last:border-0 hover:bg-canvas"
              >
                <span className={`tnum text-base font-semibold ${item.alarm ? "text-danger" : "text-fg"}`}>{item.count}</span>
                <span className="min-w-0 flex-1 truncate text-fg">{item.label}</span>
                <Icon.Chevron width={14} height={14} className="shrink-0 text-muted" />
              </button>
            ))}
          </DashSection>
        </div>
      </div>
    </div>
  );
}

interface SettingsTab {
  key: string;
  label: string;
  group: "Content" | "Administration" | "Account";
  show: boolean;
  render: () => React.ReactNode;
}

export function SettingsView() {
  const { setCrumb } = useOutletContext<ShellOutlet>();
  useEffect(() => setCrumb(null), [setCrumb]);
  const { user } = useUser();
  const has = (p: string) => user.permissions.includes(p as never);

  const allTabs: SettingsTab[] = [
    { key: "model", label: "Content types", group: "Content", show: true, render: () => <ContentTypesPanel /> },
    { key: "languages", label: "Languages", group: "Content", show: true, render: () => <LanguagesPanel /> },
    { key: "site", label: "Site", group: "Content", show: has("content.publish"), render: () => <SitePanel /> },
    { key: "users", label: "Users & roles", group: "Administration", show: has("user.manage"), render: () => <UsersPanel /> },
    { key: "keys", label: "API keys", group: "Administration", show: has("deliverykey.manage"), render: () => <DeliveryKeysPanel /> },
    { key: "mcp", label: "MCP", group: "Administration", show: has("user.manage"), render: () => <McpTokensPanel /> },
    { key: "ai", label: "AI", group: "Administration", show: has("user.manage"), render: () => <AiPanel /> },
    { key: "stock", label: "Stock images", group: "Administration", show: has("user.manage"), render: () => <StockImagesPanel /> },
    { key: "webhooks", label: "Webhooks", group: "Administration", show: has("webhook.manage"), render: () => <WebhooksPanel /> },
    { key: "audit", label: "Audit log", group: "Administration", show: has("audit.read"), render: () => <AuditPanel /> },
    { key: "trash", label: "Trash", group: "Administration", show: true, render: () => <TrashPanel /> },
    { key: "account", label: "Your account", group: "Account", show: true, render: () => (<><TwoFactorPanel /><PasswordPanel /></>) },
  ];
  const tabs = allTabs.filter((t) => t.show);

  // Deep-link a tab via the URL hash (e.g. /settings#site from the site
  // switcher). A suffix after ":" addresses something INSIDE the tab — e.g.
  // #model:BlogPost from the dashboard opens that type's editor (the panel
  // itself consumes the suffix).
  const hashTab = typeof window !== "undefined" ? window.location.hash.slice(1).split(":")[0]! : "";
  const [active, setActive] = useState(tabs.some((t) => t.key === hashTab) ? hashTab : (tabs[0]?.key ?? "model"));
  const current = tabs.find((t) => t.key === active) ?? tabs[0];
  const groups: SettingsTab["group"][] = ["Content", "Administration", "Account"];

  return (
    <div className="h-full overflow-hidden">
      <div className="flex h-full">
        {/* Left section nav */}
        <nav aria-label="Settings sections" className="w-56 shrink-0 overflow-auto border-r border-line bg-panel p-3">
          <h1 className="mb-3 px-2 text-xl font-semibold tracking-[-0.02em] text-fg">Settings</h1>
          {groups.map((g) => {
            const items = tabs.filter((t) => t.group === g);
            if (!items.length) return null;
            return (
              <div key={g} className="mb-3">
                <div className="px-2 pb-1 text-[10px] font-bold uppercase tracking-wide text-muted">{g}</div>
                {items.map((t) => (
                  <button
                    key={t.key}
                    onClick={() => setActive(t.key)}
                    aria-current={active === t.key}
                    className={`mb-0.5 flex w-full items-center rounded-[var(--radius)] px-2 py-1.5 text-left text-sm transition-colors ${
                      active === t.key ? "bg-accent/15 font-medium text-accent-700" : "text-fg hover:bg-line/50"
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            );
          })}
        </nav>

        {/* Active section */}
        <section className="min-w-0 flex-1 overflow-auto">
          <div className="mx-auto max-w-4xl animate-slide-up p-8">
            <h2 className="mb-5 text-2xl font-semibold tracking-[-0.02em] text-fg">{current?.label}</h2>
            {current?.render()}
          </div>
        </section>
      </div>
    </div>
  );
}
