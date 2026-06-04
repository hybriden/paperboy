import * as RPopover from "@radix-ui/react-popover";

export const Popover = RPopover.Root;
export const PopoverTrigger = RPopover.Trigger;

export function PopoverContent({
  children,
  align = "start",
  className = "",
}: {
  children: React.ReactNode;
  align?: "start" | "center" | "end";
  className?: string;
}) {
  return (
    <RPopover.Portal>
      <RPopover.Content
        align={align}
        sideOffset={6}
        className={`z-50 rounded-[var(--radius-lg)] border border-line bg-panel p-3 shadow-pop data-[state=open]:animate-slide-up ${className}`}
      >
        {children}
      </RPopover.Content>
    </RPopover.Portal>
  );
}
