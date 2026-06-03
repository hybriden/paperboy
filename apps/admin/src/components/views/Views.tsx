import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
import { api } from "../../lib/api.js";
import { Icon } from "../../lib/icons.js";
import { useUser } from "../../lib/user.js";
import type { ShellOutlet } from "../Shell.js";
import { AiPanel, AuditPanel, ContentTypesPanel, DeliveryKeysPanel, LanguagesPanel, McpTokensPanel, PasswordPanel, SitePanel, TrashPanel, TwoFactorPanel, UsersPanel, WebhooksPanel } from "./AdminPanels.js";

function StatCard({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-lg border border-line bg-panel p-5 shadow-panel">
      <div className="masthead tnum text-4xl leading-none text-fg">{value}</div>
      <div className="mt-2 text-[11px] font-semibold uppercase tracking-wide text-muted">{label}</div>
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

  const nodes = tree.data ?? [];
  const pages = nodes.filter((n) => n.kind === "page");
  const blocks = nodes.filter((n) => n.kind === "block");

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

        <h2 className="mb-2 text-xs font-bold uppercase tracking-wide text-muted">Recent content</h2>
        <div className="overflow-hidden rounded-lg border border-line bg-panel shadow-panel">
          {tree.isLoading && [0, 1, 2].map((i) => <div key={i} className="h-12 animate-pulse border-b border-line bg-line/30 last:border-0" />)}
          {!tree.isLoading && nodes.length === 0 && <p className="p-5 text-sm text-muted">No content yet.</p>}
          {nodes.map((n) => {
            const loc = Object.values(n.locales)[0];
            return (
              <button
                key={n.documentId}
                onClick={() => navigate(`/edit/${n.documentId}`)}
                className="flex w-full items-center gap-3 border-b border-line px-4 py-3 text-left text-sm transition-colors last:border-0 hover:bg-canvas"
              >
                {n.kind === "block" ? <Icon.Block width={16} height={16} className="text-muted" /> : <Icon.File width={16} height={16} className="text-muted" />}
                <span className="font-medium text-fg">{n.name}</span>
                <span className="font-mono text-xs text-muted">{n.type}</span>
                {loc && (
                  <span className={`ml-auto rounded-full px-2 py-0.5 text-[11px] font-semibold ${loc.status === "published" ? "bg-published/10 text-published" : "bg-draft/10 text-draft"}`}>
                    {loc.status}
                  </span>
                )}
              </button>
            );
          })}
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
    { key: "webhooks", label: "Webhooks", group: "Administration", show: has("webhook.manage"), render: () => <WebhooksPanel /> },
    { key: "audit", label: "Audit log", group: "Administration", show: has("audit.read"), render: () => <AuditPanel /> },
    { key: "trash", label: "Trash", group: "Administration", show: true, render: () => <TrashPanel /> },
    { key: "account", label: "Your account", group: "Account", show: true, render: () => (<><TwoFactorPanel /><PasswordPanel /></>) },
  ];
  const tabs = allTabs.filter((t) => t.show);

  const [active, setActive] = useState(tabs[0]?.key ?? "model");
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
