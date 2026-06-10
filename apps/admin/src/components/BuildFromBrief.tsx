import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { type AgentEvent, api } from "../lib/api.js";
import { Icon } from "../lib/icons.js";
import { TypeIcon } from "../lib/typeIcons.js";
import { Dialog, DialogContent } from "./ui/dialog.js";

type Phase = "idle" | "running" | "done" | "error";

interface ActivityRow {
  id: number;
  kind: "status" | "tool";
  text: string;
  state: "running" | "ok" | "failed";
}

/**
 * "Build from brief" — the in-product content agent. The server runs a
 * tool-use loop AS this user (drafts only; it has no publish/delete tools)
 * and streams every action here as it happens. Review the drafts in the
 * tree/preview, then publish like any other change.
 */
export function BuildFromBriefDialog({
  parentId,
  parentName,
  locale,
  open,
  onOpenChange,
}: {
  /** The currently open page — offered as the default parent. */
  parentId: string | null;
  parentName: string | null;
  locale: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [brief, setBrief] = useState("");
  const [target, setTarget] = useState<"here" | "root">(parentId ? "here" : "root");
  const [phase, setPhase] = useState<Phase>("idle");
  const [rows, setRows] = useState<ActivityRow[]>([]);
  const [created, setCreated] = useState<Array<{ documentId: string; name: string; type: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const rowId = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);

  const pushRow = (kind: ActivityRow["kind"], text: string, state: ActivityRow["state"]) => {
    setRows((prev) => [...prev, { id: ++rowId.current, kind, text, state }]);
    // Keep the newest activity visible.
    requestAnimationFrame(() => listRef.current?.scrollTo({ top: listRef.current.scrollHeight }));
  };

  const onEvent = (ev: AgentEvent) => {
    if (ev.type === "status" && ev.text) pushRow("status", ev.text, "ok");
    else if (ev.type === "tool" && ev.text) pushRow("tool", ev.text, "running");
    else if (ev.type === "tool_done") {
      setRows((prev) => {
        const last = [...prev].reverse().find((r) => r.kind === "tool" && r.state === "running");
        return prev.map((r) => (r === last ? { ...r, state: ev.ok ? "ok" : "failed", text: ev.ok ? r.text : `${r.text} — ${ev.text ?? "failed"}` } : r));
      });
    } else if (ev.type === "done") {
      setCreated(ev.created ?? []);
      setPhase("done");
    } else if (ev.type === "error") {
      if (ev.created?.length) setCreated(ev.created);
      setError(ev.text ?? "Agent failed");
      setPhase("error");
    }
  };

  async function start() {
    setPhase("running");
    setRows([]);
    setCreated([]);
    setError(null);
    try {
      await api.aiAgent({ brief, parentId: target === "here" ? parentId : null, locale }, onEvent);
      // Stream ended without a done/error event (connection drop) — surface it.
      setPhase((p) => (p === "running" ? "error" : p));
      setError((e) => e ?? null);
    } catch (e) {
      setError((e as Error).message);
      setPhase("error");
    } finally {
      // New drafts exist regardless of how the run ended.
      qc.invalidateQueries({ queryKey: ["tree", "root"] });
      qc.invalidateQueries({ queryKey: ["blocks"] });
    }
  }

  const running = phase === "running";

  return (
    <Dialog open={open} onOpenChange={(o) => !running && onOpenChange(o)}>
      <DialogContent
        title="Build from brief"
        description="Describe what to create. The agent works in drafts only, as you — review in the preview, then publish."
        className="w-[min(620px,94vw)]"
      >
        {phase === "idle" && (
          <div className="space-y-3">
            <textarea
              className="field-input min-h-[120px] resize-y"
              placeholder={`e.g. "A 'Spring Launch' landing page with a hero, plus a news section: a list page with three short articles about the launch."`}
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              aria-label="Brief"
            />
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <label className="flex items-center gap-2">
                <span className="text-muted">Create under</span>
                <select className="field-input w-auto py-1" value={target} onChange={(e) => setTarget(e.target.value as "here" | "root")} aria-label="Parent page">
                  {parentId && <option value="here">{parentName ?? "This page"}</option>}
                  <option value="root">Site root</option>
                </select>
              </label>
              <span className="text-muted">Language: <strong className="text-fg">{locale.toUpperCase()}</strong></span>
              <button className="btn-primary ml-auto" disabled={brief.trim().length < 10} onClick={() => void start()}>
                Build drafts
              </button>
            </div>
          </div>
        )}

        {phase !== "idle" && (
          <div className="space-y-3">
            <div ref={listRef} className="max-h-[42vh] space-y-1 overflow-y-auto rounded-[var(--radius)] border border-line bg-canvas/60 p-2.5">
              {rows.map((r) => (
                <div key={r.id} className={`flex items-start gap-2 text-sm ${r.kind === "status" ? "text-muted" : "text-fg"}`}>
                  <span className="mt-0.5 w-4 shrink-0 text-center" aria-hidden>
                    {r.kind === "status" ? "·" : r.state === "running" ? <span className="inline-block animate-pulse">…</span> : r.state === "ok" ? "✓" : "✗"}
                  </span>
                  <span className={r.state === "failed" ? "text-danger" : ""}>{r.text}</span>
                </div>
              ))}
              {running && rows.length === 0 && <p className="text-sm text-muted">Starting…</p>}
            </div>

            {error && <p className="text-sm text-danger">{error}</p>}

            {created.length > 0 && (
              <div>
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Drafts created</div>
                <ul className="space-y-1">
                  {created.map((c) => (
                    <li key={c.documentId}>
                      <button
                        className="flex w-full items-center gap-2 rounded-[var(--radius)] border border-line px-2.5 py-1.5 text-left text-sm hover:bg-line/40"
                        onClick={() => {
                          onOpenChange(false);
                          navigate(`/edit/${c.documentId}${locale !== "en" ? `?lang=${locale}` : ""}`);
                        }}
                      >
                        <TypeIcon name={undefined} fallback="file" width={15} height={15} className="shrink-0 text-muted" />
                        <span className="font-medium">{c.name}</span>
                        <span className="text-xs text-muted">{c.type}</span>
                        <span className="ml-auto rounded-full bg-draft/10 px-2 py-0.5 text-[11px] font-semibold text-draft">Draft</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="flex items-center justify-end gap-2">
              {!running && (
                <button className="btn-subtle" onClick={() => { setPhase("idle"); setRows([]); }}>
                  <Icon.Plus width={14} height={14} /> New brief
                </button>
              )}
              <button className="btn-subtle" disabled={running} onClick={() => onOpenChange(false)}>
                {running ? "Working…" : "Close"}
              </button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
