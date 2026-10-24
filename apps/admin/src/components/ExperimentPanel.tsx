import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { EXPERIMENT_ARMS, type BlockInstance, type BlockSummary, type ContentTypeDef, type FieldDef } from "@paperboy/shared";
import { api, type ExperimentDetail, type ExperimentInput, type ExperimentView, type WinnerApply } from "../lib/api.js";
import type { BlockPath } from "../lib/block-path.js";
import { experimentBadge, liftText, neededPerVersion, parseGoal, pct, versionName } from "../lib/experiments.js";
import { Icon } from "../lib/icons.js";
import { useUser } from "../lib/user.js";
import { ContentArea } from "./fields/ContentArea.js";
import { Badge } from "./ui/badge.js";
import { Callout } from "./ui/callout.js";
import { useConfirm } from "./ui/confirm.js";
import { Dialog, DialogContent } from "./ui/dialog.js";
import { useToast } from "./ui/toast.js";

/**
 * The experiment panel (#125): one content area of a page tested against up to
 * three alternatives. Version A is the page's PUBLISHED area; B–D are edited
 * with the same ContentArea editor the area uses (palette, allowedBlocks,
 * shared blocks), and validated by the same write path server-side.
 *
 * `id: null` sets up a new experiment; saving it switches the panel to it.
 */
