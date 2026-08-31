import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiError, type SubmissionRow } from "../lib/api.js";
import { Icon } from "../lib/icons.js";
import { Badge } from "./ui/badge.js";
import { Callout } from "./ui/callout.js";
import { useConfirm } from "./ui/confirm.js";
import { Dialog, DialogContent } from "./ui/dialog.js";
import { EmptyState } from "./ui/empty-state.js";
import { Skeleton, SkeletonRows } from "./ui/skeleton.js";
import { Surface } from "./ui/surface.js";
import { useToast } from "./ui/toast.js";

/**
 * What visitors sent through one Form, and the two ways to get rid of it.
 *
 * Reachable from the Form document's own "Submissions" tab (Editor) and from
 * Settings → Form submissions, which lists every form first. Both hosts pass a
 * `formId` — a submissions list is always ABOUT a form, so there is no
 * everything-at-once view and no bulk export of the whole site.
 */

const PAGE = 50;

/** A failed load must never read as "nothing here" — that would be a lie, and
 *  the honest reading of a dropped request is that we don't know. 403 is its own
 *  case: the permission is enforced on the server, so it can differ from what
 *  this session's permission list says. */
export function SubmissionsLoadError({ error, subject }: { error: unknown; subject: "form" | "site" }) {
  if (error instanceof ApiError && error.status === 403) {
    return (
      <Callout tone="caution" title="You can’t read form submissions">
        Submissions hold personal data visitors sent you, so they need their own permission. Ask an administrator for the
        Editor role (or higher) if answering these is part of your job.
      </Callout>
    );
  }
  return (
    <Callout tone="critical" title={subject === "form" ? "Couldn’t load the submissions" : "Couldn’t load the forms"}>
      This isn’t an empty {subject} — the list failed to load. Reload to try again.
    </Callout>
  );
}

/** One answer as display text. Objects/arrays become JSON so a nested value is
 *  still visible (never "[object Object]"), and a checkbox reads the way the
 *  visitor saw it. */
function answerText(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  return JSON.stringify(v);
}

/** The answers in snapshot order — every question the form asked when it was
 *  answered, under the label it was asked with. Any stored key the snapshot
 *  doesn't mention is appended rather than hidden. */
function answersOf(row: SubmissionRow): { key: string; label: string; text: string }[] {
  const out = row.fieldSnapshot.map((f) => ({
    key: f.name,
    label: f.label || f.name,
    text: answerText(row.values[f.name]),
  }));
  for (const key of Object.keys(row.values)) {
    if (!out.some((a) => a.key === key)) out.push({ key, label: key, text: answerText(row.values[key]) });
  }
  return out;
}

/** One-line preview of a row: the answers that were actually given. */
function summarise(row: SubmissionRow): string {
  return answersOf(row)
    .filter((a) => a.text !== "—")
    .map((a) => `${a.label}: ${a.text}`)
    .join(" · ");
}

const when = (iso: string) => new Date(iso).toLocaleString();

