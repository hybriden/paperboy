import * as RDialog from "@radix-ui/react-dialog";
import { Icon } from "../../lib/icons.js";

export const Dialog = RDialog.Root;
export const DialogTrigger = RDialog.Trigger;
export const DialogClose = RDialog.Close;

/** Named widths, each clamped to the viewport so dialogs stay usable on phones. */
const sizeClass = {
  sm: "w-[min(400px,94vw)]",
  md: "w-[min(460px,94vw)]",
  lg: "w-[min(560px,94vw)]",
  xl: "w-[min(680px,94vw)]",
} as const;

export function DialogContent({
  children,
  title,
  description,
  size = "md",
  className = "",
}: {
  children: React.ReactNode;
  title: string;
  description?: string;
  size?: keyof typeof sizeClass;
  className?: string;
}) {
  return (
    <RDialog.Portal>
      <RDialog.Overlay className="fixed inset-0 z-50 bg-black/45 backdrop-blur-[1px] data-[state=open]:animate-fade-in" />
      <RDialog.Content
        className={`fixed left-1/2 top-1/2 z-50 max-h-[85vh] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-[var(--radius-lg)] border border-line bg-panel p-5 shadow-pop outline-none data-[state=open]:animate-scale-in ${sizeClass[size]} ${className}`}
      >
        <div className="mb-3 flex items-start justify-between gap-4">
          <div>
            <RDialog.Title className="text-base font-bold text-fg">{title}</RDialog.Title>
            {description && <RDialog.Description className="mt-0.5 text-sm text-muted">{description}</RDialog.Description>}
          </div>
          <RDialog.Close className="rounded p-1 text-muted hover:bg-line/60 hover:text-fg" aria-label="Close">
            <Icon.X width={16} height={16} />
          </RDialog.Close>
        </div>
        {children}
      </RDialog.Content>
    </RDialog.Portal>
  );
}