export function ExperimentPanel({
  id,
  documentId,
  locale,
  area,
  areaBlocks,
  types,
  sharedBlocks,
  onOpen,
  onClose,
  onEnded,
}: {
  id: number | null;
  documentId: string;
  locale: string;
  area: FieldDef;
  /** The area as the editor holds it now: a new version starts as a copy. */
  areaBlocks: BlockInstance[];
  types: ContentTypeDef[];
  sharedBlocks: BlockSummary[];
  onOpen: (id: number) => void;
  onClose: () => void;
  /** Ended; a winner may now be the area's draft. */
  onEnded: () => void;
}) {
  const detail = useQuery({
    queryKey: ["experiment", id],
    queryFn: ({ signal }) => api.experiment(id!, signal),
    enabled: id !== null,
    // Counts move while it runs.
    refetchInterval: (q) => (q.state.data?.status === "running" ? 30_000 : false),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="xl" title={id === null ? `A/B test: ${area.displayName}` : (detail.data?.name ?? "Experiment")} description="Test this area of the page against up to three other versions.">
        {id !== null && !detail.data ? (
          <p className="text-sm text-muted">{detail.isError ? (detail.error as Error).message : "Loading…"}</p>
        ) : (
          <ExperimentForm
            key={id ?? "new"}
            exp={detail.data ?? null}
            documentId={documentId}
            locale={locale}
            area={area}
            areaBlocks={areaBlocks}
            types={types}
            sharedBlocks={sharedBlocks}
            onOpen={onOpen}
            onEnded={onEnded}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

interface ArmDraft {
  key: string;
  label: string;
  weight: number;
  blocks: BlockInstance[];
}

/** ISO → the value a datetime-local input shows, in local time. */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

const fracToPct = (f: number | null): string => (f == null ? "" : String(Math.round(f * 10_000) / 100));

function ExperimentForm({
  exp,
  documentId,
  locale,
  area,
  areaBlocks,
  types,
  sharedBlocks,
  onOpen,
  onEnded,
}: {
  exp: ExperimentDetail | null;
  documentId: string;
  locale: string;
  area: FieldDef;
  areaBlocks: BlockInstance[];
  types: ContentTypeDef[];
  sharedBlocks: BlockSummary[];
  onOpen: (id: number) => void;
  onEnded: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const { user } = useUser();
  const canEdit = user.permissions.includes("content.update");
  const canPublish = user.permissions.includes("content.publish");
  const settings = useQuery({ queryKey: ["experiment-settings"], queryFn: ({ signal }) => api.experimentSettings(signal) });

  const goal = parseGoal(exp?.goal ?? "form");
  const [name, setName] = useState(exp?.name ?? "");
  const [hypothesis, setHypothesis] = useState(exp?.hypothesis ?? "");
  const [goalKind, setGoalKind] = useState(goal.kind);
  const [eventName, setEventName] = useState(goal.event);
  const [baseline, setBaseline] = useState(fracToPct(exp?.baselineRate ?? null));
  const [lift, setLift] = useState(fracToPct(exp?.mde ?? null));
  const [endsAt, setEndsAt] = useState(toLocalInput(exp?.endsAt ?? null));
  const [arms, setArms] = useState<ArmDraft[]>(
    exp
      ? exp.arms.map((a) => ({ key: a.key, label: a.label ?? "", weight: a.weight, blocks: a.blocks ?? [] }))
      : [{ key: "a", label: "", weight: 50, blocks: [] }, { key: "b", label: "", weight: 50, blocks: structuredClone(areaBlocks) }],
  );
  const [dirty, setDirty] = useState(exp === null);
  const [openPath, setOpenPath] = useState<BlockPath>([]);
  const [ending, setEnding] = useState(false);
  const touch = <T,>(set: (v: T) => void) => (v: T) => { set(v); setDirty(true); };
  const patchArm = (key: string, p: Partial<ArmDraft>) => { setArms((all) => all.map((a) => (a.key === key ? { ...a, ...p } : a))); setDirty(true); };

  const status = exp?.status ?? "draft";
  const editable = canEdit && (status === "draft" || status === "paused");
  const needed = neededPerVersion(baseline, lift);
  const totalWeight = arms.reduce((s, a) => s + a.weight, 0);
  const freeKey = EXPERIMENT_ARMS.find((k) => !arms.some((a) => a.key === k));

  const refresh = (next: ExperimentView) => {
    qc.setQueryData(["experiment", next.id], (old: ExperimentDetail | undefined) => ({ ...next, daily: old?.daily ?? [] }));
    void qc.invalidateQueries({ queryKey: ["experiment", next.id] });
    void qc.invalidateQueries({ queryKey: ["experiments"] });
  };
  const fail = (title: string) => (e: Error) => toast.error(title, e.message);

  const save = useMutation({
    mutationFn: () => {
      const body: ExperimentInput = {
        name: name.trim(),
        hypothesis: hypothesis.trim() || null,
        goal: goalKind === "form" ? "form" : `event:${eventName.trim()}`,
        baselineRate: baseline.trim() ? Number(baseline) / 100 : null,
        mde: lift.trim() ? Number(lift) / 100 : null,
        endsAt: endsAt ? new Date(endsAt).toISOString() : null,
        arms: arms.map((a) => (a.key === "a" ? { key: "a", label: a.label || null, weight: a.weight } : { key: a.key, label: a.label || null, weight: a.weight, blocks: a.blocks })),
      };
      return exp ? api.updateExperiment(exp.id, body) : api.createExperiment({ ...body, documentId, locale, area: area.name });
    },
    onSuccess: (next) => {
      setDirty(false);
      refresh(next);
      toast.success(exp ? "Experiment saved" : "Experiment created", "Start it when the versions are ready.");
      if (!exp) onOpen(next.id);
    },
    onError: fail("Couldn’t save the experiment"),
  });
  const start = useMutation({ mutationFn: () => api.startExperiment(exp!.id), onSuccess: (n) => { refresh(n); toast.success("Experiment started"); }, onError: fail("Couldn’t start the experiment") });
  const pause = useMutation({ mutationFn: () => api.pauseExperiment(exp!.id), onSuccess: (n) => { refresh(n); toast.success("Experiment paused", "Every visitor sees version A until you start it again."); }, onError: fail("Couldn’t pause the experiment") });
  const busy = save.isPending || start.isPending || pause.isPending;

  const mode = settings.data?.mode;
  return (
    <div className="flex flex-col gap-4 text-sm">
      {exp && (
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={status === "running" ? "primary" : status === "ended" ? "default" : "caution"} role="status">{experimentBadge(exp)}</Badge>
          {exp.startedAt && <span className="text-xs text-muted">started {new Date(exp.startedAt).toLocaleDateString()}</span>}
        </div>
      )}
      {exp?.needsReview && status !== "ended" && (
        <Callout tone="caution" title="Set up by an agent">Check the versions below. Starting the experiment is the review.</Callout>
      )}
      {status === "running" && (
        <Callout tone="primary">This experiment is running, so it can’t be edited: changing a version mid-test would mix two tests in one count. Pause it to edit.</Callout>
      )}
      {status === "ended" && (
        <Callout tone="default">
          Ended {exp?.endedAt ? new Date(exp.endedAt).toLocaleDateString() : ""}
          {exp?.winner ? ` with ${versionName(exp.winner)} as the winner` : " without a winner"}
          {exp?.endReason && exp.endReason !== "manual" ? ` (${exp.endReason})` : ""}. It is kept with its results.
        </Callout>
      )}

      <fieldset disabled={!editable} className="flex flex-col gap-3">
        <legend className="sr-only">Plan</legend>
        <label>
          <span className="field-label">Name</span>
          <input className="field-input" value={name} placeholder="Hero headline: benefit vs. feature" onChange={(e) => touch(setName)(e.target.value)} />
        </label>
        <label>
          <span className="field-label">Hypothesis <span className="text-muted">(optional)</span></span>
          <textarea className="field-textarea" rows={2} value={hypothesis} placeholder="A headline about the benefit gets more sign-ups, because…" onChange={(e) => touch(setHypothesis)(e.target.value)} />
        </label>

        <div className="flex flex-col gap-3">
          {arms.map((a) => (
            <section key={a.key} aria-label={versionName(a.key)} className="rounded-(--radius) border border-line p-3">
              <div className="mb-2 flex flex-wrap items-end gap-3">
                <h3 className="text-sm font-semibold text-fg">{versionName(a.key)}</h3>
                <label className="min-w-40 flex-1">
                  <span className="field-label">Label <span className="text-muted">(optional)</span></span>
                  <input className="field-input" value={a.label} placeholder={a.key === "a" ? "Current" : "Shorter headline"} onChange={(e) => patchArm(a.key, { label: e.target.value })} />
                </label>
                <label className="w-36">
                  <span className="field-label">Share of visitors</span>
                  <span className="flex items-center gap-1">
                    <input type="number" min={0} max={100} className="field-input" value={a.weight} aria-label={`Share of visitors for ${versionName(a.key)} (%)`} onChange={(e) => patchArm(a.key, { weight: Math.max(0, Math.min(100, Math.round(Number(e.target.value) || 0))) })} />
                    <span className="text-muted">%</span>
                  </span>
                </label>
                {a.key !== "a" && arms.length > 2 && (
                  <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => { setArms((all) => all.filter((x) => x.key !== a.key)); setDirty(true); }}>Remove {versionName(a.key)}</button>
                )}
              </div>
              {a.key === "a" ? (
                <p className="text-xs text-muted">The page’s published {area.displayName}, as it is. Edit it on the page itself.</p>
              ) : (
                <ContentArea
                  field={area}
                  value={a.blocks}
                  onChange={(blocks) => patchArm(a.key, { blocks })}
                  types={types}
                  sharedBlocks={sharedBlocks}
                  disabled={!editable}
                  openPath={openPath}
                  onOpenPath={setOpenPath}
                />
              )}
            </section>
          ))}
          {totalWeight > 0 && totalWeight !== 100 && (
            <p className="text-xs text-muted">The shares add up to {totalWeight}, so they are read relative to each other: {arms.map((a) => `${a.key.toUpperCase()} ${Math.round((a.weight / totalWeight) * 100)} %`).join(", ")}.</p>
          )}
          {freeKey && editable && (
            <button type="button" className="btn-subtle self-start px-2 py-1 text-xs" onClick={() => { setArms((all) => [...all, { key: freeKey, label: "", weight: 50, blocks: structuredClone(areaBlocks) }]); setDirty(true); }}>
              <Icon.Plus width={14} height={14} /> Add {versionName(freeKey)}
            </button>
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label>
            <span className="field-label">Goal</span>
            <select className="field-input" value={goalKind} onChange={(e) => touch(setGoalKind)(e.target.value as "form" | "event")}>
              <option value="form">A form on this page is sent</option>
              <option value="event">A custom event from the site</option>
            </select>
          </label>
          {goalKind === "event" && (
            <label>
              <span className="field-label">Event name</span>
              <input className="field-input font-mono text-xs" value={eventName} placeholder="signup" onChange={(e) => touch(setEventName)(e.target.value.toLowerCase())} />
              <span className="mt-1 block text-xs text-muted">The site reports it as <code>event:{eventName || "signup"}</code>.</span>
            </label>
          )}
          <label>
            <span className="field-label">Today’s conversion rate (%)</span>
            <input type="number" min={0} max={100} step="0.1" className="field-input" value={baseline} placeholder="4" onChange={(e) => touch(setBaseline)(e.target.value)} />
          </label>
          <label>
            <span className="field-label">Smallest lift worth detecting (%)</span>
            <input type="number" min={0} step="1" className="field-input" value={lift} placeholder="20" onChange={(e) => touch(setLift)(e.target.value)} />
          </label>
        </div>
        <p className="text-xs text-muted" aria-live="polite">
          {needed != null
            ? `Needs about ${needed.toLocaleString()} visitors per version before a result can be read. No winner is named before that.`
            : "No plan set: without today’s rate and the lift to detect, the results will never name a winner — any early difference could be chance."}
        </p>
        <label className="sm:w-1/2">
          <span className="field-label">End date <span className="text-muted">(optional)</span></span>
          <input type="datetime-local" className="field-input" value={endsAt} onChange={(e) => touch(setEndsAt)(e.target.value)} />
          <span className="mt-1 block text-xs text-muted">Ends by itself then, without a winner; the page goes back to version A.</span>
        </label>
      </fieldset>

      {exp && status !== "draft" && <Results exp={exp} />}

      {mode && (
        <p className="text-xs text-muted">
          {mode === "cookieless"
            ? "This site runs experiments cookieless: each page view draws a version and nothing is stored on the visitor’s device. Only goals on the same page (a form on it) can be counted; a goal on another page, or a visitor coming back, can’t be measured."
            : "This site runs experiments with consent: after the visitor agrees, the site keeps a random id for at most 13 months, so a visitor keeps their version and later goals count. Without consent it works cookieless."}
          {" "}Paperboy stores counts per day only — no IP address, user agent or visitor id.
        </p>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-3">
        {editable && (
          <button type="button" className={exp ? "btn-subtle" : "btn-primary"} disabled={busy || !dirty || !name.trim()} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : exp ? "Save" : "Create experiment"}
          </button>
        )}
        {exp && canPublish && (status === "draft" || status === "paused") && (
          <button
            type="button"
            className="btn-primary"
            disabled={busy || dirty}
            title={dirty ? "Save your changes first" : undefined}
            onClick={() => confirm.ask({
              title: status === "paused" ? "Resume the experiment?" : "Start the experiment?",
              description: `Visitors to the live page are split between versions ${arms.map((a) => a.key.toUpperCase()).join(", ")} by the shares set here. While it runs the versions can’t be edited; pause it to edit.`,
              confirmLabel: status === "paused" ? "Resume experiment" : "Start experiment",
              onConfirm: () => start.mutate(),
            })}
          >
            {status === "paused" ? "Resume" : "Start"}
          </button>
        )}
        {exp && canPublish && status === "running" && (
          <button
            type="button"
            className="btn-subtle"
            disabled={busy}
            onClick={() => confirm.ask({ title: "Pause the experiment?", description: "Every visitor sees version A while it is paused. The counts so far are kept, and you can edit the versions.", confirmLabel: "Pause experiment", onConfirm: () => pause.mutate() })}
          >
            Pause
          </button>
        )}
        {exp && canPublish && status !== "ended" && (
          <button type="button" className="btn-subtle" disabled={busy} onClick={() => setEnding(true)}>End…</button>
        )}
      </div>
      {ending && exp && <EndDialog exp={exp} onDone={(n) => { refresh(n); setEnding(false); onEnded(); }} onClose={() => setEnding(false)} />}
      {confirm.dialog}
    </div>
  );
}

function Results({ exp }: { exp: ExperimentDetail }) {
  const days = [...new Set(exp.daily.map((d) => d.day))];
  return (
    <section aria-label="Results" className="flex flex-col gap-2">
      <h3 className="text-xs font-bold uppercase tracking-wide text-muted">Results</h3>
      <p role="status" className="font-medium text-fg">{exp.verdict.summary}</p>
      {exp.verdict.srmWarning && (
        <Callout tone="critical" title="The split doesn’t match the shares">Visitors aren’t divided between the versions as set (sample ratio mismatch), so no result can be trusted. Look for caching or bots pinning one version.</Callout>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-muted">
              <th className="px-2 py-1.5 font-semibold">Version</th>
              <th className="px-2 py-1.5 text-right font-semibold">Visitors</th>
              <th className="px-2 py-1.5 text-right font-semibold">Conversions</th>
              <th className="px-2 py-1.5 text-right font-semibold">Rate</th>
              <th className="px-2 py-1.5 font-semibold">Lift vs. A</th>
            </tr>
          </thead>
          <tbody>
            {exp.results.map((r) => (
              <tr key={r.key} className="border-b border-line last:border-0">
                <td className="px-2 py-1.5">{versionName(r.key)}{exp.verdict.leader === r.key && <Badge tone="positive" className="ml-1.5">leads</Badge>}</td>
                <td className="tnum px-2 py-1.5 text-right">{r.exposures}</td>
                <td className="tnum px-2 py-1.5 text-right">{r.conversions}</td>
                <td className="tnum px-2 py-1.5 text-right">{pct(r.rate)}</td>
                <td className="px-2 py-1.5 text-xs">{r.key === "a" ? "control" : liftText(r.comparison)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {exp.verdict.needed != null && <p className="text-xs text-muted">Planned: {exp.verdict.needed.toLocaleString()} visitors per version.</p>}
      {days.length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs text-muted">Per day</summary>
          <table className="mt-1 w-full text-xs">
            <thead>
              <tr className="border-b border-line text-left text-muted">
                <th className="px-2 py-1 font-semibold">Day</th>
                {exp.results.map((r) => <th key={r.key} className="px-2 py-1 text-right font-semibold">{r.key.toUpperCase()} visitors / conversions</th>)}
              </tr>
            </thead>
            <tbody>
              {days.map((day) => (
                <tr key={day} className="border-b border-line last:border-0">
                  <td className="px-2 py-1">{day}</td>
                  {exp.results.map((r) => {
                    const d = exp.daily.find((x) => x.day === day && x.arm === r.key);
                    return <td key={r.key} className="tnum px-2 py-1 text-right">{d ? `${d.exposures} / ${d.conversions}` : "0 / 0"}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </section>
  );
}

function EndDialog({ exp, onDone, onClose }: { exp: ExperimentView; onDone: (next: ExperimentView) => void; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const offerWinner = exp.verdict.complete;
  const [winner, setWinner] = useState(exp.verdict.leader ?? "b");
  const end = useMutation({
    mutationFn: (apply: WinnerApply) => api.endExperiment(exp.id, apply === "none" ? { winner: null, apply: "none" } : { winner, apply }),
    onSuccess: (r) => {
      onDone(r.experiment);
      // The winner landed in the page's area (draft, maybe published).
      void qc.invalidateQueries({ queryKey: ["content", exp.documentId] });
      void qc.invalidateQueries({ queryKey: ["versions", exp.documentId] });
      void qc.invalidateQueries({ queryKey: ["tree"] });
      toast.success("Experiment ended", r.applied === "draft" ? `${versionName(winner)} is now the area’s draft. Review it and publish.` : r.applied === "publish" ? `${versionName(winner)} is published.` : "The page shows version A.");
    },
    onError: (e) => toast.error("Couldn’t end the experiment", (e as Error).message),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="End the experiment?" description="Every visitor sees one version again. The experiment is kept with its results." size="md">
        <div className="flex flex-col gap-3 text-sm">
          {offerWinner ? (
            <fieldset>
              <legend className="field-label">Winner</legend>
              <div className="flex flex-wrap gap-3">
                {exp.arms.filter((a) => a.key !== "a").map((a) => (
                  <label key={a.key} className="flex items-center gap-1.5">
                    <input type="radio" name="winner" value={a.key} checked={winner === a.key} onChange={() => setWinner(a.key)} />
                    {versionName(a.key)}{exp.verdict.leader === a.key ? " (leads)" : ""}
                  </label>
                ))}
              </div>
              <p className="mt-1 text-xs text-muted">{exp.verdict.summary}</p>
            </fieldset>
          ) : (
            <Callout tone="caution" title="No winner can be chosen yet">{exp.verdict.summary}</Callout>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
            <button type="button" className="btn-subtle" disabled={end.isPending} onClick={() => end.mutate("none")}>End without a winner</button>
            {offerWinner && (
              <>
                <button type="button" className="btn-subtle" disabled={end.isPending} onClick={() => end.mutate("draft")}>Winner as draft</button>
                <button type="button" className="btn-primary" disabled={end.isPending} onClick={() => end.mutate("publish")}>Publish winner</button>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
