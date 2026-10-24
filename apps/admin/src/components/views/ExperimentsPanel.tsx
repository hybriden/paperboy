import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { ExperimentMode, ExperimentStatus } from "@paperboy/shared";
import { api, type ExperimentSettings, type ExperimentView } from "../../lib/api.js";
import { experimentBadge } from "../../lib/experiments.js";
import { Icon } from "../../lib/icons.js";
import { relativeTime } from "../../lib/relative-time.js";
import { useUser } from "../../lib/user.js";
import { Badge } from "../ui/badge.js";
import { EmptyState } from "../ui/empty-state.js";
import { Surface } from "../ui/surface.js";
import { useToast } from "../ui/toast.js";

/** The page editor link that opens an experiment's panel. */
export const experimentLink = (e: ExperimentView): string => `/edit/${e.documentId}?lang=${encodeURIComponent(e.locale)}&experiment=${e.id}`;

const FILTERS: [ExperimentStatus | "all", string][] = [["all", "All"], ["running", "Running"], ["draft", "Draft"], ["paused", "Paused"], ["ended", "Ended"]];

/**
 * Settings → Experiments (#125), for the active site: every A/B experiment with
 * a status filter and search, and the site's privacy mode. Experiments are set
 * up and run from the page's content area; a row opens that panel.
 */
export function ExperimentsPanel() {
  const navigate = useNavigate();
  const list = useQuery({ queryKey: ["experiments", "all"], queryFn: ({ signal }) => api.experiments({}, signal) });
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<ExperimentStatus | "all">("all");
  const all = list.data ?? [];
  const needle = q.trim().toLowerCase();
  const visible = all.filter((e) => (filter === "all" || e.status === filter) && (!needle || `${e.name} ${e.pageName ?? ""} ${e.area}`.toLowerCase().includes(needle)));

  return (
    <>
      <section className="mb-8">
        <h2 className="mb-2 pane-title">Experiments</h2>
        <p className="mb-2 text-xs text-muted">
          A/B tests of one content area each. Set one up from a page’s content area (“A/B test this area”); open a row to see its results.
        </p>
        <Surface elevation={1} className="overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
            <label className="flex min-w-48 flex-1 items-center gap-1.5 rounded-(--radius) border border-line bg-panel px-2">
              <Icon.Search width={14} height={14} className="text-muted" />
              <input type="search" aria-label="Search experiments" className="w-full bg-transparent py-1 text-xs outline-none" placeholder="Search name or page" value={q} onChange={(e) => setQ(e.target.value)} />
            </label>
            <div className="flex flex-wrap gap-1">
              {FILTERS.map(([k, label]) => (
                <button key={k} type="button" aria-pressed={filter === k} className={`rounded-full px-2.5 py-0.5 text-xs ${filter === k ? "bg-accent text-white" : "bg-line/60 text-fg hover:bg-line"}`} onClick={() => setFilter(k)}>
                  {label} <span className="tnum opacity-75">{k === "all" ? all.length : all.filter((e) => e.status === k).length}</span>
                </button>
              ))}
            </div>
          </div>
          {visible.map((e) => (
            <button
              key={e.id}
              type="button"
              onClick={() => void navigate(experimentLink(e))}
              className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-2.5 text-left text-sm transition-colors last:border-0 hover:bg-canvas"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-fg">{e.name}</span>
                <span className="block truncate text-xs text-muted">{e.pageName ?? e.documentId} · {e.area} · {e.locale}</span>
              </span>
              {e.needsReview && e.status !== "ended" && <Badge tone="caution">needs review</Badge>}
              <Badge tone={e.status === "running" ? "primary" : e.status === "ended" ? "default" : "caution"}>{experimentBadge(e)}</Badge>
              <span className="w-24 shrink-0 text-right text-xs text-muted">{relativeTime(e.updatedAt)}</span>
            </button>
          ))}
          {list.isSuccess && all.length === 0 && (
            <EmptyState title="No experiments yet">Open a page, and use “A/B test this area” on one of its content areas.</EmptyState>
          )}
          {list.isSuccess && all.length > 0 && visible.length === 0 && <p className="p-4 text-sm text-muted">No experiment matches.</p>}
        </Surface>
      </section>
      <PrivacySettings />
    </>
  );
}

function PrivacySettings() {
  const { user } = useUser();
  const canManage = user.permissions.includes("site.manage");
  const qc = useQueryClient();
  const toast = useToast();
  const settings = useQuery({ queryKey: ["experiment-settings"], queryFn: ({ signal }) => api.experimentSettings(signal) });
  const s = settings.data;
  const save = useMutation({
    mutationFn: (body: { mode?: ExperimentMode; warnDays?: number }) => api.setExperimentSettings(body),
    onSuccess: (next: ExperimentSettings) => {
      qc.setQueryData(["experiment-settings"], next);
      toast.success("Experiment settings saved");
    },
    onError: (e) => toast.error("Couldn’t save", (e as Error).message),
  });
  if (!s) return null;
  return (
    <section className="mb-8">
      <h2 className="mb-2 pane-title">Privacy and run length</h2>
      <Surface elevation={1} padding="lg" className="flex flex-col gap-3 text-sm">
        <fieldset disabled={!canManage || save.isPending}>
          <legend className="field-label">How visitors are counted</legend>
          {([
            ["cookieless", "Cookieless (default)", "Each page view draws a version and nothing is stored on the visitor’s device. Only goals on the same page, such as a form on it, can be counted; a goal on another page or a returning visitor can’t be measured."],
            ["consent", "With consent", "After the visitor agrees, the site keeps a random id for at most 13 months, so a visitor keeps their version and goals on later pages count. Your consent banner must ask for it; it is not “strictly necessary”."],
          ] as const).map(([mode, label, hint]) => (
            <div key={mode} className="mt-1.5">
              <label className="flex items-center gap-2 font-medium text-fg">
                <input type="radio" name="experiment-mode" checked={s.mode === mode} onChange={() => save.mutate({ mode })} />
                {label}
              </label>
              <p className="ml-5 text-xs text-muted">{hint}</p>
            </div>
          ))}
        </fieldset>
        <label className="flex flex-wrap items-center gap-2">
          <span>Warn on the dashboard when an experiment has run for more than</span>
          <input
            type="number"
            min={1}
            max={365}
            className="field-input w-20"
            aria-label="Warning after days"
            defaultValue={s.warnDays}
            disabled={!canManage || save.isPending}
            onBlur={(e) => { const n = Math.round(Number(e.target.value)); if (n >= 1 && n <= 365 && n !== s.warnDays) save.mutate({ warnDays: n }); }}
          />
          <span>days</span>
        </label>
        <p className="text-xs text-muted">Either way Paperboy stores counts per day only: no IP address, user agent or visitor id.{canManage ? "" : " Changing these needs the site’s General settings permission."}</p>
      </Surface>
    </section>
  );
}
