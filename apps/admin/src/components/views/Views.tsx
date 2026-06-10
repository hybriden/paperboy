import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
import { api } from "../../lib/api.js";
import { Icon } from "../../lib/icons.js";
import { useUser } from "../../lib/user.js";
import type { ShellOutlet } from "../Shell.js";
import { AiPanel, AuditPanel, ContentTypesPanel, DeliveryKeysPanel, LanguagesPanel, McpTokensPanel, PasswordPanel, SitePanel, StockImagesPanel, TrashPanel, TwoFactorPanel, UsersPanel, WebhooksPanel } from "./AdminPanels.js";

function StatCard({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-lg border border-line bg-panel p-5 shadow-panel">
      <div className="masthead tnum text-4xl leading-none text-fg">{value}</div>
      <div className="mt-2 text-[11px] font-semibold uppercase tracking-wide text-muted">{label}</div>
    </div>
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
      {hint && <p className="-mt-1 mb-2 text-xs text-muted/80">{hint}</p>}
      <div className="overflow-hidden rounded-lg border border-line bg-panel shadow-panel">{children}</div>
    </section>
  );
}

function EmptyRow({ children }: { children: React.ReactNode }) {
  return <p className="p-5 text-sm text-muted">{children}</p>;
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
  const housekeepingItems = hk
    ? ([
        { label: hk.trash === 1 ? "item in trash" : "items in trash", count: hk.trash, to: "/settings#trash" },
        { label: hk.unusedBlocks === 1 ? "unused shared block" : "unused shared blocks", count: hk.unusedBlocks, to: "/edit" },
        { label: hk.emptyTypes === 1 ? "content type without content" : "content types without content", count: hk.emptyTypes, to: "/settings#model" },
        ...(hk.failingWebhooks != null
          ? [{ label: hk.failingWebhooks === 1 ? "failing webhook" : "failing webhooks", count: hk.failingWebhooks, to: "/settings#webhooks", alarm: true }]
          : []),
      ] as { label: string; count: number; to: string; alarm?: boolean }[])
    : [];
  const attention = housekeepingItems.filter((i) => i.count > 0);

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
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${w.change === "new" ? "bg-draft/10 text-draft" : "bg-accent/10 text-accent-700"}`}>
                  {w.change === "new" ? "draft" : "edited"}
                </span>
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
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${sch.action === "publish" ? "bg-published/10 text-published" : "bg-danger/10 text-danger"}`}>
                  {sch.action === "publish" ? "goes live" : "expires"}
                </span>
                <span className="tnum shrink-0 text-xs text-muted">{scheduleTime(sch.at)}</span>
              </button>
            ))}
          </DashSection>
        </div>

        <div className="grid gap-8 lg:grid-cols-2">
          {/* Per-language coverage: pages that don't exist in a locale yet. */}
          <DashSection title="Translations">
            {dash.isLoading && skeleton(2)}
            {d && gaps.length === 0 && <EmptyRow>Every page exists in all languages.</EmptyRow>}
            {gaps.map((t) => (
              <div key={t.locale} className="flex items-center gap-3 border-b border-line px-4 py-3 text-sm last:border-0">
                <span className="font-mono text-xs text-muted">{t.locale}</span>
                <span className="min-w-0 flex-1 truncate font-medium text-fg">{t.displayName}</span>
                <span className="tnum text-xs text-muted">{t.missing} {t.missing === 1 ? "page" : "pages"} not translated</span>
              </div>
            ))}
          </DashSection>

          {/* Tidy-up signals: trash, orphans, dead webhooks. */}
          <DashSection title="Housekeeping">
            {dash.isLoading && skeleton(2)}
            {d && attention.length === 0 && <EmptyRow>All tidy — nothing needs attention.</EmptyRow>}
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

  // Deep-link a tab via the URL hash (e.g. /settings#site from the site switcher).
  const hashTab = typeof window !== "undefined" ? window.location.hash.slice(1) : "";
  const [active, setActive] = useState(tabs.some((t) => t.key === hashTab) ? hashTab : (tabs[0]?.key ?? "model"));
  const current = tabs.find((t) => t.key === active) ?? tabs[0];
  const groups: SettingsTab["group"][] = ["Content", "Administration", "Account"];

  return (
    <div className="h-full overflow-hidden">
      <div className="flex h-full">
        {/* Left section nav */}
        <nav aria-label="Settings sections" className="w-56 shrink-0 overflow-auto border-r border-line bg-panel p-3">
          <h1 className="masthead mb-3 px-2 text-xl text-fg">Settings</h1>
          {groups.map((g) => {
            const items = tabs.filter((t) => t.group === g);
            if (!items.length) return null;
            return (
              <div key={g} className="mb-3">
                <div className="px-2 pb-1 text-[10px] font-bold uppercase tracking-wide text-muted/70">{g}</div>
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
            <h2 className="masthead mb-5 text-2xl text-fg">{current?.label}</h2>
            {current?.render()}
          </div>
        </section>
      </div>
    </div>
  );
}