export function FormSubmissions({ formId, canManage }: { formId: string; canManage: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [offset, setOffset] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const [eraseEmail, setEraseEmail] = useState("");

  const list = useQuery({
    queryKey: ["submissions", formId, offset],
    queryFn: ({ signal }) => api.submissions({ formId, limit: PAGE, offset }, signal),
  });

  function refresh() {
    void qc.invalidateQueries({ queryKey: ["submissions"] });
    void qc.invalidateQueries({ queryKey: ["forms"] });
  }

  const remove = useMutation({
    mutationFn: (submissionId: string) => api.deleteSubmission(submissionId),
    onSuccess: () => {
      setOpenId(null);
      toast.success("Submission deleted", "The answers are gone for good.");
      refresh();
    },
    onError: (e) => toast.error("Couldn’t delete the submission", (e as Error).message),
  });

  const erase = useMutation({
    mutationFn: (email: string) => api.eraseSubmissions(email),
    onSuccess: ({ deleted }) => {
      setEraseEmail("");
      setOpenId(null);
      toast.success(
        deleted === 1 ? "1 submission erased" : `${deleted} submissions erased`,
        deleted === 0 ? "Nothing on this site contained that address." : "Every submission containing that address is gone.",
      );
      refresh();
    },
    onError: (e) => toast.error("Couldn’t erase the submissions", (e as Error).message),
  });

  const exportCsv = useMutation({
    mutationFn: () => api.submissionsCsv(formId),
    onSuccess: (csv) => {
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `submissions-${formId}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    },
    onError: (e) => toast.error("Couldn’t export", (e as Error).message),
  });

  if (list.isError) return <SubmissionsLoadError error={list.error} subject="form" />;

  const rows = list.data?.items ?? [];
  const total = list.data?.total ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-lg text-sm text-muted">
          What visitors sent through this form, newest first. These answers are personal data — read them, act on them,
          and delete them when you no longer need them.
        </p>
        <button
          type="button"
          className="btn-subtle shrink-0"
          disabled={exportCsv.isPending || total === 0}
          onClick={() => exportCsv.mutate()}
        >
          {exportCsv.isPending ? "Preparing…" : "Export CSV"}
        </button>
      </div>

      <Surface elevation={1} className="overflow-hidden">
        {list.isLoading ? (
          <SkeletonRows rows={4} />
        ) : rows.length === 0 ? (
          <EmptyState title="No submissions yet">
            Answers appear here as soon as someone sends the published form.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line" aria-label="Submissions, newest first">
            {rows.map((row) => {
              const summary = summarise(row);
              return (
                <li key={row.submissionId} className="flex items-start gap-1 hover:bg-canvas">
                  <button
                    type="button"
                    className="min-w-0 flex-1 px-3 py-2.5 text-left"
                    onClick={() => setOpenId(row.submissionId)}
                  >
                    <span className="block truncate text-sm text-fg">{summary || "No answers were recorded"}</span>
                    <span className="mt-1 flex items-center gap-2 text-xs text-muted">
                      <span>{when(row.createdAt)}</span>
                      <Badge>{row.locale}</Badge>
                    </span>
                  </button>
                  {canManage && (
                    <button
                      type="button"
                      className="mr-2 mt-2.5 grid h-7 w-7 shrink-0 place-items-center rounded text-muted hover:bg-danger-subtle hover:text-danger"
                      aria-label={`Delete the submission from ${when(row.createdAt)}`}
                      title="Delete this submission permanently"
                      disabled={remove.isPending}
                      onClick={() =>
                        confirm.ask({
                          title: "Delete this submission permanently?",
                          description:
                            "The visitor’s answers, and anything stored with them, are removed for good. This cannot be undone.",
                          confirmLabel: "Delete permanently",
                          onConfirm: () => remove.mutate(row.submissionId),
                        })
                      }
                    >
                      <Icon.Trash width={15} height={15} />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {total > PAGE && (
          <div className="flex items-center justify-between gap-2 border-t border-line px-3 py-2 text-xs text-muted">
            <span>
              Showing <span className="tnum">{offset + 1}</span>–<span className="tnum">{Math.min(offset + PAGE, total)}</span> of{" "}
              <span className="tnum">{total}</span>
            </span>
            <span className="flex gap-1.5">
              <button
                type="button"
                className="btn-subtle px-2 py-1 text-xs"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(offset - PAGE, 0))}
              >
                Previous
              </button>
              <button
                type="button"
                className="btn-subtle px-2 py-1 text-xs"
                disabled={offset + PAGE >= total}
                onClick={() => setOffset(offset + PAGE)}
              >
                Next
              </button>
            </span>
          </div>
        )}
      </Surface>

      {canManage && (
        <Surface padding="md" className="space-y-2">
          <div>
            <h3 className="text-sm font-semibold text-fg">Erase by email</h3>
            <p className="mt-0.5 text-xs text-muted">
              For a data-subject erasure request. Deletes every submission containing this address, in any field and in
              every form on this site — not just this one. It cannot be undone.
            </p>
          </div>
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const email = eraseEmail.trim();
              if (!email) return;
              confirm.ask({
                title: "Erase every submission from this address?",
                description: `This permanently deletes every submission on this site whose answers contain ${email}, in any form. It cannot be undone.`,
                confirmLabel: "Erase permanently",
                onConfirm: () => erase.mutate(email),
              });
            }}
          >
            <label className="min-w-56 flex-1">
              <span className="field-label">Email address</span>
              <input
                className="field-input"
                type="email"
                autoComplete="off"
                placeholder="visitor@example.com"
                value={eraseEmail}
                onChange={(e) => setEraseEmail(e.target.value)}
              />
            </label>
            <button className="btn-danger" disabled={erase.isPending || eraseEmail.trim() === ""}>
              {erase.isPending ? "Erasing…" : "Erase submissions"}
            </button>
          </form>
        </Surface>
      )}

      {openId && (
        <SubmissionDialog
          submissionId={openId}
          canManage={canManage}
          onOpenChange={(open) => !open && setOpenId(null)}
          onDelete={(id, createdAt) =>
            confirm.ask({
              title: "Delete this submission permanently?",
              description: `The answers received ${when(createdAt)} are removed for good. This cannot be undone.`,
              confirmLabel: "Delete permanently",
              onConfirm: () => remove.mutate(id),
            })
          }
        />
      )}
      {confirm.dialog}
    </div>
  );
}

/**
 * One submission in full, every answer under the LABEL it was asked with.
 *
 * Re-read from the server rather than shown from the list row: this is the one
 * place the whole answer set is displayed, and a row that has since been deleted
 * (by a colleague, or by the retention sweep) must read as gone instead of
 * rendering personal data that no longer exists.
 */
function SubmissionDialog({
  submissionId,
  canManage,
  onOpenChange,
  onDelete,
}: {
  submissionId: string;
  canManage: boolean;
  onOpenChange: (open: boolean) => void;
  onDelete: (submissionId: string, createdAt: string) => void;
}) {
  const detail = useQuery({
    queryKey: ["submission", submissionId],
    queryFn: ({ signal }) => api.submission(submissionId, signal),
  });
  const row = detail.data;
  const gone = detail.error instanceof ApiError && detail.error.status === 404;
  const answers = row ? answersOf(row) : [];
  const meta = row ? Object.entries(row.meta) : [];

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        title="Submission"
        description={row ? `Received ${when(row.createdAt)} · ${row.locale}` : undefined}
        size="xl"
      >
        {detail.isLoading && (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        )}

        {gone && (
          <Callout tone="caution" title="This submission is no longer here">
            It was deleted, or its retention period ran out, since the list was loaded.
          </Callout>
        )}

        {detail.isError && !gone && (
          <Callout tone="critical" title="Couldn’t load this submission">
            The answers are still stored — this dialog just couldn’t read them. Close it and try again.
          </Callout>
        )}

        {row && (
          <div className="space-y-4">
            {answers.length === 0 ? (
              <p className="text-sm text-muted">This submission stored no answers.</p>
            ) : (
              <dl className="divide-y divide-line border-y border-line">
                {answers.map((a) => (
                  <div key={a.key} className="grid gap-0.5 py-2.5 sm:grid-cols-[minmax(0,12rem)_1fr] sm:gap-4">
                    <dt className="text-[13px] font-semibold text-fg">{a.label}</dt>
                    <dd className="whitespace-pre-wrap break-words text-sm text-fg">{a.text}</dd>
                  </div>
                ))}
              </dl>
            )}

            {meta.length > 0 && (
              <div>
                <div className="eyebrow">Recorded with the answers</div>
                <dl className="mt-1.5 space-y-1 text-xs">
                  {meta.map(([k, v]) => (
                    <div key={k} className="grid gap-0.5 sm:grid-cols-[minmax(0,12rem)_1fr] sm:gap-4">
                      <dt className="font-semibold text-fg">{k}</dt>
                      <dd className="break-words font-mono text-muted">{answerText(v)}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}

            <p className="text-xs text-muted">
              {row.expiresAt
                ? `Deleted automatically on ${when(row.expiresAt)}, per this form’s retention setting.`
                : "This form sets no retention period, so nothing deletes this automatically."}
            </p>

            <div className="flex justify-end gap-2">
              {canManage && (
                <button type="button" className="btn-danger" onClick={() => onDelete(row.submissionId, row.createdAt)}>
                  Delete permanently
                </button>
              )}
              <button type="button" className="btn-ghost" onClick={() => onOpenChange(false)}>
                Close
              </button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
