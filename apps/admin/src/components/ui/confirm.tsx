import { useCallback, useState } from "react";
import { Dialog, DialogContent } from "./dialog.js";

/**
 * One confirmation gate for irreversible actions.
 *
 * The app already had the right pattern — Tree's "Delete <locale> version?" dialog
 * spells out that it cannot be undone — but the strongest guards sat on the
 * SMALLEST actions. Deleting one shared block got a `window.confirm`; deleting a
 * site required typing its slug; but "Discard draft changes" (which destroys all
 * unpublished work on a variant) and "Move to trash" (which unpublishes a whole
 * subtree) were a single click in a dropdown, with `destructive` being pure styling.
 *
 * Usage:
 *   const confirm = useConfirm();
 *   …
 *   <MenuItem destructive onSelect={() => confirm.ask({
 *     title: "Discard draft changes?",
 *     description: "…cannot be undone.",
 *     confirmLabel: "Discard changes",
 *     onConfirm: () => discard.mutate(),
 *   })}>Discard draft changes</MenuItem>
 *   …
 *   {confirm.dialog}
 */
export interface ConfirmRequest {
  title: string;
  description: string;
  /** Label of the confirming button. Say what will happen, not "OK". */
  confirmLabel: string;
  onConfirm: () => void;
  /** "danger" (default) for what can't be undone; "primary" for a deliberate,
   *  reversible step that still deserves a pause (starting an A/B test). */
  tone?: "danger" | "primary";
}

export interface ConfirmApi {
  ask: (request: ConfirmRequest) => void;
  /** Render this somewhere in the component's tree. */
  dialog: React.ReactNode;
}

export function useConfirm(): ConfirmApi {
  const [pending, setPending] = useState<ConfirmRequest | null>(null);
  const ask = useCallback((request: ConfirmRequest) => setPending(request), []);

  const dialog = pending ? (
    <Dialog open onOpenChange={(open) => !open && setPending(null)}>
      <DialogContent title={pending.title} description={pending.description} size="md">
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={() => setPending(null)}>
            Cancel
          </button>
          <button
            type="button"
            className={pending.tone === "primary" ? "btn-primary" : "btn-danger"}
            onClick={() => {
              const { onConfirm } = pending;
              setPending(null);
              onConfirm();
            }}
          >
            {pending.confirmLabel}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  ) : null;

  return { ask, dialog };
}
